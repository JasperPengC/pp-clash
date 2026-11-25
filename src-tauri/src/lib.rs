#[cfg(desktop)]
use kernel::KernelState;
#[cfg(desktop)]
use prefs::AppFlags;
#[cfg(desktop)]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(desktop)]
use std::time::Duration;

#[cfg(desktop)]
use tauri::tray::TrayIconBuilder;
#[cfg(desktop)]
use tauri::{Emitter, Manager, WindowEvent};
#[cfg(target_os = "macos")]
use tauri::ActivationPolicy;

mod backup_state;
mod backup_cipher;
mod portable_backup;
mod webdav;
mod webdav_commands;
mod webdav_settings;
mod credential_store;
mod backup_history;
mod backup_scheduler;
mod webdav_backup;
mod backup_sub_store;
mod complete_restore_state;
mod sub_store_service;
mod sub_store_commands;
mod mihomo;
mod platform;
mod subscription;
mod traffic;

#[cfg(target_os = "android")]
mod android;
#[cfg(target_os = "android")]
pub use android::run;
#[cfg(target_os = "android")]
use android::kernel;

#[cfg(desktop)]
mod diagnostics;
#[cfg(desktop)]
mod icons;
#[cfg(desktop)]
mod kernel;
#[cfg(desktop)]
mod leakcheck;
#[cfg(all(desktop, any(target_os = "linux", test)))]
mod linux;
#[cfg(desktop)]
mod prefs;
#[cfg(desktop)]
mod resources;
#[cfg(desktop)]
mod services;
#[cfg(desktop)]
mod sysproxy;
#[cfg(desktop)]
mod tray;
mod update;
#[cfg(desktop)]
mod watchdog;

#[cfg(desktop)]
static HIDDEN_TO_TRAY: AtomicBool = AtomicBool::new(false);

#[cfg(desktop)]
#[tauri::command]
fn main_window_visible(app: tauri::AppHandle) -> bool {
    app.get_webview_window("main")
        .map(|w| w.is_visible().unwrap_or(true) && !w.is_minimized().unwrap_or(false))
        .unwrap_or(false)
}

/// 菜单栏常驻：禁止 macOS 在最后一个窗口关闭后自动终止进程。
#[cfg(target_os = "macos")]
fn disable_automatic_termination() {
    use objc2_foundation::{ns_string, NSProcessInfo};
    NSProcessInfo::processInfo()
        .disableAutomaticTermination(ns_string!("PP Clash menu bar resident"));
}

#[cfg(all(desktop, not(target_os = "macos")))]
fn disable_automatic_termination() {}

/// 把主窗口叫到前台。托盘点击和菜单项都走这里。
#[cfg(desktop)]
pub fn focus_main(app: &tauri::AppHandle) {
    // 从托盘/面板唤回主窗口时恢复 Dock 图标
    HIDDEN_TO_TRAY.store(false, Ordering::Relaxed);
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(ActivationPolicy::Regular);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        let _ = w.emit("window://visible", true);
    }
}


#[cfg(target_os = "windows")]
pub fn is_elevated() -> bool {
    platform::is_elevated()
}

#[cfg(desktop)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(KernelState::default())
        .manage(AppFlags::default())
        .invoke_handler(tauri::generate_handler![
            main_window_visible,
            resources::reinstall_bundled_resources,
            resources::list_kernel_versions,
            resources::list_resource_files,
            resources::download_kernel_version,
            resources::list_kernel_releases,
            kernel::remove_kernel_version,
            resources::download_geo_resource,
            resources::system_helper_info,
            resources::install_system_helper,
            resources::uninstall_system_helper,
            kernel::kernel_status,
            kernel::kernel_info,
            kernel::validate_config,
            kernel::read_kernel_log,
            kernel::start_kernel,
            kernel::stop_kernel,
            kernel::cleanup_stale_kernel,
            icons::resolve_process_icon,
            subscription::fetch_subscription,
            subscription::read_subscription_file,
            subscription::export_log_file,
            subscription::save_config,
            subscription::prepare_config,
            subscription::commit_config,
            subscription::finish_config,
            subscription::discard_config,
            subscription::save_app_state,
            subscription::load_app_state,
            subscription::backup_app_state,
            subscription::list_backups,
            subscription::restore_backup,
            webdav_commands::webdav_list,
            webdav_commands::webdav_upload,
            webdav_commands::webdav_preview,
            webdav_commands::webdav_restore,
            webdav_commands::get_webdav_settings,
            webdav_commands::save_webdav_settings,
            webdav_commands::test_webdav_connection,
            webdav_commands::webdav_backup_status,
            webdav_commands::webdav_backup_now,
            webdav_commands::webdav_backup_history,
            webdav_commands::webdav_backup_delete,
            webdav_commands::webdav_saved_preview,
            webdav_commands::webdav_saved_restore,
            sub_store_commands::sub_store_status,
            sub_store_commands::sub_store_start,
            sub_store_commands::sub_store_stop,
            sub_store_commands::sub_store_request,
            sub_store_commands::sub_store_preview_prepare,
            sub_store_commands::sub_store_preview,
            sub_store_commands::sub_store_preview_cancel,
            sub_store_commands::sub_store_snapshot,
            sub_store_commands::sub_store_restore_snapshot,
            mihomo::mihomo_request,
            sysproxy::set_system_proxy,
            sysproxy::get_system_proxy,
            prefs::set_close_to_tray,
            prefs::set_launch_login,
            prefs::open_data_dir,
            prefs::open_external_url,
            prefs::is_elevated,
            prefs::restart_as_admin,
            diagnostics::append_diagnostic_log,
            diagnostics::export_diagnostics,
            services::check_ip_quality_auto,
            services::probe_services,
            services::probe_services_auto,
            services::probe_service_auto,
            services::probe_node_health,
            services::lookup_ip_country,
            services::lookup_ip_country_auto,
            tray::traffic_rates,
            tray::sync_tray,
            tray::set_tray_flags,
            tray::tray_snapshot,
            tray::tray_action,
            leakcheck::leak_check_ip,
            leakcheck::leak_check_dns,
            update::check_app_update,
            update::check_github_update,
            update::download_app_update,
            update::open_downloaded_update,
        ])
        .setup(|app| {
            disable_automatic_termination();
            backup_sub_store::recover(&platform::data_dir()?).map_err(std::io::Error::other)?;
            webdav_commands::start_scheduler(app.handle().clone());
            // 看门狗会拉起 PowerShell（Windows），延后到首屏之后再启动，避免拖慢冷启动。
            let watchdog_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(1200)).await;
                watchdog::start(&watchdog_handle);
            });
            // 兜底：无论窗口配置怎么变，启动后都把主窗口显示出来并置前
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                #[cfg(target_os = "windows")]
                {
                    let _ = w.set_decorations(false);
                    let _ = w.set_shadow(false);
                    if let Ok(hwnd) = w.hwnd() {
                        platform::remove_native_caption(hwnd.0 as isize);
                    }
                }
                let _ = w.set_focus();
            }

            // show() 之后 Windows 11 可能会重新补上阴影/边框，延迟再压一次。
            #[cfg(target_os = "windows")]
            {
                let h = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(600)).await;
                    if let Some(w) = h.get_webview_window("main") {
                        let _ = w.set_decorations(false);
                        let _ = w.set_shadow(false);
                        if let Ok(hwnd) = w.hwnd() {
                            platform::remove_native_caption(hwnd.0 as isize);
                        }
                    }
                });
            }

            // 猫头保留状态眼睛色；macOS 的头部/网速由菜单栏按钮自身外观适配。
            let tray_icon = tauri::include_image!("resources/tray/off-dark.png");
            let tray_builder = TrayIconBuilder::with_id("main")
                .icon(tray_icon)
                .icon_as_template(false)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| tray::on_tray_click(tray.app_handle(), event));

            // AppIndicator 不转发 TrayIconEvent::Click；保留菜单才能从托盘唤回窗口。
            #[cfg(target_os = "linux")]
            let tray_builder = {
                use tauri::menu::{Menu, MenuItem};
                let open = MenuItem::with_id(app, "open", "打开 PP Clash", true, None::<&str>)?;
                let panel = MenuItem::with_id(app, "panel", "快捷面板", true, None::<&str>)?;
                let settings = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
                tray_builder.menu(&Menu::with_items(app, &[&open,&panel,&settings,&quit])?)
                    .show_menu_on_left_click(true)
                    .on_menu_event(|app,event| {
                        let app = app.clone();
                        let id = event.id().as_ref().to_string();
                        tauri::async_runtime::spawn(async move {
                            match id.as_str() {
                                "panel" => tray::open_panel_from_menu(&app),
                                "settings" => { let _ = tray::tray_action(app,"open".into(),Some(serde_json::json!("settings"))).await; },
                                "open" => focus_main(&app),
                                "quit" => { let _ = tray::tray_action(app,"quit".into(),None).await; },
                                _ => {}
                            }
                        });
                    })
            };

            tray_builder.build(app)?;

            // 菜单内容按当前状态异步重建（内核状态 / 分组节点 / 代理开关）
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = tray::rebuild(&handle).await {
                    eprintln!("[tray] 初始菜单构建失败：{e}");
                }
            });

            // 每秒刷新托盘图标状态与实时网速；不重建菜单
            let traffic_handle = app.handle().clone();
            tauri::async_runtime::spawn(traffic::run(traffic_handle));
            let tick_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    let _ = tray::tick(&tick_handle).await;
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if matches!(event, WindowEvent::Focused(_) | WindowEvent::Resized(_)) {
                    let visible = window.is_visible().unwrap_or(true)
                        && !window.is_minimized().unwrap_or(false);
                    let _ = window.emit("window://visible", visible);
                }
                if let WindowEvent::Focused(true) = event {
                    #[cfg(target_os = "macos")]
                    let _ = window
                        .app_handle()
                        .set_activation_policy(ActivationPolicy::Regular);
                }
            }
            if window.label() == "tray-panel" {
                if let WindowEvent::Focused(false) = event {
                    tray::hide_panel(window.app_handle());
                }
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    tray::hide_panel(window.app_handle());
                }
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                // 关窗行为跟随设置：最小化到托盘（默认）或真正退出
                let to_tray = *window
                    .state::<AppFlags>()
                    .close_to_tray
                    .lock()
                    .unwrap();
                if to_tray {
                    api.prevent_close();
                    HIDDEN_TO_TRAY.store(true, Ordering::Relaxed);
                    let _ = window.hide();
                    let _ = window.emit("window://visible", false);
                    let hide_dock = *window
                        .state::<AppFlags>()
                        .hide_dock_on_close
                        .lock()
                        .unwrap();
                    if hide_dock {
                        #[cfg(target_os = "macos")]
                        let _ = window
                            .app_handle()
                            .set_activation_policy(ActivationPolicy::Accessory);
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { has_visible_windows: false, .. } = event {
            focus_main(app_handle);
        }
        if let tauri::RunEvent::Exit = event {
            webdav_commands::shutdown_scheduler();
            sub_store_commands::shutdown();
        }
        if let tauri::RunEvent::ExitRequested { code, api, .. } = event {
            // 用户点红点 / Cmd+W 关闭最后一个窗口时，Tauri 会请求退出；
            // 开了「关窗到托盘」且窗口已隐藏时拦下，让进程和菜单栏继续常驻。
            // 托盘「退出」走 app.exit()，code 为 Some，不受影响。
            if code.is_none() {
                let to_tray = *app_handle
                    .state::<AppFlags>()
                    .close_to_tray
                    .lock()
                    .unwrap();
                let hidden = HIDDEN_TO_TRAY.load(Ordering::Relaxed)
                    || app_handle
                        .get_webview_window("main")
                        .map(|w| !w.is_visible().unwrap_or(false))
                        .unwrap_or(false);
                if to_tray && hidden {
                    HIDDEN_TO_TRAY.store(true, Ordering::Relaxed);
                    api.prevent_exit();
                }
            }
        }
    });
}
