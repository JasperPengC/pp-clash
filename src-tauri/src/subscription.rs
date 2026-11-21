use std::time::Duration;
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, Mutex};
use std::sync::atomic::{AtomicU64, Ordering};
use sha2::{Digest, Sha256};

struct ConfigCandidate {
    digest: Vec<u8>,
    validated: bool,
    /// Some 表示已经提交；内层 None 表示提交前不存在正式配置。
    committed: Option<Option<PathBuf>>,
}

static CANDIDATES: OnceLock<Mutex<HashMap<PathBuf, ConfigCandidate>>> = OnceLock::new();
fn candidates() -> &'static Mutex<HashMap<PathBuf, ConfigCandidate>> {
    CANDIDATES.get_or_init(|| Mutex::new(HashMap::new()))
}
static CANDIDATE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub(crate) fn config_digest(path: &Path) -> Result<Vec<u8>, String> {
    let content = std::fs::read(path).map_err(|e| format!("读取候选配置失败：{e}"))?;
    Ok(Sha256::digest(content).to_vec())
}

pub(crate) fn mark_config_validated(path: &Path, digest: &[u8]) -> Result<(), String> {
    if config_digest(path)? != digest { return Err("配置在校验期间被修改，请重新生成".to_string()); }
    let mut candidates = candidates().lock().map_err(|_| "配置事务锁不可用".to_string())?;
    if let Some(candidate) = candidates.get_mut(path) {
        if candidate.digest != digest { return Err("候选配置已改变，请重新生成".to_string()); }
        candidate.validated = true;
    }
    Ok(())
}

/// 候选文件唯一且不覆盖当前可启动配置。
#[tauri::command]
pub fn prepare_config(content: String, data_dir: String) -> Result<String, String> {
    #[cfg(target_os = "android")]
    let content = crate::android::kernel::mobile_config(&content)?;
    let dir = resolve_data_dir(&data_dir)?.canonicalize().map_err(|e| e.to_string())?;
    let sequence = CANDIDATE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
    let path = dir.join(format!(".config-candidate-{}-{stamp}-{sequence}.yaml", std::process::id()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    let mut file = options.open(&path).map_err(|e| format!("创建候选配置失败：{e}"))?;
    if let Err(error) = file.write_all(content.as_bytes()).and_then(|_| file.sync_all()) {
        let _ = std::fs::remove_file(&path);
        return Err(format!("写候选配置失败：{error}"));
    }
    candidates().lock().map_err(|_| "配置事务锁不可用".to_string())?.insert(path.clone(), ConfigCandidate {
        digest: Sha256::digest(content.as_bytes()).to_vec(), validated: false, committed: None,
    });
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn commit_config(candidate_path: String) -> Result<String, String> {
    let path = PathBuf::from(candidate_path);
    let mut candidates = candidates().lock().map_err(|_| "配置事务锁不可用".to_string())?;
    let candidate = candidates.get(&path).ok_or("未知候选配置")?;
    if candidate.committed.is_some() || !candidate.validated || config_digest(&path)? != candidate.digest {
        return Err("候选配置尚未通过校验或内容已改变".to_string());
    }
    let dir = path.parent().ok_or("候选配置目录无效")?;
    let target = dir.join("config.yaml");
    if target.exists() {
        // 备份失败则不修改正式文件；上一次可启动版本始终留在相同目录。
        let temporary_backup = path.with_extension("previous");
        std::fs::copy(&target, &temporary_backup).map_err(|e| format!("备份配置失败：{e}"))?;
        if let Err(error) = std::fs::rename(&temporary_backup, dir.join("config.previous.yaml")) {
            let _ = std::fs::remove_file(&temporary_backup);
            return Err(format!("保留上一份配置失败：{error}"));
        }
    }
    let rollback = if target.exists() {
        let rollback = path.with_extension("rollback");
        std::fs::copy(&target, &rollback).map_err(|e| format!("创建事务回滚副本失败：{e}"))?;
        Some(rollback)
    } else { None };
    if let Err(error) = std::fs::rename(&path, &target) {
        if let Some(previous) = rollback { let _ = std::fs::remove_file(previous); }
        return Err(format!("提交配置失败：{error}"));
    }
    candidates.get_mut(&path).unwrap().committed = Some(rollback);
    // 返回值直接用于 mihomo 的 /configs 重载；Windows verbatim 前缀会被
    // SAFE_PATHS 拒绝。事务键和回滚副本仍保留 canonical 路径。
    Ok(crate::platform::kernel_path(&target).to_string_lossy().into_owned())
}

/// 提交成功后必须收尾；前端确认过期时恢复本次提交前的版本。
#[tauri::command]
pub fn finish_config(candidate_path: String, rollback: bool) -> Result<(), String> {
    let path = PathBuf::from(candidate_path);
    let mut candidates = candidates().lock().map_err(|_| "配置事务锁不可用".to_string())?;
    let candidate = candidates.get(&path).ok_or("未知配置事务")?;
    let previous = candidate.committed.as_ref().ok_or("候选配置尚未提交")?;
    let target = path.parent().ok_or("候选配置目录无效")?.join("config.yaml");
    if rollback {
        // 不允许过期事务回滚后来通过其它调用方提交的内容。
        if config_digest(&target)? != candidate.digest { return Err("正式配置已被后续事务改变，拒绝回滚".to_string()); }
        match previous {
            Some(previous) => std::fs::rename(previous, &target).map_err(|e| format!("回滚配置失败：{e}"))?,
            None => std::fs::remove_file(&target).map_err(|e| format!("撤销首次配置失败：{e}"))?,
        }
    } else if let Some(previous) = previous {
        std::fs::remove_file(previous).map_err(|e| format!("清理事务副本失败：{e}"))?;
    }
    candidates.remove(&path);
    Ok(())
}

#[tauri::command]
pub fn discard_config(candidate_path: String) -> Result<(), String> {
    let path = PathBuf::from(candidate_path);
    let mut candidates = candidates().lock().map_err(|_| "配置事务锁不可用".to_string())?;
    if candidates.get(&path).is_some_and(|candidate| candidate.committed.is_some()) {
        return Err("已提交配置必须先结束事务".to_string());
    }
    if candidates.remove(&path).is_some() {
        match std::fs::remove_file(&path) {
            Ok(()) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(format!("删除候选配置失败：{error}")),
        }
    }
    Ok(())
}

/// 解析数据目录：相对名落到平台应用数据目录下，绝对路径原样使用。
pub fn resolve_data_dir(data_dir: &str) -> Result<std::path::PathBuf, String> {
    let dir = std::path::PathBuf::from(data_dir);
    let dir = if dir.is_absolute() {
        dir
    } else {
        crate::platform::base_data_dir()?.join(data_dir)
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建工作目录失败：{e}"))?;
    Ok(dir)
}

#[derive(Default)]
struct StatePersistence {
    generation: u64,
    sessions: HashMap<String, u64>,
}

// 同目录读/保存/备份/恢复共享边界；恢复成功后所有旧会话永久失去写权限。
type StatePersistenceRegistry = Mutex<HashMap<PathBuf, Arc<Mutex<StatePersistence>>>>;
static STATE_PERSISTENCE: OnceLock<StatePersistenceRegistry> = OnceLock::new();
fn state_persistence(dir: &Path) -> Result<Arc<Mutex<StatePersistence>>, String> {
    let key = dir.canonicalize().map_err(|e| format!("解析状态目录失败：{e}"))?;
    let mut states = STATE_PERSISTENCE.get_or_init(|| Mutex::new(HashMap::new()))
        .lock().map_err(|_| "状态目录锁不可用")?;
    Ok(Arc::clone(states.entry(key).or_default()))
}

/// 把应用状态（订阅、活动订阅、安全策略、设置）落盘到 state.json。
///
/// 用一份 JSON 而不是多文件，避免订阅与配置/设置之间出现不一致。
#[tauri::command]
pub fn save_app_state(content: String, data_dir: String, session: Option<String>) -> Result<(), String> {
    let dir = resolve_data_dir(&data_dir)?;
    let persistence = state_persistence(&dir)?;
    let state = persistence.lock().map_err(|_| "状态事务锁不可用")?;
    let allowed = match session {
        Some(session) => state.sessions.get(&session) == Some(&state.generation),
        None => state.generation == 0, // 兼容首次水合前的旧调用；恢复后必须取得新会话。
    };
    if !allowed { return Err("状态已经恢复，旧保存已忽略，请重新加载".into()); }
    crate::backup_state::replace(&dir.join("state.json"), content.as_bytes())
}

/// 读取 state.json。没有则返回 None（首次启动）。
#[tauri::command]
pub fn load_app_state(data_dir: String, session: Option<String>) -> Result<Option<String>, String> {
    let dir = resolve_data_dir(&data_dir)?;
    let persistence = state_persistence(&dir)?;
    let mut state = persistence.lock().map_err(|_| "状态事务锁不可用")?;
    if let Some(session) = session {
        let generation = state.generation;
        if *state.sessions.entry(session).or_insert(generation) != generation {
            return Err("旧状态会话已失效，请重新加载".into());
        }
    } // 无会话读取供托盘等只读调用方使用，绝不恢复写权限。
    let path = dir.join("state.json");
    if !path.is_file() {
        return Ok(None);
    }
    let s = std::fs::read_to_string(&path).map_err(|e| format!("读状态失败：{e}"))?;
    Ok(Some(s))
}

/// 本地订阅文件大小上限：10 MB。
const MAX_SUBSCRIPTION_FILE: u64 = 10 * 1024 * 1024;

/// 读取本地 Clash/mihomo 配置文件。
///
/// 只接受普通文件（不接受目录/FIFO），限制 10MB，避免误选大文件把进程拖死。
#[tauri::command]
pub fn read_subscription_file(path: String) -> Result<String, String> {
    let p = std::path::PathBuf::from(&path);
    let meta = std::fs::metadata(&p).map_err(|e| format!("读取文件失败：{e}"))?;
    if !meta.is_file() {
        return Err("只能导入普通文件".to_string());
    }
    if meta.len() > MAX_SUBSCRIPTION_FILE {
        return Err("订阅文件超过 10 MB".to_string());
    }
    let ext = p
        .extension()
        .and_then(|x| x.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(ext.as_str(), "yaml" | "yml" | "json") {
        return Err("仅支持 .yaml / .yml / .json 文件".to_string());
    }
    let text = std::fs::read_to_string(&p).map_err(|e| format!("读取文件失败：{e}"))?;
    if text.trim().is_empty() {
        return Err("文件是空的".to_string());
    }
    Ok(text)
}

/// 日志导出上限：20 MB。
const MAX_LOG_EXPORT: usize = 20 * 1024 * 1024;

/// 把当前过滤后的日志写到用户选择的路径。
#[tauri::command]
pub fn export_log_file(path: String, content: String) -> Result<(), String> {
    if content.len() > MAX_LOG_EXPORT {
        return Err("日志超过 20 MB，无法导出".to_string());
    }
    let p = std::path::PathBuf::from(&path);
    if p.exists() && p.is_dir() {
        return Err("导出路径不能是目录".to_string());
    }
    if let Some(parent) = p.parent() {
        if !parent.is_dir() {
            return Err("导出目录不存在".to_string());
        }
    }
    std::fs::write(&p, content).map_err(|e| format!("写日志失败：{e}"))
}

/// 拉取订阅的结果：原文 + 订阅响应头里的元信息。
///
/// 机场通常用响应头下发三样东西，客户端如果能读出来，体验会好很多：
/// - `profile-title` / `Content-Disposition`：订阅的真实名字（常常是机场名）
/// - `subscription-userinfo`：已用 / 总量 / 到期时间，用于剩余流量进度条
/// - `profile-update-interval`：建议的自动更新间隔
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionPayload {
    pub raw: String,
    pub profile_title: Option<String>,
    pub content_disposition: Option<String>,
    pub subscription_userinfo: Option<String>,
    pub profile_update_interval: Option<String>,
}

fn header_value(headers: &reqwest::header::HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// 拉取订阅原文。
///
/// 为什么不在前端 fetch：机场订阅一般不返回 CORS 头，WebView 里会被拦。
/// 而且部分机场按 UA 返回不同格式，这里统一用 clash.meta 的 UA。
#[tauri::command]
pub async fn fetch_subscription(
    url: String,
    proxy_port: Option<u16>,
) -> Result<SubscriptionPayload, String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("订阅地址必须是 http(s) 链接".to_string());
    }

    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("clash.meta");
    if let Some(port) = proxy_port {
        builder = builder.proxy(
            reqwest::Proxy::all(format!("http://127.0.0.1:{port}"))
                .map_err(|e| format!("内核代理配置失败：{e}"))?,
        );
    }
    let client = builder
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败：{e}"))?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("请求失败：{e}"))?;

    let status = resp.status();
    if !status.is_success() {
        return Err(format!("订阅返回 HTTP {status}"));
    }

    // 元信息必须在读 body 之前从 headers 里取（读完之后 headers 还在，但这里更直观）
    let profile_title = header_value(resp.headers(), "profile-title");
    let content_disposition = header_value(resp.headers(), "content-disposition");
    let subscription_userinfo = header_value(resp.headers(), "subscription-userinfo");
    let profile_update_interval = header_value(resp.headers(), "profile-update-interval");

    let text = resp.text().await.map_err(|e| format!("读取响应失败：{e}"))?;

    // 部分机场会返回一段 HTML（比如到期提示页），提前拦住，别让下游 YAML 解析炸掉
    if text.trim_start().starts_with('<') {
        return Err("订阅返回的是网页而不是配置，可能已过期或链接失效".to_string());
    }

    Ok(SubscriptionPayload {
        raw: text,
        profile_title,
        content_disposition,
        subscription_userinfo,
        profile_update_interval,
    })
}

/// 把配置写到磁盘，返回路径。
///
/// `data_dir` 允许传相对名（如 "PPClash"），会落到平台应用数据目录下；
/// 传绝对路径则原样使用。
#[tauri::command]
pub fn save_config(content: String, data_dir: String) -> Result<String, String> {
    let dir = resolve_data_dir(&data_dir)?;
    let path = dir.join("config.yaml");
    std::fs::write(&path, content).map_err(|e| format!("写配置失败：{e}"))?;
    Ok(path.to_string_lossy().to_string())
}

#[derive(serde::Serialize)]
pub struct BackupEntry {
    pub name: String,
    pub size: u64,
    pub mtime_ms: u64,
}

fn backups_dir(data_dir: &str) -> Result<std::path::PathBuf, String> {
    let dir = resolve_data_dir(data_dir)?;
    let backups = dir.join("backups");
    if std::fs::symlink_metadata(&backups).is_ok_and(|m| !m.file_type().is_dir()) {
        return Err("备份目录不能是符号链接或普通文件".into());
    }
    std::fs::create_dir_all(&backups).map_err(|e| format!("创建备份目录失败：{e}"))?;
    Ok(backups)
}

/// 备份 state.json 到数据目录 backups/，返回备份文件路径。
#[tauri::command]
pub fn backup_app_state(data_dir: String) -> Result<String, String> {
    let dir = resolve_data_dir(&data_dir)?;
    let persistence = state_persistence(&dir)?;
    let _state = persistence.lock().map_err(|_| "状态事务锁不可用")?;
    let src = dir.join("state.json");
    let bytes = crate::backup_state::read_regular(&src)?;
    let backup = crate::backup_state::encode(&bytes)?;
    let backups = backups_dir(&data_dir)?;
    crate::backup_state::snapshot(&backups, "state-", &backup)
}

pub(crate) fn portable_state_bytes(dir: &Path) -> Result<Vec<u8>, String> {
    let persistence = state_persistence(dir)?;
    let _state = persistence.lock().map_err(|_| "状态事务锁不可用")?;
    crate::backup_state::read_regular(&dir.join("state.json"))
}

pub(crate) fn restore_portable(dir: &Path, incoming: &[u8], session: &str) -> Result<(), String> {
    let persistence = state_persistence(dir)?;
    let mut state = persistence.lock().map_err(|_| "状态事务锁不可用")?;
    if state.sessions.get(session) != Some(&state.generation) { return Err("状态会话已变更，请重新打开备份".into()); }
    let target = dir.join("state.json");
    let previous = match std::fs::symlink_metadata(&target) {
        Ok(_) => Some(crate::backup_state::read_regular(&target)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("读取本机状态失败：{e}")),
    };
    let merged = crate::portable_backup::merge(previous.as_deref().unwrap_or(br#"{"profiles":[]}"#), incoming)?;
    if let Some(previous) = previous {
        let backups = backups_dir(dir.to_str().ok_or("无效状态目录")?)?;
        crate::backup_state::snapshot(&backups, "state-before-", &previous)?;
    }
    crate::backup_state::replace(&target, &merged)?;
    state.generation += 1;
    Ok(())
}

/// 列出已有备份（新的在前）。
#[tauri::command]
pub fn list_backups(data_dir: String) -> Result<Vec<BackupEntry>, String> {
    let backups = backups_dir(&data_dir)?;
    let mut out = Vec::new();
    let entries = std::fs::read_dir(&backups).map_err(|e| format!("读取备份目录失败：{e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let meta = match std::fs::symlink_metadata(&path) {
            Ok(m) if m.file_type().is_file() => m,
            Ok(_) => continue,
            Err(_) => continue,
        };
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        out.push(BackupEntry {
            name,
            size: meta.len(),
            mtime_ms,
        });
    }
    out.sort_by_key(|b| std::cmp::Reverse(b.mtime_ms));
    Ok(out)
}

/// 从备份恢复 state.json；前端需要重新加载页面（或重启应用）。
#[tauri::command]
pub fn restore_backup(data_dir: String, name: String) -> Result<(), String> {
    let dir = resolve_data_dir(&data_dir)?;
    let persistence = state_persistence(&dir)?;
    let mut state = persistence.lock().map_err(|_| "状态事务锁不可用")?;
    if name.is_empty() || name.starts_with('.') || name.contains(['/', '\\', ':']) || !name.ends_with(".json") || name.contains("..") {
        return Err("非法备份名".to_string());
    }
    let src = backups_dir(&data_dir)?.join(&name);
    let bytes = crate::backup_state::decode(&crate::backup_state::read_regular(&src)?)?;
    let target = dir.join("state.json");
    match std::fs::symlink_metadata(&target) {
        Ok(_) => {
            let previous = crate::backup_state::read_regular(&target)?;
            // 原始字节留存，即便旧文件损坏也不会在恢复过程中丢失。
            crate::backup_state::snapshot(&backups_dir(&data_dir)?, "state-before-", &previous)?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
        Err(e) => return Err(format!("读取原状态失败：{e}")),
    }
    crate::backup_state::replace(&target, &bytes)?;
    state.generation += 1;
    Ok(())
}

#[cfg(test)]
mod local_file_tests {
    use super::read_subscription_file;

    fn temp_path(ext: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "ppclash-read-test-{}-{}.{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            ext
        ));
        p
    }

    #[test]
    fn reads_yaml_file() {
        let p = temp_path("yaml");
        std::fs::write(&p, "proxies: []\n").unwrap();
        let out = read_subscription_file(p.to_string_lossy().to_string()).unwrap();
        assert!(out.contains("proxies"));
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn rejects_wrong_extension() {
        let p = temp_path("txt");
        std::fs::write(&p, "proxies: []\n").unwrap();
        let err = read_subscription_file(p.to_string_lossy().to_string()).unwrap_err();
        assert!(err.contains("仅支持"));
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn rejects_empty_file() {
        let p = temp_path("yml");
        std::fs::write(&p, "  \n").unwrap();
        let err = read_subscription_file(p.to_string_lossy().to_string()).unwrap_err();
        assert!(err.contains("空"));
        let _ = std::fs::remove_file(p);
    }
}

#[cfg(test)]
mod config_transaction_tests {
    use super::*;

    #[test]
    #[cfg(target_os = "windows")]
    fn committed_path_is_usable_by_mihomo_and_receipt_still_rolls_back() {
        let dir = tempfile::Builder::new().prefix("ppclash reload ").tempdir().unwrap();
        let target = dir.path().join("config.yaml");
        std::fs::write(&target, "old-valid").unwrap();
        let receipt = prepare_config("new-valid".into(), dir.path().to_string_lossy().into()).unwrap();
        assert!(receipt.starts_with(r"\\?\"), "事务凭据应保留 canonical 文件身份");
        let digest = config_digest(Path::new(&receipt)).unwrap();
        mark_config_validated(Path::new(&receipt), &digest).unwrap();
        let committed = commit_config(receipt.clone()).unwrap();
        assert!(!committed.starts_with(r"\\?\"), "传给 mihomo 的路径不能含 verbatim 前缀");
        assert_eq!(std::fs::canonicalize(&committed).unwrap(), std::fs::canonicalize(&target).unwrap(),
            "传给 mihomo 的路径必须指向已提交的配置，兼容 Windows 短路径别名");
        assert_eq!(std::fs::read_to_string(&committed).unwrap(), "new-valid");
        finish_config(receipt, true).unwrap();
        assert_eq!(std::fs::read_to_string(&committed).unwrap(), "old-valid");
    }

    #[test]
    fn validation_is_bound_to_candidate_bytes_and_previous_config_is_retained() {
        let dir = std::env::temp_dir().join(format!("ppclash-config-test-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&dir).unwrap();
        let data_dir = dir.to_string_lossy().to_string();
        let target = dir.join("config.yaml");
        std::fs::write(&target, "old-valid").unwrap();
        let candidate = prepare_config("new-valid".into(), data_dir.clone()).unwrap();
        assert!(commit_config(candidate.clone()).is_err());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "old-valid");
        let digest = config_digest(Path::new(&candidate)).unwrap();
        mark_config_validated(Path::new(&candidate), &digest).unwrap();
        std::fs::write(&candidate, "changed-after-validation").unwrap();
        assert!(commit_config(candidate.clone()).is_err());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "old-valid");
        discard_config(candidate).unwrap();

        let candidate = prepare_config("new-valid".into(), data_dir).unwrap();
        let digest = config_digest(Path::new(&candidate)).unwrap();
        mark_config_validated(Path::new(&candidate), &digest).unwrap();
        assert_eq!(commit_config(candidate.clone()).unwrap(), crate::platform::kernel_path(&target.canonicalize().unwrap()).to_string_lossy());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "new-valid");
        assert_eq!(std::fs::read_to_string(dir.join("config.previous.yaml")).unwrap(), "old-valid");
        assert!(!Path::new(&candidate).exists());
        finish_config(candidate, false).unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn validation_rejects_changes_during_check_and_discard_only_removes_owned_candidates() {
        let dir = std::env::temp_dir().join(format!("ppclash-config-discard-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let candidate = prepare_config("before".into(), dir.to_string_lossy().to_string()).unwrap();
        let digest = config_digest(Path::new(&candidate)).unwrap();
        std::fs::write(&candidate, "after").unwrap();
        assert!(mark_config_validated(Path::new(&candidate), &digest).is_err());
        assert!(commit_config(candidate.clone()).is_err());
        discard_config(candidate.clone()).unwrap();
        assert!(!Path::new(&candidate).exists());
        let unrelated = dir.join("keep.yaml");
        std::fs::write(&unrelated, "keep").unwrap();
        discard_config(unrelated.to_string_lossy().to_string()).unwrap();
        assert!(unrelated.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn expired_commit_restores_its_previous_file_and_rejects_rollback_over_a_newer_commit() {
        let dir = std::env::temp_dir().join(format!("ppclash-config-rollback-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let data_dir = dir.to_string_lossy().to_string();
        let make = |text: &str| {
            let path = prepare_config(text.into(), data_dir.clone()).unwrap();
            let digest = config_digest(Path::new(&path)).unwrap();
            mark_config_validated(Path::new(&path), &digest).unwrap();
            path
        };
        let first = make("first");
        commit_config(first.clone()).unwrap();
        finish_config(first, true).unwrap();
        assert!(!dir.join("config.yaml").exists());

        std::fs::write(dir.join("config.yaml"), "original").unwrap();
        let old = make("old");
        commit_config(old.clone()).unwrap();
        assert!(discard_config(old.clone()).is_err());
        finish_config(old, true).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("config.yaml")).unwrap(), "original");

        let old = make("old");
        commit_config(old.clone()).unwrap();
        let new = make("new");
        commit_config(new.clone()).unwrap();
        assert!(finish_config(old.clone(), true).is_err());
        assert_eq!(std::fs::read_to_string(dir.join("config.yaml")).unwrap(), "new");
        finish_config(old, false).unwrap();
        finish_config(new, false).unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_commit_retains_original_and_candidate_for_discard() {
        let dir = std::env::temp_dir().join(format!("ppclash-config-failure-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let candidate = prepare_config("new".into(), dir.to_string_lossy().to_string()).unwrap();
        std::fs::write(dir.join("config.yaml"), "old").unwrap();
        // 让备份原子替换失败，验证失败不会先截断正式配置。
        std::fs::create_dir(dir.join("config.previous.yaml")).unwrap();
        let digest = config_digest(Path::new(&candidate)).unwrap();
        mark_config_validated(Path::new(&candidate), &digest).unwrap();
        assert!(commit_config(candidate.clone()).is_err());
        assert_eq!(std::fs::read_to_string(dir.join("config.yaml")).unwrap(), "old");
        assert!(Path::new(&candidate).exists());
        discard_config(candidate).unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[cfg(test)]
mod log_export_tests {
    use super::export_log_file;

    #[test]
    fn writes_log_file() {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "ppclash-log-test-{}-{}.log",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        export_log_file(p.to_string_lossy().to_string(), "hello\n".to_string()).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "hello\n");
        let _ = std::fs::remove_file(p);
    }
}

#[cfg(test)]
mod backup_restore_tests {
    use super::*;
    use serde_json::json;

    const CURRENT: &[u8] = br#"{"profiles":[],"activeId":null,"settings":{"theme":"dark"}}"#;
    const LEGACY: &[u8] = br#"{"profiles":[{"id":"p1","name":"Legacy","url":"https://example.invalid/sub","raw":"proxies: []","updatedAt":0}],"activeId":"p1","settings":{"overrideText":"rules: []","overrideMode":"yaml","overrideEnabled":false,"customRules":["DOMAIN,example.invalid,DIRECT"]}}"#;

    fn fixture(bytes: &[u8]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("backups")).unwrap();
        std::fs::write(dir.path().join("state.json"), CURRENT).unwrap();
        std::fs::write(dir.path().join("backups/state-input.json"), bytes).unwrap();
        dir
    }

    fn restore(dir: &Path) -> Result<(), String> {
        restore_backup(dir.to_string_lossy().into(), "state-input.json".into())
    }

    #[test]
    fn invalid_backups_never_change_existing_state_or_create_snapshots() {
        for bytes in [b"{".as_slice(), b"[]", b"null", b"{}", b"{\"profiles\":{}}", b"{\"settings\":null}", b"{\"settings\":{\"controllerSecret\":2}}", b"{\"profiles\":[],\"activeId\":\"missing\"}", b"{\"settings\":{\"settingsVersion\":999}}"] {
            let dir = fixture(bytes);
            assert!(restore(dir.path()).is_err(), "accepted {}", String::from_utf8_lossy(bytes));
            assert_eq!(std::fs::read(dir.path().join("state.json")).unwrap(), CURRENT);
            assert_eq!(std::fs::read_dir(dir.path().join("backups")).unwrap().count(), 1);
        }
    }

    #[test]
    fn restore_blocks_ordinary_saves_even_after_readonly_load() {
        let dir = fixture(LEGACY);
        let data_dir = dir.path().to_string_lossy().to_string();
        restore(dir.path()).unwrap();
        assert_eq!(load_app_state(data_dir.clone(), None).unwrap().unwrap().as_bytes(), LEGACY);
        assert!(save_app_state(String::from_utf8(CURRENT.to_vec()).unwrap(), data_dir, None).is_err());
        assert_eq!(std::fs::read(dir.path().join("state.json")).unwrap(), LEGACY);
    }

    #[test]
    fn restore_retires_all_old_sessions_and_late_load_cannot_revoke_new_writer() {
        let dir = fixture(LEGACY);
        let data_dir = dir.path().to_string_lossy().to_string();
        for session in ["old-a", "old-b"] {
            load_app_state(data_dir.clone(), Some(session.into())).unwrap();
        }
        restore(dir.path()).unwrap();
        load_app_state(data_dir.clone(), Some("new".into())).unwrap();
        assert!(load_app_state(data_dir.clone(), Some("old-a".into())).is_err());
        for session in ["old-a", "old-b"] {
            assert!(save_app_state(String::from_utf8(CURRENT.to_vec()).unwrap(), data_dir.clone(), Some(session.into())).is_err());
        }
        // 之前尚未抵达后端的读只能加入本代集合，不能独占/撤销新水合的写权限。
        load_app_state(data_dir.clone(), Some("late-read".into())).unwrap();
        load_app_state(data_dir.clone(), None).unwrap();
        save_app_state(String::from_utf8(CURRENT.to_vec()).unwrap(), data_dir, Some("new".into())).unwrap();
        assert_eq!(std::fs::read(dir.path().join("state.json")).unwrap(), CURRENT);
    }

    #[test]
    fn delayed_old_save_is_rejected_after_restore_has_replaced_the_state() {
        let dir = fixture(LEGACY);
        let data_dir = dir.path().to_string_lossy().to_string();
        load_app_state(data_dir.clone(), Some("old".into())).unwrap();
        let (dispatch, pending) = std::sync::mpsc::channel();
        let save = std::thread::spawn(move || {
            pending.recv().unwrap();
            save_app_state(String::from_utf8(CURRENT.to_vec()).unwrap(), data_dir, Some("old".into()))
        });
        restore(dir.path()).unwrap();
        dispatch.send(()).unwrap();
        assert!(save.join().unwrap().is_err());
        assert_eq!(std::fs::read(dir.path().join("state.json")).unwrap(), LEGACY);
    }

    #[test]
    fn failed_restore_preserves_existing_session_write_permission() {
        let dir = fixture(b"{");
        let data_dir = dir.path().to_string_lossy().to_string();
        load_app_state(data_dir.clone(), Some("current".into())).unwrap();
        assert!(restore(dir.path()).is_err());
        save_app_state(String::from_utf8(LEGACY.to_vec()).unwrap(), data_dir, Some("current".into())).unwrap();
        assert_eq!(std::fs::read(dir.path().join("state.json")).unwrap(), LEGACY);
    }

    #[test]
    fn future_backup_format_is_rejected_without_changing_state() {
        let bytes = serde_json::to_vec(&json!({"format":"ppclash-state", "version":999, "state":{"profiles":[]}})).unwrap();
        let dir = fixture(&bytes);
        assert!(restore(dir.path()).is_err());
        assert_eq!(std::fs::read(dir.path().join("state.json")).unwrap(), CURRENT);
    }

    #[test]
    fn malformed_core_fields_and_profile_references_are_rejected() {
        for value in [
            json!({"profiles":[{"id":"a"}]}),
            json!({"profiles":[], "fixedNodes":{"missing":{"Proxy":"Node"}}}),
            json!({"profiles":[], "selectedNodes":{"missing":{"Proxy":"Node"}}}),
            json!({"profiles":[], "selectedNodes":[]}),
            json!({"profiles":[], "pinnedNodes":{"Proxy":[12]}}),
            json!({"settings":{"mixedPort":65536}}),
            json!({"settings":{"overrides":[{"id":"a","name":"a","mode":"yaml","enabled":true,"text":4}]}}),
            json!({"settings":{"customRules":[{"payload":4}]}}),
            json!({"policy":{"dnsLeakProtection":"yes"}}),
            json!({"profiles":[], "tunEnabled":1}),
            json!({"format":"another-app","version":1,"profiles":[]}),
            json!({"version":2,"profiles":[]}),
        ] {
            let dir = fixture(&serde_json::to_vec(&value).unwrap());
            assert!(restore(dir.path()).is_err(), "accepted {value}");
            assert_eq!(std::fs::read(dir.path().join("state.json")).unwrap(), CURRENT);
        }
    }

    #[test]
    fn oversized_input_is_rejected_without_reading_or_replacing_state() {
        let dir = fixture(LEGACY);
        std::fs::OpenOptions::new().write(true).open(dir.path().join("backups/state-input.json")).unwrap().set_len(64 * 1024 * 1024 + 1).unwrap();
        assert!(restore(dir.path()).is_err());
        assert_eq!(std::fs::read(dir.path().join("state.json")).unwrap(), CURRENT);
    }

    #[test]
    fn backup_names_reject_windows_streams_and_path_traversal() {
        let dir = fixture(LEGACY);
        for name in ["../state.json", "..\\state.json", "state:stream.json", "", ".hidden.json"] {
            // 在 Unix 上也构造 ADS 风格名称，验证跨平台的统一边界。
            if name == "state:stream.json" {
                let _ = std::fs::write(dir.path().join("backups").join(name), LEGACY);
            }
            assert!(restore_backup(dir.path().to_string_lossy().into(), name.into()).is_err());
        }
        assert_eq!(std::fs::read(dir.path().join("state.json")).unwrap(), CURRENT);
    }

    #[test]
    fn legacy_backup_restores_and_previous_bytes_are_restorable() {
        let dir = fixture(LEGACY);
        restore(dir.path()).unwrap();
        assert_eq!(std::fs::read(dir.path().join("state.json")).unwrap(), LEGACY);
        let entries = list_backups(dir.path().to_string_lossy().into()).unwrap();
        let previous = entries.iter().find(|entry| entry.name.starts_with("state-before-")).expect("missing pre-restore snapshot");
        restore_backup(dir.path().to_string_lossy().into(), previous.name.clone()).unwrap();
        assert_eq!(std::fs::read(dir.path().join("state.json")).unwrap(), CURRENT);
    }

    #[test]
    fn new_backups_are_versioned_and_restore_the_original_state() {
        let dir = fixture(LEGACY);
        let backup = backup_app_state(dir.path().to_string_lossy().into()).unwrap();
        let bytes = std::fs::read(&backup).unwrap();
        let document: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(document["format"], "ppclash-state");
        assert_eq!(document["version"], 1);
        assert_eq!(document["state"]["settings"]["theme"], "dark");
        std::fs::write(dir.path().join("state.json"), LEGACY).unwrap();
        restore_backup(dir.path().to_string_lossy().into(), Path::new(&backup).file_name().unwrap().to_str().unwrap().into()).unwrap();
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&std::fs::read(dir.path().join("state.json")).unwrap()).unwrap(), serde_json::from_slice::<serde_json::Value>(CURRENT).unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn backup_symlinks_are_rejected_and_not_listed() {
        use std::os::unix::fs::symlink;
        let dir = fixture(LEGACY);
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("external.json"), LEGACY).unwrap();
        std::fs::remove_file(dir.path().join("backups/state-input.json")).unwrap();
        symlink(outside.path().join("external.json"), dir.path().join("backups/state-input.json")).unwrap();
        assert!(restore(dir.path()).is_err());
        assert_eq!(std::fs::read(dir.path().join("state.json")).unwrap(), CURRENT);
        assert!(list_backups(dir.path().to_string_lossy().into()).unwrap().is_empty());
    }
}
