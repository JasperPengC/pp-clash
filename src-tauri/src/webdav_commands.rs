use crate::{
    backup_cipher, backup_history,
    backup_scheduler::{self, BackupStatus, Scheduler},
    credential_store::{CredentialStore, PlatformCredentialStore},
    platform, portable_backup,
    webdav::{Connection, Remote},
    webdav_backup,
    webdav_settings::{
        self, ConnectionTestResult, SaveRequest, SettingsError, SettingsSnapshot, TestRequest,
    },
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock,
    },
};
use zeroize::Zeroizing;

#[tauri::command]
pub async fn get_webdav_settings() -> Result<SettingsSnapshot, SettingsError> {
    tauri::async_runtime::spawn_blocking(|| {
        let dir = platform::data_dir()
            .map_err(|_| SettingsError::new("data_directory_unavailable", "应用数据目录不可用"))?;
        webdav_settings::get_settings_metadata(&dir, &PlatformCredentialStore)
    })
    .await
    .map_err(|_| SettingsError::new("settings_task_failed", "无法读取 WebDAV 设置"))?
}

#[tauri::command]
pub async fn save_webdav_settings(request: SaveRequest) -> Result<SettingsSnapshot, SettingsError> {
    let _gate = job_gate()
        .try_lock()
        .map_err(|_| SettingsError::new("backup_busy", "备份任务正在进行，请完成后保存设置"))?;
    let snapshot = tauri::async_runtime::spawn_blocking(move || {
        let dir = platform::data_dir()
            .map_err(|_| SettingsError::new("data_directory_unavailable", "应用数据目录不可用"))?;
        webdav_settings::save_settings(&dir, &PlatformCredentialStore, request)
    })
    .await
    .map_err(|_| SettingsError::new("settings_task_failed", "无法保存 WebDAV 设置"))??;
    retry_credentials(
        &mut RUNTIME_STATE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()),
    );
    wake_scheduler();
    #[cfg(target_os = "android")]
    crate::android::cloud_tools::schedule(snapshot.configured && snapshot.settings.schedule != webdav_settings::Schedule::Off)
        .map_err(|message| SettingsError::new("background_schedule_failed", &message))?;
    Ok(snapshot)
}

#[tauri::command]
pub async fn test_webdav_connection(
    request: TestRequest,
) -> Result<ConnectionTestResult, SettingsError> {
    let connection = tauri::async_runtime::spawn_blocking(move || {
        let dir = platform::data_dir()
            .map_err(|_| SettingsError::new("data_directory_unavailable", "应用数据目录不可用"))?;
        webdav_settings::prepare_connection_test(&dir, &PlatformCredentialStore, request)
    })
    .await
    .map_err(|_| SettingsError::new("settings_task_failed", "无法准备 WebDAV 连接测试"))??;
    webdav_settings::test_connection(connection).await
}

#[tauri::command]
pub async fn webdav_list(connection: Connection) -> Result<Vec<String>, String> {
    Remote::connect(connection)?.list().await
}

#[tauri::command]
pub async fn webdav_upload(
    app: tauri::AppHandle,
    connection: Connection,
    passphrase: String,
    device: String,
) -> Result<String, String> {
    let _gate = job_gate()
        .try_lock()
        .map_err(|_| "WebDAV 备份任务正在进行")?;
    let remote = Remote::connect(connection)?;
    let passphrase = Zeroizing::new(passphrase);
    let plain = Zeroizing::new(
        crate::backup_sub_store::export(&app, &platform::data_dir()?, &device).await?,
    );
    let file =
        tauri::async_runtime::spawn_blocking(move || backup_cipher::encrypt(&plain, &passphrase))
            .await
            .map_err(|_| "无法准备备份")??;
    remote.upload(file).await
}

#[derive(Serialize)]
pub struct BackupPreview {
    #[serde(flatten)]
    details: portable_backup::Preview,
    digest: String,
}

#[tauri::command]
pub async fn webdav_preview(
    connection: Connection,
    name: String,
    passphrase: String,
) -> Result<BackupPreview, String> {
    let passphrase = Zeroizing::new(passphrase);
    let file = Remote::connect(connection)?.download(&name).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let digest = format!("{:x}", Sha256::digest(&file));
        let plain = backup_cipher::decrypt(file, &passphrase)?;
        Ok(BackupPreview {
            details: portable_backup::preview(&plain)?,
            digest,
        })
    })
    .await
    .map_err(|_| "无法预览备份")?
}

#[tauri::command]
pub async fn webdav_restore(
    app: tauri::AppHandle,
    connection: Connection,
    name: String,
    passphrase: String,
    digest: String,
    session: String,
) -> Result<(), String> {
    let _gate = job_gate().try_lock().map_err(|_| "WebDAV 任务正在进行")?;
    let passphrase = Zeroizing::new(passphrase);
    let file = Remote::connect(connection)?.download(&name).await?;
    let plain = tauri::async_runtime::spawn_blocking(move || {
        let plain = webdav_backup::verified_restore_plain(file, &passphrase, &digest)?;
        Ok::<_, String>(Zeroizing::new(plain))
    })
    .await
    .map_err(|_| "无法恢复备份")??;
    crate::backup_sub_store::restore(&app, &platform::data_dir()?, &plain, &session).await
}

struct RuntimeState {
    scope: String,
    scheduler: Scheduler,
    credential_pause: Option<String>,
}
static RUNTIME_STATE: Mutex<Option<RuntimeState>> = Mutex::new(None);
static JOB_GATE: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
fn job_gate() -> &'static tokio::sync::Mutex<()> {
    JOB_GATE.get_or_init(|| tokio::sync::Mutex::new(()))
}
struct RuntimeTaskGuard {
    scope: String,
    armed: bool,
    credential_read_pending: bool,
}
impl Drop for RuntimeTaskGuard {
    fn drop(&mut self) {
        if self.armed {
            if let Ok(mut state) = RUNTIME_STATE.lock() {
                if let Some(state) = state.as_mut().filter(|state| {
                    state.scope == self.scope && state.scheduler.status().phase == "running"
                }) {
                    let now = backup_scheduler::utc_now().unwrap_or(0);
                    state
                        .scheduler
                        .finish(now, Err("备份任务被中断；未报告成功".into()));
                    if self.credential_read_pending {
                        let message =
                            "凭据读取被中断；自动备份已暂停，请点击立即备份或重新保存凭据后重试"
                                .to_string();
                        state.credential_pause = Some(message.clone());
                        state.scheduler.disable(message);
                    }
                }
            }
        }
    }
}
static SCHEDULER_STOP: AtomicBool = AtomicBool::new(false);
static SCHEDULER_WAKE: OnceLock<tokio::sync::Notify> = OnceLock::new();
static SCHEDULER_TASK: Mutex<Option<tauri::async_runtime::JoinHandle<()>>> = Mutex::new(None);
fn wake_scheduler() {
    SCHEDULER_WAKE
        .get_or_init(tokio::sync::Notify::new)
        .notify_one();
}
fn unavailable_status(message: String) -> BackupStatus {
    let mut state = RUNTIME_STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let state = state.get_or_insert_with(|| RuntimeState {
        scope: String::new(),
        scheduler: Scheduler::new(webdav_settings::Schedule::Off, None, 0),
        credential_pause: None,
    });
    state.scheduler.disable(message);
    state.scheduler.status()
}
async fn refresh_status() -> Result<BackupStatus, String> {
    if let Some(status) = RUNTIME_STATE
        .lock()
        .map_err(|_| "备份状态锁不可用")?
        .as_ref()
        .map(|state| state.scheduler.status())
        .filter(|status| status.phase == "running")
    {
        return Ok(status);
    }
    let context = tauri::async_runtime::spawn_blocking(|| {
        let dir = platform::data_dir().map_err(|_| "应用数据目录不可用")?;
        load_status_context(&dir, &PlatformCredentialStore)
    })
    .await
    .map_err(|_| "无法读取 WebDAV 任务设置")?;
    let context = match context {
        Ok(value) => value,
        Err(_) => return Ok(unavailable_status("无法读取 WebDAV 设置或成功账本".into())),
    };
    let now = backup_scheduler::utc_now()?;
    let mut state = RUNTIME_STATE.lock().map_err(|_| "备份状态锁不可用")?;
    Ok(reconcile_status(&mut state, context, now))
}
type StatusContext = (SettingsSnapshot, String, Option<u64>);
fn load_status_context(
    dir: &Path,
    credentials: &impl CredentialStore,
) -> Result<StatusContext, String> {
    let snapshot =
        webdav_settings::get_settings_metadata(dir, credentials).map_err(|error| error.message)?;
    let scope = backup_history::scope(
        &snapshot.settings,
        snapshot.device_id.as_deref().unwrap_or(""),
    );
    let ledger = if snapshot.configured {
        backup_history::SuccessLedger::load(dir, &scope)?
    } else {
        backup_history::SuccessLedger::default()
    };
    Ok((snapshot, scope, ledger.last_success_at))
}
fn reconcile_status(
    state: &mut Option<RuntimeState>,
    context: StatusContext,
    now: u64,
) -> BackupStatus {
    let (snapshot, scope, last) = context;
    if state.as_ref().is_none_or(|state| state.scope != scope) {
        // 普通状态刷新或配置文件变化不能撤销用户拒绝凭据访问后的暂停。
        let credential_pause = state
            .as_ref()
            .and_then(|state| state.credential_pause.clone());
        *state = Some(RuntimeState {
            scope,
            scheduler: Scheduler::new(snapshot.settings.schedule.clone(), last, now),
            credential_pause,
        });
    }
    let state = state.as_mut().unwrap();
    state.scheduler.reconcile_success(last);
    state.scheduler.configure(snapshot.settings.schedule, now);
    let reason = if !snapshot.configured {
        Some("请先保存 WebDAV 设置")
    } else if snapshot.credential_store.status == crate::credential_store::Availability::Unsupported
    {
        Some("此平台不支持持久凭据，自动备份已关闭")
    } else if snapshot.credential_store.status != crate::credential_store::Availability::Available {
        Some("平台凭据库不可用，自动备份已暂停")
    } else if snapshot.has_password != Some(true) || snapshot.has_backup_passphrase != Some(true) {
        Some("备份任务需要保存服务器密码和独立备份口令")
    } else {
        None
    };
    if let Some(reason) = reason {
        state.scheduler.disable(reason.into());
    } else if let Some(reason) = &state.credential_pause {
        state.scheduler.disable(reason.clone());
    } else {
        state.scheduler.enable(now);
    }
    state.scheduler.status()
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupRunResult {
    pub status: BackupStatus,
    pub record: backup_history::BackupEntry,
    pub cleanup_error: Option<String>,
}
fn begin_saved_backup(
    state: &mut Option<RuntimeState>,
    now: u64,
    manual: bool,
) -> Result<Option<String>, String> {
    let state = state.as_mut().ok_or("WebDAV 设置不可用")?;
    let status = state.scheduler.status();
    if status.phase == "disabled" {
        return if manual {
            Err(status.error.unwrap_or_else(|| "WebDAV 任务不可用".into()))
        } else {
            Ok(None)
        };
    }
    Ok(state
        .scheduler
        .begin(now, manual)
        .then(|| state.scope.clone()))
}
fn finish_settings_error(state: &mut RuntimeState, now: u64, error: &SettingsError) {
    state.scheduler.finish(now, Err(error.message.clone()));
    if matches!(
        error.code,
        "credential_store_unavailable"
            | "credential_store_unsupported"
            | "saved_password_missing"
            | "backup_credentials_missing"
    ) {
        let message = format!(
            "{}；自动备份已暂停，请解锁凭据库并点击立即备份，或重新保存凭据后重试",
            error.message
        );
        state.credential_pause = Some(message.clone());
        state.scheduler.disable(message);
    }
}
fn retry_credentials(state: &mut Option<RuntimeState>) {
    if let Some(state) = state.as_mut() {
        state.credential_pause = None;
    }
}
async fn run_saved_backup(
    app: Option<&tauri::AppHandle>,
    manual: bool,
) -> Result<Option<BackupRunResult>, String> {
    let _gate = match job_gate().try_lock() {
        Ok(guard) => guard,
        Err(_) if !manual => return Ok(None),
        Err(_) => return Err("WebDAV 任务正在进行，请稍后重试".into()),
    };
    if manual {
        retry_credentials(&mut *RUNTIME_STATE.lock().map_err(|_| "备份状态锁不可用")?);
    }
    refresh_status().await?;
    let now = backup_scheduler::utc_now()?;
    let scope = {
        let mut state = RUNTIME_STATE.lock().map_err(|_| "备份状态锁不可用")?;
        let Some(scope) = begin_saved_backup(&mut state, now, manual)? else {
            return Ok(None);
        };
        scope
    };
    let mut lease = RuntimeTaskGuard {
        scope: scope.clone(),
        armed: true,
        credential_read_pending: true,
    };
    let prepared = tauri::async_runtime::spawn_blocking(|| {
        let dir = platform::data_dir()
            .map_err(|_| SettingsError::new("data_directory_unavailable", "应用数据目录不可用"))?;
        let saved = webdav_settings::prepare_saved_backup(&dir, &PlatformCredentialStore)?;
        Ok::<_, SettingsError>((dir, saved))
    })
    .await
    .map_err(|_| "无法准备 WebDAV 备份任务")?;
    let (dir, saved) = match prepared {
        Ok(saved) => saved,
        Err(error) => {
            let mut state = RUNTIME_STATE.lock().map_err(|_| "备份状态锁不可用")?;
            if let Some(state) = state.as_mut().filter(|state| state.scope == scope) {
                finish_settings_error(state, backup_scheduler::utc_now().unwrap_or(now), &error);
            }
            lease.armed = false;
            return Err(error.message);
        }
    };
    lease.credential_read_pending = false;
    let result = async {
        let plain = Zeroizing::new(match app {
            Some(app) => crate::backup_sub_store::export(app, &dir, &saved.connection.settings.device_name).await?,
            #[cfg(target_os = "android")]
            None => crate::backup_sub_store::export_background(&dir, &saved.connection.settings.device_name).await?,
            #[cfg(not(target_os = "android"))]
            None => return Err("备份应用上下文不可用".into()),
        });
        let prepared = tauri::async_runtime::spawn_blocking(move || {
            let version = serde_json::from_slice::<serde_json::Value>(&plain)
                .ok()
                .and_then(|value| value["version"].as_u64())
                .and_then(|value| u32::try_from(value).ok())
                .ok_or("跨设备备份版本无效")?;
            let bytes = backup_cipher::encrypt(&plain, &saved.passphrase)
                .map_err(|_| "无法加密备份，请检查独立备份口令和备份大小")?;
            let remote = Remote::connect(Connection {
                endpoint: saved
                    .connection
                    .settings
                    .directory_url()
                    .map_err(|error| error.message)?
                    .into(),
                username: saved.connection.settings.username.clone(),
                password: saved.connection.password.to_string(),
            })?;
            Ok::<_, String>((
                dir,
                saved.connection.settings,
                saved.connection.device_id,
                remote,
                bytes,
                version,
            ))
        })
        .await
        .map_err(|_| "无法准备 WebDAV 备份任务")??;
        let (dir, settings, id, remote, bytes, version) = prepared;
        webdav_backup::perform_backup_versioned(&remote, settings, id, dir, bytes, now, version)
            .await
    }
    .await;
    let mut state = RUNTIME_STATE.lock().map_err(|_| "备份状态锁不可用")?;
    let state = state
        .as_mut()
        .filter(|state| state.scope == scope)
        .ok_or("备份设置已变化")?;
    lease.armed = false;
    match result {
        Ok(completion) => {
            state.scheduler.finish(completion.completed_at, Ok(()));
            state
                .scheduler
                .cleanup_warning(completion.cleanup_error.clone());
            Ok(Some(BackupRunResult {
                status: state.scheduler.status(),
                record: completion.record,
                cleanup_error: completion.cleanup_error,
            }))
        }
        Err(error) => {
            state.scheduler.finish(
                backup_scheduler::utc_now().unwrap_or(now),
                Err(error.clone()),
            );
            Err(error)
        }
    }
}
/// 应用 setup 后调用一次；持有原生 worker，关闭窗口不停止。
#[cfg(target_os = "android")]
pub async fn run_android_background_backup() -> Result<(), String> {
    run_saved_backup(None, false).await.map(|_| ())
}

#[cfg(target_os = "android")]
pub fn android_credentials_paused() -> bool {
    RUNTIME_STATE.lock().map(|state| state.as_ref().is_some_and(|state| state.credential_pause.is_some())).unwrap_or(true)
}

pub fn start_scheduler(app: tauri::AppHandle) {
    let mut handle = SCHEDULER_TASK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if handle.is_some() {
        return;
    }
    SCHEDULER_STOP.store(false, Ordering::SeqCst);
    *handle = Some(tauri::async_runtime::spawn(async move {
        #[cfg(target_os = "android")]
        if let Ok(dir) = platform::data_dir() {
            if let Ok(snapshot) = webdav_settings::get_settings_metadata(&dir, &PlatformCredentialStore) {
                let _ = crate::android::cloud_tools::schedule(snapshot.configured && snapshot.settings.schedule != webdav_settings::Schedule::Off);
            }
        }
        while !SCHEDULER_STOP.load(Ordering::SeqCst) {
            let _ = run_saved_backup(Some(&app), false).await;
            tokio::select! { _=tokio::time::sleep(std::time::Duration::from_secs(30))=>{}, _=SCHEDULER_WAKE.get_or_init(tokio::sync::Notify::new).notified()=>{} }
        }
    }));
}
/// 真正退出应用时调用；强制中断不会报告未完成任务成功。
pub fn shutdown_scheduler() {
    SCHEDULER_STOP.store(true, Ordering::SeqCst);
    wake_scheduler();
    if let Some(task) = SCHEDULER_TASK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take()
    {
        task.abort();
    }
    if let Ok(mut state) = RUNTIME_STATE.lock() {
        if let Some(state) = state.as_mut() {
            if state.scheduler.status().phase == "running" {
                state.scheduler.finish(
                    backup_scheduler::utc_now().unwrap_or(0),
                    Err("备份任务因应用退出中断".into()),
                );
            }
            state.scheduler.disable("备份调度已停止".into());
        }
    }
}
#[tauri::command]
pub async fn webdav_backup_status() -> Result<BackupStatus, String> {
    refresh_status().await
}
#[tauri::command]
pub async fn webdav_backup_now(app: tauri::AppHandle) -> Result<BackupRunResult, String> {
    let result = run_saved_backup(Some(&app), true)
        .await?
        .ok_or_else(|| "备份任务未执行".to_string())?;
    #[cfg(target_os = "android")]
    crate::android::cloud_tools::schedule(result.status.next_due_at.is_some())?;
    Ok(result)
}
async fn saved_remote() -> Result<(PathBuf, webdav_settings::Settings, String, Remote), String> {
    tauri::async_runtime::spawn_blocking(|| {
        let dir = platform::data_dir().map_err(|_| "应用数据目录不可用")?;
        let connection = webdav_settings::prepare_saved_connection(&dir, &PlatformCredentialStore)
            .map_err(|error| error.message)?;
        let remote = Remote::connect(Connection {
            endpoint: connection
                .settings
                .directory_url()
                .map_err(|error| error.message)?
                .into(),
            username: connection.settings.username.clone(),
            password: connection.password.to_string(),
        })?;
        Ok((dir, connection.settings, connection.device_id, remote))
    })
    .await
    .map_err(|_| "无法读取保存的 WebDAV 连接")?
}
#[tauri::command]
pub async fn webdav_backup_history(
    offset: usize,
    limit: usize,
) -> Result<backup_history::HistoryPage, String> {
    if !(1..=100).contains(&limit) {
        return Err("每页备份数必须在 1 到 100 之间".into());
    }
    let (_, _, id, remote) = saved_remote().await?;
    backup_history::page(remote.history(&id).await?, offset, limit)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResult {
    pub name: String,
    pub deleted: bool,
}
#[tauri::command]
pub async fn webdav_backup_delete(name: String) -> Result<DeleteResult, String> {
    let _gate = job_gate().try_lock().map_err(|_| "WebDAV 任务正在进行")?;
    let (dir, settings, id, remote) = saved_remote().await?;
    let deleted = remote.delete(&name).await?;
    let scope = backup_history::scope(&settings, &id);
    let forget = name.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut ledger = backup_history::SuccessLedger::load(&dir, &scope)?;
        ledger.forget(&forget);
        ledger.save(&dir, &scope)
    })
    .await
    .map_err(|_| "远端删除已执行，但本机账本更新失败")??;
    Ok(DeleteResult { name, deleted })
}
fn validate_restore_passphrase(passphrase: &str) -> Result<(), String> {
    if passphrase.trim().is_empty() || passphrase.len() > 4096 {
        Err("备份口令不能为空或超过 4096 字节".into())
    } else {
        Ok(())
    }
}
#[tauri::command]
pub async fn webdav_saved_preview(
    name: String,
    passphrase: String,
) -> Result<BackupPreview, String> {
    let passphrase = Zeroizing::new(passphrase);
    validate_restore_passphrase(&passphrase)?;
    let (_, _, _, remote) = saved_remote().await?;
    let file = remote.download(&name).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let digest = format!("{:x}", Sha256::digest(&file));
        let plain = backup_cipher::decrypt(file, &passphrase)?;
        Ok(BackupPreview {
            details: portable_backup::preview(&plain)?,
            digest,
        })
    })
    .await
    .map_err(|_| "无法预览备份")?
}
#[tauri::command]
pub async fn webdav_saved_restore(
    app: tauri::AppHandle,
    name: String,
    passphrase: String,
    digest: String,
    session: String,
) -> Result<(), String> {
    let _gate = job_gate().try_lock().map_err(|_| "WebDAV 任务正在进行")?;
    let passphrase = Zeroizing::new(passphrase);
    validate_restore_passphrase(&passphrase)?;
    let (dir, _, _, remote) = saved_remote().await?;
    let file = remote.download(&name).await?;
    let plain = tauri::async_runtime::spawn_blocking(move || {
        let plain = webdav_backup::verified_restore_plain(file, &passphrase, &digest)?;
        Ok::<_, String>(Zeroizing::new(plain))
    })
    .await
    .map_err(|_| "无法恢复备份")??;
    crate::backup_sub_store::restore(&app, &dir, &plain, &session).await
}

#[cfg(test)]
mod scheduler_runtime_tests {
    use super::*;
    static RUNTIME_TEST_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    use crate::{
        credential_store::test_support::MemoryCredentials,
        webdav_settings::{CredentialChange, Schedule, Settings},
    };
    fn saved_fixture(schedule: Schedule) -> (tempfile::TempDir, MemoryCredentials) {
        let dir = tempfile::tempdir().unwrap();
        let credentials = MemoryCredentials::default();
        webdav_settings::save_settings(
            dir.path(),
            &credentials,
            SaveRequest {
                settings: Settings {
                    endpoint: "https://example.invalid/dav".into(),
                    username: "isolated".into(),
                    schedule,
                    ..Settings::default()
                },
                password: CredentialChange::Replace {
                    value: "fixture-password".into(),
                },
                backup_passphrase: CredentialChange::Replace {
                    value: "fixture-passphrase".into(),
                },
            },
        )
        .unwrap();
        credentials.read_calls.set(0);
        (dir, credentials)
    }
    #[test]
    fn status_and_off_polling_never_read_secrets() {
        let (dir, credentials) = saved_fixture(Schedule::Off);
        let mut state = None;
        for now in [100, 200, 300] {
            reconcile_status(
                &mut state,
                load_status_context(dir.path(), &credentials).unwrap(),
                now,
            );
            assert!(begin_saved_backup(&mut state, now, false)
                .unwrap()
                .is_none());
        }
        assert_eq!(credentials.read_calls.get(), 0);
    }
    #[test]
    fn not_due_polling_reads_zero_and_due_task_reads_both_secrets() {
        let (dir, credentials) = saved_fixture(Schedule::Daily);
        let (_, scope, _) = load_status_context(dir.path(), &credentials).unwrap();
        let mut ledger = backup_history::SuccessLedger::default();
        ledger.last_success_at = Some(100);
        ledger.save(dir.path(), &scope).unwrap();
        let mut state = None;
        for now in [200, 300, 400] {
            reconcile_status(
                &mut state,
                load_status_context(dir.path(), &credentials).unwrap(),
                now,
            );
            assert!(begin_saved_backup(&mut state, now, false)
                .unwrap()
                .is_none());
        }
        assert_eq!(credentials.read_calls.get(), 0);
        assert!(begin_saved_backup(&mut state, 86_400_100, false)
            .unwrap()
            .is_some());
        webdav_settings::prepare_saved_backup(dir.path(), &credentials).unwrap();
        assert_eq!(credentials.read_calls.get(), 2);
    }
    #[test]
    fn denied_credentials_pause_automatic_requests_until_explicit_retry() {
        let (dir, credentials) = saved_fixture(Schedule::Daily);
        let mut state = None;
        reconcile_status(
            &mut state,
            load_status_context(dir.path(), &credentials).unwrap(),
            100,
        );
        assert!(begin_saved_backup(&mut state, 100, false)
            .unwrap()
            .is_some());
        credentials
            .read_error
            .set(Some(crate::credential_store::Availability::Unavailable));
        let error = webdav_settings::prepare_saved_backup(dir.path(), &credentials)
            .err()
            .unwrap();
        finish_settings_error(state.as_mut().unwrap(), 100, &error);
        assert_eq!(state.as_ref().unwrap().scheduler.status().phase, "disabled");
        for now in [60_100, 120_100, 86_400_100] {
            reconcile_status(
                &mut state,
                load_status_context(dir.path(), &credentials).unwrap(),
                now,
            );
            assert!(begin_saved_backup(&mut state, now, false)
                .unwrap()
                .is_none());
        }
        assert_eq!(credentials.read_calls.get(), 1);
        credentials.read_error.set(None);
        retry_credentials(&mut state);
        reconcile_status(
            &mut state,
            load_status_context(dir.path(), &credentials).unwrap(),
            86_400_100,
        );
        assert!(begin_saved_backup(&mut state, 86_400_100, true)
            .unwrap()
            .is_some());
        webdav_settings::prepare_saved_backup(dir.path(), &credentials).unwrap();
        assert_eq!(credentials.read_calls.get(), 3);
    }
    #[test]
    fn unconfigured_status_and_metadata_never_probe_keychain() {
        let dir = tempfile::tempdir().unwrap();
        let credentials = MemoryCredentials::default();
        credentials
            .read_error
            .set(Some(crate::credential_store::Availability::Unavailable));
        let mut state = None;
        assert!(
            !webdav_settings::get_settings_metadata(dir.path(), &credentials)
                .unwrap()
                .configured
        );
        reconcile_status(
            &mut state,
            load_status_context(dir.path(), &credentials).unwrap(),
            100,
        );
        assert!(begin_saved_backup(&mut state, 100, false)
            .unwrap()
            .is_none());
        assert!(begin_saved_backup(&mut state, 100, true).is_err());
        assert_eq!(credentials.read_calls.get(), 0);
    }
    #[test]
    fn manual_backup_with_schedule_off_reads_both_secrets() {
        let (dir, credentials) = saved_fixture(Schedule::Off);
        let mut state = None;
        reconcile_status(
            &mut state,
            load_status_context(dir.path(), &credentials).unwrap(),
            100,
        );
        assert!(begin_saved_backup(&mut state, 100, true).unwrap().is_some());
        webdav_settings::prepare_saved_backup(dir.path(), &credentials).unwrap();
        assert_eq!(credentials.read_calls.get(), 2);
    }
    #[tokio::test]
    async fn cancelling_pending_credential_read_pauses_automatic_retry() {
        let _test_gate = RUNTIME_TEST_GATE.lock().await;
        let mut scheduler = Scheduler::new(Schedule::Daily, Some(100), 86_400_100);
        assert!(scheduler.begin(86_400_100, false));
        *RUNTIME_STATE.lock().unwrap() = Some(RuntimeState {
            scope: "cancel-credentials".into(),
            scheduler,
            credential_pause: None,
        });
        drop(RuntimeTaskGuard {
            scope: "cancel-credentials".into(),
            armed: true,
            credential_read_pending: true,
        });
        let mut state = RUNTIME_STATE.lock().unwrap();
        assert_eq!(state.as_ref().unwrap().scheduler.status().phase, "disabled");
        assert!(begin_saved_backup(&mut state, 172_800_100, false)
            .unwrap()
            .is_none());
        assert_eq!(
            state.as_ref().unwrap().scheduler.status().last_success_at,
            Some(100)
        );
    }
    #[test]
    fn missing_saved_credentials_pause_without_reading_again_on_status() {
        let (dir, credentials) = saved_fixture(Schedule::Daily);
        let mut state = None;
        reconcile_status(
            &mut state,
            load_status_context(dir.path(), &credentials).unwrap(),
            100,
        );
        assert!(begin_saved_backup(&mut state, 100, false)
            .unwrap()
            .is_some());
        credentials.values.borrow_mut().clear();
        let error = webdav_settings::prepare_saved_backup(dir.path(), &credentials)
            .err()
            .unwrap();
        finish_settings_error(state.as_mut().unwrap(), 100, &error);
        reconcile_status(
            &mut state,
            load_status_context(dir.path(), &credentials).unwrap(),
            86_400_100,
        );
        assert!(begin_saved_backup(&mut state, 86_400_100, false)
            .unwrap()
            .is_none());
        assert_eq!(credentials.read_calls.get(), 1);
        assert_eq!(state.as_ref().unwrap().scheduler.status().phase, "disabled");
    }
    #[tokio::test]
    async fn cancelling_inflight_task_clears_running_status_and_preserves_success() {
        let _test_gate = RUNTIME_TEST_GATE.lock().await;
        let mut scheduler = Scheduler::new(webdav_settings::Schedule::Daily, Some(123), 86_400_123);
        assert!(scheduler.begin(86_400_123, true));
        *RUNTIME_STATE.lock().unwrap() = Some(RuntimeState {
            scope: "cancel-test".into(),
            scheduler,
            credential_pause: None,
        });
        let (ready, wait) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let _lease = RuntimeTaskGuard {
                scope: "cancel-test".into(),
                armed: true,
                credential_read_pending: false,
            };
            let _ = ready.send(());
            tokio::time::sleep(std::time::Duration::from_secs(1000)).await;
        });
        wait.await.unwrap();
        task.abort();
        let _ = task.await;
        let state = RUNTIME_STATE.lock().unwrap();
        let status = state.as_ref().unwrap().scheduler.status();
        assert_eq!(status.phase, "error");
        assert_eq!(status.last_success_at, Some(123));
    }
    #[tokio::test]
    async fn manual_and_automatic_share_one_gate() {
        let guard = job_gate().try_lock().unwrap();
        assert!(job_gate().try_lock().is_err());
        drop(guard);
        assert!(job_gate().try_lock().is_ok());
    }
}
