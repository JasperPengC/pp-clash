use super::*;
#[path = "preview_tests.rs"]
mod preview_tests;
#[path = "export_tests.rs"]
mod export_tests;
#[path = "launch_tests.rs"]
mod launch_tests;
#[path = "lifecycle_tests.rs"]
mod lifecycle_tests;
fn resource_root() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let local = manifest.join("resources/sub-store");
    if local.is_dir() {
        local
    } else {
        manifest.join("../../../src-tauri/resources/sub-store")
    }
}
fn request(path: &str, body: Option<Value>, method: &str) -> ServiceRequest {
    ServiceRequest {
        path: path.into(),
        method: method.into(),
        body,
    }
}
async fn api(service: &SubStoreService, path: &str, body: Option<Value>, method: &str) -> Value {
    serde_json::from_str(&service.request(request(path, body, method)).await.unwrap()).unwrap()
}
fn synthetic(name: &str) -> Value {
    json!({ "name": name, "source": "local", "content": "proxies:\n  - name: Sample\n    type: ss\n    server: 192.0.2.1\n    port: 443\n    cipher: aes-128-gcm\n    password: synthetic\n", "process": [] })
}

#[test]
fn rejects_traversal_double_encoding_and_urls() {
    for path in [
        "https://evil/api/subs",
        "//evil/api/subs",
        "/api/../storage",
        "/api/sub/%252e%252e",
        "/api/sub/%2fsettings",
        "/api/subs#x",
        "/api/sub/%00",
        "/api//settings",
        "/api/sub/%z0",
        "/__ppclash_shutdown",
    ] {
        assert!(
            validate_request(&request(path, None, "GET")).is_err(),
            "accepted {path}"
        );
    }
    for path in [
        "/api/subs",
        "/api/sub/%E4%B8%AD%E6%96%87",
        "/download/a?target=ClashMeta",
        "/api/sync/artifact/a",
        "/api/token",
        "/api/archives/a/restore",
    ] {
        validate_request(&request(path, None, "GET")).unwrap();
    }
    assert!(validate_request(&request("/api/subs", None, "PUT")).is_err());
    assert!(validate_request(&request("/api/storage", Some(json!({})), "POST")).is_err());
}
#[tokio::test]
async fn starts_full_service_once_and_restarts_with_persisted_data() {
    let data = tempfile::tempdir().unwrap();
    let service = SubStoreService::new(resource_root(), data.path().join("data"));
    let (a, b) = tokio::join!(service.start(), service.start());
    assert_eq!(a.phase, "running", "{:?}", a);
    assert_eq!(b.phase, "running");
    let first = service.state().process.as_ref().unwrap().child.id();
    assert_eq!(service.start().await.phase, "running");
    assert_eq!(service.state().process.as_ref().unwrap().child.id(), first);
    api(&service, "/api/subs", Some(synthetic("sample")), "POST").await;
    api(
        &service,
        "/api/collections",
        Some(json!({ "name": "combined", "subscriptions": ["sample"], "process": [] })),
        "POST",
    )
    .await;
    api(
        &service,
        "/api/files",
        Some(json!({"name": "config", "source": "local", "content": "mode: rule\n"})),
        "POST",
    )
    .await;
    let download = service
        .request(request(
            "/download/collection/combined?target=ClashMeta",
            None,
            "GET",
        ))
        .await
        .unwrap();
    assert!(download.contains("192.0.2.1"));
    service.stop().await.unwrap();
    assert_eq!(service.status().phase, "stopped");
    assert!(service.state().process.is_none());
    assert_eq!(service.start().await.phase, "running");
    assert_eq!(
        api(&service, "/api/sub/sample", None, "GET").await["data"]["name"],
        "sample"
    );
    assert_eq!(
        api(&service, "/api/collection/combined", None, "GET").await["data"]["subscriptions"][0],
        "sample"
    );
    let env = api(&service, "/api/utils/env", None, "GET").await;
    assert!(env.pointer("/data/meta/node/env").is_none());
    service.shutdown();
    assert_eq!(service.status().phase, "stopped");
    assert_eq!(service.start().await.phase, "failed");
}
#[tokio::test]
async fn rejects_browser_and_unauthorized_calls_even_with_the_right_prefix() {
    let data = tempfile::tempdir().unwrap();
    let service = SubStoreService::new(resource_root(), data.path().join("data"));
    assert_eq!(service.start().await.phase, "running");
    let (base, prefix, token) = {
        let s = service.state();
        let p = s.process.as_ref().unwrap();
        (
            format!("http://127.0.0.1:{}", p.port),
            p.prefix.clone(),
            p.token.clone(),
        )
    };
    for (url, auth, origin, fetch) in [
        (format!("{base}/api/subs"), false, None, None),
        (format!("{base}{prefix}/api/subs"), false, None, None),
        (
            format!("{base}{prefix}/api/subs"),
            true,
            Some("https://native.invalid"),
            None,
        ),
        (
            format!("{base}{prefix}/api/subs"),
            true,
            Some("http://localhost:3000"),
            None,
        ),
        (format!("{base}{prefix}/api/subs"), true, Some("null"), None),
        (
            format!("{base}{prefix}/api/subs"),
            true,
            None,
            Some("same-origin"),
        ),
    ] {
        let mut call = service.client.get(url);
        if auth {
            call = call.bearer_auth(&token);
        }
        if let Some(origin) = origin {
            call = call.header("Origin", origin);
        }
        if let Some(fetch) = fetch {
            call = call.header("Sec-Fetch-Site", fetch);
        }
        assert_eq!(call.send().await.unwrap().status(), 403);
    }
    assert_eq!(
        api(&service, "/api/subs", None, "GET").await["status"],
        "success"
    );
    service.stop().await.unwrap();
}
#[tokio::test]
async fn preserves_processor_and_missing_resource_error_reasons() {
    let data = tempfile::tempdir().unwrap();
    let service = SubStoreService::new(resource_root(), data.path().join("data"));
    api(&service, "/api/subs", Some(synthetic("broken")), "POST").await;
    api(&service, "/api/sub/broken", Some(json!({"process": [{"type": "Script Operator", "args": {"mode": "script", "content": "function operator(proxies) { throw new Error('native strict synthetic'); }"}}]})), "PATCH").await;
    let error = service
        .request(request("/download/broken?target=ClashMeta", None, "GET"))
        .await
        .unwrap_err();
    assert!(error.contains("native strict synthetic"), "{error}");
    let missing = service
        .request(request("/download/missing?target=ClashMeta", None, "GET"))
        .await
        .unwrap_err();
    assert!(missing.contains("RESOURCE_NOT_FOUND"), "{missing}");
    let before = service.snapshot().await.unwrap();
    assert_eq!(
        before["files"]["sub-store.json"]["subs"][0]["name"],
        "broken"
    );
    service.stop().await.unwrap();
}
#[tokio::test]
async fn complete_snapshot_roundtrip_preserves_unknown_fields_and_rejects_bad_data() {
    let data = tempfile::tempdir().unwrap();
    let service = SubStoreService::new(resource_root(), data.path().join("data"));
    api(&service, "/api/subs", Some(synthetic("original")), "POST").await;
    let mut snapshot = service.snapshot().await.unwrap();
    snapshot["files"]["root.json"]["customScriptState"] = json!({ "nested": [1, "keep", null] });
    snapshot["files"]["sub-store.json"]["futureOfficialField"] = json!({"advanced": true});
    service.restore_snapshot(&snapshot).await.unwrap();
    let actual = service.snapshot().await.unwrap();
    assert_eq!(actual, snapshot);
    for bad in [
        json!({"schemaVersion": 99, "engineVersion": VERSION, "files": {}}),
        json!({"schemaVersion": 1, "engineVersion": VERSION, "files": {"../root.json": {}, "sub-store.json": {"settings": {}}}}),
        json!({"schemaVersion": 1, "engineVersion": VERSION, "files": {"root.json": {}, "sub-store.json": {"settings": {}, "subs": {}}}}),
    ] {
        assert!(service.restore_snapshot(&bad).await.is_err());
        assert_eq!(service.snapshot().await.unwrap(), snapshot);
    }
    service.stop().await.unwrap();
}
#[tokio::test]
async fn failed_readiness_during_restore_rolls_back_original_files() {
    let data = tempfile::tempdir().unwrap();
    let mut service = SubStoreService::new(resource_root(), data.path().join("data"));
    api(&service, "/api/subs", Some(synthetic("original")), "POST").await;
    let before = service.snapshot().await.unwrap();
    let mut changed = before.clone();
    changed["files"]["sub-store.json"]["subs"] = json!([]);
    service.ready_timeout = Duration::ZERO;
    let error = service.restore_snapshot(&changed).await.unwrap_err();
    assert!(error.contains("已回滚"), "{error}");
    assert_eq!(read_snapshot(&service.data).unwrap(), before);
    service.ready_timeout = Duration::from_secs(12);
    assert_eq!(service.start().await.phase, "running");
    assert_eq!(service.snapshot().await.unwrap(), before);
    service.stop().await.unwrap();
}
#[tokio::test]
async fn externally_killed_process_can_restart_and_missing_resources_fail_closed() {
    let data = tempfile::tempdir().unwrap();
    let service = SubStoreService::new(resource_root(), data.path().join("data"));
    assert_eq!(service.start().await.phase, "running");
    service
        .state()
        .process
        .as_mut()
        .unwrap()
        .child
        .kill()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while service.status().phase == "running" {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }).await.expect("killed process must exit");
    assert_eq!(service.status().phase, "failed");
    assert_eq!(service.start().await.phase, "running");
    service.stop().await.unwrap();
    let invalid = SubStoreService::new(data.path().join("missing"), data.path().join("unused"));
    assert_eq!(invalid.start().await.phase, "failed");
    assert!(!invalid.data.exists());
}
#[tokio::test]
async fn snapshot_transaction_prevents_interleaved_requests() {
    let data = tempfile::tempdir().unwrap();
    let service = SubStoreService::new(resource_root(), data.path().join("data"));
    let transaction = service.transaction().await;
    transaction.snapshot().await.unwrap();
    assert!(tokio::time::timeout(
        Duration::from_millis(100),
        service.request(request("/api/subs", None, "GET"))
    )
    .await
    .is_err());
    drop(transaction);
    assert_eq!(
        api(&service, "/api/subs", None, "GET").await["status"],
        "success"
    );
    service.stop().await.unwrap();
}
#[tokio::test]
async fn unknown_physical_files_are_rejected_without_being_lost() {
    let data = tempfile::tempdir().unwrap();
    let service = SubStoreService::new(resource_root(), data.path().join("data"));
    let before = service.snapshot().await.unwrap();
    fs::write(
        service.data.join("custom-script-file.json"),
        "{\"keep\":true}",
    )
    .unwrap();
    assert!(service.snapshot().await.is_err());
    assert!(service.restore_snapshot(&before).await.is_err());
    assert_eq!(
        fs::read_to_string(service.data.join("custom-script-file.json")).unwrap(),
        "{\"keep\":true}"
    );
    service.stop().await.unwrap();
}
#[tokio::test]
async fn corrupted_persistent_json_is_not_silently_reinitialized() {
    let data = tempfile::tempdir().unwrap();
    let service = SubStoreService::new(resource_root(), data.path().join("data"));
    fs::create_dir(&service.data).unwrap();
    fs::write(service.data.join("sub-store.json"), "{broken").unwrap();
    let status = service.start().await;
    assert_eq!(status.phase, "failed");
    assert!(status.error.unwrap().contains("损坏"));
    assert_eq!(
        fs::read_to_string(service.data.join("sub-store.json")).unwrap(),
        "{broken"
    );
}
#[tokio::test]
async fn interrupted_directory_exchange_recovers_original_data_before_start() {
    let data = tempfile::tempdir().unwrap();
    let service = SubStoreService::new(resource_root(), data.path().join("data"));
    api(&service, "/api/subs", Some(synthetic("original")), "POST").await;
    let before = service.snapshot().await.unwrap();
    service.stop().await.unwrap();
    let old = data
        .path()
        .join(".sub-store-before-00000000000000000000000000000000");
    let stage = data
        .path()
        .join(".sub-store-stage-00000000000000000000000000000000");
    fs::rename(&service.data, &old).unwrap();
    fs::create_dir(&stage).unwrap();
    fs::write(data.path().join(".sub-store-restore.json"), serde_json::to_vec(&json!({"schemaVersion": 1, "stage": stage.file_name().unwrap().to_str().unwrap(), "old": old.file_name().unwrap().to_str().unwrap()})).unwrap()).unwrap();
    assert_eq!(service.start().await.phase, "running");
    assert_eq!(service.snapshot().await.unwrap(), before);
    assert!(!old.exists());
    assert!(!stage.exists());
    service.stop().await.unwrap();
}
#[test]
fn async_operations_are_send_for_tauri_commands() {
    fn assert_send<T: Send>(_: T) {}
    let service = SubStoreService::new(resource_root(), PathBuf::from("unused"));
    assert_send(service.start());
    assert_send(service.snapshot());
    assert_send(service.request(request("/api/subs", None, "GET")));
}
fn fixture_resources(dir: &Path, replace: impl FnOnce(String) -> String) -> PathBuf {
    use sha2::{Digest, Sha256};
    let source = resource_root();
    let target = resources::target().unwrap();
    let destination = dir.join("resources");
    fs::create_dir_all(destination.join(&target)).unwrap();
    let mut manifest: Value =
        serde_json::from_slice(&fs::read(source.join(&target).join("manifest.json")).unwrap())
            .unwrap();
    for file in manifest["files"].as_array().unwrap() {
        let name = file["path"].as_str().unwrap();
        fs::hard_link(source.join(name), destination.join(name)).unwrap();
    }
    let bootstrap = destination.join("service-bootstrap.cjs");
    let updated = replace(fs::read_to_string(&bootstrap).unwrap());
    fs::remove_file(&bootstrap).unwrap();
    fs::write(&bootstrap, &updated).unwrap();
    for file in manifest["files"].as_array_mut().unwrap() {
        if file["path"] == "service-bootstrap.cjs" {
            file["bytes"] = json!(updated.len());
            file["sha256"] = json!(format!("{:x}", Sha256::digest(updated.as_bytes())));
        }
    }
    fs::write(
        destination.join(target).join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    destination
}
#[tokio::test]
async fn bind_collision_and_readiness_failure_fail_closed_and_allow_retry() {
    let collision = tempfile::tempdir().unwrap();
    let root = fixture_resources(collision.path(), |s| {
        s.replace("require(path.join(__dirname, 'sub-store.bundle.cjs'));", "require('node:net').createServer().listen(Number(process.env.SUB_STORE_BACKEND_API_PORT), '127.0.0.1', () => require(path.join(__dirname, 'sub-store.bundle.cjs')));")
    });
    let service = SubStoreService::new(root, collision.path().join("data"));
    let status = service.start().await;
    assert_eq!(status.phase, "failed");
    assert!(status.error.unwrap().contains("退出"));
    assert!(service.state().process.is_none());
    let timeout = tempfile::tempdir().unwrap();
    let root = fixture_resources(timeout.path(), |s| {
        s.replace(
            "require(path.join(__dirname, 'sub-store.bundle.cjs'));",
            "setInterval(() => {}, 1000);",
        )
    });
    let mut service = SubStoreService::new(root, timeout.path().join("data"));
    service.ready_timeout = Duration::from_millis(200);
    let status = service.start().await;
    assert_eq!(status.phase, "failed");
    assert!(status.error.unwrap().contains("就绪超时"));
    assert!(service.state().process.is_none());
    service.resources = resource_root();
    service.ready_timeout = Duration::from_secs(12);
    assert_eq!(service.start().await.phase, "running");
    service.stop().await.unwrap();
}
#[test]
fn resource_tampering_and_snapshot_limits_are_rejected() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture_resources(fixture.path(), |s| s);
    let bootstrap = root.join("service-bootstrap.cjs");
    fs::remove_file(&bootstrap).unwrap();
    fs::write(bootstrap, "altered").unwrap();
    assert!(resources::verify(&root).is_err());
    let value = json!({"schemaVersion":1,"engineVersion":VERSION,"files":{"root.json":{},"sub-store.json":{"settings":{},"unknown": "x".repeat(MAX_SNAPSHOT)}}});
    assert!(validate_snapshot(&value).unwrap_err().contains("大小限制"));
    assert!(validate_request(&request(
        "/api/subs",
        Some(json!({"content":"x".repeat(MAX_BODY)})),
        "POST"
    ))
    .unwrap_err()
    .contains("大小限制"));
}
#[tokio::test]
async fn oversized_real_service_response_is_rejected() {
    let data = tempfile::tempdir().unwrap();
    let service = SubStoreService::new(resource_root(), data.path().join("data"));
    let mut snapshot = service.snapshot().await.unwrap();
    snapshot["files"]["sub-store.json"]["files"] = json!([{ "name": "oversized", "source": "local", "content": "x".repeat(MAX_RESPONSE + 1024) }]);
    service.restore_snapshot(&snapshot).await.unwrap();
    let error = service
        .request(request("/api/wholeFile/oversized", None, "GET"))
        .await
        .unwrap_err();
    assert!(error.contains("大小限制"), "{error}");
    service.stop().await.unwrap();
}
#[cfg(target_os = "macos")]
#[tokio::test]
async fn records_darwin_runtime_baseline_using_bundled_node() {
    let data = tempfile::tempdir().unwrap();
    let service = SubStoreService::new(resource_root(), data.path().join("data"));
    assert_eq!(service.start().await.phase, "running");
    api(&service, "/api/subs", Some(synthetic("baseline")), "POST").await;
    let pid = service.state().process.as_ref().unwrap().child.id();
    let output = Command::new("ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    let rss: u64 = String::from_utf8(output.stdout)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert!(rss > 0);
    let evidence = json!({"target":resources::target().unwrap(),"engineVersion":VERSION,"nodeVersion":"24.18.0","nodeBytes":fs::metadata(resource_root().join(resources::target().unwrap()).join("node")).unwrap().len(),"bundleBytes":fs::metadata(resource_root().join("sub-store.bundle.cjs")).unwrap().len(),"residentKiB":rss,"sample":"one local synthetic subscription; no long-term memory claim"});
    let output = resource_root()
        .join("../../../.cache/cloud-tools-20261121/runtime/native-service-baseline.json");
    fs::write(output, serde_json::to_vec_pretty(&evidence).unwrap()).unwrap();
    service.stop().await.unwrap();
}
#[tokio::test]
async fn legitimate_json_file_with_status_field_is_returned_as_raw_text() {
    let data = tempfile::tempdir().unwrap();
    let service = SubStoreService::new(resource_root(), data.path().join("data"));
    let content = "{\"status\":\"failed\",\"message\":\"legitimate file content\"}";
    api(
        &service,
        "/api/files",
        Some(json!({"name":"json-file","source":"local","content":content})),
        "POST",
    )
    .await;
    assert_eq!(
        service
            .request(request("/api/file/json-file", None, "GET"))
            .await
            .unwrap(),
        content
    );
    service.stop().await.unwrap();
}
#[tokio::test]
async fn complete_restore_pending_blocks_public_operations_but_coordinator_transaction_can_recover()
{
    let data = tempfile::tempdir().unwrap();
    let service = SubStoreService::new(resource_root(), data.path().join("data"));
    let before = service.snapshot().await.unwrap();
    let marker = data.path().join(".ppclash-complete-restore.json");
    fs::write(&marker, r#"{"version":1,"committed":false}"#).unwrap();
    let started = service.start().await;
    let requested = service.request(request("/api/subs", None, "GET")).await;
    let snapshotted = service.snapshot().await;
    let restored = service.restore_snapshot(&before).await;
    assert_eq!(started.phase, "failed");
    assert!(started.error.unwrap().contains("重启"));
    assert!(requested.unwrap_err().contains("重启"));
    assert!(snapshotted.unwrap_err().contains("重启"));
    assert!(restored.unwrap_err().contains("重启"));
    assert_eq!(service.status().phase, "failed");
    assert_eq!(read_snapshot(&service.data).unwrap(), before);
    let transaction = service.transaction().await;
    let old = transaction.snapshot().await.unwrap();
    assert_eq!(old, before);
    let mut candidate = old.clone();
    candidate["files"]["root.json"]["coordinatorRecovery"] = json!(true);
    transaction.restore_snapshot(&candidate).await.unwrap();
    assert_eq!(transaction.snapshot().await.unwrap(), candidate);
    drop(transaction);
    assert!(service
        .request(request("/api/subs", None, "GET"))
        .await
        .is_err());
    fs::remove_file(marker).unwrap();
    assert_eq!(service.start().await.phase, "running");
    service.stop().await.unwrap();
}
fn disk_snapshot(value: &str) -> Value {
    json!({ "schemaVersion": 1, "engineVersion": VERSION, "files": { "root.json": {"unknown": value}, "sub-store.json": {"settings": {}, "subs": [], "future": {"keep": value}} } })
}
#[test]
fn offline_rollback_replaces_corrupt_candidate_with_valid_previous_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    fs::create_dir(&data).unwrap();
    fs::write(data.join("root.json"), b"{\"truncated\":").unwrap();
    fs::write(data.join("sub-store.json"), b"{\"subs\":[]}").unwrap();
    let previous = disk_snapshot("previous");
    recover_snapshot_on_disk(&data, &previous).unwrap();
    assert_eq!(read_snapshot(&data).unwrap(), previous);
    assert!(!restore_journal(&data).unwrap().exists());
}
#[test]
fn offline_rollback_survives_another_crash_with_a_corrupt_old_candidate() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let old = dir.path().join(".sub-store-before-00000000000000000000000000000000");
    let stage = dir.path().join(".sub-store-stage-00000000000000000000000000000000");
    fs::create_dir(&data).unwrap();
    fs::create_dir(&old).unwrap();
    fs::write(old.join("root.json"), b"{\"truncated\":").unwrap();
    let previous = disk_snapshot("previous");
    write_snapshot(&data, &previous).unwrap();
    write_restore_journal(&restore_journal(&data).unwrap(), &stage, &old).unwrap();
    assert!(recover_snapshot_on_disk(&data, &json!({"invalid":true})).is_err());
    assert!(old.exists());
    assert!(restore_journal(&data).unwrap().exists());
    recover_snapshot_on_disk(&data, &previous).unwrap();
    assert_eq!(read_snapshot(&data).unwrap(), previous);
    assert!(!old.exists());
    assert!(!restore_journal(&data).unwrap().exists());
}
#[test]
fn offline_previous_snapshot_restoration_requires_no_node_and_preserves_unknown_json() {
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().join("sub-store");
    fs::create_dir(&data).unwrap();
    write_snapshot(&data, &disk_snapshot("candidate")).unwrap();
    let previous = disk_snapshot("previous");
    recover_snapshot_on_disk(&data, &previous).unwrap();
    assert_eq!(read_snapshot(&data).unwrap(), previous);
    assert!(!restore_journal(&data).unwrap().exists());
    let absent = temp.path().join("previously-absent");
    recover_snapshot_on_disk(&absent, &previous).unwrap();
    assert_eq!(read_snapshot(&absent).unwrap(), previous);
}
#[test]
fn offline_recovery_first_finishes_existing_exchange_even_when_new_snapshot_is_invalid() {
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().join("sub-store");
    fs::create_dir(&data).unwrap();
    write_snapshot(&data, &disk_snapshot("candidate")).unwrap();
    let old = temp
        .path()
        .join(".sub-store-before-00000000000000000000000000000000");
    let stage = temp
        .path()
        .join(".sub-store-stage-00000000000000000000000000000000");
    fs::create_dir(&old).unwrap();
    write_snapshot(&old, &disk_snapshot("original")).unwrap();
    fs::create_dir(&stage).unwrap();
    write_snapshot(&stage, &disk_snapshot("staged")).unwrap();
    write_restore_journal(&restore_journal(&data).unwrap(), &stage, &old).unwrap();
    let error = recover_snapshot_on_disk(&data, &json!({"invalid":true})).unwrap_err();
    assert!(
        error.contains("快照"),
        "{error}; journal={}",
        fs::read_to_string(restore_journal(&data).unwrap()).unwrap_or_default()
    );
    assert_eq!(read_snapshot(&data).unwrap(), disk_snapshot("original"));
    assert!(!old.exists());
    assert!(!stage.exists());
    recover_snapshot_on_disk(&data, &disk_snapshot("previous")).unwrap();
    assert_eq!(read_snapshot(&data).unwrap(), disk_snapshot("previous"));
}
#[test]
fn offline_restore_and_interrupted_exchange_do_not_delete_unknown_physical_files() {
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().join("sub-store");
    fs::create_dir(&data).unwrap();
    write_snapshot(&data, &disk_snapshot("candidate")).unwrap();
    fs::write(data.join("custom-script-file"), "retained").unwrap();
    assert!(recover_snapshot_on_disk(&data, &disk_snapshot("previous")).is_err());
    assert_eq!(
        fs::read_to_string(data.join("custom-script-file")).unwrap(),
        "retained"
    );
    let old = temp
        .path()
        .join(".sub-store-before-00000000000000000000000000000000");
    let stage = temp
        .path()
        .join(".sub-store-stage-00000000000000000000000000000000");
    fs::create_dir(&old).unwrap();
    write_snapshot(&old, &disk_snapshot("original")).unwrap();
    fs::create_dir(&stage).unwrap();
    write_snapshot(&stage, &disk_snapshot("staged")).unwrap();
    write_restore_journal(&restore_journal(&data).unwrap(), &stage, &old).unwrap();
    assert!(recover_snapshot_on_disk(&data, &disk_snapshot("previous")).is_err());
    assert!(old.exists());
    assert!(restore_journal(&data).unwrap().exists());
    assert_eq!(
        fs::read_to_string(data.join("custom-script-file")).unwrap(),
        "retained"
    );
}
#[test]
fn legacy_platform_encoded_exchange_log_is_recovered_without_path_escape() {
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().join("sub-store");
    fs::create_dir(&data).unwrap();
    write_snapshot(&data, &disk_snapshot("candidate")).unwrap();
    let old_name = ".sub-store-before-00000000000000000000000000000000";
    let stage_name = ".sub-store-stage-00000000000000000000000000000000";
    let old = temp.path().join(old_name);
    let stage = temp.path().join(stage_name);
    fs::create_dir(&old).unwrap();
    write_snapshot(&old, &disk_snapshot("original")).unwrap();
    fs::create_dir(&stage).unwrap();
    write_snapshot(&stage, &disk_snapshot("staged")).unwrap();
    let log = json!({"schemaVersion":1,"old":{"Unix":old_name.as_bytes()},"stage":{"Windows":stage_name.as_bytes()}});
    fs::write(
        restore_journal(&data).unwrap(),
        serde_json::to_vec(&log).unwrap(),
    )
    .unwrap();
    recover_snapshot_on_disk(&data, &disk_snapshot("previous")).unwrap();
    assert_eq!(read_snapshot(&data).unwrap(), disk_snapshot("previous"));
    assert!(!old.exists());
    assert!(!stage.exists());
    let hostile =
        json!({"schemaVersion":1,"old":{"Unix":b"../outside".as_slice()},"stage":stage_name});
    fs::write(
        restore_journal(&data).unwrap(),
        serde_json::to_vec(&hostile).unwrap(),
    )
    .unwrap();
    assert!(recover_snapshot_on_disk(&data, &disk_snapshot("next")).is_err());
    assert_eq!(read_snapshot(&data).unwrap(), disk_snapshot("previous"));
}
