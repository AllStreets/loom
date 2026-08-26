mod ollama;
mod error;
mod exec;
mod fleet;
mod timeline;
mod organs;
mod kernel;
mod voice;
mod cloud;
mod market;
pub mod deckserve;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // Register the `deck://` custom protocol to serve the bundled AUSPEX
        // globe on its own origin in production.
        // macOS/Linux origin: deck://localhost  (closes Stage-1 reviewer I3)
        .register_uri_scheme_protocol("deck", deckserve::handler)
        // Recovery boot (Phase 21, wall 5): before the webview loads any TS, if
        // the previous edit never confirmed a good boot, hard-reset the source
        // repo to its pre-edit HEAD. Runs EARLY in setup, synchronously.
        .setup(|app| {
            let handle = app.handle().clone();
            if let Some(sha) = kernel::boot_recover(&handle) {
                eprintln!("[kernel] recovery boot: an edit didn't hold — reset to {sha}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![greet, fleet::fleet_status, fleet::fleet_chat, timeline::timeline_init, timeline::timeline_commit, timeline::timeline_log, timeline::timeline_rollback, organs::organ_write, organs::organ_list, organs::organ_read, organs::organ_grant, organs::organ_delete, voice::voice_status, voice::voice_setup, voice::stt_transcribe, voice::tts_speak, cloud::cloud_chat, cloud::cloud_key_set, cloud::cloud_key_present, cloud::cloud_key_clear, market::quote_fetch, market::market_chart, market::market_crypto, market::market_book, market::market_trades, market::market_fx, kernel::kernel_editable, kernel::kernel_read, kernel::kernel_propose, kernel::kernel_validate, kernel::kernel_apply, kernel::kernel_discard, kernel::kernel_rollback, kernel::kernel_boot_ok, kernel::kernel_boot_check])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
