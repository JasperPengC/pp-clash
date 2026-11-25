use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema_version: u32,
    engine_version: String,
    node_version: String,
    target: String,
    files: Vec<ResourceFile>,
}
#[derive(Deserialize)]
struct ResourceFile {
    path: String,
    sha256: String,
    bytes: u64,
}

pub fn target() -> Result<String, String> {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win",
        "linux" => "linux",
        "android" => "android",
        _ => return Err("此平台尚不支持完整内置 Node Sub-Store 服务".into()),
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        _ => return Err("此架构尚未提供完整内置 Node 运行时".into()),
    };
    Ok(format!("{os}-{arch}"))
}

pub fn verify(root: &Path) -> Result<PathBuf, String> {
    let target = target()?;
    let manifest_path = root.join(&target).join("manifest.json");
    let bytes = fs::read(&manifest_path)
        .map_err(|e| format!("缺少内置服务资源 {}: {e}", manifest_path.display()))?;
    if bytes.len() > 64 * 1024 {
        return Err("内置服务清单过大".into());
    }
    let manifest: Manifest =
        serde_json::from_slice(&bytes).map_err(|e| format!("内置服务清单无效: {e}"))?;
    if manifest.schema_version != 1
        || manifest.engine_version != super::VERSION
        || manifest.node_version != "24.18.0"
        || manifest.target != target
    {
        return Err("内置服务资源版本或架构不匹配".into());
    }
    let binary = format!(
        "{target}/{}",
        if target.starts_with("win-") {
            "node.exe"
        } else {
            "node"
        }
    );
    let expected = [
        "sub-store.bundle.cjs".to_owned(),
        "service-bootstrap.cjs".to_owned(),
        "build-provenance.json".to_owned(),
        "runtime-manifest.json".to_owned(),
        binary.clone(),
        format!("{target}/LICENSE"),
    ];
    if manifest.files.len() != expected.len()
        || expected.iter().any(|name| {
            manifest
                .files
                .iter()
                .filter(|file| &file.path == name)
                .count()
                != 1
        })
    {
        return Err("内置服务资源清单缺项或重复".into());
    }
    for file in manifest.files {
        let relative = Path::new(&file.path);
        if relative
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
        {
            return Err("内置资源路径无效".into());
        }
        let path = if file.path == binary { executable_path(root, &binary)? } else { root.join(relative) };
        let metadata =
            fs::symlink_metadata(&path).map_err(|e| format!("内置服务资源不可读: {e}"))?;
        if !metadata.is_file() || metadata.len() != file.bytes || metadata.len() > 256 * 1024 * 1024
        {
            return Err(format!("内置服务资源大小或类型不匹配: {}", file.path));
        }
        let mut reader = fs::File::open(&path).map_err(|e| e.to_string())?;
        let mut hash = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let count = reader.read(&mut buffer).map_err(|e| e.to_string())?;
            if count == 0 {
                break;
            }
            hash.update(&buffer[..count]);
        }
        if format!("{:x}", hash.finalize()) != file.sha256 {
            return Err(format!("内置服务资源校验失败: {}", file.path));
        }
    }
    executable_path(root, &binary)
}

fn executable_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    #[cfg(target_os = "android")]
    { let _ = (root, relative); crate::android::cloud_tools::binary() }
    #[cfg(not(target_os = "android"))]
    { Ok(root.join(relative)) }
}
