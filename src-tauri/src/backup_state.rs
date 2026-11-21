use serde_json::{Map, Value};
use std::collections::HashSet;
use std::io::{Read, Write};
use std::path::Path;

const MAX_BYTES: u64 = 64 * 1024 * 1024;
type Object = Map<String, Value>;

fn object(value: &Value) -> Result<&Object, String> {
    value.as_object().ok_or_else(|| "备份字段应为对象".into())
}
fn fields(map: &Object, names: &[&str], valid: fn(&Value) -> bool) -> Result<(), String> {
    for name in names {
        if map.get(*name).is_some_and(|v| !valid(v)) {
            return Err(format!("备份字段 {name} 格式无效"));
        }
    }
    Ok(())
}
fn strings(map: &Object, names: &[&str]) -> Result<(), String> { fields(map, names, Value::is_string) }
fn booleans(map: &Object, names: &[&str]) -> Result<(), String> { fields(map, names, Value::is_boolean) }
fn number(v: &Value) -> bool { v.as_f64().is_some_and(|n| n.is_finite() && n >= 0.0) }
fn optional_number(v: &Value) -> bool { v.is_null() || number(v) }
fn choice(map: &Object, key: &str, values: &[&str]) -> Result<(), String> {
    fields(map, &[key], Value::is_string)?;
    if let Some(v) = map.get(key).and_then(Value::as_str) {
        if !values.contains(&v) { return Err(format!("不支持的备份字段 {key}")); }
    }
    Ok(())
}
fn required_strings(map: &Object, keys: &[&str]) -> Result<(), String> {
    for key in keys {
        if map.get(*key).and_then(Value::as_str).is_none() { return Err(format!("备份缺少有效字段 {key}")); }
    }
    Ok(())
}

pub(crate) fn validate(state: &Value) -> Result<(), String> {
    let root = object(state)?;
    if !root.contains_key("profiles") && !root.contains_key("settings") {
        return Err("不是 PP Clash 状态备份".into());
    }
    booleans(root, &["tunEnabled", "sysProxyEnabled"])?;
    let mut ids = HashSet::new();
    if let Some(profiles) = root.get("profiles") {
        for profile in profiles.as_array().ok_or("备份 profiles 应为数组")? {
            let p = object(profile)?;
            required_strings(p, &["id", "name", "url", "raw"])?;
            let id = p["id"].as_str().unwrap();
            if id.is_empty() || !ids.insert(id) { return Err("订阅标识为空或重复".into()); }
            fields(p, &["updatedAt"], number)?;
            fields(p, &["updateIntervalHours", "autoUpdateHours"], optional_number)?;
            booleans(p, &["useProxy"])?;
            choice(p, "sourceType", &["url", "file"])?;
            if let Some(info) = p.get("userinfo").filter(|v| !v.is_null()) {
                fields(object(info)?, &["upload", "download", "total", "expire"], number)?;
            }
            if let Some(edits) = p.get("ruleEdits") {
                let edits = object(edits)?;
                if !edits.get("order").and_then(Value::as_array).is_some_and(|a| a.iter().all(|v| v.as_u64().is_some())) {
                    return Err("规则顺序格式无效".into());
                }
                for (index, edit) in object(edits.get("edits").ok_or("缺少规则编辑")?)? {
                    if index.parse::<u64>().is_err() { return Err("规则索引无效".into()); }
                    booleans(object(edit)?, &["enabled"])?;
                    strings(object(edit)?, &["target"])?;
                }
            }
        }
    }
    if let Some(active) = root.get("activeId").filter(|v| !v.is_null()) {
        if !active.as_str().is_some_and(|id| ids.contains(id)) { return Err("活动订阅引用不存在".into()); }
    }
    if let Some(policy) = root.get("policy") {
        booleans(object(policy)?, &["dnsLeakProtection", "fakeIp", "ipv6", "blockWebRtc", "tunStrictRoute", "blockQuic"])?;
    }
    if let Some(pins) = root.get("pinnedNodes") {
        for names in object(pins)?.values() {
            if !names.as_array().is_some_and(|a| a.iter().all(Value::is_string)) { return Err("收藏节点格式无效".into()); }
        }
    }
    for key in ["fixedNodes", "selectedNodes"] {
        if let Some(records) = root.get(key) {
            for (id, groups) in object(records)? {
                if !ids.contains(id.as_str()) { return Err(format!("{key} 引用不存在的订阅")); }
                if !object(groups)?.values().all(Value::is_string) { return Err(format!("{key} 格式无效")); }
            }
        }
    }
    if let Some(settings) = root.get("settings") {
        let s = object(settings)?;
        strings(s, &["controllerSecret", "kernelPath", "bindAddress", "authUser", "authPass", "dnsCustom", "githubProxy", "egressGuardNode", "updateFeedUrl", "overrideText"])?;
        booleans(s, &["launchAtLogin", "closeToTray", "allowLan", "advancedMode", "traySpeed", "hideDockOnClose", "geoAutoUpdate", "snifferEnabled", "snifferOverrideDestination", "autoUpdate", "autoFailover", "stableRouting", "egressGuard", "updateCheckOnLaunch", "overrideEnabled"])?;
        fields(s, &["mixedPort", "controllerPort", "dnsPort", "socksPort", "httpPort", "redirPort"], |v| v.as_u64().is_some_and(|n| n <= 65535))?;
        fields(s, &["settingsVersion"], |v| v.as_u64().is_some_and(|n| n <= 3))?;
        fields(s, &["geoUpdateInterval"], number)?;
        choice(s, "theme", &["system", "light", "dark"])?;
        choice(s, "textSize", &["standard", "larger", "large"])?;
        choice(s, "mode", &["rule", "global", "direct"])?;
        choice(s, "geoDataMode", &["db", "dat"])?;
        choice(s, "dnsNameserver", &["auto", "cloudflare", "google", "quad9", "custom"])?;
        choice(s, "overrideMode", &["yaml", "js"])?;
        if let Some(urls) = s.get("geoUrls") {
            if !object(urls)?.values().all(Value::is_string) { return Err("资源地址格式无效".into()); }
        }
        if let Some(overrides) = s.get("overrides") {
            let mut ids = HashSet::new();
            for file in overrides.as_array().ok_or("覆写应为数组")? {
                let f = object(file)?;
                required_strings(f, &["id", "name", "text", "mode"])?;
                if !ids.insert(f["id"].as_str().unwrap()) { return Err("覆写标识重复".into()); }
                choice(f, "mode", &["yaml", "js"])?;
                if !f.get("enabled").is_some_and(Value::is_boolean) { return Err("覆写 enabled 无效".into()); }
            }
        }
        if let Some(rules) = s.get("customRules") {
            for rule in rules.as_array().ok_or("规则应为数组")? {
                if rule.is_string() { continue; } // 旧版本按字符串保存规则。
                let rule = object(rule)?;
                required_strings(rule, &["id", "type", "payload", "target"])?;
                if !rule.get("enabled").is_some_and(Value::is_boolean) { return Err("规则 enabled 无效".into()); }
            }
        }
    }
    Ok(())
}

pub fn read_regular(path: &Path) -> Result<Vec<u8>, String> {
    let meta = std::fs::symlink_metadata(path).map_err(|e| format!("读取备份失败：{e}"))?;
    if !meta.file_type().is_file() || meta.len() > MAX_BYTES { return Err("备份必须为不超过64MB的普通文件".into()); }
    let mut bytes = Vec::new();
    std::fs::File::open(path).map_err(|e| e.to_string())?.take(MAX_BYTES + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_BYTES { return Err("备份超过64MB".into()); }
    Ok(bytes)
}

/// 旧格式保留原字节，新格式只取已验证的state，不能将未知封装当旧格式。
pub fn decode(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let doc: Value = serde_json::from_slice(bytes).map_err(|e| format!("备份JSON无效：{e}"))?;
    let obj = object(&doc)?;
    if obj.contains_key("format") || obj.contains_key("version") || obj.contains_key("state") {
        if doc["format"] != "ppclash-state" || doc["version"] != 1 { return Err("不支持的备份格式或版本".into()); }
        validate(&doc["state"])?;
        serde_json::to_vec(&doc["state"]).map_err(|e| e.to_string())
    } else {
        validate(&doc)?;
        Ok(bytes.to_vec())
    }
}

pub fn encode(state: &[u8]) -> Result<Vec<u8>, String> {
    let state: Value = serde_json::from_slice(state).map_err(|e| e.to_string())?;
    validate(&state)?;
    serde_json::to_vec(&serde_json::json!({"format": "ppclash-state", "version": 1, "state": state})).map_err(|e| e.to_string())
}

/// persist覆盖使用同目录原子替换；失败时旧目标保留，临时文件由RAII删除。
pub fn replace(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or("无效状态目录")?;
    let mut temporary = tempfile::NamedTempFile::new_in(dir).map_err(|e| e.to_string())?;
    temporary.write_all(bytes).and_then(|_| temporary.as_file().sync_all()).map_err(|e| e.to_string())?;
    temporary.persist(path).map_err(|e| format!("替换状态失败，原文件保留：{}", e.error))?;
    Ok(())
}

pub fn snapshot(dir: &Path, prefix: &str, bytes: &[u8]) -> Result<String, String> {
    let mut file = tempfile::Builder::new().prefix(prefix).suffix(".json").tempfile_in(dir).map_err(|e| e.to_string())?;
    file.write_all(bytes).and_then(|_| file.as_file().sync_all()).map_err(|e| e.to_string())?;
    let (_, path) = file.keep().map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_replacement_preserves_target_and_removes_temporary() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("state.json");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("preserve"), b"old").unwrap();
        assert!(replace(&target, b"new").is_err());
        assert_eq!(std::fs::read(target.join("preserve")).unwrap(), b"old");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn valid_state_replaces_atomically_and_uses_private_permissions() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("state.json");
        std::fs::write(&target, b"old").unwrap();
        replace(&target, b"new").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"new");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(target).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn rule_edit_shapes_are_checked_before_restore() {
        let invalid = br#"{"profiles":[{"id":"p","name":"p","url":"x","raw":"x","ruleEdits":{"order":"bad","edits":{}}}]}"#;
        assert!(decode(invalid).is_err());
        let valid = br#"{"profiles":[{"id":"p","name":"p","url":"x","raw":"x","ruleEdits":{"order":[2,0],"edits":{"2":{"enabled":false,"target":"DIRECT"}}}}]}"#;
        assert!(decode(valid).is_ok());
    }
}
