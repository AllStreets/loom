mod agora;
mod ollama;
mod error;
mod fleet;
mod timeline;
mod organs;
mod voice;
mod cloud;
mod market;
pub mod deckserve;

use tauri::Manager;

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
        .manage(agora::AgoraState::default())
        .invoke_handler(tauri::generate_handler![greet, fleet::fleet_status, fleet::fleet_chat, timeline::timeline_init, timeline::timeline_commit, timeline::timeline_log, timeline::timeline_rollback, organs::organ_write, organs::organ_list, organs::organ_read, organs::organ_grant, organs::organ_delete, voice::voice_status, voice::voice_setup, voice::stt_transcribe, voice::tts_speak, cloud::cloud_chat, cloud::cloud_key_set, cloud::cloud_key_present, cloud::cloud_key_clear, market::quote_fetch, market::market_chart, market::market_crypto, market::market_book, market::market_trades, market::market_fx, agora::agora_start, agora::agora_stop, agora::agora_status, agora::agora_logs])
        .build(tauri::generate_context!())
        .expect("error building tauri application")
        .run(|app_handle, event| match event {
            // ExitRequested fires before teardown on the normal quit path
            // (macOS Cmd-Q included) — early enough for synchronous cleanup.
            tauri::RunEvent::ExitRequested { .. } => {
                let agora_state = app_handle.state::<agora::AgoraState>();
                agora::kill_agora(&agora_state);
            }
            // Second net for exit paths that skip ExitRequested. kill_agora
            // takes the child out of state, so a double fire is a no-op.
            tauri::RunEvent::Exit => {
                let agora_state = app_handle.state::<agora::AgoraState>();
                agora::kill_agora(&agora_state);
            }
            _ => {}
        });
}
