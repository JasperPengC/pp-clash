//! 完整 Sub-Store 仅通过原生串行门面访问；持久数据事务与进程生命周期共用操作锁。
use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};
use tokio::sync::{Mutex as AsyncMutex, MutexGuard};
use uuid::Uuid;
#[path = "sub_store_resources.rs"]
mod resources;
#[path = "sub_store_preview.rs"]
mod preview;

pub const VERSION: &str = "2.44.16";
const MAX_BODY: usize = 8 * 1024 * 1024;
const MAX_RESPONSE: usize = 16 * 1024 * 1024;
const MAX_SNAPSHOT: usize = 32 * 1024 * 1024;
const PORT_CONFLICT_EXIT_CODE: i32 = 98;
const MAX_LAUNCH_ATTEMPTS: usize = 3;
const DATA_FILES: [&str; 2] = ["root.json", "sub-store.json"];

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ServiceStatus {
    pub phase: String,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
impl ServiceStatus {
    fn new(phase: &str, error: Option<String>) -> Self {
        Self {
            phase: phase.into(),
            version: VERSION.into(),
            error,
        }
    }
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServiceRequest {
    pub path: String,
    pub method: String,
    pub body: Option<Value>,
}
struct Process {
    child: Child,
    port: u16,
    prefix: String,
    token: String,
    startup_status: tempfile::TempDir,
}
impl Process {
    fn has_port_conflict_receipt(&self) -> bool {
        let path = self.startup_status.path().join("port-conflict");
        fs::symlink_metadata(&path)
            .is_ok_and(|metadata| metadata.is_file() && metadata.len() == self.token.len() as u64)
            && fs::read_to_string(path).is_ok_and(|value| value == self.token)
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
struct State {
    status: ServiceStatus,
    process: Option<Process>,
    startup_port_conflict: bool,
}
pub struct SubStoreService {
    resources: PathBuf,
    data: PathBuf,
    operation: AsyncMutex<()>,
    state: Mutex<State>,
    exiting: AtomicBool,
    restoring: AtomicBool,
    preview: Mutex<Option<std::sync::Arc<preview::PreviewJob>>>,
    client: reqwest::Client,
    ready_timeout: Duration,
}
pub struct ServiceTransaction<'a> {
    service: &'a SubStoreService,
    _guard: MutexGuard<'a, ()>,
}

impl SubStoreService {
    pub fn runtime_target() -> Result<String, String> {
        resources::target()
    }
    pub fn verify_resources(root: &Path) -> Result<(), String> {
        resources::verify(root).map(|_| ())
    }
    pub fn new(resources: PathBuf, data: PathBuf) -> Self {
        let status = match resources::target() {
            Ok(_) => ServiceStatus::new("stopped", None),
            Err(e) => ServiceStatus::new("unsupported", Some(e)),
        };
        Self {
            resources,
            data,
            operation: AsyncMutex::new(()),
            state: Mutex::new(State {
                status,
                process: None,
                startup_port_conflict: false,
            }),
            exiting: AtomicBool::new(false),
            restoring: AtomicBool::new(false),
            preview: Mutex::new(None),
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                // 本地请求不复用空闲连接，避免快照序列化或系统暂停后向已关闭连接写入。
                .pool_max_idle_per_host(0)
                .connect_timeout(Duration::from_secs(2))
                .timeout(Duration::from_secs(45))
                .build()
                .expect("fixed HTTP client configuration"),
            ready_timeout: Duration::from_secs(12),
        }
    }
    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
    pub fn status(&self) -> ServiceStatus {
        if let Err(error) = reject_pending_complete_restore(&self.data) {
            return ServiceStatus::new("failed", Some(error));
        }
        self.runtime_status()
    }
    fn runtime_status(&self) -> ServiceStatus {
        let mut state = self.state();
        let exited = state
            .process
            .as_mut()
            .and_then(|p| match p.child.try_wait() {
                Ok(Some(code)) => Some((
                    format!("Sub-Store 服务退出: {code}"),
                    code.code() == Some(PORT_CONFLICT_EXIT_CODE) && p.has_port_conflict_receipt(),
                )),
                Err(e) => Some((format!("Sub-Store 进程状态错误: {e}"), false)),
                _ => None,
            });
        if let Some((mut error, port_conflict)) = exited {
            state.startup_port_conflict = state.status.phase == "starting"
                && port_conflict;
            if state.startup_port_conflict {
                error = "Sub-Store 服务启动端口被占用（EADDRINUSE），进程已退出".into();
            }
            state.process.take();
            state.status = ServiceStatus::new("failed", Some(error));
        }
        state.status.clone()
    }
    pub async fn start(&self) -> ServiceStatus {
        let _guard = self.operation.lock().await;
        if let Err(error) = reject_pending_complete_restore(&self.data) {
            return ServiceStatus::new("failed", Some(error));
        }
        match self.start_locked().await {
            Ok(()) => self.status(),
            Err(e) => self.fail(e),
        }
    }
    pub async fn stop(&self) -> Result<(), String> {
        let _guard = self.operation.lock().await;
        self.stop_locked().await
    }
    pub async fn request(&self, request: ServiceRequest) -> Result<String, String> {
        validate_request(&request)?;
        let _guard = self.operation.lock().await;
        reject_pending_complete_restore(&self.data)?;
        self.start_locked().await.inspect_err(|e| {
            self.fail(e.clone());
        })?;
        self.request_locked(&request).await
    }
    pub async fn transaction(&self) -> ServiceTransaction<'_> {
        ServiceTransaction {
            service: self,
            _guard: self.operation.lock().await,
        }
    }
    pub async fn snapshot(&self) -> Result<Value, String> {
        let transaction = self.transaction().await;
        reject_pending_complete_restore(&self.data)?;
        transaction.snapshot().await
    }
    pub async fn restore_snapshot(&self, snapshot: &Value) -> Result<(), String> {
        let transaction = self.transaction().await;
        reject_pending_complete_restore(&self.data)?;
        transaction.restore_snapshot(snapshot).await
    }
    /// 在 App RunEvent::Exit 中调用；无需异步运行时，应用崩溃由 Node 的父进程监视补充回收。
    pub fn shutdown(&self) {
        self.exiting.store(true, Ordering::SeqCst);
        self.shutdown_preview();
        let mut state = self.state();
        state.process.take();
        state.status = ServiceStatus::new("stopped", None);
    }
    fn fail(&self, error: String) -> ServiceStatus {
        let mut state = self.state();
        state.process.take();
        if state.status.phase != "unsupported" {
            state.status = ServiceStatus::new("failed", Some(error));
        }
        state.status.clone()
    }
    async fn start_locked(&self) -> Result<(), String> {
        if !self.restoring.load(Ordering::SeqCst) && path_present(&restore_journal(&self.data)?)? {
            self.stop_locked().await?;
            recover_interrupted_restore(&self.data)?;
        }
        let status = self.runtime_status();
        if self.exiting.load(Ordering::SeqCst) {
            return Err("应用正在退出".into());
        }
        if status.phase == "unsupported" {
            return Err(status.error.unwrap_or_else(|| "此平台不受支持".into()));
        }
        if status.phase == "running" {
            return Ok(());
        }
        self.state().status = ServiceStatus::new("starting", None);
        let result = self.launch().await;
        if let Err(e) = &result {
            self.fail(e.clone());
        }
        result
    }
    async fn launch(&self) -> Result<(), String> {
        for attempt in 0..MAX_LAUNCH_ATTEMPTS {
            if self.exiting.load(Ordering::SeqCst) {
                return Err("应用正在退出".into());
            }
            {
                let mut state = self.state();
                state.status = ServiceStatus::new("starting", None);
                state.startup_port_conflict = false;
            }
            match self.launch_once().await {
                Ok(()) => return Ok(()),
                Err(error) => {
                    // 只重试bootstrap确认的监听竞争，不重放请求或任意启动失败。
                    if !self.state().startup_port_conflict || attempt + 1 == MAX_LAUNCH_ATTEMPTS {
                        return Err(error);
                    }
                }
            }
        }
        unreachable!("launch loop always returns on its last attempt")
    }
    async fn launch_once(&self) -> Result<(), String> {
        let binary = resources::verify(&self.resources)?;
        ensure_data_dir(&self.data)?;
        validate_disk(&self.data)?;
        let listener =
            TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("无法分配服务端口: {e}"))?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let prefix = format!("/{}", Uuid::new_v4().simple());
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let startup_status = tempfile::Builder::new()
            .prefix("ppclash-startup-")
            .tempdir_in(self.runtime_directory()?)
            .map_err(|e| format!("创建服务启动状态目录失败: {e}"))?;
        let mut command = Command::new(binary);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        command
            .arg(self.resources.join("service-bootstrap.cjs"))
            .current_dir(&self.data)
            .env_clear()
            .env("LANG", "en_US.UTF-8")
            .env("SUB_STORE_DATA_BASE_PATH", &self.data)
            .env("SUB_STORE_BACKEND_API_HOST", "127.0.0.1")
            .env("SUB_STORE_BACKEND_API_PORT", port.to_string())
            .env("SUB_STORE_BACKEND_PREFIX", "1")
            .env("SUB_STORE_FRONTEND_BACKEND_PATH", &prefix)
            .env("SUB_STORE_CORS_ALLOWED_ORIGINS", "https://native.invalid")
            .env("SUB_STORE_BODY_JSON_LIMIT", "8mb")
            .env("PPCLASH_SUB_STORE_TOKEN", &token)
            .env("PPCLASH_SUB_STORE_STARTUP_STATUS", startup_status.path().join("port-conflict"))
            .env(
                "PPCLASH_SUB_STORE_PARENT_PID",
                std::process::id().to_string(),
            )
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // 系统 TLS、临时目录及完整脚本执行环境；不继承用户 Node/proxy/Sub-Store 启动配置。
        for key in [
            "HOME",
            "USERPROFILE",
            "SYSTEMROOT",
            "WINDIR",
            "TEMP",
            "TMP",
            "TMPDIR",
            "PATH",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        for key in ["TMPDIR", "TMP", "TEMP"] {
            command.env(key, self.runtime_directory()?);
        }
        drop(listener);
        let child = command
            .spawn()
            .map_err(|e| format!("内置 Node 启动失败: {e}"))?;
        {
            let mut state = self.state();
            if self.exiting.load(Ordering::SeqCst) {
                drop(Process {
                    child,
                    port,
                    prefix,
                    token,
                    startup_status,
                });
                return Err("应用正在退出".into());
            }
            state.process = Some(Process {
                child,
                port,
                prefix,
                token,
                startup_status,
            });
        }
        let deadline = tokio::time::Instant::now() + self.ready_timeout;
        while tokio::time::Instant::now() < deadline {
            let phase = self.runtime_status().phase;
            if phase != "starting" {
                return Err(self
                    .runtime_status()
                    .error
                    .unwrap_or_else(|| "服务在就绪前退出".into()));
            }
            let probe = ServiceRequest {
                path: "/api/utils/env".into(),
                method: "GET".into(),
                body: None,
            };
            if let Ok(Ok(text)) =
                tokio::time::timeout(Duration::from_millis(500), self.request_locked(&probe)).await
            {
                if serde_json::from_str::<Value>(&text)
                    .ok()
                    .and_then(|v| {
                        v.pointer("/data/version")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                    })
                    .as_deref()
                    == Some(VERSION)
                {
                    let mut state = self.state();
                    if self.exiting.load(Ordering::SeqCst) || state.process.is_none() {
                        return Err("应用正在退出".into());
                    }
                    state.status = ServiceStatus::new("running", None);
                    return Ok(());
                }
            }
            tokio::time::sleep(Duration::from_millis(75)).await;
        }
        Err("Sub-Store 服务就绪超时；请检查端口与随包引擎资源".into())
    }
    async fn request_locked(&self, request: &ServiceRequest) -> Result<String, String> {
        let (url, token) = {
            let state = self.state();
            let p = state.process.as_ref().ok_or("Sub-Store 服务未运行")?;
            (
                format!("http://127.0.0.1:{}{}{}", p.port, p.prefix, request.path),
                p.token.clone(),
            )
        };
        let method = reqwest::Method::from_bytes(request.method.as_bytes())
            .map_err(|_| "不支持的服务方法")?;
        let mut builder = self.client.request(method, url).bearer_auth(token);
        if let Some(body) = &request.body {
            builder = builder
                .header("Content-Type", "application/json")
                .body(serde_json::to_vec(body).map_err(|e| e.to_string())?);
        }
        let mut response = builder.send().await.map_err(|e| {
            format!(
                "Sub-Store 请求失败: {}",
                if e.is_timeout() {
                    "处理超时"
                } else {
                    "服务连接异常"
                }
            )
        })?;
        let status = response.status();
        if response
            .content_length()
            .is_some_and(|len| len > MAX_RESPONSE as u64)
        {
            return Err("Sub-Store 响应超过大小限制".into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Sub-Store 响应读取失败")?
        {
            if bytes.len() + chunk.len() > MAX_RESPONSE {
                return Err("Sub-Store 响应超过大小限制".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let mut text = String::from_utf8(bytes).map_err(|_| "Sub-Store 响应不是 UTF-8 文本")?;
        if !status.is_success() {
            return Err(format!(
                "Sub-Store HTTP {}: {}",
                status.as_u16(),
                redact_error(&text)
            ));
        }
        if request.path.split('?').next() == Some("/api/utils/env") {
            let mut value: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
            if let Some(node) = value
                .pointer_mut("/data/meta/node")
                .and_then(Value::as_object_mut)
            {
                node.remove("env");
                node.remove("argv");
            }
            text = serde_json::to_string(&value).map_err(|e| e.to_string())?;
        }
        let raw_response = request.method == "GET"
            && (request.path.starts_with("/download/")
                || request.path.starts_with("/share/")
                || request.path.starts_with("/api/file/"));
        if !raw_response {
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                if value.get("status").and_then(Value::as_str) == Some("failed")
                    || value.get("status").and_then(Value::as_str) == Some("error")
                {
                    return Err(format!("Sub-Store: {}", redact_error(&text)));
                }
            }
        }
        Ok(text)
    }
    async fn stop_locked(&self) -> Result<(), String> {
        // 只有在途请求和定时任务均完成才退出；忙碌或超时不能冒充安全快照。
        if self.state().process.is_some() {
            if self.runtime_status().phase == "failed" {
                return Err("Sub-Store 已异常退出，不能确认数据完整，请重试启动".into());
            }
            let request = ServiceRequest {
                path: "/__ppclash_shutdown".into(),
                method: "POST".into(),
                body: None,
            };
            tokio::time::timeout(Duration::from_secs(6), self.request_locked(&request))
                .await.map_err(|_| "Sub-Store 停止超时，仍保留运行中的任务，请稍后重试")??;
            for _ in 0..40 {
                if self
                    .state()
                    .process
                    .as_mut()
                    .is_none_or(|p| p.child.try_wait().ok().flatten().is_some())
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            if self.state().process.as_mut().is_some_and(|p| p.child.try_wait().ok().flatten().is_none()) {
                return Err("Sub-Store 尚未退出，未生成快照，请稍后重试".into());
            }
        }
        let mut state = self.state();
        state.process.take();
        if state.status.phase != "unsupported" {
            state.status = ServiceStatus::new("stopped", None);
        }
        Ok(())
    }
}
impl ServiceTransaction<'_> {
    pub async fn snapshot(&self) -> Result<Value, String> {
        let service = self.service;
        service.start_locked().await?;
        service.stop_locked().await?;
        let result = read_snapshot(&service.data);
        let restart = service.start_locked().await;
        match (result, restart) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(e), _) => Err(e),
            (_, Err(e)) => Err(format!("快照后重启失败: {e}")),
        }
    }
    pub async fn restore_snapshot(&self, snapshot: &Value) -> Result<(), String> {
        validate_snapshot(snapshot)?;
        let service = self.service;
        service.start_locked().await?;
        let parent = service.data.parent().ok_or("无效服务数据目录")?;
        let journal = restore_journal(&service.data)?;
        service.restoring.store(true, Ordering::SeqCst);
        let _restore_activity = RestoreActivity(&service.restoring);
        let suffix = Uuid::new_v4().simple().to_string();
        let stage = parent.join(format!(".sub-store-stage-{suffix}"));
        let old = parent.join(format!(".sub-store-before-{suffix}"));
        fs::create_dir(&stage).map_err(|e| format!("创建恢复暂存目录失败: {e}"))?;
        set_private_directory(&stage)?;
        let write = write_snapshot(&stage, snapshot);
        if let Err(e) = write {
            let _ = fs::remove_dir_all(&stage);
            return Err(e);
        }
        if let Err(error) = service.stop_locked().await {
            let _ = fs::remove_dir_all(&stage);
            return Err(error);
        }
        if let Err(e) = read_snapshot(&service.data) {
            let _ = fs::remove_dir_all(&stage);
            let _ = service.start_locked().await;
            return Err(e);
        }
        write_restore_journal(&journal, &stage, &old)?;
        if let Err(e) = fs::rename(&service.data, &old) {
            let _ = fs::remove_dir_all(&stage);
            let _ = service.start_locked().await;
            return Err(format!("保存服务恢复前数据失败: {e}"));
        }
        let publish =
            fs::rename(&stage, &service.data).map_err(|e| format!("发布服务恢复数据失败: {e}"));
        let result = match publish {
            Ok(()) => service.start_locked().await.and_then(|_| {
                fs::remove_file(&journal).map_err(|e| format!("恢复提交标记写入失败: {e}"))
            }),
            Err(e) => Err(e),
        };
        if let Err(error) = result {
            service.stop_locked().await?;
            if service.data.exists() {
                fs::remove_dir_all(&service.data).map_err(|e| {
                    format!(
                        "恢复失败且无法清理候选数据: {error}; {e}; 原数据位于 {}",
                        old.display()
                    )
                })?;
            }
            fs::rename(&old, &service.data).map_err(|e| {
                format!(
                    "恢复失败且回滚失败: {error}; {e}; 原数据位于 {}",
                    old.display()
                )
            })?;
            let _ = fs::remove_file(&journal);
            let restart = service.start_locked().await;
            let _ = fs::remove_dir_all(&stage);
            return Err(match restart {
                Ok(()) => format!("恢复未发布，已回滚原数据: {error}"),
                Err(e) => format!("恢复未发布，原数据已回滚但重启失败: {error}; {e}"),
            });
        }
        let _ = fs::remove_dir_all(&old);
        Ok(())
    }
}

fn validate_request(request: &ServiceRequest) -> Result<(), String> {
    if !matches!(request.method.as_str(), "GET" | "POST" | "PATCH" | "DELETE") {
        return Err("不支持的 Sub-Store 请求方法".into());
    }
    if request.path.len() > 16 * 1024
        || !request.path.starts_with('/')
        || request.path.starts_with("//")
        || request.path.contains(['#', '\\'])
        || request.path.chars().any(char::is_control)
    {
        return Err("无效的 Sub-Store 请求路径".into());
    }
    let path = request.path.split('?').next().unwrap_or_default();
    let mut segments = path.split('/');
    segments.next();
    let root = segments.next().unwrap_or_default();
    if !matches!(root, "api" | "download" | "share") {
        return Err("此路径不属于 Sub-Store API".into());
    }
    for segment in segments {
        let bytes = segment.as_bytes();
        for (i, byte) in bytes.iter().enumerate() {
            if *byte == b'%'
                && (i + 2 >= bytes.len()
                    || !bytes[i + 1].is_ascii_hexdigit()
                    || !bytes[i + 2].is_ascii_hexdigit())
            {
                return Err("无效路径编码".into());
            }
        }
        let decoded = percent_decode_str(segment)
            .decode_utf8()
            .map_err(|_| "路径不是 UTF-8")?;
        if decoded.is_empty()
            || decoded == "."
            || decoded == ".."
            || decoded.contains(['/', '\\', '%', '#', '?'])
            || decoded.chars().any(char::is_control)
        {
            return Err("请求路径禁止跳转或重复编码".into());
        }
    }
    if path == "/api/storage" && request.method != "GET" {
        return Err("完整数据恢复必须使用原生事务接口".into());
    }
    if let Some(body) = &request.body {
        if serde_json::to_vec(body).map_err(|e| e.to_string())?.len() > MAX_BODY {
            return Err("Sub-Store 请求体超过大小限制".into());
        }
    }
    Ok(())
}
fn redact_error(text: &str) -> String {
    // 处理器错误原文保留；错误长度有限，避免把巨型下载体写进UI日志。
    text.chars().take(16 * 1024).collect()
}
pub fn validate_snapshot(snapshot: &Value) -> Result<(), String> {
    let object = snapshot
        .as_object()
        .ok_or("Sub-Store 快照必须为 JSON 对象")?;
    if object.len() != 3
        || object.get("schemaVersion").and_then(Value::as_u64) != Some(1)
        || object.get("engineVersion").and_then(Value::as_str) != Some(VERSION)
    {
        return Err("不支持的 Sub-Store 快照字段或版本".into());
    }
    let files = object
        .get("files")
        .and_then(Value::as_object)
        .ok_or("快照缺少完整持久数据")?;
    if files.len() != DATA_FILES.len()
        || DATA_FILES
            .iter()
            .any(|name| !files.get(*name).is_some_and(Value::is_object))
    {
        return Err("快照文件必须且只能包含 root.json 与 sub-store.json 对象".into());
    }
    let data = &files["sub-store.json"];
    if !data.get("settings").is_some_and(Value::is_object) {
        return Err("Sub-Store 数据缺少 settings 对象".into());
    }
    for key in [
        "subs",
        "collections",
        "files",
        "modules",
        "artifacts",
        "rules",
        "tokens",
        "archives",
    ] {
        if data.get(key).is_some_and(|v| !v.is_array()) {
            return Err(format!("Sub-Store 数据字段 {key} 必须为数组"));
        }
    }
    if serde_json::to_vec(snapshot)
        .map_err(|e| e.to_string())?
        .len()
        > MAX_SNAPSHOT
    {
        return Err("Sub-Store 快照超过大小限制".into());
    }
    Ok(())
}
fn set_private_directory(dir: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    Ok(())
}
impl SubStoreService {
    fn runtime_directory(&self) -> Result<PathBuf, String> {
        let directory = self.data.parent().ok_or("无效服务数据目录")?.join(".sub-store-runtime");
        ensure_data_dir(&directory)?;
        Ok(directory)
    }
}

fn ensure_data_dir(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("服务数据目录创建失败: {e}"))?;
    if !fs::symlink_metadata(dir)
        .map_err(|e| e.to_string())?
        .is_dir()
    {
        return Err("服务数据目录不能是链接".into());
    }
    set_private_directory(dir)
}
fn validate_disk(dir: &Path) -> Result<(), String> {
    for name in DATA_FILES {
        let path = dir.join(name);
        if path.exists() {
            let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
            if !metadata.is_file() || metadata.len() > MAX_SNAPSHOT as u64 {
                return Err(format!("服务持久数据无效: {name}"));
            }
            if !serde_json::from_slice::<Value>(&fs::read(&path).map_err(|e| e.to_string())?)
                .map_err(|e| format!("服务持久数据损坏: {name}: {e}"))?
                .is_object()
            {
                return Err(format!("服务持久数据不是对象: {name}"));
            }
        }
    }
    Ok(())
}
fn read_snapshot(dir: &Path) -> Result<Value, String> {
    validate_disk(dir)?;
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !DATA_FILES
            .iter()
            .any(|name| entry.file_name() == std::ffi::OsStr::new(name))
        {
            return Err(format!(
                "服务数据目录含不支持的文件，未执行覆盖: {}",
                entry.file_name().to_string_lossy()
            ));
        }
    }
    let mut files = serde_json::Map::new();
    for name in DATA_FILES {
        files.insert(
            name.into(),
            serde_json::from_slice(
                &fs::read(dir.join(name)).map_err(|e| format!("读取完整持久数据失败: {e}"))?,
            )
            .map_err(|e| e.to_string())?,
        );
    }
    let snapshot = json!({ "schemaVersion": 1, "engineVersion": VERSION, "files": files });
    validate_snapshot(&snapshot)?;
    Ok(snapshot)
}
fn write_snapshot(dir: &Path, snapshot: &Value) -> Result<(), String> {
    use std::io::Write;
    for name in DATA_FILES {
        let path = dir.join(name);
        let bytes =
            serde_json::to_vec_pretty(&snapshot["files"][name]).map_err(|e| e.to_string())?;
        let mut file = fs::File::create(&path)
            .map_err(|e| format!("恢复数据写入失败: {e}"))?;
        file.write_all(&bytes)
            .map_err(|e| format!("恢复数据写入失败: {e}"))?;
        file.sync_all()
            .map_err(|e| format!("恢复数据同步失败: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
#[cfg(test)]
#[path = "../../scripts/sub-store/native-tests/service_tests.rs"]
mod tests;

struct RestoreActivity<'a>(&'a AtomicBool);
impl Drop for RestoreActivity<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
fn restore_journal(data: &Path) -> Result<PathBuf, String> {
    Ok(data
        .parent()
        .ok_or("无效服务数据目录")?
        .join(".sub-store-restore.json"))
}
fn write_restore_journal(journal: &Path, stage: &Path, old: &Path) -> Result<(), String> {
    use std::io::Write;
    let stage_name = stage
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("无效暂存目录")?;
    let old_name = old
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("无效回滚目录")?;
    let bytes =
        serde_json::to_vec(&json!({"schemaVersion": 1, "stage": stage_name, "old": old_name}))
            .map_err(|e| e.to_string())?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(journal)
        .map_err(|e| format!("创建恢复日志失败: {e}"))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| format!("同步恢复日志失败: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(journal, fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
        fs::File::open(journal.parent().ok_or("无效恢复日志目录")?)
            .and_then(|f| f.sync_all())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn recover_interrupted_restore(data: &Path) -> Result<(), String> {
    recover_interrupted_restore_for_snapshot(data, false)
}
fn recover_interrupted_restore_for_snapshot(data: &Path, verified_previous: bool) -> Result<(), String> {
    let journal = restore_journal(data)?;
    let metadata = fs::symlink_metadata(&journal).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > 4096 {
        return Err("服务恢复日志类型或大小无效".into());
    }
    let value: Value = serde_json::from_slice(&fs::read(&journal).map_err(|e| e.to_string())?)
        .map_err(|e| format!("服务恢复日志损坏: {e}"))?;
    if value.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return Err("服务恢复日志版本不受支持".into());
    }
    let parent = data.parent().ok_or("无效服务数据目录")?;
    let resolve = |key: &str, prefix: &str| -> Result<PathBuf, String> {
        let name = value
            .get(key)
            .and_then(restore_log_name)
            .ok_or("恢复日志路径缺失")?;
        let suffix = name.strip_prefix(prefix).ok_or("恢复日志路径无效")?;
        if suffix.len() != 32 || !suffix.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err("恢复日志路径无效".into());
        }
        Ok(parent.join(name))
    };
    let stage = resolve("stage", ".sub-store-stage-")?;
    let old = resolve("old", ".sub-store-before-")?;
    for dir in [&stage, &old, data] {
        if path_present(dir)? {
            ensure_supported_directory(dir)?;
        }
    }
    if old.exists() {
        if ensure_supported_directory(&old)? > 0 && !verified_previous {
            read_snapshot(&old)?;
        }
        if data.exists() {
            fs::remove_dir_all(data).map_err(|e| format!("清理中断的候选恢复数据失败: {e}"))?;
        }
        fs::rename(&old, data).map_err(|e| format!("回滚中断的恢复失败: {e}"))?;
    }
    if stage.exists() {
        fs::remove_dir_all(stage).map_err(|e| e.to_string())?;
    }
    fs::remove_file(journal).map_err(|e| e.to_string())?;
    Ok(())
}

/// 仅在服务从未启动的初始化恢复阶段调用；调用者必须保证该目录无运行中的 Node 或其它写入者。
/// 不启动 Node，先回滚旧的服务交换日志，再事务发布跨应用日志保存的 previousSnapshot。
pub fn recover_snapshot_on_disk(data: &Path, snapshot: &Value) -> Result<(), String> {
    let journal = restore_journal(data)?;
    if path_present(&journal)? {
        // 重试离线回滚时 old 也可能是损坏候选；只有有效旧快照能允许继续。
        recover_interrupted_restore_for_snapshot(data, validate_snapshot(snapshot).is_ok())?;
    }
    validate_snapshot(snapshot)?;
    let parent = data.parent().ok_or("无效服务数据目录")?;
    fs::create_dir_all(parent).map_err(|e| format!("创建恢复父目录失败: {e}"))?;
    let had_data = path_present(data)?;
    if had_data {
        // 候选可能在崩溃时只写了一半；可靠来源是已校验的 previous snapshot。
        // 仍拒绝未知文件、目录及符号链接，不能借恢复删除用户额外内容。
        ensure_supported_directory(data)?;
    }
    let suffix = Uuid::new_v4().simple().to_string();
    let stage = parent.join(format!(".sub-store-stage-{suffix}"));
    let old = parent.join(format!(".sub-store-before-{suffix}"));
    fs::create_dir(&stage).map_err(|e| format!("创建离线恢复暂存目录失败: {e}"))?;
    let prepare = set_private_directory(&stage)
        .and_then(|_| write_snapshot(&stage, snapshot))
        .and_then(|_| read_snapshot(&stage).map(|_| ()));
    if let Err(error) = prepare {
        let _ = fs::remove_dir_all(&stage);
        return Err(error);
    }
    if let Err(error) = write_restore_journal(&journal, &stage, &old) {
        let _ = fs::remove_dir_all(&stage);
        return Err(error);
    }
    let publish = (|| -> Result<(), String> {
        if had_data {
            fs::rename(data, &old).map_err(|e| format!("保存离线恢复前数据失败: {e}"))?;
        }
        fs::rename(&stage, data).map_err(|e| format!("发布离线恢复数据失败: {e}"))?;
        if read_snapshot(data)? != *snapshot {
            return Err("离线恢复数据验证不一致".into());
        }
        fs::remove_file(&journal).map_err(|e| format!("提交离线恢复日志失败: {e}"))?;
        #[cfg(unix)]
        {
            fs::File::open(parent)
                .and_then(|file| file.sync_all())
                .map_err(|e| format!("同步离线恢复目录失败: {e}"))?;
        }
        Ok(())
    })();
    if let Err(error) = publish {
        // commit日志已成功删除时，候选已经完整发布；目录同步失败也必须显式回滚原数据。
        let rollback = (|| -> Result<(), String> {
            if old.exists() {
                if path_present(data)? {
                    ensure_supported_directory(data)?;
                    fs::remove_dir_all(data).map_err(|e| e.to_string())?;
                }
                fs::rename(&old, data).map_err(|e| e.to_string())?;
            } else if !had_data && data.exists() {
                ensure_supported_directory(data)?;
                fs::remove_dir_all(data).map_err(|e| e.to_string())?;
            }
            if stage.exists() {
                ensure_supported_directory(&stage)?;
                fs::remove_dir_all(&stage).map_err(|e| e.to_string())?;
            }
            if path_present(&journal)? {
                fs::remove_file(&journal).map_err(|e| e.to_string())?;
            }
            Ok(())
        })();
        return Err(match rollback {
            Ok(()) => format!("离线恢复未发布，原数据已保留: {error}"),
            Err(rollback_error) => format!(
                "离线恢复失败且回滚未完成: {error}; {rollback_error}; 原数据位于 {}",
                old.display()
            ),
        });
    }
    let _ = fs::remove_dir_all(old);
    Ok(())
}

fn reject_pending_complete_restore(data: &Path) -> Result<(), String> {
    if crate::complete_restore_state::pending(data.parent().ok_or("无效服务数据目录")?)? {
        return Err("跨应用完整恢复尚未完成，请重启应用完成恢复后再操作 Sub-Store".into());
    }
    Ok(())
}
fn path_present(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}
fn ensure_supported_directory(dir: &Path) -> Result<usize, String> {
    if !fs::symlink_metadata(dir)
        .map_err(|e| e.to_string())?
        .is_dir()
    {
        return Err("服务恢复路径不是安全目录".into());
    }
    let mut count = 0;
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !DATA_FILES
            .iter()
            .any(|name| entry.file_name() == std::ffi::OsStr::new(name))
            || !fs::symlink_metadata(entry.path())
                .map_err(|e| e.to_string())?
                .is_file()
        {
            return Err(format!(
                "服务恢复目录含不支持的文件，未执行覆盖: {}",
                entry.file_name().to_string_lossy()
            ));
        }
        count += 1;
    }
    Ok(count)
}

fn restore_log_name(value: &Value) -> Option<String> {
    if let Some(name) = value.as_str() {
        return Some(name.to_owned());
    }
    // 兼容旧版误将 OsStr 序列化为平台枚举的日志；目录名仍必须通过固定前缀及32hex校验。
    let object = value.as_object()?;
    if object.len() != 1 {
        return None;
    }
    let bytes = object
        .get("Unix")
        .or_else(|| object.get("Windows"))?
        .as_array()?;
    if bytes.len() > 128 {
        return None;
    }
    bytes
        .iter()
        .map(|value| {
            let byte = value.as_u64()?;
            if byte > 127 {
                return None;
            }
            Some(char::from(byte as u8))
        })
        .collect()
}
