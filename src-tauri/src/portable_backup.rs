use crate::backup_state;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

const ROOT: &[&str] = &[
    "profiles",
    "activeId",
    "pinnedNodes",
    "fixedNodes",
    "selectedNodes",
];
const SETTINGS: &[&str] = &[
    "overrides",
    "customRules",
    "overrideEnabled",
    "overrideText",
    "overrideMode",
];

#[derive(Serialize, Deserialize)]
struct Document {
    format: String,
    version: u32,
    device: String,
    state: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    device: String,
    profiles: usize,
    collections: usize,
}

fn project(source: &Value, fields: &[&str]) -> Map<String, Value> {
    fields
        .iter()
        .filter_map(|&key| {
            source
                .get(key)
                .map(|value| (key.to_string(), value.clone()))
        })
        .collect()
}

fn portable(source: &Value) -> Result<Value, String> {
    let mut state = project(source, ROOT);
    let profiles = state
        .get_mut("profiles")
        .and_then(Value::as_array_mut)
        .ok_or("备份缺少订阅列表")?;
    for profile in profiles {
        // A desktop file path or Android content URI belongs to the source device.
        if profile["sourceType"] == "file" {
            profile["url"] = Value::String(String::new());
        }
    }
    state.insert(
        "settings".into(),
        Value::Object(project(&source["settings"], SETTINGS)),
    );
    Ok(Value::Object(state))
}

pub fn export(bytes: &[u8], device: &str) -> Result<Vec<u8>, String> {
    let bytes = backup_state::decode(bytes)?;
    let source = serde_json::from_slice(&bytes).map_err(|e| format!("读取状态失败：{e}"))?;
    let device = device.trim();
    if device.is_empty() || device.chars().count() > 80 {
        return Err("设备名称应为 1 到 80 个字符".into());
    }
    serde_json::to_vec(&Document {
        format: "ppclash-portable".into(),
        version: 1,
        device: device.into(),
        state: portable(&source)?,
    })
    .map_err(|e| e.to_string())
}

fn read(bytes: &[u8]) -> Result<Document, String> {
    let mut doc: Document = serde_json::from_slice(bytes).map_err(|_| "无法读取跨设备备份")?;
    if doc.format != "ppclash-portable" || doc.version != 1 {
        return Err("不支持的跨设备备份版本".into());
    }
    doc.state = portable(&doc.state)?;
    backup_state::validate(&doc.state)?;
    Ok(doc)
}

pub fn preview(bytes: &[u8]) -> Result<Preview, String> {
    let doc = read(bytes)?;
    let profiles = doc.state["profiles"].as_array().unwrap();
    Ok(Preview {
        device: doc.device,
        profiles: profiles.len(),
        collections: profiles.iter().filter(|p| p["sourceType"] == "collection").count(),
    })
}

pub fn merge(current: &[u8], incoming: &[u8]) -> Result<Vec<u8>, String> {
    let doc = read(incoming)?;
    let mut state: Value =
        serde_json::from_slice(&backup_state::decode(current)?).map_err(|e| e.to_string())?;
    let mut incoming = doc.state;
    // Reuse only an existing target-side file binding for the same subscription.
    if let Some(existing) = state["profiles"].as_array() {
        let paths: std::collections::HashMap<_, _> = existing
            .iter()
            .filter(|p| p["sourceType"] == "file")
            .filter_map(|p| Some((p["id"].as_str()?, p["url"].as_str()?)))
            .collect();
        for profile in incoming["profiles"].as_array_mut().unwrap() {
            if profile["sourceType"] == "file" {
                if let Some(path) = profile["id"].as_str().and_then(|id| paths.get(id)) {
                    profile["url"] = Value::String((*path).to_owned());
                }
            }
        }
    }
    fn replace_fields(
        target: &mut Map<String, Value>,
        source: &mut Map<String, Value>,
        keys: &[&str],
    ) {
        for key in keys {
            target.remove(*key);
            if let Some(value) = source.remove(*key) {
                target.insert((*key).into(), value);
            }
        }
    }
    let target = state.as_object_mut().unwrap();
    let source = incoming.as_object_mut().unwrap();
    replace_fields(target, source, ROOT);
    let settings = target
        .entry("settings")
        .or_insert_with(|| Value::Object(Map::new()));
    replace_fields(
        settings.as_object_mut().ok_or("本机设置格式无效")?,
        source["settings"].as_object_mut().unwrap(),
        SETTINGS,
    );
    backup_state::validate(&state)?;
    serde_json::to_vec(&state).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn collection_recipe_survives_portable_restore() {
        let source = serde_json::json!({"profiles":[
            {"id":"a","name":"A","url":"","raw":"a","sourceType":"file"},
            {"id":"b","name":"B","url":"","raw":"b","sourceType":"file"},
            {"id":"c","name":"C","url":"","raw":"combined","sourceType":"collection",
             "collection":{"sources":["b","a"],"include":"Tokyo","exclude":"old","find":"Tokyo","replace":"JP"}}
        ],"activeId":"c"});
        let document = export(&serde_json::to_vec(&source).unwrap(), "Desktop").unwrap();
        let summary = preview(&document).unwrap();
        assert_eq!((summary.profiles, summary.collections), (3, 1));
        let restored: Value = serde_json::from_slice(&merge(br#"{"profiles":[]}"#, &document).unwrap()).unwrap();
        assert_eq!(restored["profiles"], source["profiles"]);
        assert_eq!(restored["activeId"], "c");
    }

    #[test]
    fn migrates_subscriptions_and_rules_only() {
        let original = br#"{"profiles":[{"id":"f","name":"X","url":"/source/private.yaml","raw":"example","sourceType":"file"}],"activeId":"f","selectedNodes":{"f":{"g":"n"}},"tunEnabled":true,"settings":{"controllerSecret":"source-secret","kernelPath":"/source","mixedPort":555,"customRules":["MATCH,DIRECT"]}}"#;
        let data = export(original, "Work Mac").unwrap();
        assert!(!std::str::from_utf8(&data).unwrap().contains("/source"));
        assert!(!std::str::from_utf8(&data)
            .unwrap()
            .contains("source-secret"));
        assert_eq!(preview(&data).unwrap().profiles, 1);
        let current = br#"{"profiles":[],"tunEnabled":false,"settings":{"kernelPath":"local","mixedPort":1234,"controllerSecret":"local-secret"}}"#;
        let restored: Value = serde_json::from_slice(&merge(current, &data).unwrap()).unwrap();
        assert_eq!(restored["tunEnabled"], false);
        assert_eq!(restored["settings"]["mixedPort"], 1234);
        assert_eq!(restored["settings"]["controllerSecret"], "local-secret");
        assert_eq!(restored["settings"]["kernelPath"], "local");
        assert_eq!(restored["settings"]["customRules"][0], "MATCH,DIRECT");
        assert_eq!(restored["selectedNodes"]["f"]["g"], "n");
        assert_eq!(restored["profiles"][0]["url"], "");
        assert_eq!(restored["profiles"][0]["raw"], "example");
        assert_eq!(restored["activeId"], "f");
    }
}
