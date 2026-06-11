mod commands;
mod cutter;
mod filmstrip;
mod keyframes;
mod probe;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::DownloadCancel::default())
        .invoke_handler(tauri::generate_handler![
            commands::probe_video,
            commands::list_keyframes,
            commands::export_clip,
            commands::default_save_path,
            commands::generate_filmstrip,
            commands::download_video,
            commands::cancel_download
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            // Delete any URL download temp file when the app exits.
            if let tauri::RunEvent::Exit = event {
                commands::cleanup_temp();
            }
        });
}
