//! 远端名字只承载无秘密元数据；本机成功账本决定保留清理范围。
use reqwest::Url;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupEntry {
    pub name: String,
    pub device_id: Option<String>,
    pub device_name: String,
    pub created_at: Option<u64>,
    pub size: Option<u64>,
    pub version: Option<u32>,
    pub is_current_device: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub items: Vec<BackupEntry>,
    pub total: usize,
    pub offset: usize,
    pub limit: usize,
}
pub fn page(items: Vec<BackupEntry>, offset: usize, limit: usize) -> Result<HistoryPage, String> {
    if !(1..=100).contains(&limit) {
        return Err("每页备份数必须在 1 到 100 之间".into());
    }
    let total = items.len();
    Ok(HistoryPage {
        items: items.into_iter().skip(offset).take(limit).collect(),
        total,
        offset,
        limit,
    })
}
#[cfg(test)]
pub fn new_backup_name(id: &str, device: &str, now: u64) -> Result<String, String> {
    new_backup_name_with_version(id, device, now, 1)
}
pub fn new_backup_name_with_version(
    id: &str,
    device: &str,
    now: u64,
    version: u32,
) -> Result<String, String> {
    if ![1, 2].contains(&version) {
        return Err("不支持的跨设备备份版本".into());
    }
    let id = uuid::Uuid::parse_str(id).map_err(|_| "设备标识无效")?;
    if now > 9_999_999_999_999 {
        return Err("系统时间异常".into());
    }
    let mut label = String::new();
    for c in device.chars() {
        if label.len() + c.len_utf8() > 64 {
            break;
        }
        label.push(c);
    }
    if label.trim().is_empty() || label.chars().any(char::is_control) {
        return Err("设备名称无效".into());
    }
    let hex: String = label
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok(format!(
        "ppclash-v{version}-{}-{now:013}-{hex}-{}.ppbackup",
        id.simple(),
        uuid::Uuid::new_v4().simple()
    ))
}
pub fn parse_name(name: &str, current_id: &str) -> Option<BackupEntry> {
    let stem = name.strip_prefix("ppclash-")?.strip_suffix(".ppbackup")?;
    let parts: Vec<_> = stem.split('-').collect();
    let (device_id, device_name, time, version) = match parts.as_slice() {
        [version, id, time, label, nonce]
            if matches!(*version, "v1" | "v2")
                && id.len() == 32
                && nonce.len() == 32
                && label.len() <= 128
                && label.len() % 2 == 0 =>
        {
            let id = uuid::Uuid::parse_str(id).ok()?.to_string();
            uuid::Uuid::parse_str(nonce).ok()?;
            let bytes = label
                .as_bytes()
                .as_chunks::<2>()
                .0
                .iter()
                .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok())
                .collect::<Option<Vec<_>>>()?;
            let label = String::from_utf8(bytes).ok()?;
            if label.trim().is_empty() || label.chars().any(char::is_control) {
                return None;
            }
            (
                Some(id),
                label,
                *time,
                Some(if *version == "v2" { 2 } else { 1 }),
            )
        }
        [time, nonce] if nonce.len() == 32 && nonce.bytes().all(|b| b.is_ascii_hexdigit()) => {
            (None, "旧版备份".into(), *time, None)
        }
        _ => return None,
    };
    if time.len() != 13 || !time.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(BackupEntry {
        name: name.into(),
        is_current_device: device_id.as_deref() == Some(current_id),
        device_id,
        device_name,
        created_at: time.parse().ok(),
        size: None,
        version,
    })
}
fn success(status: &str) -> bool {
    status
        .split_whitespace()
        .nth(1)
        .is_some_and(|code| code.len() == 3 && code.starts_with('2'))
}
pub fn parse_listing(directory: &Url, bytes: &[u8], id: &str) -> Result<Vec<BackupEntry>, String> {
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
        getcontentlength: Option<String>,
        resourcetype: Option<ResourceType>,
    }
    #[derive(Deserialize)]
    struct ResourceType {
        collection: Option<Collection>,
    }
    #[derive(Deserialize)]
    struct Collection {}
    let Listing::MultiStatus { response } =
        quick_xml::de::from_reader(bytes).map_err(|_| "无法读取 WebDAV 目录列表")?;
    let directory_path = percent_encoding::percent_decode_str(directory.path())
        .decode_utf8()
        .map_err(|_| "WebDAV 目录编码无效")?;
    let mut names = BTreeMap::new();
    for entry in response {
        if entry.status.as_deref().is_some_and(|s| !success(s))
            || (!entry.propstat.is_empty() && !entry.propstat.iter().any(|p| success(&p.status)))
        {
            continue;
        }
        let Ok(url) = directory.join(&entry.href) else {
            continue;
        };
        if url.origin() != directory.origin() || url.query().is_some() || url.fragment().is_some() {
            continue;
        }
        let Ok(path) = percent_encoding::percent_decode_str(url.path()).decode_utf8() else {
            continue;
        };
        let Some(name) = path.strip_prefix(directory_path.as_ref()) else {
            continue;
        };
        let Some(mut row) = parse_name(name, id) else {
            continue;
        };
        if entry
            .propstat
            .iter()
            .filter(|p| success(&p.status))
            .any(|p| {
                p.prop
                    .resourcetype
                    .as_ref()
                    .is_some_and(|r| r.collection.is_some())
            })
        {
            continue;
        }
        row.size = entry
            .propstat
            .iter()
            .filter(|p| success(&p.status))
            .find_map(|p| p.prop.getcontentlength.as_ref()?.parse::<u64>().ok());
        names.entry(row.name.clone()).or_insert(row);
    }
    let mut rows: Vec<_> = names.into_values().collect();
    rows.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| b.name.cmp(&a.name))
    });
    Ok(rows)
}
pub fn is_collection(directory: &Url, bytes: &[u8]) -> Result<bool, String> {
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
    let Listing::MultiStatus { response } =
        quick_xml::de::from_reader(bytes).map_err(|_| "无法读取 WebDAV 目录应答")?;
    for entry in response {
        let Ok(url) = directory.join(&entry.href) else {
            continue;
        };
        if url.origin() != directory.origin() || url.query().is_some() || url.fragment().is_some() {
            continue;
        }
        let Ok(path) = percent_encoding::percent_decode_str(url.path()).decode_utf8() else {
            continue;
        };
        let Ok(expected) = percent_encoding::percent_decode_str(directory.path()).decode_utf8()
        else {
            return Err("WebDAV 目录编码无效".into());
        };
        if path != expected {
            continue;
        }
        if entry.status.as_deref().is_some_and(|s| !success(s)) {
            return Err("WebDAV 目录访问被拒绝".into());
        }
        if !entry.propstat.iter().any(|p| success(&p.status)) {
            return Err("WebDAV 目录属性访问被拒绝".into());
        }
        if entry
            .propstat
            .iter()
            .filter(|p| success(&p.status))
            .any(|p| {
                p.prop
                    .resourcetype
                    .as_ref()
                    .is_some_and(|r| r.collection.is_some())
            })
        {
            return Ok(true);
        }
        return Err("WebDAV 目标不是目录".into());
    }
    Err("WebDAV 未确认目标目录".into())
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SuccessLedger {
    pub last_success_at: Option<u64>,
    confirmed: Vec<String>,
}
impl SuccessLedger {
    fn path(dir: &std::path::Path, scope: &str) -> Result<std::path::PathBuf, String> {
        if scope.is_empty()
            || scope.len() > 128
            || !scope
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err("备份账本标识无效".into());
        }
        Ok(dir.join(format!("webdav-success-{scope}.json")))
    }
    pub fn load(dir: &std::path::Path, scope: &str) -> Result<Self, String> {
        use std::io::Read;
        let path = Self::path(dir, scope)?;
        match std::fs::symlink_metadata(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Self::default()),
            Ok(m) if m.file_type().is_file() => {}
            _ => return Err("无法读取备份成功账本".into()),
        }
        let mut bytes = Vec::new();
        std::fs::File::open(path)
            .map_err(|_| "无法读取备份成功账本")?
            .take(2 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "无法读取备份成功账本")?;
        if bytes.len() > 2 * 1024 * 1024 {
            return Err("备份成功账本过大".into());
        }
        let ledger: Self =
            serde_json::from_slice(&bytes).map_err(|_| "备份成功账本格式无效，未覆盖原文件")?;
        if ledger.confirmed.len() > 5000
            || ledger
                .confirmed
                .iter()
                .any(|name| parse_name(name, "").is_none())
        {
            return Err("备份成功账本格式无效，未覆盖原文件".into());
        }
        Ok(ledger)
    }
    pub fn save(&self, dir: &std::path::Path, scope: &str) -> Result<(), String> {
        use std::io::Write;
        let path = Self::path(dir, scope)?;
        let mut file = tempfile::NamedTempFile::new_in(dir).map_err(|_| "无法创建备份成功账本")?;
        file.write_all(&serde_json::to_vec(self).map_err(|_| "无法生成备份成功账本")?)
            .map_err(|_| "无法写入备份成功账本")?;
        file.as_file()
            .sync_all()
            .map_err(|_| "无法同步备份成功账本")?;
        file.persist(path).map_err(|_| "无法保存备份成功账本")?;
        #[cfg(unix)]
        std::fs::File::open(dir)
            .and_then(|file| file.sync_all())
            .map_err(|_| "无法同步备份成功账本目录")?;
        Ok(())
    }
    pub fn confirm(&mut self, name: String, now: u64) {
        self.confirmed.retain(|old| old != &name);
        self.confirmed.push(name);
        if self.confirmed.len() > 5000 {
            self.confirmed.drain(..self.confirmed.len() - 5000);
        }
        self.last_success_at = Some(now);
    }
    pub fn forget(&mut self, name: &str) {
        self.confirmed.retain(|old| old != name);
    }
    pub fn cleanup_candidates(
        &self,
        remote: &[BackupEntry],
        id: &str,
        retention: usize,
    ) -> Vec<String> {
        let confirmed: std::collections::HashSet<_> = self.confirmed.iter().collect();
        let mut ours: Vec<_> = remote
            .iter()
            .filter(|row| row.device_id.as_deref() == Some(id) && confirmed.contains(&row.name))
            .collect();
        ours.sort_by(|a, b| {
            b.created_at
                .cmp(&a.created_at)
                .then_with(|| b.name.cmp(&a.name))
        });
        ours.into_iter()
            .skip(retention)
            .map(|row| row.name.clone())
            .collect()
    }
}

pub fn scope(settings: &crate::webdav_settings::Settings, id: &str) -> String {
    use sha2::Digest;
    let identity = serde_json::to_vec(&(
        settings.endpoint.as_str(),
        settings.directory.as_str(),
        settings.username.as_str(),
        id,
    ))
    .unwrap();
    format!("{:x}", sha2::Sha256::digest(identity))
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "104b10e5-1d32-4c60-bc15-7e755dd8b501";
    #[test]
    fn retention_only_uses_confirmed_current_device_files_and_survives_restart() {
        let dir = tempfile::tempdir().unwrap();
        let mut ledger = SuccessLedger::default();
        let first = new_backup_name(ID, "Mac", 10).unwrap();
        let second = new_backup_name(ID, "Mac", 20).unwrap();
        let unknown = new_backup_name(ID, "Mac", 30).unwrap();
        let other = new_backup_name("7a4e822c-1151-42df-ae1b-d2aff972b1da", "Mac", 5).unwrap();
        ledger.confirm(first.clone(), 10);
        ledger.confirm(second.clone(), 20);
        ledger.save(dir.path(), "scope").unwrap();
        let ledger = SuccessLedger::load(dir.path(), "scope").unwrap();
        assert_eq!(ledger.last_success_at, Some(20));
        let remote = [&first, &second, &unknown, &other]
            .iter()
            .map(|n| parse_name(n, ID).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(ledger.cleanup_candidates(&remote, ID, 1), vec![first]);
        assert!(SuccessLedger::load(dir.path(), "another-account")
            .unwrap()
            .cleanup_candidates(&remote, ID, 1)
            .is_empty());
        let page = page(remote, 1, 2).unwrap();
        assert_eq!(
            (page.total, page.offset, page.limit, page.items.len()),
            (4, 1, 2, 2)
        );
        assert!(super::page(vec![], 0, 0).is_err());
    }
    #[test]
    fn new_portable_version_is_shown_in_remote_history() {
        let name = new_backup_name_with_version(ID, "Mac", 123, 2).unwrap();
        assert_eq!(parse_name(&name, ID).unwrap().version, Some(2));
        assert!(new_backup_name_with_version(ID, "Mac", 123, 99).is_err());
    }
    #[test]
    fn collection_href_accepts_equivalent_percent_encoding_case() {
        let url = Url::parse("https://host.invalid/%E5%A4%87%E4%BB%BD/").unwrap();
        let xml=br#"<D:multistatus xmlns:D="DAV:"><D:response><D:href>/%e5%a4%87%e4%bb%bd/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>"#;
        assert!(is_collection(&url, xml).unwrap());
    }
    #[test]
    fn names_keep_stable_identity_unicode_and_time() {
        let name = new_backup_name(ID, "工作 Mac", 123).unwrap();
        let row = parse_name(&name, ID).unwrap();
        assert_eq!(row.device_name, "工作 Mac");
        assert_eq!(row.created_at, Some(123));
        assert!(row.is_current_device);
        assert!(!parse_name(&name, "other").unwrap().is_current_device);
        assert!(parse_name("../secret", ID).is_none());
    }
    #[test]
    fn listing_decodes_percent_encoding_and_only_uses_successful_propstat() {
        let name = new_backup_name(ID, "工作 Mac", 123).unwrap();
        let href = name.replacen("p", "%70", 1);
        let xml = format!(
            r#"<D:multistatus xmlns:D="DAV:"><D:response><D:href>/cloud/%E5%A4%87%E4%BB%BD/{href}</D:href><D:propstat><D:prop><D:getcontentlength>432</D:getcontentlength></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response><D:response><D:href>https://evil.invalid/{name}</D:href></D:response><D:response><D:href>/cloud/%E5%A4%87%E4%BB%BD/{name}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response></D:multistatus>"#
        );
        let list = parse_listing(
            &Url::parse("https://host.invalid/cloud/%E5%A4%87%E4%BB%BD/").unwrap(),
            xml.as_bytes(),
            ID,
        )
        .unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].size, Some(432));
    }
}
