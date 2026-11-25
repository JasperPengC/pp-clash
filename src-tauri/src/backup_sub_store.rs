//! 完整云备份协调：服务操作串行，应用状态先预约，失败保留旧状态。
use std::{path::Path, fs, io::Write};
use crate::{portable_backup, subscription};
#[cfg(any(desktop, target_os = "android"))]
use serde::{Deserialize, Serialize};

use crate::complete_restore_state::JOURNAL;
#[cfg(any(desktop, target_os = "android"))]
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RestoreJournal {
    version: u32,
    committed: bool,
    previous_state: String,
    previous_exists: bool,
    previous_sub_store: serde_json::Value,
}
#[cfg(any(desktop, target_os = "android"))]
fn write_journal(dir: &Path, journal: &RestoreJournal) -> Result<(), String> {
    let bytes = serde_json::to_vec(journal).map_err(|e| e.to_string())?;
    if bytes.len() > 64 * 1024 * 1024 { return Err("完整恢复日志超过64MB，尚未覆盖数据".into()); }
    let mut file = tempfile::NamedTempFile::new_in(dir).map_err(|e| e.to_string())?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        file.as_file().set_permissions(fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    }
    file.write_all(&bytes).and_then(|_| file.as_file().sync_all()).map_err(|e| format!("同步完整恢复日志失败：{e}"))?;
    file.persist(dir.join(JOURNAL)).map_err(|e| format!("发布完整恢复日志失败：{e}"))?;
    sync_directory(dir)
}
fn sync_directory(dir: &Path) -> Result<(), String> {
    #[cfg(unix)]
    fs::File::open(dir).and_then(|file| file.sync_all()).map_err(|e| format!("同步恢复目录失败：{e}"))?;
    let _ = dir;
    Ok(())
}
fn clear_journal(dir: &Path) -> Result<(), String> {
    fs::remove_file(dir.join(JOURNAL)).map_err(|e| format!("清除完整恢复日志失败：{e}"))?;
    sync_directory(dir)
}
/// setup 和首次服务初始化调用；此前不允许创建服务进程或加载应用状态。
pub fn recover(dir: &Path) -> Result<(), String> {
    match fs::symlink_metadata(dir.join(JOURNAL)) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("无法读取完整恢复日志：{error}")),
        Ok(_) => {},
    }
    #[cfg(not(any(desktop, target_os = "android")))]
    return Err("此平台无法恢复中断的完整备份，请在桌面端恢复".into());
    #[cfg(any(desktop, target_os = "android"))] {
        let bytes = crate::backup_state::read_regular(&dir.join(JOURNAL))?;
        let journal: RestoreJournal = serde_json::from_slice(&bytes).map_err(|e| format!("完整恢复日志损坏：{e}"))?;
        if journal.version != 1 { return Err("完整恢复日志版本不受支持".into()); }
        crate::backup_state::validate(&serde_json::from_str(&journal.previous_state).map_err(|e| e.to_string())?)?;
        crate::sub_store_service::validate_snapshot(&journal.previous_sub_store)?;
        if !journal.committed {
            crate::sub_store_service::recover_snapshot_on_disk(&dir.join("sub-store"), &journal.previous_sub_store)?;
            if journal.previous_exists {
                crate::backup_state::replace(&dir.join("state.json"), journal.previous_state.as_bytes())?;
            } else if dir.join("state.json").exists() {
                fs::remove_file(dir.join("state.json")).map_err(|e| format!("回滚中断的状态恢复失败：{e}"))?;
            }
        }
        if journal.committed {
            if let Err(error) = clear_journal(dir) {
                eprintln!("完整恢复已提交，恢复日志稍后清理：{error}");
            }
            Ok(())
        } else {
            clear_journal(dir)
        }
    }
}

pub async fn export(app: &tauri::AppHandle, dir: &Path, device: &str) -> Result<Vec<u8>, String> {
    if crate::complete_restore_state::pending(dir)? { return Err("完整恢复尚未结束，请重启应用完成恢复后再备份".into()); }
    #[cfg(any(desktop, target_os = "android"))]
    if dir.join("sub-store").exists() {
        let service = crate::sub_store_commands::service(app)?;
        let transaction = service.transaction().await;
        let snapshot = transaction.snapshot().await?;
        let bytes = subscription::portable_state_bytes(dir)?;
        return portable_backup::export_with_sub_store(&bytes, device, snapshot);
    }
    let _ = app;
    portable_backup::export(&subscription::portable_state_bytes(dir)?, device)
}

#[cfg(target_os = "android")]
pub async fn export_background(dir: &Path, device: &str) -> Result<Vec<u8>, String> {
    if crate::complete_restore_state::pending(dir)? { return Err("完整恢复尚未结束，请重启应用完成恢复后再备份".into()); }
    if dir.join("sub-store").exists() {
        let service = crate::sub_store_commands::background_service()?;
        let transaction = service.transaction().await;
        let snapshot = transaction.snapshot().await?;
        let bytes = subscription::portable_state_bytes(dir)?;
        return portable_backup::export_with_sub_store(&bytes, device, snapshot);
    }
    portable_backup::export(&subscription::portable_state_bytes(dir)?, device)
}

pub async fn restore(app: &tauri::AppHandle, dir: &Path, incoming: &[u8], session: &str) -> Result<(), String> {
    let snapshot = portable_backup::sub_store_snapshot(incoming)?;
    if let Some(snapshot) = snapshot {
        #[cfg(not(any(desktop, target_os = "android")))]
        { let _ = (app, dir, session, snapshot); return Err("此平台尚不支持恢复完整 Sub-Store 数据，请在桌面端恢复".into()); }
        #[cfg(any(desktop, target_os = "android"))]
        {
            crate::sub_store_service::validate_snapshot(&snapshot)?;
            // 应用预约先取得，随后服务锁；等待服务时也禁止旧会话写回。
            let mut state = subscription::begin_portable_restore(dir, incoming, session)?;
            let service = crate::sub_store_commands::service(app)?;
            let transaction = service.transaction().await;
            let previous = transaction.snapshot().await?;
            // 两部分均生成可读本机快照后才覆盖；任一快照创建失败直接退出。
            let full_previous = portable_backup::export_with_sub_store(state.previous(), "恢复前本机快照", previous.clone())?;
            // 完整快照另存目录，避免旧版“仅状态”备份列表提供无法完整恢复的条目。
            let backups = dir.join("complete-backups");
            std::fs::create_dir_all(&backups).map_err(|e| format!("无法创建完整恢复快照目录：{e}"))?;
            crate::backup_state::snapshot(&backups, "portable-before-", &full_previous)?;
            let mut journal = RestoreJournal { version: 1, committed: false,
                previous_state: String::from_utf8(state.previous().to_vec()).map_err(|e| e.to_string())?,
                previous_exists: state.previous_exists(), previous_sub_store: previous.clone() };
            write_journal(dir, &journal)?;
            let result = async {
                transaction.restore_snapshot(&snapshot).await?;
                state.publish()?;
                journal.committed = true;
                write_journal(dir, &journal)
            }.await;
            if let Err(error) = result {
                // 提交标记写入错误的结果可能已落盘。先恢复pending，才能开始回滚。
                journal.committed = false;
                write_journal(dir, &journal)?;
                let service_rollback = transaction.restore_snapshot(&previous).await;
                let state_rollback = state.rollback();
                if service_rollback.is_err() || state_rollback.is_err() {
                    return Err(format!("完整恢复失败：{error}；回滚尚未结束：服务 {:?}，状态 {:?}。请重启应用继续恢复；恢复日志和本机快照已保留。", service_rollback.err(), state_rollback.err()));
                }
                // 即使提交标记同步失败，回滚成功也将日志重置为pending后清理。
                journal.committed = false;
                write_journal(dir, &journal)?;
                clear_journal(dir)?;
                state.finish()?;
                return Err(format!("完整恢复未发布，已回滚原数据：{error}"));
            }
            // committed已持久化，两部分已经完成；清理失败不能改变恢复结果。
            if let Err(error) = clear_journal(dir) {
                eprintln!("完整恢复已提交，恢复日志将在下次启动清理：{error}");
            }
            state.finish()?;
            return Ok(());
        }
    }
    let _ = app;
    subscription::restore_portable(dir, incoming, session)
}
