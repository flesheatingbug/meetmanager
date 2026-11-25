// XC Organiser — Windows app shell.
// The whole app is the web UI in ../src; this adds what a browser can't do on its own:
// reading/writing the sync folder (OneDrive) and native Save dialogs.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};
use tauri::Emitter;

/// Published by the GitHub workflow on every build of main (rolling "latest-windows" release).
const UPDATE_URL: &str =
    "https://github.com/flesheatingbug/meetmanager/releases/download/latest-windows/latest.json";
const RELEASES_PAGE: &str = "https://github.com/flesheatingbug/meetmanager/releases/latest";

#[derive(Serialize)]
struct FileInfo {
    name: String,
    modified: f64,
    size: u64,
}

/// Only plain file names inside the sync folder are allowed (no paths).
fn safe_name(name: &str) -> Result<&str, String> {
    if name.is_empty()
        || name.contains(['/', '\\', ':'])
        || name.contains("..")
        || name.starts_with('.')
    {
        return Err(format!("Not allowed: {name}"));
    }
    Ok(name)
}

fn err(e: std::io::Error) -> String {
    e.to_string()
}

/// "%OneDrive%\XC Organiser" if OneDrive is set up on this computer.
#[tauri::command]
fn sync_default_folder() -> Option<String> {
    for var in ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"] {
        if let Ok(p) = std::env::var(var) {
            let base = Path::new(&p);
            if !p.is_empty() && base.is_dir() {
                return Some(base.join("XC Organiser").to_string_lossy().into_owned());
            }
        }
    }
    None
}

#[tauri::command]
fn device_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "This computer".into())
}

#[tauri::command]
async fn pick_folder() -> Option<String> {
    rfd::AsyncFileDialog::new()
        .set_title("Choose the folder to sync meets through")
        .pick_folder()
        .await
        .map(|f| f.path().to_string_lossy().into_owned())
}

#[tauri::command]
fn sync_list(folder: String) -> Result<Vec<FileInfo>, String> {
    let dir = PathBuf::from(&folder);
    fs::create_dir_all(&dir).map_err(err)?;
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(err)?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.to_lowercase().ends_with(".json") || name.starts_with("~$") {
            continue;
        }
        if let Ok(md) = entry.metadata() {
            if md.is_file() {
                let modified = md
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as f64)
                    .unwrap_or(0.0);
                out.push(FileInfo { name, modified, size: md.len() });
            }
        }
    }
    Ok(out)
}

#[tauri::command]
fn sync_read(folder: String, name: String) -> Result<String, String> {
    fs::read_to_string(PathBuf::from(folder).join(safe_name(&name)?)).map_err(err)
}

/// Write via a temporary file + rename so OneDrive never uploads a half-written meet.
#[tauri::command]
fn sync_write(folder: String, name: String, contents: String) -> Result<(), String> {
    let dir = PathBuf::from(folder);
    fs::create_dir_all(&dir).map_err(err)?;
    let name = safe_name(&name)?;
    let tmp = dir.join(format!("~${name}.tmp")); // OneDrive skips "~$" files
    fs::write(&tmp, contents.as_bytes()).map_err(err)?;
    fs::rename(&tmp, dir.join(name)).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

#[tauri::command]
fn sync_remove(folder: String, name: String) -> Result<(), String> {
    match fs::remove_file(PathBuf::from(folder).join(safe_name(&name)?)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Native "Save as" for exports (Excel, CSV, meet files, backups).
#[tauri::command]
async fn save_file(name: String, contents_b64: String) -> Result<Option<String>, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(contents_b64)
        .map_err(|e| e.to_string())?;
    let ext = Path::new(&name)
        .extension()
        .map(|e| e.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut dialog = rfd::AsyncFileDialog::new().set_file_name(&name);
    if !ext.is_empty() {
        dialog = dialog.add_filter(ext.to_uppercase(), &[ext.as_str()]);
    }
    match dialog.save_file().await {
        Some(file) => {
            fs::write(file.path(), bytes).map_err(err)?;
            Ok(Some(file.path().to_string_lossy().into_owned()))
        }
        None => Ok(None),
    }
}

// ---------- updates ----------

#[tauri::command]
fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

fn update_dir() -> PathBuf {
    std::env::temp_dir().join("xc-organiser-update")
}

/// Fetch latest.json: {version, url, sha256, size, published}
#[tauri::command]
async fn update_check() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let body = ureq::get(UPDATE_URL)
            .set("User-Agent", "XC-Organiser")
            .timeout(Duration::from_secs(20))
            .call()
            .map_err(|e| e.to_string())?
            .into_string()
            .map_err(err)?;
        serde_json::from_str::<serde_json::Value>(&body).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Download the installer in the background, reporting progress, and check its SHA-256.
#[tauri::command]
async fn update_download(
    app: tauri::AppHandle,
    url: String,
    sha256: String,
    version: String,
) -> Result<String, String> {
    if !url.starts_with("https://github.com/flesheatingbug/meetmanager/releases/download/") {
        return Err("Unexpected download address".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let resp = ureq::get(&url)
            .set("User-Agent", "XC-Organiser")
            .call()
            .map_err(|e| e.to_string())?;
        let total: u64 = resp
            .header("Content-Length")
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        let dir = update_dir();
        fs::create_dir_all(&dir).map_err(err)?;
        let ver: String = version
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '.')
            .collect();
        let path = dir.join(format!("XC-Organiser-setup-{ver}.exe"));
        let mut file = fs::File::create(&path).map_err(err)?;
        let mut reader = resp.into_reader();
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 64 * 1024];
        let (mut done, mut reported) = (0u64, 0u64);
        loop {
            let n = reader.read(&mut buf).map_err(err)?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n]).map_err(err)?;
            hasher.update(&buf[..n]);
            done += n as u64;
            if total > 0 && (done - reported >= total / 50 || done == total) {
                reported = done;
                let _ = app.emit("update-progress", done as f64 / total as f64);
            }
        }
        file.flush().map_err(err)?;
        drop(file);
        let got: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
        if !got.eq_ignore_ascii_case(sha256.trim()) {
            let _ = fs::remove_file(&path);
            return Err("The download was damaged (checksum didn't match). It will be tried again later.".into());
        }
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Close the app, run the installer silently, then reopen the app.
#[tauri::command]
fn update_install(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let setup = PathBuf::from(&path);
    if !setup.starts_with(update_dir()) || !setup.is_file() {
        return Err("The downloaded update wasn't found. Check for updates again.".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let exe = std::env::current_exe().map_err(err)?;
        let q = |p: &Path| p.to_string_lossy().replace('\'', "''");
        let script = format!(
            "Start-Sleep -Seconds 2; Start-Process -FilePath '{}' -ArgumentList '/S' -Wait; Start-Process -FilePath '{}'",
            q(&setup),
            q(&exe)
        );
        std::process::Command::new("powershell")
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-Command", &script])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(err)?;
        app.exit(0);
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("Automatic install is only available on Windows".into())
    }
}

/// Open a new email in the default email app.
#[tauri::command]
fn open_mailto(url: String) -> Result<(), String> {
    if !url.starts_with("mailto:") {
        return Err("Not an email link".into());
    }
    open::that_detached(&url).map_err(err)
}

/// Open the releases page in the default browser.
#[tauri::command]
fn open_releases() -> Result<(), String> {
    #[cfg(windows)]
    let r = std::process::Command::new("explorer").arg(RELEASES_PAGE).spawn();
    #[cfg(not(windows))]
    let r = std::process::Command::new("xdg-open").arg(RELEASES_PAGE).spawn();
    r.map(|_| ()).map_err(err)
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            sync_default_folder,
            device_name,
            pick_folder,
            sync_list,
            sync_read,
            sync_write,
            sync_remove,
            save_file,
            app_version,
            update_check,
            update_download,
            update_install,
            open_releases,
            open_mailto
        ])
        .run(tauri::generate_context!())
        .expect("error while running XC Organiser");
}
