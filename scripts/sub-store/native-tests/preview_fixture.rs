use super::*;

pub(crate) async fn wait_worker_ready(service: &SubStoreService, id: &str) {
    let started = std::time::Instant::now();
    // Setup includes the official snapshot restart and a separate preview Node.
    // Each real Node still runs with its unchanged 12-second readiness deadline.
    tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            let worker = {
                let slot = service.preview.lock().unwrap();
                let job = slot.as_ref().filter(|job| job.id == id).expect("preview reservation disappeared during setup");
                let worker = job.worker.lock().unwrap().as_ref().and_then(Weak::upgrade);
                worker
            };
            if let Some(worker) = worker {
                let status = worker.status();
                assert_ne!(status.phase, "failed", "preview worker failed during setup: {status:?}");
                if status.phase == "running" {
                    eprintln!("preview fixture worker ready after {:?}", started.elapsed());
                    return;
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("preview setup did not reach a ready real worker");
}
