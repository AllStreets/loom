mod ollama;
mod error;
mod fleet;
mod timeline;
mod organs;
mod voice;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet, fleet::fleet_status, fleet::fleet_chat, timeline::timeline_init, timeline::timeline_commit, timeline::timeline_log, timeline::timeline_rollback, organs::organ_write, organs::organ_list, organs::organ_read, organs::organ_grant, organs::organ_delete, voice::voice_status, voice::voice_setup, voice::stt_transcribe, voice::tts_speak])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
