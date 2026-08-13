// On-device TTS probe — verifies the sherpa vits/piper configuration against a
// REAL downloaded voice, outside the GUI. Usage:
//   cargo run --release --example tts_probe -- <model.onnx> <tokens-or-json> [data_dir]
// Writes /tmp/loom-tts-probe.wav on success and prints sample stats.
use sherpa_rs::tts::{CommonTtsConfig, VitsTts, VitsTtsConfig};
use sherpa_rs::OnnxConfig;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: tts_probe <model.onnx> <tokens-or-json> [data_dir]");
        std::process::exit(2);
    }
    let model = args[1].clone();
    let tokens = args[2].clone();
    let data_dir = args.get(3).cloned().unwrap_or_default();

    println!("model:    {model}");
    println!("tokens:   {tokens}");
    println!("data_dir: {data_dir}");

    let mut tts = VitsTts::new(VitsTtsConfig {
        model,
        tokens,
        data_dir,
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

    match tts.create("Hello. I am LOOM. This is my voice.", 0, 1.0) {
        Ok(audio) => {
            let n = audio.samples.len();
            let peak = audio.samples.iter().fold(0f32, |m, s| m.max(s.abs()));
            println!("OK: {n} samples @ {} Hz, peak {peak:.3}", audio.sample_rate);
            if n == 0 || peak < 0.01 {
                eprintln!("FAIL: silent/empty audio");
                std::process::exit(1);
            }
            // minimal wav write
            let mut wav: Vec<u8> = Vec::new();
            let data_len = (n * 2) as u32;
            wav.extend_from_slice(b"RIFF");
            wav.extend_from_slice(&(36 + data_len).to_le_bytes());
            wav.extend_from_slice(b"WAVEfmt ");
            wav.extend_from_slice(&16u32.to_le_bytes());
            wav.extend_from_slice(&1u16.to_le_bytes());
            wav.extend_from_slice(&1u16.to_le_bytes());
            wav.extend_from_slice(&audio.sample_rate.to_le_bytes());
            wav.extend_from_slice(&(audio.sample_rate * 2).to_le_bytes());
            wav.extend_from_slice(&2u16.to_le_bytes());
            wav.extend_from_slice(&16u16.to_le_bytes());
            wav.extend_from_slice(b"data");
            wav.extend_from_slice(&data_len.to_le_bytes());
            for s in &audio.samples {
                wav.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
            }
            std::fs::write("/tmp/loom-tts-probe.wav", wav).unwrap();
            println!("wrote /tmp/loom-tts-probe.wav");
        }
        Err(e) => {
            eprintln!("FAIL: {e}");
            std::process::exit(1);
        }
    }
}
