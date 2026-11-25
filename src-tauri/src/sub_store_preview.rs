//! 预览和导出生成在完整数据副本中执行，取消不触碰正式服务和持久数据。
use super::*;
use std::sync::{Arc, Weak};
use tokio::sync::watch;

#[cfg(test)]
#[path = "../../scripts/sub-store/native-tests/preview_fixture.rs"]
mod test_fixture;
#[cfg(test)]
pub(super) use test_fixture::wait_worker_ready;

const CANCELLED: &str = "SUB_STORE_PREVIEW_CANCELLED";
pub(super) struct PreviewJob {
    id: String,
    created: std::time::Instant,
    started: AtomicBool,
    cancel: watch::Sender<bool>,
    worker: Mutex<Option<Weak<SubStoreService>>>,
}
impl PreviewJob {
    fn shutdown(&self) {
        self.cancel.send_replace(true);
        if let Some(worker) = self
            .worker
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .and_then(Weak::upgrade)
        {
            worker.shutdown();
        }
    }
}
struct PreviewLease {
    owner: Arc<SubStoreService>,
    job: Arc<PreviewJob>,
}
impl Drop for PreviewLease {
    fn drop(&mut self) {
        self.job.shutdown();
        let mut slot = self.owner.preview.lock().unwrap_or_else(|e| e.into_inner());
        if slot.as_ref().is_some_and(|job| Arc::ptr_eq(job, &self.job)) {
            slot.take();
        }
    }
}
struct CancelOnDrop(Arc<PreviewJob>);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel.send_replace(true);
    }
}
struct PreviewWorkspace {
    service: Arc<SubStoreService>,
    _directory: tempfile::TempDir,
}
impl Drop for PreviewWorkspace {
    fn drop(&mut self) {
        self.service.shutdown();
    }
}

impl SubStoreService {
    /// 两阶段入口使取消先于执行到达时仍有效；仅未执行的过期预留可被替换。
    pub fn prepare_preview(&self) -> Result<String, String> {
        let mut slot = self.preview.lock().unwrap_or_else(|e| e.into_inner());
        if self.exiting.load(Ordering::SeqCst) {
            return Err("应用正在退出".into());
        }
        if slot.as_ref().is_some_and(|job| {
            job.started.load(Ordering::SeqCst)
                || (!*job.cancel.borrow() && job.created.elapsed() < Duration::from_secs(60))
        }) {
            return Err("已有预览或导出正在准备或执行，请先取消或等待完成".into());
        }
        let (cancel, _) = watch::channel(false);
        let id = Uuid::new_v4().to_string();
        *slot = Some(Arc::new(PreviewJob {
            id: id.clone(),
            created: std::time::Instant::now(),
            started: AtomicBool::new(false),
            cancel,
            worker: Mutex::new(None),
        }));
        Ok(id)
    }
    pub fn cancel_preview(&self, id: &str) -> bool {
        let slot = self.preview.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(job) = slot.as_ref().filter(|job| job.id == id) {
            job.cancel.send_replace(true);
            true
        } else {
            false
        }
    }
    pub(super) fn shutdown_preview(&self) {
        let job = self
            .preview
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if let Some(job) = job {
            job.shutdown();
        }
    }
    pub async fn preview(
        self: &Arc<Self>,
        id: &str,
        request: ServiceRequest,
    ) -> Result<String, String> {
        let job = {
            let slot = self.preview.lock().unwrap_or_else(|e| e.into_inner());
            let job = slot.as_ref().filter(|job| job.id == id).ok_or(CANCELLED)?;
            if job.started.swap(true, Ordering::SeqCst) {
                return Err("预览或导出请求不能重复执行".into());
            }
            job.clone()
        };
        let lease = PreviewLease {
            owner: self.clone(),
            job: job.clone(),
        };
        validate_request(&request)?;
        let is_preview = request.method == "POST"
            && matches!(
                request.path.as_str(),
                "/api/preview/sub" | "/api/preview/collection" | "/api/preview/file"
            );
        let path = request.path.split('?').next().unwrap_or_default();
        let segments: Vec<_> = path.split('/').collect();
        let is_export = request.method == "GET" && request.body.is_none()
            && matches!(segments.as_slice(),
                ["", "download", _] | ["", "download", "collection", _] | ["", "api", "file", _]);
        if !is_preview && !is_export {
            return Err("可取消任务仅支持来源、组合和文件预览或导出".into());
        }
        // IPC调用future被丢弃时仅发取消；独立监督任务完成正式快照后再退出。
        let _cancel_on_drop = CancelOnDrop(job.clone());
        let service = self.clone();
        tokio::spawn(async move {
            let _lease = lease;
            service.execute_preview(job, request).await
        })
        .await
        .map_err(|e| format!("预览任务异常退出: {e}"))?
    }
    async fn execute_preview(
        &self,
        job: Arc<PreviewJob>,
        request: ServiceRequest,
    ) -> Result<String, String> {
        let mut cancel = job.cancel.subscribe();
        let mut snapshot = {
            let guard = tokio::select! {
                biased;
                _ = cancel.wait_for(|value| *value) => return Err(CANCELLED.into()),
                guard = self.operation.lock() => guard,
            };
            reject_pending_complete_restore(&self.data)?;
            // 开始后完整完成快照事务，避免取消打断正式服务的停止/重启。
            ServiceTransaction {
                service: self,
                _guard: guard,
            }
            .snapshot()
            .await?
        };
        if *cancel.borrow() {
            return Err(CANCELLED.into());
        }
        // 临时引擎只执行本次预览，不能把持久数据中的定时同步再启动一份。
        if let Some(artifacts) = snapshot
            .pointer_mut("/files/sub-store.json/artifacts")
            .and_then(Value::as_array_mut)
        {
            for artifact in artifacts {
                if let Some(object) = artifact.as_object_mut() {
                    object.remove("cron");
                }
            }
        }
        let directory = tempfile::Builder::new()
            .prefix("ppclash-preview-")
            .tempdir_in(self.runtime_directory()?)
            .map_err(|e| format!("创建预览临时目录失败: {e}"))?;
        let data = directory.path().join("data");
        ensure_data_dir(&data)?;
        write_snapshot(&data, &snapshot)?;
        let workspace = PreviewWorkspace {
            service: Arc::new(SubStoreService::new(self.resources.clone(), data)),
            _directory: directory,
        };
        *job.worker.lock().unwrap_or_else(|e| e.into_inner()) =
            Some(Arc::downgrade(&workspace.service));
        // 丢弃HTTP future不等于停止Node；workspace的Drop在返回前回收进程及数据。
        tokio::select! {
            biased;
            _ = cancel.wait_for(|value| *value) => Err(CANCELLED.into()),
            result = workspace.service.request(request) => result,
        }
    }
}
