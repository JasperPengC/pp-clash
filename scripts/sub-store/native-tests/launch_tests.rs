use super::*;

fn counted_bootstrap(source: String, counter: &Path, action: &str) -> String {
    source.replace(
        "require(path.join(__dirname, 'sub-store.bundle.cjs'));",
        &format!(
            "const fs = require('node:fs'); const counter = {}; const attempt = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) + 1 : 1; fs.writeFileSync(counter, String(attempt)); fs.appendFileSync(counter + '.status-paths', process.env.PPCLASH_SUB_STORE_STARTUP_STATUS + '\\n'); {action}",
            serde_json::to_string(counter).unwrap()
        ),
    )
}

fn assert_startup_directories_removed(counter: &Path) {
    let paths = fs::read_to_string(format!("{}.status-paths", counter.display())).unwrap();
    for path in paths.lines() {
        assert!(
            !Path::new(path).parent().unwrap().exists(),
            "startup directory retained: {path}"
        );
    }
}

const COLLISION: &str = "require('node:net').createServer().listen(Number(process.env.SUB_STORE_BACKEND_API_PORT), '127.0.0.1', () => require(path.join(__dirname, 'sub-store.bundle.cjs')));";

#[tokio::test]
async fn startup_receipt_uses_the_application_data_directory() {
    let data = tempfile::tempdir().unwrap();
    let counter = data.path().join("starts");
    let root = fixture_resources(data.path(), |source| {
        counted_bootstrap(source, &counter, "require(path.join(__dirname, 'sub-store.bundle.cjs'));")
    });
    let service = SubStoreService::new(root, data.path().join("data"));
    assert_eq!(service.start().await.phase, "running");
    service.stop().await.unwrap();
    let paths = fs::read_to_string(format!("{}.status-paths", counter.display())).unwrap();
    for path in paths.lines() {
        assert!(Path::new(path).starts_with(data.path().join(".sub-store-runtime")), "receipt escaped app storage: {path}");
    }
    assert_startup_directories_removed(&counter);
}

#[tokio::test]
async fn snapshot_restart_recovers_a_real_port_race_without_changing_saved_data() {
    let data = tempfile::tempdir().unwrap();
    let counter = data.path().join("starts");
    let root = fixture_resources(data.path(), |source| {
        counted_bootstrap(source, &counter, &format!("if (attempt === 2) {{ {COLLISION} }} else {{ require(path.join(__dirname, 'sub-store.bundle.cjs')); }}"))
    });
    let service = SubStoreService::new(root, data.path().join("data"));
    api(&service, "/api/subs", Some(synthetic("preserved")), "POST").await;
    let snapshot = service
        .snapshot()
        .await
        .expect("a transient port race must not fail the snapshot restart");
    assert_eq!(
        snapshot["files"]["sub-store.json"]["subs"][0],
        synthetic("preserved")
    );
    assert_eq!(fs::read_to_string(&counter).unwrap(), "3");
    assert_eq!(
        api(&service, "/api/sub/preserved", None, "GET").await["data"],
        synthetic("preserved")
    );
    service.stop().await.unwrap();
    assert_eq!(read_snapshot(&service.data).unwrap(), snapshot);
    assert_startup_directories_removed(&counter);
}

#[tokio::test]
async fn persistent_port_races_stop_after_three_attempts_and_release_the_worker() {
    let data = tempfile::tempdir().unwrap();
    let counter = data.path().join("starts");
    let root = fixture_resources(data.path(), |source| {
        counted_bootstrap(source, &counter, COLLISION)
    });
    let mut service = SubStoreService::new(root, data.path().join("data"));
    let status = service.start().await;
    assert_eq!(status.phase, "failed");
    assert!(
        status
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("EADDRINUSE"),
        "{status:?}"
    );
    assert_eq!(fs::read_to_string(&counter).unwrap(), "3");
    assert!(service.state().process.is_none());
    assert_startup_directories_removed(&counter);
    service.resources = resource_root();
    assert_eq!(service.start().await.phase, "running");
    service.stop().await.unwrap();
}

#[tokio::test]
async fn unrelated_startup_crashes_are_reported_without_replaying_initialization() {
    let data = tempfile::tempdir().unwrap();
    let counter = data.path().join("starts");
    let root = fixture_resources(data.path(), |source| {
        counted_bootstrap(source, &counter, "process.exit(1);")
    });
    let service = SubStoreService::new(root, data.path().join("data"));
    let status = service.start().await;
    assert_eq!(status.phase, "failed");
    assert!(
        status.error.as_deref().unwrap_or_default().contains("退出"),
        "{status:?}"
    );
    assert_eq!(fs::read_to_string(counter).unwrap(), "1");
    assert!(service.state().process.is_none());
}

#[tokio::test]
async fn readiness_timeout_does_not_repeat_initialization() {
    let data = tempfile::tempdir().unwrap();
    let counter = data.path().join("starts");
    let root = fixture_resources(data.path(), |source| {
        counted_bootstrap(source, &counter, "setInterval(() => {}, 1000);")
    });
    let mut service = SubStoreService::new(root, data.path().join("data"));
    // A cold Node may not execute the counted bootstrap within one second.
    // Keep the real production readiness budget while testing no retry on timeout.
    service.ready_timeout = Duration::from_secs(12);
    let status = service.start().await;
    assert_eq!(status.phase, "failed");
    assert!(
        status
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("就绪超时"),
        "{status:?}"
    );
    assert_eq!(fs::read_to_string(counter).unwrap(), "1");
    assert!(service.state().process.is_none());
}

#[tokio::test]
async fn script_exit_after_listening_before_readiness_is_not_a_port_race() {
    let data = tempfile::tempdir().unwrap();
    let counter = data.path().join("starts");
    let marker = data.path().join("listening");
    let root = fixture_resources(data.path(), |source| {
        let source = source.replace(
            "if (event === 'listening') servers.add(this);",
            &format!("if (event === 'listening') {{ servers.add(this); require('node:fs').appendFileSync({}, 'listening\\n'); process.exit(98); }}", serde_json::to_string(&marker).unwrap()),
        );
        counted_bootstrap(
            source,
            &counter,
            "require(path.join(__dirname, 'sub-store.bundle.cjs'));",
        )
    });
    let service = SubStoreService::new(root, data.path().join("data"));
    let status = service.start().await;
    assert_eq!(status.phase, "failed");
    assert!(!status.error.unwrap().contains("EADDRINUSE"));
    assert_eq!(fs::read_to_string(counter).unwrap(), "1");
    assert_eq!(fs::read_to_string(marker).unwrap(), "listening\n");
    assert!(service.state().process.is_none());
}

#[tokio::test]
async fn startup_conflict_receipt_must_belong_to_the_current_session() {
    let data = tempfile::tempdir().unwrap();
    let counter = data.path().join("starts");
    let root = fixture_resources(data.path(), |source| {
        counted_bootstrap(source, &counter,
        "fs.writeFileSync(process.env.PPCLASH_SUB_STORE_STARTUP_STATUS, '0'.repeat(process.env.PPCLASH_SUB_STORE_TOKEN.length)); process.exit(98);")
    });
    let service = SubStoreService::new(root, data.path().join("data"));
    let status = service.start().await;
    assert_eq!(status.phase, "failed");
    assert!(!status.error.unwrap().contains("EADDRINUSE"));
    assert_eq!(fs::read_to_string(&counter).unwrap(), "1");
    assert!(service.state().process.is_none());
    assert_startup_directories_removed(&counter);
}

#[tokio::test]
async fn collision_on_an_unrelated_http_endpoint_is_not_retried() {
    let data = tempfile::tempdir().unwrap();
    let counter = data.path().join("starts");
    let root = fixture_resources(data.path(), |source| {
        counted_bootstrap(source, &counter,
        "const other = require('node:net').createServer(); other.listen(0, '127.0.0.1', () => { if (other.address().port === Number(process.env.SUB_STORE_BACKEND_API_PORT)) process.exit(2); http.createServer().listen(other.address().port, '127.0.0.1'); });")
    });
    let service = SubStoreService::new(root, data.path().join("data"));
    let status = service.start().await;
    assert_eq!(status.phase, "failed");
    let error = status.error.unwrap();
    let expected_exit = if cfg!(windows) { "exit code: 1" } else { "exit status: 1" };
    assert!(error.contains(expected_exit), "{error}");
    assert_eq!(fs::read_to_string(counter).unwrap(), "1");
    assert!(service.state().process.is_none());
}

#[tokio::test]
async fn running_script_exit_is_not_replayed_even_with_the_startup_conflict_code() {
    let data = tempfile::tempdir().unwrap();
    let counter = data.path().join("starts");
    let marker = data.path().join("executions");
    let root = fixture_resources(data.path(), |source| {
        counted_bootstrap(
            source,
            &counter,
            "require(path.join(__dirname, 'sub-store.bundle.cjs'));",
        )
    });
    let service = SubStoreService::new(root, data.path().join("data"));
    let mut entry = synthetic("crash");
    entry["process"] = json!([{ "type": "Script Operator", "args": { "content": format!("function operator() {{ require('fs').appendFileSync({}, 'called\\n'); process.exit(98); }}", serde_json::to_string(&marker).unwrap()) } }]);
    api(&service, "/api/subs", Some(entry), "POST").await;
    assert!(service
        .request(request("/download/crash?target=ClashMeta", None, "GET"))
        .await
        .is_err());
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    while service.status().phase == "running" && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let status = service.status();
    assert_eq!(status.phase, "failed");
    assert!(!status.error.unwrap().contains("EADDRINUSE"));
    assert_eq!(fs::read_to_string(&counter).unwrap(), "1");
    assert_eq!(fs::read_to_string(marker).unwrap(), "called\n");
    assert_eq!(
        api(&service, "/api/subs", None, "GET").await["data"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(fs::read_to_string(counter).unwrap(), "2");
    service.stop().await.unwrap();
}
