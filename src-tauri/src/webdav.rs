use crate::backup_cipher::MAX_FILE;
use reqwest::{Client, Method, RequestBuilder, Response, StatusCode, Url};
use serde::Deserialize;
use std::{
    collections::BTreeSet,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

const MAX_LIST: usize = 2 * 1024 * 1024;
const PROPERTIES: &str = r#"<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>"#;

#[derive(Deserialize)]
pub struct Connection {
    pub endpoint: String,
    pub username: String,
    pub password: String,
}

pub struct Remote {
    client: Client,
    directory: Url,
    connection: Connection,
}

fn backup_name(name: &str) -> bool {
    let Some(stem) = name
        .strip_prefix("ppclash-")
        .and_then(|s| s.strip_suffix(".ppbackup"))
    else {
        return false;
    };
    let Some((time, id)) = stem.split_once('-') else {
        return false;
    };
    time.len() == 13
        && time.bytes().all(|c| c.is_ascii_digit())
        && id.len() == 32
        && id.bytes().all(|c| c.is_ascii_hexdigit())
}

fn new_name() -> Result<String, String> {
    let time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "系统时间异常")?
        .as_millis();
    Ok(format!(
        "ppclash-{time:013}-{}.ppbackup",
        Uuid::new_v4().simple()
    ))
}

fn network_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "WebDAV 请求超时"
    } else {
        "无法连接 WebDAV 或读取应答，请检查网络、地址和服务器证书"
    }
    .into()
}

async fn bounded(mut response: Response, limit: usize) -> Result<Vec<u8>, String> {
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err("WebDAV 应答过大".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        if chunk.len() > limit - bytes.len() {
            return Err("WebDAV 应答过大".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn send(request: RequestBuilder, expected: &[StatusCode]) -> Result<Response, String> {
    let response = request.send().await.map_err(network_error)?;
    let status = response.status();
    if expected.contains(&status) {
        return Ok(response);
    }
    let message = match status.as_u16() {
        401 | 403 => "请检查 WebDAV 账号、密码与目录权限",
        404 => "WebDAV 目录或备份不存在",
        412 => "远端已有同名备份",
        507 => "WebDAV 空间不足",
        _ => "WebDAV 服务返回异常",
    };
    Err(format!("{message}（HTTP {}）", status.as_u16()))
}

impl Remote {
    pub fn connect(connection: Connection) -> Result<Self, String> {
        let mut directory =
            Url::parse(connection.endpoint.trim()).map_err(|_| "WebDAV 地址无效")?;
        if directory.host().is_none()
            || directory.query().is_some()
            || directory.fragment().is_some()
            || !directory.username().is_empty()
            || directory.password().is_some()
        {
            return Err("请输入目录地址，账号和密码请单独填写".into());
        }
        let loopback = matches!(
            directory.host_str(),
            Some("127.0.0.1" | "[::1]" | "localhost")
        );
        if directory.scheme() != "https" && !(loopback && directory.scheme() == "http") {
            return Err("WebDAV 需要 HTTPS，本机回环地址可使用 HTTP".into());
        }
        if !directory.path().ends_with('/') {
            directory
                .path_segments_mut()
                .map_err(|_| "WebDAV 目录地址无效")?
                .push("");
        }
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(90))
            .build()
            .map_err(network_error)?;
        Ok(Self {
            client,
            directory,
            connection,
        })
    }

    fn request(&self, method: Method, url: Url) -> RequestBuilder {
        let request = self.client.request(method, url);
        if self.connection.username.is_empty() && self.connection.password.is_empty() {
            request
        } else {
            request.basic_auth(&self.connection.username, Some(&self.connection.password))
        }
    }

    fn file(&self, name: &str) -> Result<Url, String> {
        if !backup_name(name) {
            return Err("备份文件名无效".into());
        }
        self.directory.join(name).map_err(|_| "备份地址无效".into())
    }

    pub async fn upload(&self, bytes: Vec<u8>) -> Result<String, String> {
        if bytes.len() > MAX_FILE {
            return Err("加密备份过大".into());
        }
        let name = new_name()?;
        send(
            self.request(Method::PUT, self.file(&name)?)
                .header("If-None-Match", "*")
                .header("Content-Type", "application/octet-stream")
                .body(bytes),
            &[StatusCode::CREATED, StatusCode::OK, StatusCode::NO_CONTENT],
        )
        .await?;
        Ok(name)
    }

    pub async fn download(&self, name: &str) -> Result<Vec<u8>, String> {
        let response = send(
            self.request(Method::GET, self.file(name)?),
            &[StatusCode::OK],
        )
        .await?;
        bounded(response, MAX_FILE).await
    }

    pub async fn list(&self) -> Result<Vec<String>, String> {
        let method = Method::from_bytes(b"PROPFIND").unwrap();
        let request = self
            .request(method, self.directory.clone())
            .header("Depth", "1")
            .header("Content-Type", "application/xml; charset=utf-8")
            .body(PROPERTIES);
        let response = send(request, &[StatusCode::MULTI_STATUS]).await?;
        let bytes = bounded(response, MAX_LIST).await?;
        listing(&self.directory, &bytes)
    }
}

fn listing(directory: &Url, bytes: &[u8]) -> Result<Vec<String>, String> {
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
    }
    let Listing::MultiStatus { response } =
        quick_xml::de::from_reader(bytes).map_err(|_| "无法读取 WebDAV 目录列表")?;
    let mut names = BTreeSet::new();
    for entry in response {
        if entry.status.is_some_and(|s| {
            !s.split_whitespace()
                .nth(1)
                .is_some_and(|code| code.starts_with('2'))
        }) {
            continue;
        }
        let Ok(url) = directory.join(&entry.href) else {
            continue;
        };
        let Some(name) = url.path_segments().and_then(|mut parts| parts.next_back()) else {
            continue;
        };
        if backup_name(name) && directory.join(name).as_ref() == Ok(&url) {
            names.insert(name.to_owned());
        }
    }
    Ok(names.into_iter().rev().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn connection(url: &str) -> Connection {
        Connection {
            endpoint: url.into(),
            username: String::new(),
            password: String::new(),
        }
    }
    #[test]
    fn limits_names_and_directory() {
        let name = new_name().unwrap();
        let remote = Remote::connect(connection("https://test.invalid/a%20b")).unwrap();
        assert_eq!(remote.directory.as_str(), "https://test.invalid/a%20b/");
        assert!(remote.file("../secret").is_err());
        assert!(listing(&remote.directory, b"<html/>").is_err());
        assert!(Remote::connect(connection("http://test.invalid/")).is_err());
        let xml = format!(
            r#"<D:multistatus xmlns:D="DAV:"><D:response><D:href>/a%20b/{name}</D:href></D:response><D:response><D:href>https://elsewhere.invalid/a%20b/{name}</D:href></D:response></D:multistatus>"#
        );
        assert_eq!(
            listing(&remote.directory, xml.as_bytes()).unwrap(),
            vec![name]
        );
    }
    #[tokio::test]
    #[ignore = "requires a writable disposable WebDAV directory in PPCLASH_TEST_DAV"]
    async fn real_encrypted_round_trip() {
        let mut config = connection(&std::env::var("PPCLASH_TEST_DAV").unwrap());
        config.username = std::env::var("PPCLASH_TEST_DAV_USER").unwrap_or_default();
        config.password = std::env::var("PPCLASH_TEST_DAV_PASSWORD").unwrap_or_default();
        if !config.username.is_empty() {
            let mut wrong = connection(&config.endpoint);
            wrong.username = config.username.clone();
            wrong.password = "wrong".into();
            let error = Remote::connect(wrong).unwrap().list().await.unwrap_err();
            assert!(error.contains("401"), "{error}");
        }
        let remote = Remote::connect(config).unwrap();
        let pass = "disposable backup password";
        let source = br#"{"profiles":[{"id":"p","name":"Demo","url":"https://example.invalid","raw":"snapshot"}],"activeId":"p","settings":{"mixedPort":1111}}"#;
        let plain = crate::portable_backup::export(source, "Mac").unwrap();
        let name = remote
            .upload(crate::backup_cipher::encrypt(&plain, pass).unwrap())
            .await
            .unwrap();
        assert!(remote.list().await.unwrap().contains(&name));
        let collision = send(
            remote
                .request(Method::PUT, remote.file(&name).unwrap())
                .header("If-None-Match", "*")
                .body("replacement"),
            &[StatusCode::CREATED],
        )
        .await
        .unwrap_err();
        assert!(collision.contains("412"), "{collision}");
        let file = remote.download(&name).await.unwrap();
        let restored = crate::backup_cipher::decrypt(file, pass).unwrap();
        assert_eq!(restored, plain);
        let device = tempfile::tempdir().unwrap();
        let dir = device.path().to_str().unwrap().to_owned();
        let previous = r#"{"profiles":[],"tunEnabled":false,"settings":{"mixedPort":2222}}"#;
        crate::subscription::save_app_state(previous.into(), dir.clone(), None).unwrap();
        crate::subscription::load_app_state(dir.clone(), Some("test".into())).unwrap();
        crate::subscription::restore_portable(device.path(), &restored, "test").unwrap();
        let result = crate::subscription::load_app_state(dir.clone(), None)
            .unwrap()
            .unwrap();
        let state: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(state["settings"]["mixedPort"], 2222);
        assert_eq!(state["activeId"], "p");
        assert_eq!(state["tunEnabled"], false);
        assert!(crate::subscription::save_app_state(
            previous.into(),
            dir.clone(),
            Some("test".into())
        )
        .is_err());
        let snapshots = crate::subscription::list_backups(dir.clone()).unwrap();
        assert_eq!(snapshots.len(), 1);
        crate::subscription::restore_backup(dir.clone(), snapshots[0].name.clone()).unwrap();
        assert_eq!(
            crate::subscription::load_app_state(dir, None)
                .unwrap()
                .unwrap(),
            previous
        );
        let error = remote.download(&new_name().unwrap()).await.unwrap_err();
        assert!(error.contains("404"), "{error}");
    }
}
