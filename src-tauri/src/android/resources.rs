use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Manager};

use super::Vpn;
use jni::{objects::{GlobalRef, JClass, JString}, JNIEnv, JavaVM};
use std::sync::OnceLock;

static JVM: OnceLock<JavaVM> = OnceLock::new();
static CLASS: OnceLock<GlobalRef> = OnceLock::new();

#[no_mangle]
pub extern "system" fn Java_com_ppclash_app_ResourceTools_initializeNative(mut env: JNIEnv, class: JClass, base: JString) {
    let result = (|| -> jni::errors::Result<()> {
        let base: String = env.get_string(&base)?.into();
        let _ = JVM.set(env.get_java_vm()?);
        let _ = CLASS.set(env.new_global_ref(class)?);
        crate::platform::set_android_data_dir(base.into());
        Ok(())
    })();
    if result.is_err() { let _ = env.throw_new("java/lang/IllegalStateException", "无法初始化原生资源任务"); }
}

pub fn schedule_saved() -> Result<(), String> {
    let mut env = JVM.get().ok_or("Android 资源任务尚未初始化")?.attach_current_thread().map_err(|_| "无法连接 Android 资源任务")?;
    let class: &JClass = CLASS.get().ok_or("Android 资源任务尚未初始化")?.as_obj().into();
    let result = env.call_static_method(class, "scheduleSaved", "()V", &[]);
    if result.is_err() { let _ = env.exception_clear(); }
    result.map(|_| ()).map_err(|_| "无法更新 Android Geo 后台任务".into())
}

#[derive(Deserialize, Serialize)]
pub struct ResourceFileInfo {
    name: String,
    size: u64,
    exists: bool,
    #[serde(default, rename = "aliasOf", skip_serializing_if = "Option::is_none")]
    alias_of: Option<String>,
    #[serde(default, rename = "sourceUrl", skip_serializing_if = "Option::is_none")]
    source_url: Option<String>,
}

#[derive(Deserialize)]
struct ResourceFiles {
    files: Vec<ResourceFileInfo>,
}

#[derive(Deserialize)]
struct ResourceSize {
    size: u64,
}

#[derive(Deserialize)]
struct ReinstalledResources {
    message: String,
}

fn data_dir() -> Result<String, String> {
    crate::platform::data_dir().map(|path| path.display().to_string())
}

#[tauri::command]
pub async fn geo_auto_update_status(app: AppHandle) -> Result<serde_json::Value, String> {
    app.state::<Vpn>().0.run_mobile_plugin_async("geoUpdateStatus", json!({ "dir": data_dir()? }))
        .await.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn list_resource_files(app: AppHandle) -> Result<Vec<ResourceFileInfo>, String> {
    let result: ResourceFiles = app
        .state::<Vpn>()
        .0
        .run_mobile_plugin_async("listResourceFiles", json!({ "dir": data_dir()? }))
        .await
        .map_err(|error| error.to_string())?;
    Ok(result.files)
}

#[tauri::command]
pub async fn download_geo_resource(
    app: AppHandle,
    name: String,
    url: String,
    proxy_url: Option<String>,
    mirror_prefix: Option<String>,
) -> Result<u64, String> {
    let result: ResourceSize = app
        .state::<Vpn>()
        .0
        .run_mobile_plugin_async(
            "downloadGeoResource",
            json!({
                "dir": data_dir()?, "name": name, "url": url,
                "proxyUrl": proxy_url.unwrap_or_default(),
                "mirrorPrefix": mirror_prefix.unwrap_or_default(),
            }),
        )
        .await
        .map_err(|error| error.to_string())?;
    Ok(result.size)
}

#[tauri::command]
pub async fn reinstall_bundled_resources(app: AppHandle) -> Result<String, String> {
    let result: ReinstalledResources = app
        .state::<Vpn>()
        .0
        .run_mobile_plugin_async("reinstallBundledResources", json!({ "dir": data_dir()? }))
        .await
        .map_err(|error| error.to_string())?;
    Ok(result.message)
}
