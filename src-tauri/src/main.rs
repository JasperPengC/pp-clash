#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "windows")]
fn windows_preflight() -> bool {
    use windows_sys::Win32::Foundation::GetLastError;
    use windows_sys::Win32::System::Threading::CreateMutexW;

    let name: Vec<u16> = "Local\\PPClashInstance\0".encode_utf16().collect();
    let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr() as *const u16) };
    if !handle.is_null() && unsafe { GetLastError() } == 183 {
        // 已有实例在运行：让出，避免第二个 WebView2 抢同一个用户数据目录。
        return false;
    }

    // 只有上一次没有正常退出时才清理 WebView2 缓存，避免每次冷启动都重建缓存。
    let app_data = std::env::var("APPDATA")
        .map(|p| std::path::PathBuf::from(p).join("PPClash"))
        .ok();
    if let Some(data) = &app_data {
        let flag = data.join("running.flag");
        if flag.exists() {
            if let Ok(local) = std::env::var("LOCALAPPDATA") {
                let dir = std::path::PathBuf::from(local)
                    .join("com.ppclash.app")
                    .join("EBWebView");
                let _ = std::fs::remove_dir_all(dir);
            }
            let _ = std::fs::remove_file(&flag);
        }
        let _ = std::fs::create_dir_all(data);
        let _ = std::fs::write(flag, std::process::id().to_string());
    }
    let _ = handle;
    true
}


#[cfg(not(target_os = "windows"))]
fn unix_preflight() -> Result<Option<std::fs::File>, String> {
    use std::io::{Read, Seek, Write};

    let data = if cfg!(target_os = "macos") {
        std::env::var("HOME")
            .map(|h| std::path::PathBuf::from(h).join("Library/Application Support/PPClash"))
            .ok()
    } else {
        std::env::var("XDG_DATA_HOME")
            .ok()
            .map(std::path::PathBuf::from)
            .or_else(|| std::env::var("HOME").ok().map(|h| std::path::PathBuf::from(h).join(".local/share")))
            .map(|p| p.join("PPClash"))
    };
    let data = data.ok_or("无法定位应用数据目录")?;
    std::fs::create_dir_all(&data).map_err(|e| format!("无法创建应用数据目录: {e}"))?;
    let lock = data.join("instance.lock");
    // 保持文件及句柄到进程退出，不能删除锁文件，否则并发启动会锁住不同 inode。
    let mut file = std::fs::OpenOptions::new()
        .read(true).write(true).create(true).truncate(false)
        .open(lock).map_err(|e| format!("无法打开应用实例锁: {e}"))?;
    match file.try_lock() {
        Ok(()) => {}
        Err(std::fs::TryLockError::WouldBlock) => return Ok(None),
        Err(e) => return Err(format!("无法取得应用实例锁: {e}")),
    }
    // 兼容仍只写 PID 的旧版本，但不能把 PID 被复用的其他进程当成本应用。
    let mut bytes = Vec::new();
    (&mut file).take(64).read_to_end(&mut bytes)
        .map_err(|e| format!("无法读取应用实例锁: {e}"))?;
    if let Ok(pid) = String::from_utf8_lossy(&bytes).trim().parse::<u32>() {
        if legacy_instance_running(pid) {
            return Ok(None);
        }
    }
    file.rewind().map_err(|e| format!("无法更新应用实例锁: {e}"))?;
    file.set_len(0).map_err(|e| format!("无法更新应用实例锁: {e}"))?;
    write!(file, "{}", std::process::id()).map_err(|e| format!("无法写入应用实例锁: {e}"))?;
    Ok(Some(file))
}

#[cfg(not(target_os = "windows"))]
fn legacy_instance_running(pid: u32) -> bool {
    if pid <= 1 || pid == std::process::id() {
        return false;
    }
    #[cfg(target_os = "macos")]
    let executable = std::process::Command::new("/bin/ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output().ok().filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|path| std::path::PathBuf::from(path.trim()));
    #[cfg(not(target_os = "macos"))]
    let executable = std::fs::read_link(format!("/proc/{pid}/exe")).ok().map(|path| {
        use std::os::unix::ffi::{OsStrExt, OsStringExt};
        let bytes = path.as_os_str().as_bytes();
        std::path::PathBuf::from(std::ffi::OsString::from_vec(bytes.strip_suffix(b" (deleted)").unwrap_or(bytes).to_vec()))
    });
    executable.zip(std::env::current_exe().ok())
        .is_some_and(|(other, current)| other.file_name().is_some() && other.file_name() == current.file_name())
}

#[cfg(target_os = "windows")]
fn instance_running() -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::OpenMutexW;

    let name: Vec<u16> = "Local\\PPClashInstance\0".encode_utf16().collect();
    let handle = unsafe { OpenMutexW(0x0010_0000, 0, name.as_ptr() as *const u16) };
    if handle.is_null() {
        false
    } else {
        unsafe { let _ = CloseHandle(handle); }
        true
    }
}

/// Windows 默认以管理员模式启动：非提权进程先拉起 UAC，再退出自己。
/// 返回 true 表示“已经在本进程继续”，false 表示应直接退出。
#[cfg(target_os = "windows")]
fn ensure_elevated() -> bool {
    use std::os::windows::process::CommandExt;

    if ppclash_lib::is_elevated() {
        return true;
    }
    if instance_running() {
        return false;
    }
    let Ok(exe) = std::env::current_exe() else {
        return true;
    };
    let ps = format!(
        "Start-Process -FilePath '{}' -Verb RunAs",
        exe.display()
    );
    let status = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            &ps,
        ])
        .creation_flags(0x0800_0000)
        .status();
    match status {
        Ok(s) if s.success() => false,
        _ => true, // UAC 被取消时回退普通模式，至少让应用能打开
    }
}


#[cfg(target_os = "windows")]
fn bootstrap_log(message: &str) {
    if let Ok(appdata) = std::env::var("APPDATA") {
        let dir = std::path::PathBuf::from(appdata).join("PPClash");
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("bootstrap.log"))
        {
            use std::io::Write;
            let _ = writeln!(f, "[{}] {}", std::process::id(), message);
        }
    }
}

fn main() {
    #[cfg(target_os = "windows")]
    {
        bootstrap_log(&format!(
            "main start elevated={} instance={}",
            ppclash_lib::is_elevated(),
            instance_running()
        ));
        if !ensure_elevated() {
            bootstrap_log("ensure_elevated -> exit");
            return;
        }
        bootstrap_log("ensure_elevated -> continue");
        if !windows_preflight() {
            bootstrap_log("windows_preflight -> exit");
            return;
        }
        bootstrap_log("windows_preflight -> continue");
    }
    #[cfg(not(target_os = "windows"))]
    let _instance_lock = match unix_preflight() {
        Ok(Some(lock)) => lock,
        Ok(None) => return,
        Err(error) => {
            eprintln!("[startup] {error}");
            std::process::exit(1);
        }
    };
    ppclash_lib::run();
}
