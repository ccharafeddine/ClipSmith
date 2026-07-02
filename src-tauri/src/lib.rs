mod commands;
mod cutter;
mod encoders;
mod filmstrip;
mod formats;
mod keyframes;
mod probe;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::DownloadCancel::default())
        .manage(encoders::EncoderCache::default())
        .manage(formats::FormatCache::default())
        .invoke_handler(tauri::generate_handler![
            commands::probe_video,
            commands::list_keyframes,
            commands::export_clip,
            commands::detect_encoder,
            commands::available_formats,
            commands::default_save_path,
            commands::generate_filmstrip,
            commands::generate_proxy,
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
