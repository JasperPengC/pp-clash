//! Android Keystore and WorkManager bridge, also usable before a window is created.
use jni::{objects::{GlobalRef, JClass, JString, JValue}, sys::jint, JNIEnv, JavaVM};
use std::{path::PathBuf, sync::OnceLock};
use crate::credential_store::Availability;

static JVM: OnceLock<JavaVM> = OnceLock::new();
static CLASS: OnceLock<GlobalRef> = OnceLock::new();
static RESOURCES: OnceLock<PathBuf> = OnceLock::new();
static BINARY: OnceLock<PathBuf> = OnceLock::new();
static RECOVERY: OnceLock<Result<(), String>> = OnceLock::new();

pub fn resources() -> Result<PathBuf, String> { RESOURCES.get().cloned().ok_or("内置服务资源尚未初始化".into()) }
pub fn binary() -> Result<PathBuf, String> { BINARY.get().cloned().ok_or("内置 Node 尚未初始化".into()) }

#[no_mangle]
pub extern "system" fn Java_com_ppclash_app_CloudTools_initializeNative(
    mut env: JNIEnv, class: JClass, base: JString, resources: JString, binary: JString,
) {
    let result = (|| -> jni::errors::Result<()> {
        let base: String = env.get_string(&base)?.into();
        let resources: String = env.get_string(&resources)?.into();
        let binary: String = env.get_string(&binary)?.into();
        let _ = JVM.set(env.get_java_vm()?);
        let _ = CLASS.set(env.new_global_ref(class)?);
        let _ = RESOURCES.set(resources.into());
        let _ = BINARY.set(binary.into());
        crate::platform::set_android_data_dir(base.into());
        Ok(())
    })();
    let recovered = result.is_ok() && RECOVERY.get_or_init(|| crate::platform::data_dir().and_then(|dir| crate::backup_sub_store::recover(&dir))).is_ok();
    if !recovered { let _ = env.throw_new("java/lang/IllegalStateException", "无法初始化原生云工具或恢复事务"); }
}

pub fn credential(action: &str, reference: &str, value: &str) -> Result<Option<zeroize::Zeroizing<String>>, Availability> {
    let mut env = JVM.get().ok_or(Availability::Unavailable)?.attach_current_thread().map_err(|_| Availability::Unavailable)?;
    let class: &JClass = CLASS.get().ok_or(Availability::Unavailable)?.as_obj().into();
    let result = (|| -> jni::errors::Result<Option<zeroize::Zeroizing<String>>> {
        let action = env.new_string(action)?;
        let reference = env.new_string(reference)?;
        let value = env.new_string(value)?;
        let output = env.call_static_method(class, "credential", "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;", &[
            JValue::Object(&action), JValue::Object(&reference), JValue::Object(&value),
        ])?.l()?;
        if output.is_null() { return Ok(None); }
        let text: String = env.get_string(&JString::from(output))?.into();
        Ok(Some(zeroize::Zeroizing::new(text)))
    })();
    if result.is_err() { let _ = env.exception_clear(); }
    result.map_err(|_| Availability::Unavailable)
}

pub fn schedule(enabled: bool) -> Result<(), String> {
    let mut env = JVM.get().ok_or("Android 后台任务尚未初始化")?.attach_current_thread().map_err(|_| "无法连接 Android 后台任务")?;
    let class: &JClass = CLASS.get().ok_or("Android 后台任务尚未初始化")?.as_obj().into();
    let result = env.call_static_method(class, "schedule", "(Z)V", &[JValue::Bool(enabled.into())]);
    if result.is_err() { let _ = env.exception_clear(); }
    result.map(|_| ()).map_err(|_| "无法更新 Android 后台任务".into())
}

#[no_mangle]
pub extern "system" fn Java_com_ppclash_app_CloudTools_runBackupNative(_env: JNIEnv, _class: JClass) -> jint {
    match tauri::async_runtime::block_on(crate::webdav_commands::run_android_background_backup()) {
        Ok(()) => 0,
        Err(_) if crate::webdav_commands::android_credentials_paused() => { let _ = schedule(false); 2 },
        Err(_) => 1,
    }
}
