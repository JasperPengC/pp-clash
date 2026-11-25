use super::*;
use std::sync::Arc;

#[tokio::test]
async fn export_all_content_types_keep_output_and_official_storage_unchanged() {
    let data = tempfile::tempdir().unwrap();
    let service = Arc::new(SubStoreService::new(resource_root(), data.path().join("data")));
    let mut entry = synthetic("saved");
    entry["process"] = json!([{ "type": "Script Operator", "args": { "content": "function operator(proxies) { $substore.write('temporary-export', '#export-key'); return proxies; }" } }]);
    api(&service, "/api/subs", Some(entry), "POST").await;
    api(&service, "/api/collections", Some(json!({ "name": "combined", "subscriptions": ["saved"], "process": [] })), "POST").await;
    api(&service, "/api/files", Some(json!({ "name": "config", "source": "local", "content": "{\"mode\":\"rule\",\"proxies\":[]}", "process": [] })), "POST").await;
    let before = service.snapshot().await.unwrap();
    for (path, expected) in [
        ("/download/saved?target=ClashMeta", "\"name\":\"Sample\""),
        ("/download/collection/combined?target=JSON", "Sample"),
        ("/api/file/config?target=ClashMeta", "{\"mode\":\"rule\",\"proxies\":[]}"),
    ] {
        let id = service.prepare_preview().unwrap();
        let output = service.preview(&id, request(path, None, "GET")).await.unwrap();
        assert!(output.contains(expected), "{output}");
        assert_eq!(service.snapshot().await.unwrap(), before);
    }
    service.stop().await.unwrap();
}

#[tokio::test]
async fn export_blocking_script_is_killed_without_losing_saved_sources_or_concurrent_changes() {
    let data = tempfile::tempdir().unwrap();
    let service = Arc::new(SubStoreService::new(resource_root(), data.path().join("data")));
    let marker = data.path().join("export-worker");
    let script = format!("function operator(proxies) {{ require('fs').writeFileSync({}, JSON.stringify([process.pid, process.env.SUB_STORE_DATA_BASE_PATH])); $substore.write('temporary-export', '#export-key'); while (true) {{}} }}", serde_json::to_string(&marker).unwrap());
    let mut entry = synthetic("blocking");
    entry["process"] = json!([{ "type": "Script Operator", "args": { "content": script } }]);
    api(&service, "/api/subs", Some(entry.clone()), "POST").await;
    let id = service.prepare_preview().unwrap();
    let generation = service.preview(&id, request("/download/blocking?target=ClashMeta", None, "GET"));
    let cancel = async {
        preview::wait_worker_ready(&service, &id).await;
        tokio::time::timeout(Duration::from_secs(20), async {
            while !marker.exists() { tokio::time::sleep(Duration::from_millis(20)).await; }
        }).await.expect("export script entered");
        api(&service, "/api/subs", Some(synthetic("concurrent")), "POST").await;
        assert!(service.cancel_preview(&id));
    };
    let (result, ()) = tokio::join!(generation, cancel);
    assert_eq!(result.unwrap_err(), "SUB_STORE_PREVIEW_CANCELLED");
    let worker: Value = serde_json::from_str(&fs::read_to_string(marker).unwrap()).unwrap();
    assert!(!Path::new(worker[1].as_str().unwrap()).exists());
    #[cfg(unix)]
    assert!(!Command::new("kill").args(["-0", &worker[0].to_string()]).stderr(Stdio::null()).status().unwrap().success());
    let snapshot = service.snapshot().await.unwrap();
    assert!(snapshot["files"]["root.json"]["export-key"].is_null());
    let saved = api(&service, "/api/sub/blocking", None, "GET").await;
    assert_eq!(saved["data"]["process"], entry["process"]);
    assert_eq!(api(&service, "/api/subs", None, "GET").await["data"].as_array().unwrap().len(), 2);
    let next = service.prepare_preview().unwrap();
    assert!(service.preview(&next, request("/download/concurrent?target=ClashMeta", None, "GET")).await.unwrap().contains("Sample"));
    service.stop().await.unwrap();
}

#[tokio::test]
async fn export_early_cancel_and_route_boundary_never_start_an_unrelated_action() {
    let data = tempfile::tempdir().unwrap();
    let service = Arc::new(SubStoreService::new(resource_root(), data.path().join("data")));
    for path in ["/download/saved?target=JSON", "/download/collection/combined?target=ClashMeta", "/api/file/config"] {
        let id = service.prepare_preview().unwrap();
        assert!(service.cancel_preview(&id));
        assert_eq!(service.preview(&id, request(path, None, "GET")).await.unwrap_err(), "SUB_STORE_PREVIEW_CANCELLED");
        assert!(service.state().process.is_none());
    }
    for (path, method, body) in [
        ("/api/sync/artifacts", "GET", None),
        ("/api/file/config", "PATCH", Some(json!({ "content": "changed" }))),
        ("/api/file/config", "GET", Some(json!({ "content": "changed" }))),
        ("/download/a/extra", "GET", None),
        ("/download/collection/a/extra", "GET", None),
        ("/share/saved", "GET", None),
    ] {
        let id = service.prepare_preview().unwrap();
        assert!(service.preview(&id, request(path, body, method)).await.is_err(), "accepted {method} {path}");
        assert!(service.state().process.is_none());
    }
    service.shutdown();
}
