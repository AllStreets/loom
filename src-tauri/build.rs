// PROTECTED (kernel.rs `PROTECTED_RUST`): this script runs before the app
// exists and bakes the binary's own identity into it. A self-edit here could
// make a generation lie about the sha it was woven from.

use std::path::{Path, PathBuf};
use std::process::Command;

/// The sha this binary is woven from: `git rev-parse HEAD` in the repo root
/// (the parent of `src-tauri/`), or `unknown` when the build happens outside a
/// repo (a seeded loomhome that lost its `.git`, or a stray checkout).
fn genome_sha(repo_root: &Path) -> String {
    let out = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(repo_root)
        .output();
    match out {
        Ok(o) if o.status.success() => {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s.len() == 40 && s.chars().all(|c| c.is_ascii_hexdigit()) { s } else { "unknown".into() }
        }
        _ => "unknown".into(),
    }
}

/// Where HEAD and the refs it points at live. Two layouts: a plain checkout
/// (`.git` is a directory) and a linked worktree (`.git` is a file naming the
/// real gitdir, whose `commondir` names where refs live).
fn git_dirs(repo_root: &Path) -> (PathBuf, PathBuf) {
    let dot_git = repo_root.join(".git");
    if let Ok(s) = std::fs::read_to_string(&dot_git) {
        if let Some(rest) = s.trim().strip_prefix("gitdir:") {
            let gitdir = PathBuf::from(rest.trim());
            let gitdir = if gitdir.is_absolute() { gitdir } else { repo_root.join(gitdir) };
            let common = std::fs::read_to_string(gitdir.join("commondir"))
                .ok()
                .map(|c| {
                    let p = PathBuf::from(c.trim());
                    if p.is_absolute() { p } else { gitdir.join(p) }
                })
                .unwrap_or_else(|| gitdir.clone());
            return (gitdir, common);
        }
    }
    (dot_git.clone(), dot_git)
}

/// Every path whose change means HEAD now names a different commit.
///
/// `HEAD` ALONE IS NOT ENOUGH, and getting this wrong bakes a lie into the
/// binary. On a branch, `HEAD` holds `ref: refs/heads/<branch>` and never
/// changes when you commit — git rewrites `refs/heads/<branch>` instead. A
/// build script watching only `HEAD` therefore does not rerun after a commit,
/// and the next binary carries the PREVIOUS sha as its own name: the ledger
/// would record one generation while the body reported another, `seed_source`
/// would check a fresh install out to an older commit than the bundle it
/// shipped with, and the owner would be offered a reweave that never settles.
/// So we watch the resolved ref too — loose and packed (a ref that is packed
/// has no loose file; cargo reruns when a watched path appears).
fn watched_paths(repo_root: &Path) -> Vec<PathBuf> {
    let (gitdir, common) = git_dirs(repo_root);
    let head = gitdir.join("HEAD");
    let mut v = vec![head.clone()];
    if let Ok(s) = std::fs::read_to_string(&head) {
        if let Some(r) = s.trim().strip_prefix("ref:") {
            let r = r.trim();
            if !r.is_empty() && !r.contains("..") {
                v.push(common.join(r));
                v.push(common.join("packed-refs"));
            }
        }
    }
    v
}

/// The dylibs the TTS stack links against, by name. `sherpa-rs-sys` drops them
/// in the CURRENT profile's target dir (`target/debug` or `target/release`),
/// which is a path `tauri.conf.json` cannot name — it holds one static list,
/// and a missing entry is a FATAL build error in `tauri-build`. So we copy them
/// somewhere stable that the config can name, from wherever this profile put
/// them, before `tauri_build::build()` reads that list.
///
/// Without this, `cargo test` on a clean checkout dies with "Library not
/// found: target/release/…" — the config would only ever be right for the
/// profile that happened to have been built last.
const TTS_DYLIBS: &[&str] = &[
    "libonnxruntime.1.17.1.dylib",
    "libsherpa-onnx-c-api.dylib",
    "libsherpa-onnx-cxx-api.dylib",
];

/// Stage the TTS dylibs into `src-tauri/libs/` (gitignored) from this build's
/// own profile directory. Best effort: a name that is not there is left for
/// `tauri-build` to complain about with its own clearer message.
#[cfg(target_os = "macos")]
fn stage_tts_dylibs(manifest_dir: &Path) {
    // OUT_DIR is <target>/<profile>/build/<pkg>-<hash>/out — three parents up
    // is the profile dir sherpa-rs-sys copied into.
    let Ok(out) = std::env::var("OUT_DIR") else { return };
    let Some(profile_dir) = Path::new(&out).ancestors().nth(3) else { return };
    let libs = manifest_dir.join("libs");
    if std::fs::create_dir_all(&libs).is_err() {
        return;
    }
    for name in TTS_DYLIBS {
        let from = profile_dir.join(name);
        if from.is_file() {
            let _ = std::fs::copy(&from, libs.join(name));
        }
    }
}

fn main() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir.parent().map(Path::to_path_buf).unwrap_or(manifest_dir.clone());

    // The TTS stack (sherpa-onnx + onnxruntime) ships as dylibs whose install
    // names are `@rpath/...`, and nothing else emits an rpath — without these
    // three lines the binary dies at launch with "no LC_RPATH's found", in dev
    // and in the bundle alike. The dylibs sit beside the binary in
    // `target/<profile>/` (dev), one level up from a test binary in
    // `target/<profile>/deps/`, and in `Contents/Frameworks` of the packaged
    // app (put there by `bundle.macOS.frameworks`). dyld tries each in turn.
    #[cfg(target_os = "macos")]
    for rpath in ["@executable_path", "@executable_path/..", "@executable_path/../Frameworks"] {
        println!("cargo:rustc-link-arg=-Wl,-rpath,{rpath}");
    }

    #[cfg(target_os = "macos")]
    stage_tts_dylibs(&manifest_dir);

    println!("cargo:rustc-env=LOOM_GENOME_SHA={}", genome_sha(&repo_root));
    for p in watched_paths(&repo_root) {
        println!("cargo:rerun-if-changed={}", p.display());
    }

    tauri_build::build()
}
