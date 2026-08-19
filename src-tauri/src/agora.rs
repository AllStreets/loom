/// agora.rs — AGORA child-process manager
///
/// Commands: agora_start, agora_stop, agora_status, agora_logs
/// State: AgoraState (Mutex<Option<Child>> + Arc<Mutex<VecDeque<String>>> ring)
/// Process safety: fixed argv ["npm","run","dev"], home-prefix path validation,
///   package.json scripts.dev check, single-child mutex, exit kill.

use crate::error::LoomError;
use serde::Serialize;
use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

const RING_CAP: usize = 200;

// ── State ─────────────────────────────────────────────────────────────────────

pub struct AgoraState {
    pub child: Mutex<Option<Child>>,
    pub ring: Arc<Mutex<VecDeque<String>>>,
}

impl Default for AgoraState {
    fn default() -> Self {
        AgoraState {
            child: Mutex::new(None),
            ring: Arc::new(Mutex::new(VecDeque::new())),
        }
    }
}

// ── Status type ───────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct AgoraStatus {
    pub running: bool,
    pub pid: Option<u32>,
}

// ── Path validation (inner, testable) ─────────────────────────────────────────

/// Inner: validate path given an explicit home dir for testability.
pub fn validate_agora_path_inner(path: &Path, home: &Path) -> Result<(), LoomError> {
    // Must exist
    if !path.exists() {
        return Err(LoomError::NotFound(format!(
            "AGORA path does not exist: {}",
            path.display()
        )));
    }

    // Must be a directory
    if !path.is_dir() {
        return Err(LoomError::NotFound(format!(
            "AGORA path is not a directory: {}",
            path.display()
        )));
    }

    // Must be under home prefix
    if !path.starts_with(home) {
        return Err(LoomError::NotFound(format!(
            "AGORA path must be under home directory ({}): {}",
            home.display(),
            path.display()
        )));
    }

    // Must have package.json
    let pkg_path = path.join("package.json");
    if !pkg_path.exists() {
        return Err(LoomError::NotFound(format!(
            "AGORA path has no package.json: {}",
            path.display()
        )));
    }

    // package.json must have scripts.dev
    let pkg_contents = std::fs::read_to_string(&pkg_path)
        .map_err(|e| LoomError::Parse(format!("read package.json: {e}")))?;
    let pkg: serde_json::Value = serde_json::from_str(&pkg_contents)
        .map_err(|e| LoomError::Parse(format!("parse package.json: {e}")))?;

    let has_dev = pkg
        .get("scripts")
        .and_then(|s| s.get("dev"))
        .is_some();

    if !has_dev {
        return Err(LoomError::Parse(format!(
            "package.json at {} has no scripts.dev entry",
            path.display()
        )));
    }

    Ok(())
}

/// Public wrapper — uses the real home directory.
pub fn validate_agora_path(path: &Path) -> Result<(), LoomError> {
    let home = home_dir()?;
    validate_agora_path_inner(path, &home)
}

// ── Tilde expansion ───────────────────────────────────────────────────────────

pub fn expand_tilde(path: &str) -> String {
    if path == "~" {
        return std::env::var("HOME").unwrap_or_else(|_| path.to_string());
    }
    if let Some(rest) = path.strip_prefix("~/") {
        let home = std::env::var("HOME").unwrap_or_else(|_| "~".to_string());
        return format!("{home}/{rest}");
    }
    path.to_string()
}

fn home_dir() -> Result<PathBuf, LoomError> {
    let home = std::env::var("HOME")
        .map_err(|_| LoomError::NotFound("HOME environment variable not set".to_string()))?;
    Ok(PathBuf::from(home))
}

// ── Ring buffer helper ────────────────────────────────────────────────────────

fn ring_push(ring: &Arc<Mutex<VecDeque<String>>>, line: String) {
    if let Ok(mut buf) = ring.lock() {
        buf.push_back(line);
        while buf.len() > RING_CAP {
            buf.pop_front();
        }
    }
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Start AGORA. If already running, returns Ok("already running").
/// Accepts path (empty → default ~/Downloads/AGORA, ~ expanded Rust-side).
/// Fixed argv: npm run dev. Path validated before spawn.
#[tauri::command]
pub fn agora_start(
    path: String,
    state: tauri::State<'_, AgoraState>,
) -> Result<String, LoomError> {
    let mut child_lock = state.child.lock().map_err(|e| LoomError::Git(format!("lock: {e}")))?;

    // Check if already running
    if let Some(child) = child_lock.as_mut() {
        match child.try_wait() {
            Ok(None) => {
                // Still running
                return Ok("already running".to_string());
            }
            _ => {
                // Exited or error — remove stale handle
                *child_lock = None;
            }
        }
    }

    // Resolve path
    let raw_path = if path.trim().is_empty() {
        "~/Downloads/AGORA".to_string()
    } else {
        path
    };
    let expanded = expand_tilde(&raw_path);
    let work_dir = PathBuf::from(&expanded);

    // Validate
    validate_agora_path(&work_dir)?;

    // Clear ring buffer
    if let Ok(mut buf) = state.ring.lock() {
        buf.clear();
    }

    // Spawn: npm run dev (no shell, fixed argv)
    let mut cmd = Command::new("npm");
    cmd.arg("run").arg("dev");
    cmd.current_dir(&work_dir);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| LoomError::Git(format!("spawn npm run dev: {e}")))?;

    // Spawn reader threads for stdout and stderr
    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    {
        let ring = Arc::clone(&state.ring);
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                if let Ok(l) = line {
                    ring_push(&ring, l);
                }
            }
        });
    }

    {
        let ring = Arc::clone(&state.ring);
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                if let Ok(l) = line {
                    ring_push(&ring, format!("[err] {l}"));
                }
            }
        });
    }

    let pid = child.id();
    *child_lock = Some(child);

    Ok(format!("started pid={pid}"))
}

/// Stop AGORA. Kills child process if running.
#[tauri::command]
pub fn agora_stop(state: tauri::State<'_, AgoraState>) -> Result<(), LoomError> {
    let mut child_lock = state.child.lock().map_err(|e| LoomError::Git(format!("lock: {e}")))?;
    if let Some(mut child) = child_lock.take() {
        child
            .kill()
            .map_err(|e| LoomError::Git(format!("kill agora: {e}")))?;
        let _ = child.wait(); // reap
    }
    Ok(())
}

/// Returns running status and optional PID.
#[tauri::command]
pub fn agora_status(state: tauri::State<'_, AgoraState>) -> AgoraStatus {
    let mut child_lock = match state.child.lock() {
        Ok(g) => g,
        Err(_) => return AgoraStatus { running: false, pid: None },
    };

    if let Some(child) = child_lock.as_mut() {
        match child.try_wait() {
            Ok(None) => {
                // Still running
                return AgoraStatus { running: true, pid: Some(child.id()) };
            }
            _ => {
                // Exited
                *child_lock = None;
            }
        }
    }

    AgoraStatus { running: false, pid: None }
}

/// Returns the ring buffer (up to 200 lines). Frontend slices last N.
#[tauri::command]
pub fn agora_logs(state: tauri::State<'_, AgoraState>) -> Vec<String> {
    match state.ring.lock() {
        Ok(buf) => buf.iter().cloned().collect(),
        Err(_) => vec![],
    }
}

// ── Exit hook helper (called from lib.rs) ────────────────────────────────────

/// Kill AGORA child if running. Called from the Tauri RunEvent::Exit handler.
pub fn kill_agora(state: &AgoraState) {
    if let Ok(mut child_lock) = state.child.lock() {
        if let Some(mut child) = child_lock.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    // ── Path validation tests ─────────────────────────────────────────────────

    #[test]
    fn test_validate_path_nonexistent() {
        let dir = tempdir().unwrap();
        let home = dir.path().to_path_buf();
        let nonexistent = home.join("nonexistent-agora-dir");
        // nonexistent_dir was never created
        let result = validate_agora_path_inner(&nonexistent, &home);
        assert!(result.is_err(), "nonexistent path must return Err");
        match result.unwrap_err() {
            LoomError::NotFound(_) => {}
            e => panic!("expected NotFound, got {:?}", e),
        }
    }

    #[test]
    fn test_validate_path_outside_home() {
        // Use /tmp as a path that is NOT under the fake home
        let fake_home = PathBuf::from("/Users/fake-home-that-does-not-exist-at-all");
        let tmp = PathBuf::from("/tmp");
        // /tmp exists and is a dir but not under fake_home
        let result = validate_agora_path_inner(&tmp, &fake_home);
        assert!(result.is_err(), "/tmp must not be accepted outside home");
        match result.unwrap_err() {
            LoomError::NotFound(_) => {}
            e => panic!("expected NotFound, got {:?}", e),
        }
    }

    #[test]
    fn test_validate_path_file_not_dir() {
        let dir = tempdir().unwrap();
        let home = dir.path().to_path_buf();
        // Create a file (not a directory)
        let file_path = home.join("not-a-dir.txt");
        fs::write(&file_path, b"hello").unwrap();
        let result = validate_agora_path_inner(&file_path, &home);
        assert!(result.is_err(), "file path must return Err");
        match result.unwrap_err() {
            LoomError::NotFound(_) => {}
            e => panic!("expected NotFound, got {:?}", e),
        }
    }

    #[test]
    fn test_validate_path_missing_package_json() {
        let dir = tempdir().unwrap();
        let home = dir.path().to_path_buf();
        let agora_dir = home.join("agora-test");
        fs::create_dir_all(&agora_dir).unwrap();
        // No package.json
        let result = validate_agora_path_inner(&agora_dir, &home);
        assert!(result.is_err(), "missing package.json must return Err");
        match result.unwrap_err() {
            LoomError::NotFound(_) => {}
            e => panic!("expected NotFound, got {:?}", e),
        }
    }

    #[test]
    fn test_validate_path_no_scripts_dev() {
        let dir = tempdir().unwrap();
        let home = dir.path().to_path_buf();
        let agora_dir = home.join("agora-test");
        fs::create_dir_all(&agora_dir).unwrap();
        // package.json without scripts.dev
        fs::write(agora_dir.join("package.json"), r#"{"scripts":{}}"#).unwrap();
        let result = validate_agora_path_inner(&agora_dir, &home);
        assert!(result.is_err(), "missing scripts.dev must return Err");
        match result.unwrap_err() {
            LoomError::Parse(_) => {}
            e => panic!("expected Parse, got {:?}", e),
        }
    }

    #[test]
    fn test_validate_path_valid() {
        let dir = tempdir().unwrap();
        let home = dir.path().to_path_buf();
        let agora_dir = home.join("agora-test");
        fs::create_dir_all(&agora_dir).unwrap();
        fs::write(
            agora_dir.join("package.json"),
            r#"{"scripts":{"dev":"concurrently -k npm:engine npm:web"}}"#,
        )
        .unwrap();
        let result = validate_agora_path_inner(&agora_dir, &home);
        assert!(result.is_ok(), "valid path must return Ok, got {:?}", result);
    }

    // ── Ring buffer tests ─────────────────────────────────────────────────────

    #[test]
    fn test_ring_buffer_cap() {
        let ring: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
        // Push 250 lines (50 more than cap)
        for i in 0..250usize {
            ring_push(&ring, format!("line {i}"));
        }
        let buf = ring.lock().unwrap();
        assert_eq!(buf.len(), RING_CAP, "ring buffer must be capped at {RING_CAP}");
        // Last line should be line 249
        assert_eq!(buf.back().unwrap(), "line 249");
        // First line should be line 50 (the first 50 were popped)
        assert_eq!(buf.front().unwrap(), "line 50");
    }

    #[test]
    fn test_ring_buffer_exact_cap() {
        let ring: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
        // Push exactly cap lines
        for i in 0..RING_CAP {
            ring_push(&ring, format!("line {i}"));
        }
        let buf = ring.lock().unwrap();
        assert_eq!(buf.len(), RING_CAP);
        assert_eq!(buf.front().unwrap(), "line 0");
        assert_eq!(buf.back().unwrap(), &format!("line {}", RING_CAP - 1));
    }

    // ── Tilde expansion tests ─────────────────────────────────────────────────

    #[test]
    fn test_expand_tilde_home() {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
        assert_eq!(expand_tilde("~"), home);
    }

    #[test]
    fn test_expand_tilde_path() {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
        let expanded = expand_tilde("~/Downloads/AGORA");
        assert_eq!(expanded, format!("{home}/Downloads/AGORA"));
    }

    #[test]
    fn test_expand_tilde_no_tilde() {
        assert_eq!(expand_tilde("/absolute/path"), "/absolute/path");
    }
}
