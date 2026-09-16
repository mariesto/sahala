use std::sync::Mutex;

/// Files handed to us by macOS (file association / Dock drop) before the
/// frontend was ready to receive events.
struct PendingOpen(Mutex<Vec<String>>);

#[tauri::command]
fn take_pending_open(state: tauri::State<PendingOpen>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap())
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Failed to read {path}: {e}"))
}

#[tauri::command]
fn write_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("Failed to write {path}: {e}"))
}

#[tauri::command]
fn rename_file(from: String, to: String) -> Result<(), String> {
    if std::path::Path::new(&to).exists() {
        return Err(format!("A file named {to} already exists"));
    }
    std::fs::rename(&from, &to).map_err(|e| format!("Failed to rename {from}: {e}"))
}

/// Swap the Dock icon at runtime (macOS). `name` picks a bundled
/// alternate from `icons/alt/<name>.png`; Finder keeps showing the
/// bundle's default icns — only the running app's Dock tile changes.
#[tauri::command]
fn set_app_icon(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let safe: String = name.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        let path = app
            .path()
            .resolve(
                format!("icons/alt/{safe}.png"),
                tauri::path::BaseDirectory::Resource,
            )
            .map_err(|e| format!("Icon {safe} not found: {e}"))?;
        if !path.exists() {
            return Err(format!("Icon {safe} not bundled"));
        }
        let path_str = path.to_string_lossy().to_string();
        app.run_on_main_thread(move || {
            set_dock_icon(&path_str);
        })
        .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, safe);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
#[allow(unused_unsafe)]
fn set_dock_icon(path: &str) {
    use objc2::{AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSString;

    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let ns_app = NSApplication::sharedApplication(mtm);
    let ns_path = NSString::from_str(path);
    if let Some(img) = unsafe { NSImage::initWithContentsOfFile(NSImage::alloc(), &ns_path) } {
        unsafe { ns_app.setApplicationIconImage(Some(&img)) };
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(PendingOpen(Mutex::new(Vec::new())))
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            rename_file,
            set_app_icon,
            take_pending_open
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = event {
            use tauri::{Emitter, Manager};
            let paths: Vec<String> = urls
                .iter()
                .filter_map(|u| u.to_file_path().ok())
                .map(|p| p.to_string_lossy().to_string())
                .collect();
            if paths.is_empty() {
                return;
            }
            // Buffer for a cold start (frontend not loaded yet) and emit
            // for the warm case (app already running).
            app_handle
                .state::<PendingOpen>()
                .0
                .lock()
                .unwrap()
                .extend(paths.clone());
            let _ = app_handle.emit("open-file", paths);
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (&app_handle, &event);
        }
    });
}
