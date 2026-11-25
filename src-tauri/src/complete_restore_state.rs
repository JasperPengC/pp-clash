use std::path::Path;

pub(crate) const JOURNAL: &str = ".ppclash-complete-restore.json";
/// 已持久提交的日志仅等待清理，不能重新冻结已恢复的数据。
pub(crate) fn pending(dir: &Path) -> Result<bool, String> {
    let path = dir.join(JOURNAL);
    match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("无法确认完整恢复状态：{error}")),
        Ok(metadata) if !metadata.is_file() || metadata.len() > 64 * 1024 * 1024 => {
            return Err("完整恢复日志类型或大小无效".into())
        }
        Ok(_) => {}
    }
    let value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).map_err(|e| e.to_string())?)
            .map_err(|e| format!("完整恢复日志损坏：{e}"))?;
    if value["version"].as_u64() != Some(1) {
        return Err("完整恢复日志版本无效".into());
    }
    value["committed"]
        .as_bool()
        .map(|committed| !committed)
        .ok_or("完整恢复提交标记无效".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_uncommitted_journals_freeze_access() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!pending(dir.path()).unwrap());
        for committed in [false, true] {
            std::fs::write(
                dir.path().join(JOURNAL),
                serde_json::to_vec(&serde_json::json!({
                    "version": 1, "committed": committed
                }))
                .unwrap(),
            )
            .unwrap();
            assert_eq!(pending(dir.path()).unwrap(), !committed);
        }
    }

    #[test]
    fn invalid_journal_cannot_unlock_access() {
        let dir = tempfile::tempdir().unwrap();
        for value in [
            "broken",
            "{}",
            r#"{"version":2,"committed":true}"#,
            r#"{"version":1,"committed":"true"}"#,
        ] {
            std::fs::write(dir.path().join(JOURNAL), value).unwrap();
            assert!(pending(dir.path()).is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn journal_symlink_cannot_unlock_access() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(outside.path(), r#"{"version":1,"committed":true}"#).unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join(JOURNAL)).unwrap();
        assert!(pending(dir.path()).is_err());
    }
}
