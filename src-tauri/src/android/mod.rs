use serde::Deserialize;
use serde_json::json;
use tauri::{plugin::PluginHandle, AppHandle, Manager, Wry};

use crate::{mihomo, platform, subscription, traffic};

pub(crate) mod kernel;
mod update;
pub(crate) mod cloud_tools;
pub(crate) mod resources;

struct Vpn(PluginHandle<Wry>);

#[tauri::command]
async fn android_system_theme(app: AppHandle, light: bool) -> Result<(), String> {
    app.state::<Vpn>().0.run_mobile_plugin_async::<serde_json::Value>("setSystemTheme", json!({ "light": light }))
        .await.map(|_| ()).map_err(|err| err.to_string())
}

#[tauri::command]
async fn read_subscription_file(app: AppHandle, path: String) -> Result<String, String> {
    #[derive(Deserialize)]
    struct Document { text: String }
    app.state::<Vpn>().0.run_mobile_plugin_async::<Document>("readDocument", json!({ "uri": path })).await
        .map(|document| document.text).map_err(|err| err.to_string())
}

#[tauri::command]
async fn export_log_file(app: AppHandle, path: String, content: String) -> Result<(), String> {
    if content.len() > 20 * 1024 * 1024 {
        return Err("日志超过 20 MB，无法导出".into());
    }
    app.state::<Vpn>().0.run_mobile_plugin_async::<serde_json::Value>("writeDocument", json!({ "uri": path, "content": content })).await
        .map(|_| ()).map_err(|err| err.to_string())
}

#[tauri::command]
fn traffic_rates() -> (f64, f64) {
    traffic::rates()
}

#[tauri::mobile_entry_point]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri::plugin::Builder::<Wry>::new("ppclash-vpn").setup(|app, api| {
            app.manage(Vpn(api.register_android_plugin("com.ppclash.app", "VpnPlugin")?));
            Ok(())
        }).build())
        .manage(kernel::KernelState::default())
        .manage(update::UpdateDownload::default())
        .setup(|app| {
            let base = app.path().app_data_dir()?;
            app.state::<Vpn>().0.run_mobile_plugin::<serde_json::Value>("initializeCloudTools", json!({"base": base}))?;
            platform::set_android_data_dir(base);
            // JNI initialization recovers once per process, including a WorkManager cold start.
            if let Err(error) = resources::schedule_saved() {
                eprintln!("Geo 后台任务尚未注册，请在资源页检查设置：{error}");
            }
            crate::webdav_commands::start_scheduler(app.handle().clone());
            tauri::async_runtime::spawn(traffic::run(app.handle().clone()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            android_system_theme,
            crate::update::check_github_update,
            update::android_app_info,
            update::download_app_update,
            update::open_downloaded_update,
            update::open_external_url,
            subscription::fetch_subscription,
            read_subscription_file,
            export_log_file,
            subscription::prepare_config,
            subscription::commit_config,
            subscription::finish_config,
            subscription::discard_config,
            subscription::save_config,
            subscription::load_app_state,
            subscription::save_app_state,
            subscription::backup_app_state,
            subscription::list_backups,
            subscription::restore_backup,
            crate::webdav_commands::webdav_list,
            crate::webdav_commands::webdav_upload,
            crate::webdav_commands::webdav_preview,
            crate::webdav_commands::webdav_restore,
            crate::webdav_commands::get_webdav_settings,
            crate::webdav_commands::save_webdav_settings,
            crate::webdav_commands::test_webdav_connection,
            crate::webdav_commands::webdav_backup_status,
            crate::webdav_commands::webdav_backup_now,
            crate::webdav_commands::webdav_backup_history,
            crate::webdav_commands::webdav_backup_delete,
            crate::webdav_commands::webdav_saved_preview,
            crate::webdav_commands::webdav_saved_restore,
            crate::sub_store_commands::sub_store_status,
            crate::sub_store_commands::sub_store_start,
            crate::sub_store_commands::sub_store_stop,
            crate::sub_store_commands::sub_store_request,
            crate::sub_store_commands::sub_store_preview_prepare,
            crate::sub_store_commands::sub_store_preview,
            crate::sub_store_commands::sub_store_preview_cancel,
            crate::sub_store_commands::sub_store_snapshot,
            crate::sub_store_commands::sub_store_restore_snapshot,
            resources::list_resource_files,
            resources::geo_auto_update_status,
            resources::download_geo_resource,
            resources::reinstall_bundled_resources,
            kernel::validate_config,
            kernel::start_kernel,
            kernel::stop_kernel,
            kernel::kernel_status,
            kernel::read_kernel_log,
            mihomo::mihomo_request,
            traffic_rates,
        ])
        .run(tauri::generate_context!())
        .expect("error while starting Android application");
}
