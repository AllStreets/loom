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

/// Where `HEAD` lives. `../.git/HEAD` is the plain case; in a linked worktree
/// `.git` is a file naming the real gitdir, so we also watch that HEAD — the
/// sha must move when HEAD moves, in either layout.
fn head_paths(repo_root: &Path) -> Vec<PathBuf> {
    let dot_git = repo_root.join(".git");
    let mut v = vec![dot_git.join("HEAD")];
    if let Ok(s) = std::fs::read_to_string(&dot_git) {
        if let Some(rest) = s.trim().strip_prefix("gitdir:") {
            let gitdir = PathBuf::from(rest.trim());
            let gitdir = if gitdir.is_absolute() { gitdir } else { repo_root.join(gitdir) };
            v.push(gitdir.join("HEAD"));
        }
    }
    v
}

fn main() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir.parent().map(Path::to_path_buf).unwrap_or(manifest_dir.clone());

    println!("cargo:rustc-env=LOOM_GENOME_SHA={}", genome_sha(&repo_root));
    println!("cargo:rerun-if-changed=../.git/HEAD");
    for p in head_paths(&repo_root).into_iter().skip(1) {
        println!("cargo:rerun-if-changed={}", p.display());
    }

    tauri_build::build()
}
