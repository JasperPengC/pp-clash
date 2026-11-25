use super::*;
use std::sync::Arc;

#[tokio::test]
async fn preview_workspace_uses_application_storage_and_is_removed_after_completion() {
    let data = tempfile::tempdir().unwrap();
    let service = Arc::new(SubStoreService::new(resource_root(), data.path().join("data")));
    let marker = data.path().join("preview-workspace");
    let script = format!("function operator(proxies) {{ require('fs').writeFileSync({}, process.env.SUB_STORE_DATA_BASE_PATH); return proxies; }}", serde_json::to_string(&marker).unwrap());
    let mut entry = synthetic("preview-storage");
    entry["process"] = json!([{ "type": "Script Operator", "args": { "content": script } }]);
    let id = service.prepare_preview().unwrap();
    service.preview(&id, request("/api/preview/sub", Some(entry), "POST")).await.unwrap();
    let workspace = PathBuf::from(fs::read_to_string(marker).unwrap());
    assert!(workspace.starts_with(data.path().join(".sub-store-runtime")), "preview escaped app storage: {}", workspace.display());
    assert!(!workspace.exists());
    service.shutdown();
}

#[tokio::test]
async fn preview_timeout_reaps_a_real_async_script_and_releases_the_slot() {
    let data = tempfile::tempdir().unwrap();
    let service = Arc::new(SubStoreService::new(
        resource_root(),
        data.path().join("data"),
    ));
    let marker = data.path().join("timeout-worker");
    let script = format!("async function operator(proxies) {{ require('fs').writeFileSync({}, JSON.stringify([process.pid, process.env.SUB_STORE_DATA_BASE_PATH])); await new Promise(resolve => setTimeout(resolve, 65000)); return proxies; }}", serde_json::to_string(&marker).unwrap());
    let mut entry = synthetic("timed-out");
    entry["process"] = json!([{ "type": "Script Operator", "args": { "content": script } }]);
    assert_eq!(service.start().await.phase, "running");
    let id = service.prepare_preview().unwrap();
    let mut pending = Box::pin(service.preview(&id, request("/api/preview/sub", Some(entry), "POST")));
    tokio::select! {
        result = &mut pending => panic!("preview completed before worker readiness: {result:?}"),
        () = preview::wait_worker_ready(&service, &id) => {},
    }
    let error = tokio::time::timeout(
        Duration::from_secs(65),
        pending,
    )
    .await
    .unwrap()
    .unwrap_err();
    assert!(error.contains("超时"), "{error}");
    let worker: Value = serde_json::from_str(&fs::read_to_string(marker).unwrap()).unwrap();
    assert!(!Path::new(worker[1].as_str().unwrap()).exists());
    #[cfg(unix)]
    assert!(!Command::new("kill")
        .args(["-0", &worker[0].to_string()])
        .stderr(Stdio::null())
        .status()
        .unwrap()
        .success());
    assert!(service.prepare_preview().is_ok());
    service.shutdown();
}

#[tokio::test]
async fn preview_file_success_and_processor_failure_both_allow_next_request() {
    let data = tempfile::tempdir().unwrap();
    let service = Arc::new(SubStoreService::new(
        resource_root(),
        data.path().join("data"),
    ));
    let id = service.prepare_preview().unwrap();
    let result: Value = serde_json::from_str(&service.preview(&id, request("/api/preview/file", Some(json!({ "name": "file", "source": "local", "content": "mode: rule\n", "process": [] })), "POST")).await.unwrap()).unwrap();
    assert!(result["data"].to_string().contains("mode: rule"));
    let id = service.prepare_preview().unwrap();
    let mut entry = synthetic("broken");
    entry["process"] = json!([{ "type": "Script Operator", "args": { "content": "function operator() { throw new Error('preview failure test'); }" } }]);
    let error = service
        .preview(&id, request("/api/preview/sub", Some(entry), "POST"))
        .await
        .unwrap_err();
    assert!(error.contains("preview failure test"));
    assert!(error.contains("trace"));
    assert!(error.contains("processor"));
    assert!(service.prepare_preview().is_ok());
    service.shutdown();
}

#[tokio::test]
async fn preview_drop_during_snapshot_keeps_transaction_until_main_service_is_ready() {
    let data = tempfile::tempdir().unwrap();
    let marker = data.path().join("snapshot-stopping");
    let root = fixture_resources(data.path(), |source| {
        source
            .replace(
                "res.end('Stopping');",
                &format!(
                    "require('fs').writeFileSync({}, 'stopping'); res.end('Stopping');",
                    serde_json::to_string(&marker).unwrap()
                ),
            )
            .replace(
                ".then(() => process.exit(0));",
                ".then(() => setTimeout(() => process.exit(0), 400));",
            )
    });
    let service = Arc::new(SubStoreService::new(root, data.path().join("data")));
    assert_eq!(service.start().await.phase, "running");
    let id = service.prepare_preview().unwrap();
    {
        let mut pending = Box::pin(service.preview(
            &id,
            request(
                "/api/preview/sub",
                Some(synthetic("dropped-snapshot")),
                "POST",
            ),
        ));
        tokio::select! {
            result = &mut pending => panic!("unexpected result: {result:?}"),
            result = tokio::time::timeout(Duration::from_secs(10), async { while !marker.exists() { tokio::time::sleep(Duration::from_millis(5)).await; } }) => result.unwrap(),
        }
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(40), service.operation.lock())
            .await
            .is_err(),
        "aborted caller released an unfinished snapshot transaction"
    );
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            if service.preview.lock().unwrap().is_none() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(service.status().phase, "running");
    assert!(service.prepare_preview().is_ok());
    service.shutdown();
}

#[tokio::test]
async fn preview_cancel_before_execution_and_while_waiting_for_storage_lock() {
    let data = tempfile::tempdir().unwrap();
    let service = Arc::new(SubStoreService::new(
        resource_root(),
        data.path().join("data"),
    ));
    let id = service.prepare_preview().unwrap();
    assert!(!service.cancel_preview("other"));
    assert!(service.cancel_preview(&id));
    assert_eq!(
        service
            .preview(
                &id,
                request("/api/preview/sub", Some(synthetic("early")), "POST")
            )
            .await
            .unwrap_err(),
        "SUB_STORE_PREVIEW_CANCELLED"
    );
    assert!(service.state().process.is_none());
    let transaction = service.transaction().await;
    let id = service.prepare_preview().unwrap();
    let preview = service.preview(
        &id,
        request("/api/preview/sub", Some(synthetic("queued")), "POST"),
    );
    let cancel = async {
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(service.cancel_preview(&id));
    };
    let (result, ()) = tokio::time::timeout(Duration::from_secs(1), async {
        tokio::join!(preview, cancel)
    })
    .await
    .unwrap();
    assert_eq!(result.unwrap_err(), "SUB_STORE_PREVIEW_CANCELLED");
    drop(transaction);
    assert!(service.state().process.is_none());
}

#[tokio::test]
async fn preview_rejects_writes_duplicate_execution_and_stale_cancel() {
    let data = tempfile::tempdir().unwrap();
    let service = Arc::new(SubStoreService::new(
        resource_root(),
        data.path().join("data"),
    ));
    let id = service.prepare_preview().unwrap();
    assert!(service.prepare_preview().is_err());
    assert!(service
        .preview(
            &id,
            request("/api/subs", Some(synthetic("no-write")), "POST")
        )
        .await
        .unwrap_err()
        .contains("预览"));
    let next = service.prepare_preview().unwrap();
    assert!(!service.cancel_preview(&id));
    assert_ne!(id, next);
    service.cancel_preview(&next);
}

#[tokio::test]
async fn preview_kills_a_real_blocking_script_preserves_storage_and_can_run_again() {
    let data = tempfile::tempdir().unwrap();
    let service = Arc::new(SubStoreService::new(
        resource_root(),
        data.path().join("data"),
    ));
    api(&service, "/api/subs", Some(synthetic("saved")), "POST").await;
    let before = service.snapshot().await.unwrap();
    let marker = data.path().join("script-started");
    let script = format!("function operator(proxies) {{ require('fs').writeFileSync({}, String(process.pid)); $substore.write('temporary-preview', '#cancel-test'); while (true) {{}} }}", serde_json::to_string(&marker).unwrap());
    let mut entry = synthetic("blocking-draft");
    entry["process"] = json!([{ "type": "Script Operator", "args": { "content": script } }]);
    let id = service.prepare_preview().unwrap();
    let preview = service.preview(&id, request("/api/preview/sub", Some(entry), "POST"));
    let cancel = async {
        preview::wait_worker_ready(&service, &id).await;
        tokio::time::timeout(Duration::from_secs(20), async {
            while !marker.exists() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("script entered");
        let pid: u32 = fs::read_to_string(&marker).unwrap().parse().unwrap();
        let started = std::time::Instant::now();
        assert!(service.cancel_preview(&id));
        (pid, started)
    };
    let (result, (pid, started)) = tokio::join!(preview, cancel);
    assert_eq!(result.unwrap_err(), "SUB_STORE_PREVIEW_CANCELLED");
    assert!(started.elapsed() < Duration::from_secs(2));
    #[cfg(unix)]
    assert!(
        !Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success(),
        "preview process remains alive"
    );
    assert_eq!(service.snapshot().await.unwrap(), before);
    let id = service.prepare_preview().unwrap();
    let result: Value = serde_json::from_str(
        &service
            .preview(
                &id,
                request(
                    "/api/preview/collection",
                    Some(json!({ "name": "draft", "subscriptions": ["saved"], "process": [] })),
                    "POST",
                ),
            )
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(result["data"]["processed"][0]["name"], "Sample");
    assert_eq!(service.snapshot().await.unwrap(), before);
    assert!(!service.cancel_preview(&id));
    service.stop().await.unwrap();
}

#[tokio::test]
async fn preview_slow_download_cancel_closes_socket_and_does_not_cancel_a_save() {
    use std::io::{Read, Write};
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (connected_tx, connected_rx) = std::sync::mpsc::channel();
    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(25)))
            .unwrap();
        let mut buffer = [0; 4096];
        socket.read(&mut buffer).unwrap();
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100000\r\nContent-Type: text/plain\r\n\r\nproxies:").unwrap();
        connected_tx.send(()).unwrap();
        socket.read(&mut buffer)
    });
    let data = tempfile::tempdir().unwrap();
    let service = Arc::new(SubStoreService::new(
        resource_root(),
        data.path().join("data"),
    ));
    api(&service, "/api/subs", Some(synthetic("saved")), "POST").await;
    let id = service.prepare_preview().unwrap();
    let preview = service.preview(&id, request("/api/preview/sub", Some(json!({ "name": "slow", "source": "remote", "url": format!("http://{address}/slow"), "process": [] })), "POST"));
    let cancel = async {
        preview::wait_worker_ready(&service, &id).await;
        tokio::time::timeout(Duration::from_secs(20), async {
            while connected_rx.try_recv().is_err() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        assert!(!service.cancel_preview("unrelated"));
        assert!(service
            .preview(
                &id,
                request("/api/preview/sub", Some(synthetic("duplicate")), "POST")
            )
            .await
            .unwrap_err()
            .contains("重复"));
        api(
            &service,
            "/api/subs",
            Some(synthetic("saved-during-preview")),
            "POST",
        )
        .await;
        assert!(service.cancel_preview(&id));
    };
    let (result, ()) = tokio::join!(preview, cancel);
    assert_eq!(result.unwrap_err(), "SUB_STORE_PREVIEW_CANCELLED");
    match server.join().unwrap() {
        Ok(0) => {}
        Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => {}
        result => panic!("download stayed open: {result:?}"),
    }
    assert_eq!(
        api(&service, "/api/subs", None, "GET").await["data"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    service.stop().await.unwrap();
}

#[tokio::test]
async fn preview_call_drop_reaps_worker_and_releases_reservation() {
    let data = tempfile::tempdir().unwrap();
    let service = Arc::new(SubStoreService::new(
        resource_root(),
        data.path().join("data"),
    ));
    let marker = data.path().join("dropped-worker");
    let script = format!("function operator(proxies) {{ require('fs').writeFileSync({}, JSON.stringify([process.pid, process.env.SUB_STORE_DATA_BASE_PATH])); while (true) {{}} }}", serde_json::to_string(&marker).unwrap());
    let mut entry = synthetic("dropped");
    entry["process"] = json!([{ "type": "Script Operator", "args": { "content": script } }]);
    assert_eq!(service.start().await.phase, "running");
    let id = service.prepare_preview().unwrap();
    {
        let mut pending =
            Box::pin(service.preview(&id, request("/api/preview/sub", Some(entry), "POST")));
        tokio::select! {
            result = &mut pending => panic!("preview completed before worker readiness: {result:?}"),
            () = preview::wait_worker_ready(&service, &id) => {},
        }
        tokio::select! {
            result = &mut pending => panic!("unexpected preview completion: {result:?}"),
            result = tokio::time::timeout(Duration::from_secs(20), async { while fs::read_to_string(&marker).ok().and_then(|text| serde_json::from_str::<Value>(&text).ok()).is_none() { tokio::time::sleep(Duration::from_millis(20)).await; } }) => result.expect("script entered before dropping preview"),
        }
    }
    let worker: Value = serde_json::from_str(&fs::read_to_string(marker).unwrap()).unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while service.preview.lock().unwrap().is_some() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(!Path::new(worker[1].as_str().unwrap()).exists());
    #[cfg(unix)]
    assert!(!Command::new("kill")
        .args(["-0", &worker[0].to_string()])
        .stderr(Stdio::null())
        .status()
        .unwrap()
        .success());
    assert!(service.prepare_preview().is_ok());
    service.shutdown();
}

#[tokio::test]
async fn preview_discards_script_storage_and_scheduled_jobs_but_keeps_dependencies() {
    let data = tempfile::tempdir().unwrap();
    let service = Arc::new(SubStoreService::new(
        resource_root(),
        data.path().join("data"),
    ));
    let mut snapshot = service.snapshot().await.unwrap();
    snapshot["files"]["sub-store.json"]["artifacts"] =
        json!([{ "name": "scheduled", "cron": "* * * * * *", "sync": true, "source": "saved" }]);
    snapshot["files"]["root.json"]["previous-key"] = json!({"value": "retained"});
    service.restore_snapshot(&snapshot).await.unwrap();
    let marker = data.path().join("workspace");
    let script = format!("function operator(proxies) {{ require('fs').writeFileSync({}, process.env.SUB_STORE_DATA_BASE_PATH); const jobs = $substore.read('artifacts'); if (jobs.some(x => x.cron)) throw new Error('scheduled job copied into preview'); if ($substore.read('#previous-key').value !== 'retained') throw new Error('lost root storage'); $substore.write('changed', '#previous-key'); return proxies; }}", serde_json::to_string(&marker).unwrap());
    let mut entry = synthetic("isolated");
    entry["process"] = json!([{ "type": "Script Operator", "args": { "content": script } }]);
    let id = service.prepare_preview().unwrap();
    let result = service
        .preview(&id, request("/api/preview/sub", Some(entry), "POST"))
        .await;
    assert!(result.is_ok(), "{result:?}");
    assert!(
        !PathBuf::from(fs::read_to_string(marker).unwrap()).exists(),
        "temporary data remains"
    );
    assert_eq!(
        service.snapshot().await.unwrap()["files"]["root.json"]["previous-key"],
        json!({"value": "retained"})
    );
    service.stop().await.unwrap();
}
