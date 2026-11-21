use crate::{
    backup_cipher, platform, portable_backup, subscription,
    webdav::{Connection, Remote},
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

#[tauri::command]
pub async fn webdav_list(connection: Connection) -> Result<Vec<String>, String> {
    Remote::connect(connection)?.list().await
}

#[tauri::command]
pub async fn webdav_upload(
    connection: Connection,
    passphrase: String,
    device: String,
) -> Result<String, String> {
    let remote = Remote::connect(connection)?;
    let passphrase = Zeroizing::new(passphrase);
    let file = tauri::async_runtime::spawn_blocking(move || {
        let bytes = subscription::portable_state_bytes(&platform::data_dir()?)?;
        let plain = portable_backup::export(&bytes, &device)?;
        backup_cipher::encrypt(&plain, &passphrase)
    })
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
    connection: Connection,
    name: String,
    passphrase: String,
    digest: String,
    session: String,
) -> Result<(), String> {
    let passphrase = Zeroizing::new(passphrase);
    let file = Remote::connect(connection)?.download(&name).await?;
    tauri::async_runtime::spawn_blocking(move || {
        if digest != format!("{:x}", Sha256::digest(&file)) {
            return Err("备份已变化，请重新预览".into());
        }
        let plain = backup_cipher::decrypt(file, &passphrase)?;
        subscription::restore_portable(&platform::data_dir()?, &plain, &session)
    })
    .await
    .map_err(|_| "无法恢复备份")?
}
