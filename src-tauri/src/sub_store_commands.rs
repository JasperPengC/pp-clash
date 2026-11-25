use crate::{
    platform,
    sub_store_service::{ServiceRequest, ServiceStatus, SubStoreService},
};
use serde_json::Value;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::AppHandle;
#[cfg(not(target_os = "android"))]
use tauri::Manager;
static SERVICE: OnceLock<Arc<SubStoreService>> = OnceLock::new();
static INITIALIZATION: Mutex<()> = Mutex::new(());

/// 仅首次解析随包资源；数据长期存 platform::data_dir()/sub-store，与应用配置分离。
pub fn service(app: &AppHandle) -> Result<&'static Arc<SubStoreService>, String> {
    #[cfg(target_os = "android")]
    { let _ = app; return background_service(); }
    #[cfg(not(target_os = "android"))]
    {
        let root = app.path().resource_dir().map_err(|e| format!("无法定位内置服务资源: {e}"))?;
        #[allow(unused_mut)]
        let mut candidates = vec![root.join("sub-store"), root.join("resources/sub-store")];
        #[cfg(debug_assertions)]
        candidates.push(std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/sub-store"));
        initialize(candidates, root)
    }
}

#[cfg(target_os = "android")]
pub fn background_service() -> Result<&'static Arc<SubStoreService>, String> {
    let root = crate::android::cloud_tools::resources()?;
    initialize(vec![root.clone()], root)
}

fn initialize(candidates: Vec<std::path::PathBuf>, root: std::path::PathBuf) -> Result<&'static Arc<SubStoreService>, String> {
    if let Some(service) = SERVICE.get() {
        return Ok(service);
    }
    let _initialization = INITIALIZATION.lock().map_err(|_| "内置服务初始化锁不可用")?;
    if let Some(service) = SERVICE.get() {
        return Ok(service);
    }
    let resources = match SubStoreService::runtime_target() {
        Ok(target) => {
            let candidate = candidates
                .into_iter()
                .find(|dir| dir.join(&target).join("manifest.json").is_file())
                .ok_or("未找到当前架构的内置服务资源，请先运行 prepare-runtime.cjs")?;
            SubStoreService::verify_resources(&candidate)?;
            candidate
        }
        Err(_) => root.join("sub-store"),
    };
    let dir = platform::data_dir()?;
    crate::backup_sub_store::recover(&dir)?;
    let data = dir.join("sub-store");
    Ok(SERVICE.get_or_init(|| Arc::new(SubStoreService::new(resources, data))))
}
/// 由主入口 RunEvent::Exit 调用；隐藏窗口或页面卸载不应调用。
pub fn shutdown() {
    if let Some(service) = SERVICE.get() {
        service.shutdown();
    }
}
#[tauri::command]
pub async fn sub_store_status(app: AppHandle) -> Result<ServiceStatus, String> {
    Ok(service(&app)?.status())
}
#[tauri::command]
pub async fn sub_store_start(app: AppHandle) -> Result<ServiceStatus, String> {
    Ok(service(&app)?.start().await)
}
#[tauri::command]
pub async fn sub_store_stop() -> Result<(), String> {
    match SERVICE.get() {
        Some(service) => service.stop().await,
        None => Ok(()),
    }
}
#[tauri::command]
pub async fn sub_store_request(app: AppHandle, request: ServiceRequest) -> Result<String, String> {
    service(&app)?.request(request).await
}
#[tauri::command]
pub fn sub_store_preview_prepare(app: AppHandle) -> Result<String, String> {
    service(&app)?.prepare_preview()
}
#[tauri::command]
pub async fn sub_store_preview(app: AppHandle, id: String, request: ServiceRequest) -> Result<String, String> {
    service(&app)?.preview(&id, request).await
}
#[tauri::command]
pub fn sub_store_preview_cancel(app: AppHandle, id: String) -> Result<bool, String> {
    Ok(service(&app)?.cancel_preview(&id))
}
#[tauri::command]
pub async fn sub_store_snapshot(app: AppHandle) -> Result<Value, String> {
    service(&app)?.snapshot().await
}
#[tauri::command]
pub async fn sub_store_restore_snapshot(app: AppHandle, snapshot: Value) -> Result<(), String> {
    service(&app)?.restore_snapshot(&snapshot).await
}
