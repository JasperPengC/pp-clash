use super::*;

#[tokio::test]
async fn shutdown_after_runtime_pause_does_not_reuse_an_expired_connection() {
    let data = tempfile::tempdir().unwrap();
    let service = SubStoreService::new(resource_root(), data.path().join("data"));
    assert_eq!(service.start().await.phase, "running");
    // Snapshot serialization can keep this current-thread runtime busy longer than Node's idle timeout.
    std::thread::sleep(Duration::from_secs(7));
    service.stop().await.unwrap();
}

async fn scheduled_service(delay: u64) -> (tempfile::TempDir, SubStoreService) {
    let dir = tempfile::tempdir().unwrap();
    let service = SubStoreService::new(resource_root(), dir.path().join("data"));
    let marker = dir.path().join("started");
    let script = format!("async function operator(proxies) {{ if ($substore.read('#drained')) return proxies; require('fs').writeFileSync({}, 'started'); await new Promise(r => setTimeout(r, {delay})); $substore.write('finished', '#drained'); return proxies; }}", serde_json::to_string(&marker.to_string_lossy()).unwrap());
    let mut sub = synthetic("scheduled-source");
    sub["process"] = json!([{ "type": "Script Operator", "args": { "content": script } }]);
    api(&service, "/api/subs", Some(sub), "POST").await;
    api(&service, "/api/artifacts", Some(json!({"name":"scheduled", "type":"subscription", "source":"scheduled-source", "platform":"ClashMeta", "sync":true, "upload":false, "cron":"* * * * * *"})), "POST").await;
    tokio::time::timeout(Duration::from_secs(4), async {
        while !marker.exists() { tokio::time::sleep(Duration::from_millis(10)).await; }
    }).await.unwrap();
    (dir, service)
}

#[tokio::test]
async fn snapshot_waits_for_background_sync_to_finish() {
    let (_dir, service) = scheduled_service(1500).await;
    let snapshot = service.snapshot().await.unwrap();
    assert_eq!(snapshot["files"]["root.json"]["drained"], "finished");
    assert!(snapshot["files"]["sub-store.json"]["artifacts"][0]["updated"].is_number());
    service.stop().await.unwrap();
}

#[tokio::test]
async fn busy_background_sync_rejects_restore_without_losing_work_or_staging() {
    let (dir, service) = scheduled_service(6500).await;
    let result = service.restore_snapshot(&disk_snapshot("replacement")).await;
    assert!(result.is_err(), "busy restore must not publish an incomplete snapshot");
    assert_eq!(api(&service, "/api/subs", None, "GET").await["data"][0]["name"], "scheduled-source");
    assert_eq!(fs::read_dir(dir.path()).unwrap().filter_map(Result::ok).filter(|e| e.file_name().to_string_lossy().starts_with(".sub-store-") && e.file_name() != ".sub-store-runtime").count(), 0);
    tokio::time::sleep(Duration::from_millis(1800)).await;
    let snapshot = service.snapshot().await.unwrap();
    assert_eq!(snapshot["files"]["root.json"]["drained"], "finished");
    service.stop().await.unwrap();
}
