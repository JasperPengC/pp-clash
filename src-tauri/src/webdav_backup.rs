use crate::{backup_history::BackupEntry, webdav::Remote, webdav_settings::Settings};
use std::path::PathBuf;
#[cfg(test)]
use std::path::Path;
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupCompletion {
    pub record: BackupEntry,
    pub completed_at: u64,
    pub cleanup_error: Option<String>,
}
#[cfg(test)]
pub(crate) fn prepare_backup_plain(dir: &Path, device: &str) -> Result<Vec<u8>, String> {
    let bytes = crate::subscription::portable_state_bytes(dir)?;
    crate::portable_backup::export(&bytes, device)
}
#[cfg(test)]
pub async fn perform_backup(
    remote: &Remote,
    settings: Settings,
    id: String,
    dir: PathBuf,
    bytes: Vec<u8>,
    created_at: u64,
) -> Result<BackupCompletion, String> {
    perform_backup_versioned(remote, settings, id, dir, bytes, created_at, 1).await
}
pub async fn perform_backup_versioned(
    remote: &Remote,
    settings: Settings,
    id: String,
    dir: PathBuf,
    bytes: Vec<u8>,
    created_at: u64,
    version: u32,
) -> Result<BackupCompletion, String> {
    use crate::backup_history::{self, SuccessLedger};
    let scope = backup_history::scope(&settings, &id);
    let ledger_dir = dir.clone();
    let ledger_scope = scope.clone();
    let mut ledger =
        tokio::task::spawn_blocking(move || SuccessLedger::load(&ledger_dir, &ledger_scope))
            .await
            .map_err(|_| "无法读取备份成功账本")??;
    let name = backup_history::new_backup_name_with_version(
        &id,
        &settings.device_name,
        created_at,
        version,
    )?;
    let size = bytes.len() as u64;
    tokio::time::timeout(std::time::Duration::from_secs(180), async {
        remote.ensure_directories(&settings).await?;
        remote.upload_named(&name, bytes).await
    })
    .await
    .map_err(|_| "WebDAV 备份任务超时；未报告上传成功")??;
    let completed_at = crate::backup_scheduler::utc_now()?;
    ledger.confirm(name.clone(), completed_at);
    let ledger_dir = dir.clone();
    let ledger_scope = scope.clone();
    let mut ledger = tokio::task::spawn_blocking(move || {
        ledger.save(&ledger_dir, &ledger_scope)?;
        Ok::<_, String>(ledger)
    })
    .await
    .map_err(|_| "无法记录备份成功时间")??;
    let cleanup = tokio::time::timeout(std::time::Duration::from_secs(30), async {
        let listing = remote.history(&id).await?;
        for name in ledger.cleanup_candidates(&listing, &id, settings.retention as usize) {
            remote.delete(&name).await?;
            ledger.forget(&name);
        }
        Ok::<_, String>(())
    })
    .await;
    let cleanup_error = match cleanup {
        Ok(Ok(())) => None,
        Ok(Err(_)) => Some("备份已成功；旧备份清理失败，请检查远端目录权限".into()),
        Err(_) => Some("备份已成功；旧备份清理超时".into()),
    };
    let ledger_scope = scope;
    let saved = tokio::task::spawn_blocking(move || ledger.save(&dir, &ledger_scope)).await;
    let cleanup_error = if !matches!(saved, Ok(Ok(()))) {
        Some("备份已成功；清理账本更新失败".into())
    } else {
        cleanup_error
    };
    let mut record = backup_history::parse_name(&name, &id).ok_or("备份记录无效")?;
    record.size = Some(size);
    Ok(BackupCompletion {
        record,
        completed_at,
        cleanup_error,
    })
}

pub(crate) fn verified_restore_plain(
    file: Vec<u8>,
    passphrase: &str,
    digest: &str,
) -> Result<Vec<u8>, String> {
    use sha2::Digest;
    if digest != format!("{:x}", sha2::Sha256::digest(&file)) {
        return Err("备份已变化，请重新预览".into());
    }
    crate::backup_cipher::decrypt(file, passphrase)
}
#[cfg(test)]
mod restore_tests {
    #[test]
    fn saved_restore_requires_preview_digest_and_correct_passphrase() {
        use sha2::Digest;
        let plain = br#"{"profiles":[]}"#;
        let file = crate::backup_cipher::encrypt(plain, "恢复口令").unwrap();
        let digest = format!("{:x}", sha2::Sha256::digest(&file));
        assert_eq!(
            super::verified_restore_plain(file.clone(), "恢复口令", &digest).unwrap(),
            plain
        );
        assert!(super::verified_restore_plain(file.clone(), "恢复口令", "changed").is_err());
        assert!(super::verified_restore_plain(file, "错误口令", &digest).is_err());
    }
}
