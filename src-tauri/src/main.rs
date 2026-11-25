// XC Meet Manager — Windows app shell.
// The whole app is the web UI in ../src; this adds what a browser can't do on its own:
// reading/writing the sync folder (OneDrive) and native Save dialogs.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

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

/// "%OneDrive%\XC Meet Manager" if OneDrive is set up on this computer.
#[tauri::command]
fn sync_default_folder() -> Option<String> {
    for var in ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"] {
        if let Ok(p) = std::env::var(var) {
            let base = Path::new(&p);
            if !p.is_empty() && base.is_dir() {
                return Some(base.join("XC Meet Manager").to_string_lossy().into_owned());
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
            save_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running XC Meet Manager");
}
