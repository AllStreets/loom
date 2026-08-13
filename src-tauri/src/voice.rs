/// voice.rs — offline STT (whisper-rs, Metal) + TTS (sherpa-rs vits/piper bundles)
///
/// Engine choice: whisper-rs 0.16 (whisper.cpp bindings, Metal feature enabled) for STT.
/// TTS: sherpa-rs 0.6 (sherpa-onnx) with sherpa-converted piper bundles — raw HuggingFace
/// piper .onnx/.onnx.json files do NOT work with sherpa-rs; the sherpa bundle format is
/// required (model .onnx + tokens.txt + espeak-ng-data/).
/// Both built cleanly after `brew install cmake` (cmake was absent; documented in report).

use crate::error::LoomError;
use crate::timeline::loom_dir;
use futures_util::StreamExt;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

// ── Registry ──────────────────────────────────────────────────────────────────

pub struct VoiceDef {
    pub id: &'static str,
    pub label: &'static str,
    /// URL to the sherpa-converted .tar.bz2 bundle on GitHub releases
    pub archive_url: &'static str,
    /// Top-level directory name inside the archive (and on disk under voice_dir)
    pub dir_name: &'static str,
}

pub const VOICES: [VoiceDef; 3] = [
    VoiceDef {
        id: "en_US-lessac-medium",
        label: "Lessac (US, medium)",
        archive_url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-lessac-medium.tar.bz2",
        dir_name: "vits-piper-en_US-lessac-medium",
    },
    VoiceDef {
        id: "en_GB-alba-medium",
        label: "Alba (GB, medium)",
        archive_url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_GB-alba-medium.tar.bz2",
        dir_name: "vits-piper-en_GB-alba-medium",
    },
    VoiceDef {
        id: "en_US-libritts-high",
        label: "LibriTTS (US, high)",
        archive_url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-libritts-high.tar.bz2",
        dir_name: "vits-piper-en_US-libritts-high",
    },
];

pub const WHISPER: (&str, &str) = (
    "ggml-base.en.bin",
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
);

/// Default voice id
pub const DEFAULT_VOICE_ID: &str = "en_US-lessac-medium";

// ── Paths ─────────────────────────────────────────────────────────────────────

pub fn voice_dir(app: &AppHandle) -> Result<PathBuf, LoomError> {
    let dir = loom_dir(app)?.join("voice");
    std::fs::create_dir_all(&dir).map_err(|e| LoomError::Git(format!("create voice dir {}: {e}", dir.display())))?;
    Ok(dir)
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

/// Returns true if the three required bundle paths all exist for a voice.
/// - `<dir_name>/<id>.onnx`
/// - `<dir_name>/tokens.txt`
/// - `<dir_name>/espeak-ng-data` (directory)
pub fn voice_present(voice_dir: &Path, voice: &VoiceDef) -> bool {
    let bundle = voice_dir.join(voice.dir_name);
    bundle.join(format!("{}.onnx", voice.id)).exists()
        && bundle.join("tokens.txt").exists()
        && bundle.join("espeak-ng-data").exists()
}

/// Returns (archive_url, dir_name) pairs for any voice bundle absent from `dir`,
/// plus (filename, url) for a missing whisper model.
pub fn missing_voices(dir: &Path) -> Vec<(&'static str, &'static str, &'static str)> {
    let mut out = Vec::new();
    for voice in &VOICES {
        if !voice_present(dir, voice) {
            out.push((voice.archive_url, voice.dir_name, voice.id));
        }
    }
    out
}

/// Returns the whisper (filename, url) if absent.
pub fn missing_whisper(dir: &Path) -> Option<(&'static str, &'static str)> {
    let (wname, wurl) = WHISPER;
    if !dir.join(wname).exists() {
        Some((wname, wurl))
    } else {
        None
    }
}

/// Cap input to 30 seconds at 16kHz mono (480_000 samples).
pub fn clamp_samples(samples: Vec<f32>) -> Vec<f32> {
    const CAP: usize = 480_000;
    if samples.len() > CAP {
        samples.into_iter().take(CAP).collect()
    } else {
        samples
    }
}

/// Build a RIFF/WAV container around raw 16-bit PCM samples.
/// mono, `rate` Hz, 16-bit little-endian. Returns the full WAV bytes.
pub fn wav_from_pcm16(rate: u32, samples: &[i16]) -> Vec<u8> {
    let num_samples = samples.len() as u32;
    let byte_rate = rate * 2; // 1 channel * 2 bytes/sample
    let data_size = num_samples * 2;
    let chunk_size = 36 + data_size; // 4 (WAVE) + 24 (fmt) + 8 (data hdr) + data_size

    let mut buf = Vec::with_capacity(44 + data_size as usize);

    // RIFF chunk descriptor
    buf.extend_from_slice(b"RIFF");
    buf.extend_from_slice(&chunk_size.to_le_bytes());
    buf.extend_from_slice(b"WAVE");

    // fmt sub-chunk
    buf.extend_from_slice(b"fmt ");
    buf.extend_from_slice(&16u32.to_le_bytes()); // sub-chunk size = 16 for PCM
    buf.extend_from_slice(&1u16.to_le_bytes()); // AudioFormat = PCM
    buf.extend_from_slice(&1u16.to_le_bytes()); // NumChannels = 1
    buf.extend_from_slice(&rate.to_le_bytes()); // SampleRate
    buf.extend_from_slice(&byte_rate.to_le_bytes()); // ByteRate
    buf.extend_from_slice(&2u16.to_le_bytes()); // BlockAlign = 2
    buf.extend_from_slice(&16u16.to_le_bytes()); // BitsPerSample = 16

    // data sub-chunk
    buf.extend_from_slice(b"data");
    buf.extend_from_slice(&data_size.to_le_bytes());
    for s in samples {
        buf.extend_from_slice(&s.to_le_bytes());
    }

    buf
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct VoicePresence {
    pub id: String,
    pub label: String,
    pub present: bool,
}

#[derive(Serialize)]
pub struct VoiceStatus {
    pub ready: bool,
    pub whisper: bool,
    pub voices: Vec<VoicePresence>,
    pub missing_bytes_hint: Option<String>,
}

#[tauri::command]
pub async fn voice_status(app: AppHandle) -> Result<VoiceStatus, LoomError> {
    let dir = voice_dir(&app)?;
    let (wname, _) = WHISPER;
    let whisper_present = dir.join(wname).exists();

    let mut voices = Vec::new();
    let mut all_voices_present = true;
    for v in &VOICES {
        let present = voice_present(&dir, v);
        if !present {
            all_voices_present = false;
        }
        voices.push(VoicePresence {
            id: v.id.to_string(),
            label: v.label.to_string(),
            present,
        });
    }

    let ready = whisper_present && all_voices_present;

    let mut missing_count = 0usize;
    if missing_whisper(&dir).is_some() {
        missing_count += 1;
    }
    missing_count += missing_voices(&dir).len();

    let missing_bytes_hint = if missing_count == 0 {
        None
    } else {
        Some(format!("{missing_count} item(s) not downloaded"))
    };

    Ok(VoiceStatus {
        ready,
        whisper: whisper_present,
        voices,
        missing_bytes_hint,
    })
}

#[tauri::command]
pub async fn voice_setup(app: AppHandle, window: tauri::Window) -> Result<(), LoomError> {
    let dir = voice_dir(&app)?;

    // ── Whisper (single file, unchanged) ──────────────────────────────────────
    if let Some((wname, wurl)) = missing_whisper(&dir) {
        let client = reqwest::Client::new();
        let resp = client
            .get(wurl)
            .send()
            .await
            .map_err(|e| LoomError::Http(e.to_string()))?;

        if !resp.status().is_success() {
            return Err(LoomError::Http(format!(
                "download whisper failed: {}",
                resp.status()
            )));
        }

        let total = resp.content_length().unwrap_or(0);
        let tmp_path = dir.join(format!("{wname}.tmp"));
        let final_path = dir.join(wname);

        {
            use tokio::io::AsyncWriteExt;
            let mut file = tokio::fs::File::create(&tmp_path)
                .await
                .map_err(|e| {
                    let _ = std::fs::remove_file(&tmp_path);
                    LoomError::Http(e.to_string())
                })?;

            let mut stream = resp.bytes_stream();
            let mut downloaded: u64 = 0;
            let mut last_pct: i64 = -1;

            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|e| {
                    let _ = std::fs::remove_file(&tmp_path);
                    LoomError::Http(e.to_string())
                })?;
                file.write_all(&chunk)
                    .await
                    .map_err(|e| {
                        let _ = std::fs::remove_file(&tmp_path);
                        LoomError::Http(e.to_string())
                    })?;
                downloaded += chunk.len() as u64;

                let pct = if total > 0 {
                    (downloaded * 100 / total) as i64
                } else {
                    -1
                };
                if pct != last_pct {
                    last_pct = pct;
                    let _ = window.emit(
                        "voice-setup-progress",
                        serde_json::json!({ "file": wname, "pct": pct }),
                    );
                }
            }
            file.flush()
                .await
                .map_err(|e| {
                    let _ = std::fs::remove_file(&tmp_path);
                    LoomError::Http(e.to_string())
                })?;
        }

        tokio::fs::rename(&tmp_path, &final_path)
            .await
            .map_err(|e| {
                let _ = std::fs::remove_file(&tmp_path);
                LoomError::Http(e.to_string())
            })?;

        let _ = window.emit(
            "voice-setup-progress",
            serde_json::json!({ "file": wname, "pct": 100 }),
        );
    }

    // ── Voice bundles (.tar.bz2) ──────────────────────────────────────────────
    let missing = missing_voices(&dir);
    if missing.is_empty() {
        return Ok(());
    }

    let client = reqwest::Client::new();

    for (archive_url, dir_name, _id) in &missing {
        let archive_name = format!("{dir_name}.tar.bz2");
        let tmp_path = dir.join(format!("{archive_name}.tmp"));
        let extract_dir = dir.join(dir_name);

        // Download archive to .tmp
        let resp = client
            .get(*archive_url)
            .send()
            .await
            .map_err(|e| LoomError::Http(e.to_string()))?;

        if !resp.status().is_success() {
            return Err(LoomError::Http(format!(
                "download {archive_name} failed: {}",
                resp.status()
            )));
        }

        let total = resp.content_length().unwrap_or(0);

        {
            use tokio::io::AsyncWriteExt;
            let mut file = tokio::fs::File::create(&tmp_path)
                .await
                .map_err(|e| {
                    let _ = std::fs::remove_file(&tmp_path);
                    LoomError::Http(e.to_string())
                })?;

            let mut stream = resp.bytes_stream();
            let mut downloaded: u64 = 0;
            let mut last_pct: i64 = -1;

            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|e| {
                    let _ = std::fs::remove_file(&tmp_path);
                    LoomError::Http(e.to_string())
                })?;
                file.write_all(&chunk)
                    .await
                    .map_err(|e| {
                        let _ = std::fs::remove_file(&tmp_path);
                        LoomError::Http(e.to_string())
                    })?;
                downloaded += chunk.len() as u64;

                let pct = if total > 0 {
                    (downloaded * 100 / total) as i64
                } else {
                    -1
                };
                if pct != last_pct {
                    last_pct = pct;
                    let _ = window.emit(
                        "voice-setup-progress",
                        serde_json::json!({ "file": archive_name, "pct": pct }),
                    );
                }
            }
            file.flush()
                .await
                .map_err(|e| {
                    let _ = std::fs::remove_file(&tmp_path);
                    LoomError::Http(e.to_string())
                })?;
        }

        // Extract synchronously (blocking I/O — fine for setup path)
        let tmp_path_clone = tmp_path.clone();
        let extract_dir_clone = extract_dir.clone();
        let dir_name_str = dir_name.to_string();
        let dir_clone = dir.clone();

        tokio::task::spawn_blocking(move || -> Result<(), LoomError> {
            use bzip2::read::BzDecoder;
            use tar::Archive;

            let file = std::fs::File::open(&tmp_path_clone)
                .map_err(|e| LoomError::Http(format!("open archive: {e}")))?;
            let bz = BzDecoder::new(file);
            let mut archive = Archive::new(bz);

            archive
                .unpack(&dir_clone)
                .map_err(|e| {
                    // Cleanup: remove partial extract dir and tmp archive
                    let _ = std::fs::remove_dir_all(&extract_dir_clone);
                    let _ = std::fs::remove_file(&tmp_path_clone);
                    LoomError::Http(format!("extract {dir_name_str}: {e}"))
                })?;

            // Remove the archive after successful extraction
            let _ = std::fs::remove_file(&tmp_path_clone);
            Ok(())
        })
        .await
        .map_err(|e| LoomError::Parse(e.to_string()))??;

        let _ = window.emit(
            "voice-setup-progress",
            serde_json::json!({ "file": archive_name, "pct": 100 }),
        );
    }

    Ok(())
}

#[tauri::command]
pub async fn stt_transcribe(
    app: AppHandle,
    samples: Vec<f32>,
) -> Result<String, LoomError> {
    use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

    let dir = voice_dir(&app)?;
    let (wname, _) = WHISPER;
    let model_path = dir.join(wname);
    if !model_path.exists() {
        return Err(LoomError::NotFound("voice not set up".into()));
    }

    let samples = clamp_samples(samples);

    // whisper_rs operations are synchronous/CPU-bound; run on blocking thread
    let model_path_str = model_path.to_string_lossy().to_string();
    let text = tokio::task::spawn_blocking(move || -> Result<String, LoomError> {
        let ctx = WhisperContext::new_with_params(
            &model_path_str,
            WhisperContextParameters::default(),
        )
        .map_err(|e| LoomError::Parse(e.to_string()))?;

        let mut state = ctx.create_state().map_err(|e| LoomError::Parse(e.to_string()))?;

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(Some("en"));
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_special(false);
        params.set_print_timestamps(false);

        state
            .full(params, &samples)
            .map_err(|e| LoomError::Parse(e.to_string()))?;

        let n = state.full_n_segments();
        let mut out = String::new();
        for i in 0..n {
            if let Some(seg) = state.get_segment(i) {
                if let Ok(text) = seg.to_str_lossy() {
                    out.push_str(&text);
                }
            }
        }
        Ok(out.trim().to_string())
    })
    .await
    .map_err(|e| LoomError::Parse(e.to_string()))??;

    Ok(text)
}

#[tauri::command]
pub async fn tts_speak(
    app: AppHandle,
    text: String,
    voice_id: String,
) -> Result<Vec<u8>, LoomError> {
    use sherpa_rs::tts::{CommonTtsConfig, VitsTts, VitsTtsConfig};
    use sherpa_rs::OnnxConfig;

    let voice_def = VOICES
        .iter()
        .find(|v| v.id == voice_id)
        .ok_or_else(|| LoomError::NotFound(format!("unknown voice: {voice_id}")))?;

    let dir = voice_dir(&app)?;

    // Verify bundle is fully present
    if !voice_present(&dir, voice_def) {
        return Err(LoomError::NotFound(format!(
            "voice bundle not downloaded: {}",
            voice_def.dir_name
        )));
    }

    let bundle_dir = dir.join(voice_def.dir_name);
    let model_path = bundle_dir
        .join(format!("{}.onnx", voice_def.id))
        .to_string_lossy()
        .to_string();
    let tokens_path = bundle_dir
        .join("tokens.txt")
        .to_string_lossy()
        .to_string();
    let data_dir_path = bundle_dir
        .join("espeak-ng-data")
        .to_string_lossy()
        .to_string();

    let (pcm, sample_rate) = tokio::task::spawn_blocking(move || -> Result<(Vec<i16>, u32), LoomError> {
        let mut tts = VitsTts::new(VitsTtsConfig {
            model: model_path,
            tokens: tokens_path,
            data_dir: data_dir_path,
            length_scale: 1.0,
            noise_scale: 0.667,
            noise_scale_w: 0.8,
            onnx_config: OnnxConfig {
                provider: "cpu".to_string(),
                num_threads: 2,
                debug: false,
            },
            tts_config: CommonTtsConfig {
                max_num_sentences: 2,
                ..Default::default()
            },
            ..Default::default()
        });

        let audio = tts
            .create(&text, 0, 1.0)
            .map_err(|e| LoomError::Parse(e.to_string()))?;

        let rate = audio.sample_rate;
        // Convert f32 samples → i16
        let samples_i16: Vec<i16> = audio
            .samples
            .iter()
            .map(|&s| (s.clamp(-1.0, 1.0) * 32767.0) as i16)
            .collect();
        Ok((samples_i16, rate))
    })
    .await
    .map_err(|e| LoomError::Parse(e.to_string()))??;

    let wav = wav_from_pcm16(sample_rate, &pcm);
    Ok(wav)
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    // ── Registry integrity ────────────────────────────────────────────────────

    #[test]
    fn registry_has_three_voices() {
        assert_eq!(VOICES.len(), 3);
    }

    #[test]
    fn default_voice_id_present() {
        assert!(
            VOICES.iter().any(|v| v.id == DEFAULT_VOICE_ID),
            "DEFAULT_VOICE_ID '{DEFAULT_VOICE_ID}' not in VOICES"
        );
    }

    #[test]
    fn all_voice_ids_unique() {
        let ids: Vec<_> = VOICES.iter().map(|v| v.id).collect();
        let mut deduped = ids.clone();
        deduped.sort();
        deduped.dedup();
        assert_eq!(ids.len(), deduped.len(), "duplicate voice id");
    }

    #[test]
    fn all_archive_urls_https_github() {
        for v in &VOICES {
            assert!(
                v.archive_url.starts_with("https://"),
                "archive url not https for {}: {}",
                v.id,
                v.archive_url
            );
            assert!(
                v.archive_url.contains("github.com"),
                "archive url not on github.com for {}: {}",
                v.id,
                v.archive_url
            );
            assert!(
                v.archive_url.ends_with(".tar.bz2"),
                "archive url does not end with .tar.bz2 for {}: {}",
                v.id,
                v.archive_url
            );
        }
    }

    #[test]
    fn dir_names_match_vits_piper_prefix_and_id() {
        for v in &VOICES {
            let expected = format!("vits-piper-{}", v.id);
            assert_eq!(
                v.dir_name, expected,
                "dir_name mismatch for {}: expected {expected}, got {}",
                v.id, v.dir_name
            );
        }
    }

    #[test]
    fn whisper_url_unchanged() {
        let (wname, wurl) = WHISPER;
        assert_eq!(wname, "ggml-base.en.bin");
        assert!(wurl.starts_with("https://"), "whisper url not https");
        assert!(
            wurl.contains("huggingface.co"),
            "whisper url not on huggingface"
        );
    }

    // ── voice_present tempdir matrix ─────────────────────────────────────────

    fn make_complete_bundle(base: &Path, voice: &VoiceDef) {
        let bundle = base.join(voice.dir_name);
        fs::create_dir_all(&bundle).unwrap();
        fs::write(bundle.join(format!("{}.onnx", voice.id)), b"").unwrap();
        fs::write(bundle.join("tokens.txt"), b"").unwrap();
        // espeak-ng-data is a directory
        fs::create_dir_all(bundle.join("espeak-ng-data")).unwrap();
    }

    #[test]
    fn voice_present_all_present_returns_true() {
        let dir = tempdir().unwrap();
        let voice = &VOICES[0];
        make_complete_bundle(dir.path(), voice);
        assert!(voice_present(dir.path(), voice));
    }

    #[test]
    fn voice_present_missing_onnx_returns_false() {
        let dir = tempdir().unwrap();
        let voice = &VOICES[0];
        let bundle = dir.path().join(voice.dir_name);
        fs::create_dir_all(&bundle).unwrap();
        // omit .onnx
        fs::write(bundle.join("tokens.txt"), b"").unwrap();
        fs::create_dir_all(bundle.join("espeak-ng-data")).unwrap();
        assert!(!voice_present(dir.path(), voice));
    }

    #[test]
    fn voice_present_missing_tokens_returns_false() {
        let dir = tempdir().unwrap();
        let voice = &VOICES[0];
        let bundle = dir.path().join(voice.dir_name);
        fs::create_dir_all(&bundle).unwrap();
        fs::write(bundle.join(format!("{}.onnx", voice.id)), b"").unwrap();
        // omit tokens.txt
        fs::create_dir_all(bundle.join("espeak-ng-data")).unwrap();
        assert!(!voice_present(dir.path(), voice));
    }

    #[test]
    fn voice_present_missing_espeak_data_returns_false() {
        let dir = tempdir().unwrap();
        let voice = &VOICES[0];
        let bundle = dir.path().join(voice.dir_name);
        fs::create_dir_all(&bundle).unwrap();
        fs::write(bundle.join(format!("{}.onnx", voice.id)), b"").unwrap();
        fs::write(bundle.join("tokens.txt"), b"").unwrap();
        // omit espeak-ng-data
        assert!(!voice_present(dir.path(), voice));
    }

    #[test]
    fn voice_present_empty_dir_returns_false() {
        let dir = tempdir().unwrap();
        let voice = &VOICES[0];
        assert!(!voice_present(dir.path(), voice));
    }

    // ── missing_voices / missing_whisper ─────────────────────────────────────

    #[test]
    fn missing_voices_empty_dir_returns_all_three() {
        let dir = tempdir().unwrap();
        assert_eq!(missing_voices(dir.path()).len(), 3);
    }

    #[test]
    fn missing_voices_with_all_bundles_present_returns_empty() {
        let dir = tempdir().unwrap();
        for voice in &VOICES {
            make_complete_bundle(dir.path(), voice);
        }
        assert!(missing_voices(dir.path()).is_empty());
    }

    #[test]
    fn missing_whisper_absent_returns_some() {
        let dir = tempdir().unwrap();
        assert!(missing_whisper(dir.path()).is_some());
    }

    #[test]
    fn missing_whisper_present_returns_none() {
        let dir = tempdir().unwrap();
        let (wname, _) = WHISPER;
        fs::write(dir.path().join(wname), b"").unwrap();
        assert!(missing_whisper(dir.path()).is_none());
    }

    // ── wav_from_pcm16 header bytes ──────────────────────────────────────────

    #[test]
    fn wav_header_riff_wave_markers() {
        let wav = wav_from_pcm16(16000, &[]);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        assert_eq!(&wav[36..40], b"data");
    }

    #[test]
    fn wav_header_sizes_empty() {
        let wav = wav_from_pcm16(16000, &[]);
        assert_eq!(wav.len(), 44);
        // chunk_size = 36 + 0 = 36
        let chunk_size = u32::from_le_bytes(wav[4..8].try_into().unwrap());
        assert_eq!(chunk_size, 36);
        // data_size = 0
        let data_size = u32::from_le_bytes(wav[40..44].try_into().unwrap());
        assert_eq!(data_size, 0);
    }

    #[test]
    fn wav_header_sizes_with_samples() {
        let samples = vec![0i16; 100];
        let wav = wav_from_pcm16(22050, &samples);
        assert_eq!(wav.len(), 44 + 200);
        let chunk_size = u32::from_le_bytes(wav[4..8].try_into().unwrap());
        assert_eq!(chunk_size, 36 + 200);
        let data_size = u32::from_le_bytes(wav[40..44].try_into().unwrap());
        assert_eq!(data_size, 200);
    }

    #[test]
    fn wav_header_sample_rate() {
        let wav = wav_from_pcm16(44100, &[]);
        let rate = u32::from_le_bytes(wav[24..28].try_into().unwrap());
        assert_eq!(rate, 44100);
        let byte_rate = u32::from_le_bytes(wav[28..32].try_into().unwrap());
        assert_eq!(byte_rate, 44100 * 2); // 1 ch * 2 bytes
    }

    #[test]
    fn wav_header_format_fields() {
        let wav = wav_from_pcm16(16000, &[]);
        // sub-chunk1 size = 16
        let sc1 = u32::from_le_bytes(wav[16..20].try_into().unwrap());
        assert_eq!(sc1, 16);
        // AudioFormat = 1 (PCM)
        let fmt = u16::from_le_bytes(wav[20..22].try_into().unwrap());
        assert_eq!(fmt, 1);
        // NumChannels = 1
        let ch = u16::from_le_bytes(wav[22..24].try_into().unwrap());
        assert_eq!(ch, 1);
        // BitsPerSample = 16
        let bits = u16::from_le_bytes(wav[34..36].try_into().unwrap());
        assert_eq!(bits, 16);
        // BlockAlign = 2
        let align = u16::from_le_bytes(wav[32..34].try_into().unwrap());
        assert_eq!(align, 2);
    }

    // ── clamp_samples ────────────────────────────────────────────────────────

    #[test]
    fn clamp_samples_under_cap_unchanged() {
        let s = vec![0.5f32; 100];
        let out = clamp_samples(s.clone());
        assert_eq!(out.len(), 100);
    }

    #[test]
    fn clamp_samples_at_cap_unchanged() {
        let s = vec![0.0f32; 480_000];
        let out = clamp_samples(s);
        assert_eq!(out.len(), 480_000);
    }

    #[test]
    fn clamp_samples_over_cap_truncated() {
        let s = vec![1.0f32; 500_000];
        let out = clamp_samples(s);
        assert_eq!(out.len(), 480_000);
    }
}
