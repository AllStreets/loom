// On-device STT probe — transcribes a 16kHz mono WAV with the real whisper model.
// Usage: cargo run --release --example stt_probe -- <ggml-model.bin> <audio-16k-mono.wav>
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: stt_probe <ggml-model.bin> <audio-16k-mono.wav>");
        std::process::exit(2);
    }
    let wav = std::fs::read(&args[2]).expect("read wav");
    // naive wav parse: find "data" chunk, read i16 LE → f32
    let data_pos = wav.windows(4).position(|w| w == b"data").expect("data chunk") + 8;
    let samples: Vec<f32> = wav[data_pos..]
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
        .collect();
    println!("samples: {} ({}s @16k)", samples.len(), samples.len() / 16000);

    let ctx = WhisperContext::new_with_params(&args[1], WhisperContextParameters::default())
        .expect("load model");
    let mut state = ctx.create_state().expect("state");
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("en"));
    params.set_print_progress(false);
    params.set_print_special(false);
    params.set_print_realtime(false);
    state.full(params, &samples).expect("transcribe");
    let n = state.full_n_segments();
    let mut text = String::new();
    for i in 0..n {
        if let Some(seg) = state.get_segment(i) {
            if let Ok(t) = seg.to_str_lossy() {
                text.push_str(&t);
            }
        }
    }
    println!("TRANSCRIPT: {}", text.trim());
    if text.to_lowercase().contains("loom") || text.to_lowercase().contains("voice") {
        println!("OK: the loop closes — LOOM heard itself.");
    } else {
        eprintln!("WARN: transcript did not contain expected words");
        std::process::exit(1);
    }
}
