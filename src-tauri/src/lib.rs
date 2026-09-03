mod ollama;
mod error;
mod exec;
mod fleet;
mod timeline;
mod organs;
mod kernel;
mod voice;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // PRE-MAIN HEAL (Phase 22 / Marrow — defense-in-depth backstop for the
    // recovery gap that Rust opens). This is the VERY FIRST statement of run(),
    // BEFORE `tauri::Builder::default()` and before ANY fallible or lazy init a
    // Rust self-edit could add. It reads the source-relative mirror
    // `.loom-boot.json` and, if a prior Rust edit was applied but never
    // confirmed a healthy boot (status `booting` on its second sighting), hard-
    // resets the source to the last-good sha and marks it `healed` so the next
    // recompile is from good source. Same-binary, so it cannot fix the CURRENT
    // bad binary — it is the backstop when the pre-compile Node guard was
    // skipped, and it marks state the guard heals on the next compile.
    // Panic-free / best-effort: it can NEVER block boot.
    kernel::preboot_heal();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
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
        .invoke_handler(tauri::generate_handler![fleet::fleet_status, fleet::fleet_chat, timeline::timeline_init, timeline::timeline_commit, timeline::timeline_log, timeline::timeline_rollback, organs::organ_write, organs::organ_list, organs::organ_read, organs::organ_grant, organs::organ_delete, voice::voice_status, voice::voice_setup, voice::stt_transcribe, voice::tts_speak, kernel::kernel_editable, kernel::kernel_read, kernel::kernel_propose, kernel::kernel_validate, kernel::kernel_approve, kernel::kernel_apply, kernel::kernel_discard, kernel::kernel_rollback, kernel::kernel_boot_ok, kernel::kernel_boot_check])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
