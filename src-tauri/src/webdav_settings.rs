use crate::credential_store::{Availability, CredentialStore};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    path::Path,
    sync::Mutex,
};
use zeroize::{Zeroize, Zeroizing};

const SETTINGS_FILE: &str = "webdav-settings.json";
static SETTINGS_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub endpoint: String,
    pub directory: String,
    pub username: String,
    pub device_name: String,
    pub schedule: Schedule,
    pub retention: u16,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Schedule {
    #[default]
    Off,
    Daily,
    Weekly,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            endpoint: String::new(),
            directory: "PP-Clash".into(),
            username: String::new(),
            device_name: "PP Clash".into(),
            schedule: Schedule::Off,
            retention: 10,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsError {
    pub code: &'static str,
    pub message: String,
}

#[derive(Deserialize)]
#[serde(tag = "intent", rename_all = "camelCase", deny_unknown_fields)]
pub enum CredentialChange {
    Keep,
    Replace { value: String },
    Clear,
}

impl Drop for CredentialChange {
    fn drop(&mut self) {
        if let Self::Replace { value } = self {
            value.zeroize();
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveRequest {
    pub settings: Settings,
    pub password: CredentialChange,
    pub backup_passphrase: CredentialChange,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TestRequest {
    pub settings: Settings,
    pub password: CredentialChange,
}

pub struct PreparedConnection {
    settings: Settings,
    password: Zeroizing<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestResult {
    pub directory_exists: bool,
    pub will_create_on_backup: bool,
}

pub fn prepare_connection_test(
    dir: &Path,
    credentials: &impl CredentialStore,
    request: TestRequest,
) -> Result<PreparedConnection, SettingsError> {
    let settings = request.settings.normalize()?;
    let password = match &request.password {
        CredentialChange::Replace { value } => {
            if value.trim().is_empty() || value.len() > 4096 {
                return Err(SettingsError::new(
                    "invalid_credential",
                    "凭据不能为空或超过 4096 字节；匿名连接请明确清除密码",
                ));
            }
            Zeroizing::new(value.clone())
        }
        CredentialChange::Clear => Zeroizing::new(String::new()),
        CredentialChange::Keep => {
            let _guard = SETTINGS_LOCK
                .lock()
                .map_err(|_| SettingsError::new("settings_busy", "WebDAV 设置锁不可用"))?;
            let stored = read_stored(dir)?;
            if let Some(stored) = stored.filter(|stored| stored.password_ref.is_some()) {
                if stored.settings.endpoint != settings.endpoint
                    || stored.settings.username != settings.username
                {
                    return Err(SettingsError::new(
                        "credential_identity_changed",
                        "服务器地址或用户名已改变，请重新输入或清除服务器密码",
                    ));
                }
                read_secret(credentials, stored.password_ref.as_deref())
                    .map_err(credential_error)?
                    .ok_or_else(|| {
                        SettingsError::new(
                            "saved_password_missing",
                            "已保存的服务器密码不存在，请重新输入或明确清除",
                        )
                    })?
            } else {
                Zeroizing::new(String::new())
            }
        }
    };
    Ok(PreparedConnection { settings, password })
}

fn network_error(error: reqwest::Error) -> SettingsError {
    if error.is_timeout() {
        SettingsError::new("connection_timeout", "WebDAV 连接测试超时")
    } else {
        SettingsError::new(
            "connection_failed",
            "无法连接 WebDAV，请检查网络、服务器地址与证书",
        )
    }
}

fn status_error(status: reqwest::StatusCode) -> SettingsError {
    let message = match status.as_u16() {
        401 | 403 => "请检查 WebDAV 账号、密码与目录权限",
        404 => "WebDAV 服务器基础目录不存在",
        301 | 302 | 303 | 307 | 308 => "WebDAV 地址发生重定向，请填写最终 HTTPS 地址",
        405 => "服务器不支持所需 WebDAV 方法",
        507 => "WebDAV 空间不足",
        _ => "WebDAV 服务器应答异常",
    };
    SettingsError::new(
        "webdav_status",
        format!("{message}（HTTP {}）", status.as_u16()),
    )
}

struct ProbeRemote {
    connection: PreparedConnection,
    client: reqwest::Client,
}

impl ProbeRemote {
    fn request(&self, method: reqwest::Method, url: Url) -> reqwest::RequestBuilder {
        let request = self.client.request(method, url);
        if self.connection.settings.username.is_empty() && self.connection.password.is_empty() {
            request
        } else {
            request.basic_auth(
                &self.connection.settings.username,
                Some(self.connection.password.as_str()),
            )
        }
    }

    async fn directory_exists(&self, url: Url) -> Result<bool, SettingsError> {
        let mut response = self.request(reqwest::Method::from_bytes(b"PROPFIND").expect("static method"), url.clone())
            .header("Depth", "0").header("Content-Type", "application/xml; charset=utf-8")
            .body(r#"<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>"#)
            .send().await.map_err(network_error)?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(false);
        }
        if response.status() != reqwest::StatusCode::MULTI_STATUS {
            return Err(status_error(response.status()));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(network_error)? {
            if bytes.len() + chunk.len() > 64 * 1024 {
                return Err(SettingsError::new(
                    "invalid_dav_response",
                    "WebDAV 目录应答过大",
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        directory_response(&url, &bytes)
    }

    async fn delete_probe(&self, url: Url) -> bool {
        match self.request(reqwest::Method::DELETE, url).send().await {
            Ok(response) => matches!(response.status().as_u16(), 200 | 204 | 404),
            Err(_) => false,
        }
    }
}

fn directory_response(url: &Url, bytes: &[u8]) -> Result<bool, SettingsError> {
    #[derive(Deserialize)]
    enum Listing {
        #[serde(rename = "multistatus")]
        MultiStatus {
            #[serde(default)]
            response: Vec<Entry>,
        },
    }
    #[derive(Deserialize)]
    struct Entry {
        href: String,
        status: Option<String>,
        #[serde(default)]
        propstat: Vec<PropStat>,
    }
    #[derive(Deserialize)]
    struct PropStat {
        status: String,
        prop: Properties,
    }
    #[derive(Deserialize)]
    struct Properties {
        resourcetype: Option<ResourceType>,
    }
    #[derive(Deserialize)]
    struct ResourceType {
        collection: Option<Collection>,
    }
    #[derive(Deserialize)]
    struct Collection {}
    let invalid = || SettingsError::new("invalid_dav_response", "WebDAV 没有返回可访问的目录信息");
    let Listing::MultiStatus { response } =
        quick_xml::de::from_reader(bytes).map_err(|_| invalid())?;
    for entry in response {
        let Ok(href) = url.join(&entry.href) else {
            continue;
        };
        if href.origin() != url.origin()
            || href.path().trim_end_matches('/') != url.path().trim_end_matches('/')
            || href.query().is_some()
            || href.fragment().is_some()
        {
            continue;
        }
        if let Some(status) = entry.status {
            match status.split_whitespace().nth(1) {
                Some("404") => return Ok(false),
                Some(code) if code.starts_with('2') => (),
                _ => return Err(invalid()),
            }
        }
        for prop in entry.propstat {
            if prop
                .status
                .split_whitespace()
                .nth(1)
                .is_some_and(|code| code.starts_with('2'))
                && prop
                    .prop
                    .resourcetype
                    .and_then(|kind| kind.collection)
                    .is_some()
            {
                return Ok(true);
            }
        }
        return Err(invalid());
    }
    Err(invalid())
}

pub async fn test_connection(
    connection: PreparedConnection,
) -> Result<ConnectionTestResult, SettingsError> {
    let base = Url::parse(&connection.settings.endpoint)
        .map_err(|_| SettingsError::new("invalid_endpoint", "WebDAV 地址无效"))?;
    let directory = connection.settings.directory_url()?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(8))
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(network_error)?;
    let remote = ProbeRemote { connection, client };
    if !remote.directory_exists(base.clone()).await? {
        return Err(SettingsError::new(
            "base_directory_missing",
            "WebDAV 服务器基础目录不存在",
        ));
    }
    let directory_exists = remote.directory_exists(directory).await?;
    let probe_name = format!(".ppclash-probe-{}", uuid::Uuid::new_v4().simple());
    let cleanup_error = || {
        SettingsError::new(
            "probe_cleanup_failed",
            format!("连接测试未能完整清理探测目录 {probe_name}，请检查删除权限后手动清理"),
        )
    };
    let probe = base
        .join(&format!("{probe_name}/"))
        .expect("safe generated path");
    let file = probe
        .join("connection-test.bin")
        .expect("safe generated filename");
    let created = remote
        .request(
            reqwest::Method::from_bytes(b"MKCOL").expect("static method"),
            probe.clone(),
        )
        .header("If-None-Match", "*")
        .send()
        .await;
    let created = match created {
        Ok(response) => response,
        Err(error) => {
            // 服务端可能已创建目录但应答丢失，仍尝试清理本次随机路径。
            if !remote.delete_probe(probe).await {
                return Err(cleanup_error());
            }
            return Err(network_error(error));
        }
    };
    if created.status() != reqwest::StatusCode::CREATED {
        return Err(status_error(created.status()));
    }
    let payload = format!("PP Clash WebDAV connection probe {}", uuid::Uuid::new_v4());
    let result = async {
        let response = remote
            .request(reqwest::Method::PUT, file.clone())
            .header("If-None-Match", "*")
            .header("Content-Type", "application/octet-stream")
            .body(payload.clone())
            .send()
            .await
            .map_err(network_error)?;
        if !matches!(response.status().as_u16(), 200 | 201 | 204) {
            return Err(status_error(response.status()));
        }
        let mut response = remote
            .request(reqwest::Method::GET, file.clone())
            .send()
            .await
            .map_err(network_error)?;
        if response.status() != reqwest::StatusCode::OK {
            return Err(status_error(response.status()));
        }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(network_error)? {
            if body.len() + chunk.len() > 1024 {
                return Err(SettingsError::new(
                    "probe_content_mismatch",
                    "WebDAV 探测文件读回内容不一致",
                ));
            }
            body.extend_from_slice(&chunk);
        }
        if body != payload.as_bytes() {
            return Err(SettingsError::new(
                "probe_content_mismatch",
                "WebDAV 探测文件读回内容不一致",
            ));
        }
        Ok(())
    }
    .await;
    let file_removed = remote.delete_probe(file).await;
    let directory_removed = remote.delete_probe(probe).await;
    if !file_removed || !directory_removed {
        return Err(cleanup_error());
    }
    result?;
    Ok(ConnectionTestResult {
        directory_exists,
        will_create_on_backup: !directory_exists,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialCapability {
    pub backend: &'static str,
    pub status: Availability,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSnapshot {
    pub settings: Settings,
    pub device_id: Option<String>,
    pub configured: bool,
    // null 表示凭据库不可读，不能把未知状态误显示成“未保存”。
    pub has_password: Option<bool>,
    pub has_backup_passphrase: Option<bool>,
    pub credential_store: CredentialCapability,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredSettings {
    version: u8,
    settings: Settings,
    device_id: String,
    password_ref: Option<String>,
    backup_passphrase_ref: Option<String>,
}

fn read_stored(dir: &Path) -> Result<Option<StoredSettings>, SettingsError> {
    let file = match std::fs::File::open(dir.join(SETTINGS_FILE)) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err(SettingsError::new(
                "settings_read_failed",
                "无法读取 WebDAV 设置",
            ))
        }
    };
    let mut bytes = Vec::new();
    file.take(32 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| SettingsError::new("settings_read_failed", "无法读取 WebDAV 设置"))?;
    let invalid = || {
        SettingsError::new(
            "invalid_saved_settings",
            "已保存的 WebDAV 设置无效，未覆盖原文件",
        )
    };
    if bytes.len() > 32 * 1024 {
        return Err(invalid());
    }
    let mut stored: StoredSettings = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if stored.version != 1
        || uuid::Uuid::parse_str(&stored.device_id).is_err()
        || [&stored.password_ref, &stored.backup_passphrase_ref]
            .into_iter()
            .flatten()
            .any(|reference| uuid::Uuid::parse_str(reference).is_err())
        || (stored.password_ref.is_some() && stored.password_ref == stored.backup_passphrase_ref)
    {
        return Err(invalid());
    }
    stored.settings = stored.settings.normalize().map_err(|_| invalid())?;
    Ok(Some(stored))
}

fn read_secret(
    credentials: &impl CredentialStore,
    reference: Option<&str>,
) -> Result<Option<Zeroizing<String>>, Availability> {
    match reference {
        Some(reference) => credentials.read(reference),
        None => {
            // 查询保留条目只探测可读性；不会创建、修改或删除任何凭据。
            credentials.read("capability-probe")?;
            Ok(None)
        }
    }
}

fn snapshot(
    stored: Option<StoredSettings>,
    credentials: &impl CredentialStore,
) -> SettingsSnapshot {
    let password = read_secret(
        credentials,
        stored
            .as_ref()
            .and_then(|value| value.password_ref.as_deref()),
    );
    let passphrase = read_secret(
        credentials,
        stored
            .as_ref()
            .and_then(|value| value.backup_passphrase_ref.as_deref()),
    );
    let status = password
        .as_ref()
        .err()
        .or(passphrase.as_ref().err())
        .copied()
        .unwrap_or(Availability::Available);
    SettingsSnapshot {
        configured: stored.is_some(),
        device_id: stored.as_ref().map(|value| value.device_id.clone()),
        settings: stored.map(|value| value.settings).unwrap_or_default(),
        has_password: password.ok().map(|value| value.is_some()),
        has_backup_passphrase: passphrase.ok().map(|value| value.is_some()),
        credential_store: CredentialCapability {
            backend: credentials.backend(),
            status,
        },
    }
}

fn credential_error(status: Availability) -> SettingsError {
    match status {
        Availability::Unsupported => SettingsError::new(
            "credential_store_unsupported",
            "此平台尚不支持持久凭据；密码和备份口令未保存",
        ),
        _ => SettingsError::new(
            "credential_store_unavailable",
            "平台凭据库不可用；请解锁或恢复凭据库后重试，未报告保存成功",
        ),
    }
}

pub struct SavedConnection {
    pub settings: Settings,
    pub device_id: String,
    pub password: Zeroizing<String>,
}
pub struct SavedBackup {
    pub connection: SavedConnection,
    pub passphrase: Zeroizing<String>,
}
fn saved_connection(
    stored: &StoredSettings,
    credentials: &impl CredentialStore,
) -> Result<SavedConnection, SettingsError> {
    let password =
        read_secret(credentials, stored.password_ref.as_deref()).map_err(credential_error)?;
    if stored.password_ref.is_some() && password.is_none() {
        return Err(SettingsError::new(
            "saved_password_missing",
            "已保存的服务器密码不存在，请重新保存凭据",
        ));
    }
    Ok(SavedConnection {
        settings: stored.settings.clone(),
        device_id: stored.device_id.clone(),
        password: password.unwrap_or_else(|| Zeroizing::new(String::new())),
    })
}
pub fn prepare_saved_connection(
    dir: &Path,
    credentials: &impl CredentialStore,
) -> Result<SavedConnection, SettingsError> {
    let _guard = SETTINGS_LOCK
        .lock()
        .map_err(|_| SettingsError::new("settings_busy", "WebDAV 设置锁不可用"))?;
    let stored = read_stored(dir)?
        .ok_or_else(|| SettingsError::new("webdav_not_configured", "请先保存 WebDAV 设置"))?;
    saved_connection(&stored, credentials)
}
pub fn prepare_saved_backup(
    dir: &Path,
    credentials: &impl CredentialStore,
) -> Result<SavedBackup, SettingsError> {
    let _guard = SETTINGS_LOCK
        .lock()
        .map_err(|_| SettingsError::new("settings_busy", "WebDAV 设置锁不可用"))?;
    let stored = read_stored(dir)?
        .ok_or_else(|| SettingsError::new("webdav_not_configured", "请先保存 WebDAV 设置"))?;
    let connection = saved_connection(&stored, credentials)?;
    let passphrase = read_secret(credentials, stored.backup_passphrase_ref.as_deref())
        .map_err(credential_error)?;
    if connection.password.is_empty() || passphrase.as_ref().is_none_or(|secret| secret.is_empty())
    {
        return Err(SettingsError::new(
            "backup_credentials_missing",
            "备份任务需要保存服务器密码和独立备份口令",
        ));
    }
    Ok(SavedBackup {
        connection,
        passphrase: passphrase.unwrap(),
    })
}

pub fn get_settings(
    dir: &Path,
    credentials: &impl CredentialStore,
) -> Result<SettingsSnapshot, SettingsError> {
    let _guard = SETTINGS_LOCK
        .lock()
        .map_err(|_| SettingsError::new("settings_busy", "WebDAV 设置锁不可用"))?;
    Ok(snapshot(read_stored(dir)?, credentials))
}

/// 状态/页面查询只读取本地引用；凭据可读性留给用户动作或到期任务验证。
pub fn get_settings_metadata(
    dir: &Path,
    credentials: &impl CredentialStore,
) -> Result<SettingsSnapshot, SettingsError> {
    let _guard = SETTINGS_LOCK
        .lock()
        .map_err(|_| SettingsError::new("settings_busy", "WebDAV 设置锁不可用"))?;
    let stored = read_stored(dir)?;
    let backend = credentials.backend();
    Ok(SettingsSnapshot {
        configured: stored.is_some(),
        device_id: stored.as_ref().map(|value| value.device_id.clone()),
        // 只说明曾保存的引用存在，不保证钥匙串当前可读取或条目仍存在。
        has_password: Some(
            stored
                .as_ref()
                .is_some_and(|value| value.password_ref.is_some()),
        ),
        has_backup_passphrase: Some(
            stored
                .as_ref()
                .is_some_and(|value| value.backup_passphrase_ref.is_some()),
        ),
        settings: stored.map(|value| value.settings).unwrap_or_default(),
        credential_store: CredentialCapability {
            backend,
            // 元数据查询只报告平台支持性，绝不为探测可用性读取秘密。
            status: if backend == "unsupported" {
                Availability::Unsupported
            } else {
                Availability::Available
            },
        },
    })
}

struct SecretMutation {
    reference: String,
    before: Option<Zeroizing<String>>,
    after: Option<Zeroizing<String>>,
}

fn prepare_secret(
    credentials: &impl CredentialStore,
    reference: Option<&str>,
    change: &CredentialChange,
) -> Result<(Option<String>, Vec<SecretMutation>, bool), SettingsError> {
    if let CredentialChange::Replace { value } = change {
        if value.trim().is_empty() || value.len() > 4096 {
            return Err(SettingsError::new(
                "invalid_credential",
                "凭据不能为空或超过 4096 字节；清除请使用明确的清除操作",
            ));
        }
    }
    let before = match read_secret(credentials, reference) {
        Ok(value) => value,
        Err(_) if reference.is_none() && !matches!(change, CredentialChange::Replace { .. }) => {
            return Ok((None, Vec::new(), false))
        }
        Err(error) => return Err(credential_error(error)),
    };
    let has_before = before.is_some();
    match change {
        CredentialChange::Keep => Ok((reference.map(str::to_owned), Vec::new(), has_before)),
        CredentialChange::Clear if reference.is_none() => Ok((None, Vec::new(), false)),
        CredentialChange::Clear => Ok((
            None,
            vec![SecretMutation {
                reference: reference.expect("checked reference").into(),
                before,
                after: None,
            }],
            false,
        )),
        CredentialChange::Replace { value } => {
            // 新旧连接的凭据引用不可复用；异常退出也不能把新密码发往旧服务器。
            let next_reference = uuid::Uuid::new_v4().to_string();
            let mut mutations = vec![SecretMutation {
                reference: next_reference.clone(),
                before: None,
                after: Some(Zeroizing::new(value.clone())),
            }];
            if let Some(reference) = reference {
                mutations.push(SecretMutation {
                    reference: reference.into(),
                    before,
                    after: None,
                });
            }
            Ok((Some(next_reference), mutations, true))
        }
    }
}

fn apply_secret(
    credentials: &impl CredentialStore,
    reference: &str,
    value: Option<&str>,
) -> Result<(), Availability> {
    match value {
        Some(value) => credentials.write(reference, value)?,
        None => credentials.delete(reference)?,
    }
    // 不能把失败/不持久的写操作当成功；核实当前平台存储的实际值。
    let read_back = credentials.read(reference)?;
    if read_back.as_ref().map(|value| value.as_str()) != value {
        return Err(Availability::Unavailable);
    }
    Ok(())
}

fn rollback(
    credentials: &impl CredentialStore,
    mutations: &[SecretMutation],
) -> Result<(), SettingsError> {
    let mut failed = false;
    for mutation in mutations.iter().rev() {
        failed |= apply_secret(
            credentials,
            &mutation.reference,
            mutation.before.as_ref().map(|value| value.as_str()),
        )
        .is_err();
    }
    if failed {
        Err(SettingsError::new(
            "credential_rollback_failed",
            "设置保存失败，部分凭据无法恢复；请重新检查并输入服务器密码与备份口令",
        ))
    } else {
        Ok(())
    }
}

pub fn save_settings(
    dir: &Path,
    credentials: &impl CredentialStore,
    request: SaveRequest,
) -> Result<SettingsSnapshot, SettingsError> {
    let _guard = SETTINGS_LOCK
        .lock()
        .map_err(|_| SettingsError::new("settings_busy", "WebDAV 设置锁不可用"))?;
    let settings = request.settings.normalize()?;
    let old = read_stored(dir)?;
    if matches!(request.password, CredentialChange::Keep)
        && old.as_ref().is_some_and(|old| {
            old.password_ref.is_some()
                && (old.settings.endpoint != settings.endpoint
                    || old.settings.username != settings.username)
        })
    {
        return Err(SettingsError::new(
            "credential_identity_changed",
            "服务器地址或用户名已改变，请重新输入或清除服务器密码",
        ));
    }
    let (password_ref, password, _) = prepare_secret(
        credentials,
        old.as_ref().and_then(|old| old.password_ref.as_deref()),
        &request.password,
    )?;
    let (backup_passphrase_ref, passphrase, has_passphrase) = prepare_secret(
        credentials,
        old.as_ref()
            .and_then(|old| old.backup_passphrase_ref.as_deref()),
        &request.backup_passphrase,
    )?;
    if settings.schedule != Schedule::Off && !has_passphrase {
        return Err(SettingsError::new(
            "backup_passphrase_required",
            "自动备份需要先保存独立的备份加密口令",
        ));
    }
    let stored = StoredSettings {
        version: 1,
        settings,
        device_id: old
            .map(|old| old.device_id)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        password_ref,
        backup_passphrase_ref,
    };
    let io_error = || {
        SettingsError::new(
            "settings_write_failed",
            "无法保存 WebDAV 设置，原设置未覆盖",
        )
    };
    std::fs::create_dir_all(dir).map_err(|_| io_error())?;
    let mut staging = tempfile::NamedTempFile::new_in(dir).map_err(|_| io_error())?;
    let bytes = serde_json::to_vec_pretty(&stored).map_err(|_| io_error())?;
    staging
        .write_all(&bytes)
        .and_then(|_| staging.as_file().sync_all())
        .map_err(|_| io_error())?;
    let mutations: Vec<_> = [password, passphrase].into_iter().flatten().collect();
    for (index, mutation) in mutations.iter().enumerate() {
        if let Err(error) = apply_secret(
            credentials,
            &mutation.reference,
            mutation.after.as_ref().map(|value| value.as_str()),
        ) {
            rollback(credentials, &mutations[..=index])?;
            return Err(credential_error(error));
        }
    }
    if staging.persist(dir.join(SETTINGS_FILE)).is_err() {
        rollback(credentials, &mutations)?;
        return Err(io_error());
    }
    Ok(snapshot(Some(stored), credentials))
}

impl SettingsError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl Settings {
    pub fn normalize(mut self) -> Result<Self, SettingsError> {
        if self.endpoint.len() > 4096
            || self.endpoint.chars().any(char::is_control)
            || self.endpoint.contains('\\')
        {
            return Err(SettingsError::new("invalid_endpoint", "WebDAV 地址无效"));
        }
        let raw = self.endpoint.trim();
        // URL 解析器会消除 ../，必须先检查原始路径。
        let (_, authority_and_path) = raw
            .split_once("://")
            .ok_or_else(|| SettingsError::new("invalid_endpoint", "WebDAV 地址无效"))?;
        let raw_path = authority_and_path
            .find('/')
            .map(|offset| &authority_and_path[offset + 1..])
            .unwrap_or("");
        let path = canonical_path(raw_path, true)?;
        let mut endpoint = Url::parse(raw)
            .map_err(|_| SettingsError::new("invalid_endpoint", "WebDAV 地址无效"))?;
        if endpoint.host().is_none()
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
        {
            return Err(SettingsError::new(
                "invalid_endpoint",
                "请输入服务器基础目录地址，账号与密码请单独填写",
            ));
        }
        let loopback = endpoint.host_str().is_some_and(|host| {
            host == "localhost"
                || host
                    .trim_matches(['[', ']'])
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
        });
        if endpoint.scheme() != "https" && !(endpoint.scheme() == "http" && loopback) {
            return Err(SettingsError::new(
                "https_required",
                "WebDAV 需要 HTTPS，本机回环地址可使用 HTTP",
            ));
        }
        endpoint.set_path(&format!(
            "/{path}{}",
            if path.is_empty() { "" } else { "/" }
        ));
        self.endpoint = endpoint.into();
        let directory = self.directory.trim();
        self.directory = if directory.is_empty() {
            "PP-Clash".into()
        } else {
            canonical_path(directory, false)?
        };
        self.username = self.username.trim().into();
        self.device_name = self.device_name.trim().into();
        if self.username.len() > 1024
            || self.username.chars().any(char::is_control)
            || self.username.contains(':')
        {
            return Err(SettingsError::new("invalid_username", "WebDAV 用户名无效"));
        }
        if self.device_name.is_empty()
            || self.device_name.len() > 256
            || self.device_name.chars().any(char::is_control)
        {
            return Err(SettingsError::new(
                "invalid_device_name",
                "设备名称不能为空、过长或包含控制字符",
            ));
        }
        if !(1..=100).contains(&self.retention) {
            return Err(SettingsError::new(
                "invalid_retention",
                "保留份数必须在 1 到 100 之间",
            ));
        }
        Ok(self)
    }

    pub fn directory_url(&self) -> Result<Url, SettingsError> {
        let canonical = self.clone().normalize()?;
        Url::parse(&format!("{}{}/", canonical.endpoint, canonical.directory))
            .map_err(|_| SettingsError::new("invalid_directory", "WebDAV 目录地址无效"))
    }
}

fn canonical_path(path: &str, allow_empty: bool) -> Result<String, SettingsError> {
    let invalid = || {
        SettingsError::new(
            "invalid_directory",
            "目录必须是相对路径，不能包含空段、路径跳转或重复百分号编码",
        )
    };
    if path.len() > 2048
        || path.starts_with('/')
        || path.contains('\\')
        || path.chars().any(char::is_control)
    {
        return Err(invalid());
    }
    let path = path.strip_suffix('/').unwrap_or(path);
    if path.is_empty() {
        return if allow_empty {
            Ok(String::new())
        } else {
            Err(invalid())
        };
    }
    let mut result = Vec::new();
    for segment in path.split('/') {
        let decoded = percent_encoding::percent_decode_str(segment)
            .decode_utf8()
            .map_err(|_| invalid())?;
        if decoded.is_empty()
            || decoded == "."
            || decoded == ".."
            || decoded.contains(['/', '\\'])
            || decoded.chars().any(char::is_control)
            || decoded.as_bytes().windows(3).any(|bytes| {
                bytes[0] == b'%' && bytes[1].is_ascii_hexdigit() && bytes[2].is_ascii_hexdigit()
            })
        {
            return Err(invalid());
        }
        let mut encoded = Url::parse("https://path.invalid/").expect("static URL");
        encoded
            .path_segments_mut()
            .expect("static hierarchical URL")
            .clear()
            .push(&decoded);
        result.push(encoded.path().trim_start_matches('/').to_owned());
    }
    Ok(result.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(endpoint: &str, directory: &str) -> Settings {
        Settings {
            endpoint: endpoint.into(),
            directory: directory.into(),
            ..Settings::default()
        }
    }

    #[test]
    fn canonical_paths_preserve_unicode_and_percent_encoding_once() {
        let value = settings("https://EXAMPLE.invalid/dav/a%20b", "云备份/My%20Mac/100%")
            .normalize()
            .unwrap();
        assert_eq!(value.endpoint, "https://example.invalid/dav/a%20b/");
        assert_eq!(
            value.directory,
            "%E4%BA%91%E5%A4%87%E4%BB%BD/My%20Mac/100%25"
        );
        assert_eq!(
            value.directory_url().unwrap().as_str(),
            "https://example.invalid/dav/a%20b/%E4%BA%91%E5%A4%87%E4%BB%BD/My%20Mac/100%25/"
        );
        assert_eq!(value.clone().normalize().unwrap(), value);
        assert_eq!(
            settings("https://example.invalid", "  ")
                .normalize()
                .unwrap()
                .directory,
            "PP-Clash"
        );
    }

    #[test]
    fn rejects_path_escape_before_url_parser_removes_dot_segments() {
        for directory in [
            "../secret",
            "a/../b",
            "a/%2e%2e/b",
            "%252e%252e",
            "a%2fb",
            "a%5Cb",
            "a\\b",
            "/absolute",
            "//host/path",
            "a\0b",
            "a//b",
        ] {
            assert!(
                settings("https://example.invalid/dav/", directory)
                    .normalize()
                    .is_err(),
                "{directory:?}"
            );
        }
        for endpoint in [
            "https://example.invalid/a/../b",
            "https://example.invalid/a/%2e%2e/b",
            "https://example.invalid/%252e%252e/",
            "https://example.invalid/a%2Fb",
            "https://example.invalid/a\\b",
        ] {
            assert!(
                settings(endpoint, "backup").normalize().is_err(),
                "{endpoint:?}"
            );
        }
    }

    #[test]
    fn requires_https_except_literal_loopback_and_rejects_embedded_secrets() {
        for endpoint in [
            "http://example.invalid",
            "ftp://example.invalid",
            "https://user:secret@example.invalid",
            "https://example.invalid?token=secret",
            "https://example.invalid/#x",
            "http://127.0.0.1.example.invalid",
        ] {
            assert!(
                settings(endpoint, "backup").normalize().is_err(),
                "{endpoint}"
            );
        }
        for endpoint in [
            "http://127.0.0.1:18080",
            "http://[::1]:18080",
            "http://localhost:18080",
            "https://example.invalid",
        ] {
            assert!(
                settings(endpoint, "backup").normalize().is_ok(),
                "{endpoint}"
            );
        }
    }

    #[test]
    fn validates_policy_and_limits_untrusted_input() {
        let mut value = settings("https://example.invalid", "backup");
        value.retention = 0;
        assert!(value.clone().normalize().is_err());
        value.retention = 101;
        assert!(value.clone().normalize().is_err());
        value.retention = 10;
        value.device_name = "a\nb".into();
        assert!(value.normalize().is_err());
    }

    use crate::credential_store::test_support::MemoryCredentials;

    fn save_request(
        password: CredentialChange,
        backup_passphrase: CredentialChange,
    ) -> SaveRequest {
        SaveRequest {
            settings: settings("https://example.invalid/dav", "backup"),
            password,
            backup_passphrase,
        }
    }

    fn replace(value: &str) -> CredentialChange {
        CredentialChange::Replace {
            value: value.into(),
        }
    }

    #[test]
    fn saved_tasks_read_both_secrets_and_reject_missing_automatic_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let credentials = MemoryCredentials::default();
        save_settings(
            dir.path(),
            &credentials,
            save_request(replace("服务器密码"), replace("独立口令")),
        )
        .unwrap();
        let task = prepare_saved_backup(dir.path(), &credentials).unwrap();
        assert_eq!(&*task.connection.password, "服务器密码");
        assert_eq!(&*task.passphrase, "独立口令");
        let device = task.connection.device_id;
        assert_eq!(
            prepare_saved_connection(dir.path(), &credentials)
                .unwrap()
                .device_id,
            device
        );
        save_settings(
            dir.path(),
            &credentials,
            save_request(CredentialChange::Clear, CredentialChange::Keep),
        )
        .unwrap();
        assert_eq!(
            &*prepare_saved_connection(dir.path(), &credentials)
                .unwrap()
                .password,
            ""
        );
        assert!(prepare_saved_backup(dir.path(), &credentials).is_err());
    }

    #[test]
    fn persists_config_without_secrets_and_reads_it_after_reopening() {
        let dir = tempfile::tempdir().unwrap();
        let credentials = MemoryCredentials::default();
        let saved = save_settings(
            dir.path(),
            &credentials,
            save_request(replace("server-secret"), replace("backup-secret")),
        )
        .unwrap();
        let loaded = get_settings(dir.path(), &credentials).unwrap();
        assert!(loaded.configured);
        assert_eq!(loaded.settings.endpoint, "https://example.invalid/dav/");
        assert_eq!(loaded.has_password, Some(true));
        assert_eq!(loaded.has_backup_passphrase, Some(true));
        assert_eq!(loaded.device_id, saved.device_id);
        assert!(uuid::Uuid::parse_str(loaded.device_id.as_deref().unwrap()).is_ok());
        let disk = std::fs::read_to_string(dir.path().join("webdav-settings.json")).unwrap();
        let public = serde_json::to_string(&loaded).unwrap();
        for secret in ["server-secret", "backup-secret"] {
            assert!(!disk.contains(secret));
            assert!(!public.contains(secret));
        }
        assert_eq!(credentials.values.borrow().len(), 2);
    }

    #[test]
    fn keep_replace_clear_are_separate_for_both_secrets() {
        let dir = tempfile::tempdir().unwrap();
        let credentials = MemoryCredentials::default();
        let first = save_settings(
            dir.path(),
            &credentials,
            save_request(replace("server-one"), replace("backup-one")),
        )
        .unwrap();
        let kept = save_settings(
            dir.path(),
            &credentials,
            save_request(CredentialChange::Keep, replace("backup-two")),
        )
        .unwrap();
        assert_eq!(kept.device_id, first.device_id);
        assert!(credentials
            .values
            .borrow()
            .values()
            .any(|v| v == "server-one"));
        assert!(!credentials
            .values
            .borrow()
            .values()
            .any(|v| v == "backup-one"));
        let cleared = save_settings(
            dir.path(),
            &credentials,
            save_request(CredentialChange::Clear, CredentialChange::Keep),
        )
        .unwrap();
        assert_eq!(cleared.has_password, Some(false));
        assert_eq!(cleared.has_backup_passphrase, Some(true));
        let all = save_settings(
            dir.path(),
            &credentials,
            save_request(CredentialChange::Keep, CredentialChange::Clear),
        )
        .unwrap();
        assert_eq!(all.has_backup_passphrase, Some(false));
        assert!(credentials.values.borrow().is_empty());
    }

    #[test]
    fn prevents_keep_from_sending_an_existing_password_to_a_new_identity() {
        let dir = tempfile::tempdir().unwrap();
        let credentials = MemoryCredentials::default();
        save_settings(
            dir.path(),
            &credentials,
            save_request(replace("server-secret"), CredentialChange::Keep),
        )
        .unwrap();
        let original = std::fs::read(dir.path().join("webdav-settings.json")).unwrap();
        for change_endpoint in [true, false] {
            let mut request = save_request(CredentialChange::Keep, CredentialChange::Keep);
            if change_endpoint {
                request.settings.endpoint = "https://other.invalid".into();
            } else {
                request.settings.username = "other-user".into();
            }
            assert_eq!(
                save_settings(dir.path(), &credentials, request)
                    .unwrap_err()
                    .code,
                "credential_identity_changed"
            );
            assert_eq!(
                std::fs::read(dir.path().join("webdav-settings.json")).unwrap(),
                original
            );
        }
    }

    #[test]
    fn credential_failures_leave_previous_config_and_secrets_intact() {
        let dir = tempfile::tempdir().unwrap();
        let credentials = MemoryCredentials::default();
        save_settings(
            dir.path(),
            &credentials,
            save_request(replace("server-old"), replace("backup-old")),
        )
        .unwrap();
        let original = std::fs::read(dir.path().join("webdav-settings.json")).unwrap();
        credentials.fail_write.set(true);
        assert!(save_settings(
            dir.path(),
            &credentials,
            save_request(replace("server-new"), CredentialChange::Keep)
        )
        .is_err());
        assert_eq!(
            std::fs::read(dir.path().join("webdav-settings.json")).unwrap(),
            original
        );
        assert!(credentials
            .values
            .borrow()
            .values()
            .any(|v| v == "server-old"));
        credentials.fail_delete.set(true);
        assert!(save_settings(
            dir.path(),
            &credentials,
            save_request(CredentialChange::Clear, CredentialChange::Keep)
        )
        .is_err());
        assert_eq!(
            std::fs::read(dir.path().join("webdav-settings.json")).unwrap(),
            original
        );
        assert!(credentials
            .values
            .borrow()
            .values()
            .any(|v| v == "server-old"));
    }

    #[test]
    fn reports_unsupported_and_unavailable_without_plaintext_fallback() {
        let dir = tempfile::tempdir().unwrap();
        let credentials = MemoryCredentials::default();
        for status in [Availability::Unsupported, Availability::Unavailable] {
            credentials.read_error.set(Some(status));
            let state = get_settings(dir.path(), &credentials).unwrap();
            assert_eq!(state.credential_store.status, status);
            assert_eq!(state.has_password, None);
            assert_eq!(state.has_backup_passphrase, None);
            assert!(save_settings(
                dir.path(),
                &credentials,
                save_request(replace("never-on-disk"), CredentialChange::Keep)
            )
            .is_err());
            assert!(!dir.path().join("webdav-settings.json").exists());
        }
    }

    #[test]
    fn refuses_automatic_backups_without_a_saved_encryption_passphrase() {
        let dir = tempfile::tempdir().unwrap();
        let credentials = MemoryCredentials::default();
        let mut request = save_request(CredentialChange::Keep, CredentialChange::Keep);
        request.settings.schedule = Schedule::Daily;
        assert_eq!(
            save_settings(dir.path(), &credentials, request)
                .unwrap_err()
                .code,
            "backup_passphrase_required"
        );
    }

    struct ProbeServer {
        endpoint: String,
        requests: std::sync::Arc<Mutex<Vec<(String, String)>>>,
        stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
        handle: Option<std::thread::JoinHandle<()>>,
    }

    impl ProbeServer {
        fn start(mode: &'static str) -> Self {
            use std::net::TcpListener;
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let endpoint = format!("http://{}/dav/", listener.local_addr().unwrap());
            listener.set_nonblocking(true).unwrap();
            let requests = std::sync::Arc::new(Mutex::new(Vec::new()));
            let captured = requests.clone();
            let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let stopping = stop.clone();
            let handle = std::thread::spawn(move || {
                let mut stored = Vec::new();
                while !stopping.load(std::sync::atomic::Ordering::Relaxed) {
                    let (mut stream, _) = match listener.accept() {
                        Ok(stream) => stream,
                        Err(_) => {
                            std::thread::sleep(std::time::Duration::from_millis(2));
                            continue;
                        }
                    };
                    // macOS 的 accept 可能继承监听器的非阻塞状态；请求读取需要阻塞等待。
                    stream.set_nonblocking(false).unwrap();
                    stream
                        .set_read_timeout(Some(std::time::Duration::from_secs(2)))
                        .unwrap();
                    let mut request = Vec::new();
                    let header_end;
                    loop {
                        let mut chunk = [0u8; 2048];
                        let n = stream.read(&mut chunk).unwrap();
                        if n == 0 {
                            return;
                        }
                        request.extend_from_slice(&chunk[..n]);
                        if let Some(index) =
                            request.windows(4).position(|bytes| bytes == b"\r\n\r\n")
                        {
                            header_end = index + 4;
                            break;
                        }
                    }
                    let headers = String::from_utf8_lossy(&request[..header_end]).into_owned();
                    let mut first = headers.lines().next().unwrap().split_whitespace();
                    let method = first.next().unwrap().to_owned();
                    let path = first.next().unwrap().to_owned();
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length: ")
                                .and_then(|value| value.parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    while request.len() < header_end + length {
                        let mut chunk = [0u8; 2048];
                        let n = stream.read(&mut chunk).unwrap();
                        request.extend_from_slice(&chunk[..n]);
                    }
                    captured
                        .lock()
                        .unwrap()
                        .push((method.clone(), path.clone()));
                    if mode == "mkcol_uncertain" && method == "MKCOL" {
                        continue;
                    }
                    let (status, body) = match method.as_str() {
                        "PROPFIND" if mode == "auth" => (401, Vec::new()),
                        "PROPFIND" if mode == "redirect" => (302, Vec::new()),
                        "PROPFIND" if path != "/dav/" && mode == "missing" => (404, Vec::new()),
                        "PROPFIND" => (207, format!("<d:multistatus xmlns:d=\"DAV:\"><d:response><d:href>{path}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>").into_bytes()),
                        "MKCOL" => (201, Vec::new()),
                        "PUT" => { assert!(headers.to_ascii_lowercase().contains("if-none-match: *")); stored = request[header_end..].to_vec(); (201, Vec::new()) },
                        "GET" if mode == "tamper" => (200, b"wrong contents".to_vec()),
                        "GET" => (200, stored.clone()),
                        "DELETE" if mode == "cleanup" => (403, Vec::new()),
                        "DELETE" => (204, Vec::new()),
                        _ => (500, Vec::new()),
                    };
                    let response = format!("HTTP/1.1 {status} fixture\r\nConnection: close\r\nContent-Length: {}\r\nLocation: http://elsewhere.invalid/\r\n\r\n", body.len());
                    stream.write_all(response.as_bytes()).unwrap();
                    stream.write_all(&body).unwrap();
                }
            });
            Self {
                endpoint,
                requests,
                stop,
                handle: Some(handle),
            }
        }
    }

    impl Drop for ProbeServer {
        fn drop(&mut self) {
            self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
            self.handle.take().unwrap().join().unwrap();
        }
    }

    #[tokio::test]
    async fn draft_probe_round_trip_cleans_up_and_does_not_save_credentials_or_settings() {
        for mode in ["missing", "exists"] {
            let server = ProbeServer::start(mode);
            let dir = tempfile::tempdir().unwrap();
            let credentials = MemoryCredentials::default();
            let request = TestRequest {
                settings: settings(&server.endpoint, "backup"),
                password: replace("draft-only-secret"),
            };
            let prepared = prepare_connection_test(dir.path(), &credentials, request).unwrap();
            let result = test_connection(prepared).await.unwrap();
            assert_eq!(result.directory_exists, mode == "exists");
            assert_eq!(result.will_create_on_backup, mode == "missing");
            assert!(!dir.path().join(SETTINGS_FILE).exists());
            assert!(credentials.values.borrow().is_empty());
            let requests = server.requests.lock().unwrap();
            assert_eq!(
                requests
                    .iter()
                    .filter(|(method, _)| method == "DELETE")
                    .count(),
                2
            );
            assert!(requests
                .iter()
                .filter(|(method, _)| method != "PROPFIND")
                .all(|(_, path)| path.starts_with("/dav/.ppclash-probe-")));
            assert!(requests.iter().any(|(method, _)| method == "PUT"));
            assert!(requests.iter().any(|(method, _)| method == "GET"));
        }
    }

    #[tokio::test]
    async fn failed_readback_still_cleans_probe_and_cleanup_failure_is_not_success() {
        for mode in ["tamper", "cleanup"] {
            let server = ProbeServer::start(mode);
            let dir = tempfile::tempdir().unwrap();
            let credentials = MemoryCredentials::default();
            let prepared = prepare_connection_test(
                dir.path(),
                &credentials,
                TestRequest {
                    settings: settings(&server.endpoint, "backup"),
                    password: CredentialChange::Clear,
                },
            )
            .unwrap();
            let error = test_connection(prepared).await.unwrap_err();
            assert_eq!(
                error.code,
                if mode == "tamper" {
                    "probe_content_mismatch"
                } else {
                    "probe_cleanup_failed"
                }
            );
            assert_eq!(
                server
                    .requests
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|(method, _)| method == "DELETE")
                    .count(),
                2
            );
        }
    }

    #[tokio::test]
    async fn authorization_and_redirect_failures_do_not_write_remote_data() {
        for mode in ["auth", "redirect"] {
            let server = ProbeServer::start(mode);
            let dir = tempfile::tempdir().unwrap();
            let credentials = MemoryCredentials::default();
            let prepared = prepare_connection_test(
                dir.path(),
                &credentials,
                TestRequest {
                    settings: settings(&server.endpoint, "backup"),
                    password: replace("secret"),
                },
            )
            .unwrap();
            let error = test_connection(prepared).await.unwrap_err();
            assert!(!error.message.contains("secret"));
            assert!(server
                .requests
                .lock()
                .unwrap()
                .iter()
                .all(|(method, _)| method == "PROPFIND"));
        }
    }

    #[tokio::test]
    async fn uncertain_probe_creation_attempts_directory_cleanup_before_returning_error() {
        let server = ProbeServer::start("mkcol_uncertain");
        let dir = tempfile::tempdir().unwrap();
        let credentials = MemoryCredentials::default();
        let prepared = prepare_connection_test(
            dir.path(),
            &credentials,
            TestRequest {
                settings: settings(&server.endpoint, "backup"),
                password: CredentialChange::Clear,
            },
        )
        .unwrap();
        assert!(test_connection(prepared).await.is_err());
        let requests = server.requests.lock().unwrap();
        assert_eq!(
            requests
                .iter()
                .filter(|(method, _)| method == "DELETE")
                .count(),
            1
        );
        assert!(!requests.iter().any(|(method, _)| method == "PUT"));
    }

    #[test]
    fn draft_keep_rejects_changed_identity_and_replace_can_test_without_supported_store() {
        let dir = tempfile::tempdir().unwrap();
        let credentials = MemoryCredentials::default();
        save_settings(
            dir.path(),
            &credentials,
            save_request(replace("saved"), CredentialChange::Keep),
        )
        .unwrap();
        let changed = TestRequest {
            settings: settings("https://other.invalid", "backup"),
            password: CredentialChange::Keep,
        };
        assert!(prepare_connection_test(dir.path(), &credentials, changed).is_err());
        credentials.read_error.set(Some(Availability::Unsupported));
        let draft = TestRequest {
            settings: settings("https://other.invalid", "backup"),
            password: replace("draft"),
        };
        assert!(prepare_connection_test(dir.path(), &credentials, draft).is_ok());
    }

    #[test]
    fn second_secret_failure_rolls_back_the_first_secret_and_dishonest_writes_fail() {
        let dir = tempfile::tempdir().unwrap();
        let credentials = MemoryCredentials::default();
        save_settings(
            dir.path(),
            &credentials,
            save_request(replace("server-old"), replace("backup-old")),
        )
        .unwrap();
        let original = std::fs::read(dir.path().join(SETTINGS_FILE)).unwrap();
        credentials
            .fail_write_on_call
            .set(credentials.write_calls.get() + 2);
        assert!(save_settings(
            dir.path(),
            &credentials,
            save_request(replace("server-new"), replace("backup-new"))
        )
        .is_err());
        assert_eq!(
            std::fs::read(dir.path().join(SETTINGS_FILE)).unwrap(),
            original
        );
        assert!(credentials
            .values
            .borrow()
            .values()
            .any(|value| value == "server-old"));
        assert!(credentials
            .values
            .borrow()
            .values()
            .any(|value| value == "backup-old"));
        assert_eq!(credentials.values.borrow().len(), 2);
        credentials.ignore_write.set(true);
        assert!(save_settings(
            dir.path(),
            &credentials,
            save_request(replace("not-persisted"), CredentialChange::Keep)
        )
        .is_err());
        assert_eq!(
            std::fs::read(dir.path().join(SETTINGS_FILE)).unwrap(),
            original
        );
    }

    #[test]
    fn replacing_credentials_does_not_rebind_an_existing_reference_to_another_identity() {
        let dir = tempfile::tempdir().unwrap();
        let credentials = MemoryCredentials::default();
        save_settings(
            dir.path(),
            &credentials,
            save_request(replace("server-old"), replace("backup-old")),
        )
        .unwrap();
        credentials.reject_overwrite.set(true);
        let mut request = save_request(replace("server-new"), replace("backup-new"));
        request.settings.endpoint = "https://new-server.invalid".into();
        let updated = save_settings(dir.path(), &credentials, request).unwrap();
        assert_eq!(updated.settings.endpoint, "https://new-server.invalid/");
        assert_eq!(updated.has_password, Some(true));
        assert_eq!(credentials.values.borrow().len(), 2);
        assert!(credentials
            .values
            .borrow()
            .values()
            .all(|value| value.ends_with("-new")));
    }

    #[test]
    fn corrupted_settings_and_invalid_credentials_do_not_overwrite_existing_data() {
        let dir = tempfile::tempdir().unwrap();
        let credentials = MemoryCredentials::default();
        std::fs::write(dir.path().join(SETTINGS_FILE), b"invalid json").unwrap();
        assert!(get_settings(dir.path(), &credentials).is_err());
        assert!(save_settings(
            dir.path(),
            &credentials,
            save_request(replace("draft"), CredentialChange::Keep)
        )
        .is_err());
        assert_eq!(
            std::fs::read(dir.path().join(SETTINGS_FILE)).unwrap(),
            b"invalid json"
        );
        assert!(credentials.values.borrow().is_empty());
        let empty = tempfile::tempdir().unwrap();
        for invalid in ["".to_owned(), " ".to_owned(), "a".repeat(4097)] {
            assert!(save_settings(
                empty.path(),
                &credentials,
                save_request(replace(&invalid), CredentialChange::Keep)
            )
            .is_err());
            assert!(!empty.path().join(SETTINGS_FILE).exists());
        }
    }

    #[test]
    fn unsupported_platform_can_save_nonsecret_settings_with_explicit_capability() {
        let dir = tempfile::tempdir().unwrap();
        let credentials = MemoryCredentials::default();
        credentials.read_error.set(Some(Availability::Unsupported));
        let result = save_settings(
            dir.path(),
            &credentials,
            save_request(CredentialChange::Keep, CredentialChange::Clear),
        )
        .unwrap();
        assert!(result.configured);
        assert_eq!(result.credential_store.status, Availability::Unsupported);
        assert_eq!(result.has_password, None);
        assert!(credentials.values.borrow().is_empty());
    }

    #[test]
    fn webdav_collection_response_rejects_wrong_resource_and_failed_propstat() {
        let url = Url::parse("https://example.invalid/dav/").unwrap();
        for xml in [
            r#"<multistatus><response><href>https://other.invalid/dav/</href><propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>"#,
            r#"<multistatus><response><href>/dav/</href><propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 403 Forbidden</status></propstat></response></multistatus>"#,
            r#"<multistatus><response><href>/dav/</href><propstat><prop><resourcetype/></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>"#,
        ] {
            assert!(directory_response(&url, xml.as_bytes()).is_err());
        }
    }
}
