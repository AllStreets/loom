//! exec.rs — hardened, fixed-argv command runner for the self-edit safety core.
//!
//! `run_checked(argv, cwd, allowed_root, timeout)` is the ONLY way the kernel
//! spawns validation processes (`npx tsc`, `npx vitest`). It mirrors the
//! discipline of the deleted `agora.rs` spawn:
//!   - fixed argv ONLY — no user-supplied string ever reaches the argv. Callers
//!     build the argv from constants; paths that vary (e.g. the list of edited
//!     files handed to vitest) are the caller's responsibility to derive from
//!     validated, whitelisted relative paths, never from raw model output.
//!   - cwd is `canonicalize()`d and asserted to `starts_with` a canonical
//!     `allowed_root` (the worktree root). An escape returns a typed error and
//!     nothing is spawned.
//!   - `Stdio::piped()` on stdout+stderr; output is ring-capped to the last
//!     `RING_LINES` lines per stream so a runaway build cannot exhaust memory.
//!   - `#[cfg(unix)]` `process_group(0)` so the child is its own group leader;
//!     on timeout AND on drop we `kill(-pgid, SIGKILL)` to take the WHOLE tree
//!     (npx → tsc/vitest grandchildren) down, not just the npx shim.
//!
//! `run_checked_env` is the same runner with a fixed list of env pairs the
//! caller composes from constants and LOOM-owned paths. `run_detached` is the
//! one exception to "wait and kill": it spawns a process meant to outlive us
//! (the warden, the relaunch) and returns only its pid.
//!
//! No shell is ever invoked.

use crate::error::LoomError;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// Last N lines retained per stream. A wall between "captured for the owner"
/// and "unbounded memory".
const RING_LINES: usize = 400;

/// Poll interval while waiting for the child, so timeout is honored promptly
/// without a busy loop.
const POLL: Duration = Duration::from_millis(25);

#[derive(Debug, serde::Serialize)]
pub struct ExecOut {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// A spawned child that group-kills its whole tree on drop (unix). Wrapping the
/// raw `Child` guarantees no orphaned process group survives an early return /
/// panic on any path between spawn and reap.
struct Guard {
    child: Child,
    reaped: bool,
}

impl Guard {
    fn pid(&self) -> u32 {
        self.child.id()
    }

    /// Group-kill (unix) then direct-kill fallback, then reap. Idempotent.
    fn kill_tree(&mut self) {
        if self.reaped {
            return;
        }
        #[cfg(unix)]
        unsafe {
            // Negative pid → signal the entire process group. The child is its
            // own group leader (process_group(0)), so pgid == child pid.
            libc::kill(-(self.child.id() as i32), libc::SIGKILL);
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.reaped = true;
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        // Safety net: if we return/panic before an explicit reap, take the tree
        // down. No orphan process group ever survives run_checked.
        self.kill_tree();
    }
}

fn ring_tail(bytes: &[u8]) -> String {
    let s = String::from_utf8_lossy(bytes);
    let mut lines: Vec<&str> = s.lines().collect();
    if lines.len() > RING_LINES {
        lines = lines.split_off(lines.len() - RING_LINES);
    }
    lines.join("\n")
}

/// Validate the argv and the cwd containment shared by every spawn in this
/// module. Both `cwd` and `allowed_root` are canonicalized before the
/// `starts_with` check — a symlinked cwd resolving outside the allowed root
/// must not pass. Returns the canonical cwd to spawn in.
fn checked_cwd(argv: &[&str], cwd: &Path, allowed_root: &Path) -> Result<PathBuf, LoomError> {
    if argv.is_empty() {
        return Err(LoomError::Parse("exec: empty argv".into()));
    }
    let canonical_cwd = cwd
        .canonicalize()
        .map_err(|e| LoomError::NotFound(format!("exec: canonicalize cwd {}: {e}", cwd.display())))?;
    let canonical_root = allowed_root.canonicalize().map_err(|e| {
        LoomError::NotFound(format!(
            "exec: canonicalize allowed_root {}: {e}",
            allowed_root.display()
        ))
    })?;
    if !canonical_cwd.starts_with(&canonical_root) {
        return Err(LoomError::Parse(format!(
            "exec: cwd {} escapes allowed root {}",
            canonical_cwd.display(),
            canonical_root.display()
        )));
    }
    Ok(canonical_cwd)
}

/// Run a fixed argv in `cwd`, which MUST canonicalize to a path under the
/// canonical `allowed_root`. Kills the whole process group on timeout / drop.
///
/// `argv[0]` is the program; `argv[1..]` its arguments. Empty argv is rejected.
pub fn run_checked(
    argv: &[&str],
    cwd: &Path,
    allowed_root: &Path,
    timeout: Duration,
) -> Result<ExecOut, LoomError> {
    run_checked_env(argv, cwd, allowed_root, timeout, &[])
}

/// `run_checked` plus a fixed list of environment pairs set on the child.
///
/// `envs` is composed by the caller from constants and LOOM-owned paths
/// (e.g. `CARGO_TARGET_DIR`, `CARGO_NET_OFFLINE`) — never from model output.
/// Everything else (containment, group kill, ring-capped output) is identical.
pub fn run_checked_env(
    argv: &[&str],
    cwd: &Path,
    allowed_root: &Path,
    timeout: Duration,
    envs: &[(&str, &str)],
) -> Result<ExecOut, LoomError> {
    let canonical_cwd = checked_cwd(argv, cwd, allowed_root)?;

    let mut cmd = Command::new(argv[0]);
    for a in &argv[1..] {
        cmd.arg(a);
    }
    for (k, v) in envs {
        cmd.env(k, v);
    }
    cmd.current_dir(&canonical_cwd);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    #[cfg(unix)]
    cmd.process_group(0);

    let child = cmd
        .spawn()
        .map_err(|e| LoomError::Git(format!("exec: spawn {}: {e}", argv[0])))?;
    let mut guard = Guard {
        child,
        reaped: false,
    };

    // Drain stdout/stderr on threads so a full pipe can never deadlock the
    // child, then join after the process settles.
    let out_handle = guard.child.stdout.take().map(|mut s| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = std::io::Read::read_to_end(&mut s, &mut buf);
            buf
        })
    });
    let err_handle = guard.child.stderr.take().map(|mut s| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = std::io::Read::read_to_end(&mut s, &mut buf);
            buf
        })
    });

    let start = Instant::now();
    let status = loop {
        match guard.child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let pid = guard.pid();
                    guard.kill_tree();
                    // Join the reader threads so we surface whatever partial
                    // output was captured before the kill.
                    let stdout = out_handle
                        .and_then(|h| h.join().ok())
                        .map(|b| ring_tail(&b))
                        .unwrap_or_default();
                    let stderr = err_handle
                        .and_then(|h| h.join().ok())
                        .map(|b| ring_tail(&b))
                        .unwrap_or_default();
                    let _ = (stdout, stderr, pid);
                    return Err(LoomError::Timeout);
                }
                std::thread::sleep(POLL);
            }
            Err(e) => {
                guard.kill_tree();
                return Err(LoomError::Git(format!("exec: wait: {e}")));
            }
        }
    };
    guard.reaped = true; // exited cleanly; Drop must not re-kill/re-wait

    let stdout = out_handle
        .and_then(|h| h.join().ok())
        .map(|b| ring_tail(&b))
        .unwrap_or_default();
    let stderr = err_handle
        .and_then(|h| h.join().ok())
        .map(|b| ring_tail(&b))
        .unwrap_or_default();

    // -1 encodes "killed by signal, no exit code" (unix). On success/failure
    // the real code is captured.
    let code = status.code().unwrap_or(-1);
    Ok(ExecOut {
        code,
        stdout,
        stderr,
    })
}

/// Spawn a fixed argv and let it go: no wait, no kill on drop, all stdio
/// null, its own process group (unix) so it survives our exit. Returns the
/// child's pid. Same argv / cwd containment rules as `run_checked`.
///
/// Used ONLY for the warden and the relaunch — processes that must outlive
/// the LOOM that spawned them. Everything else goes through `run_checked`.
pub fn run_detached(argv: &[&str], cwd: &Path, allowed_root: &Path) -> Result<u32, LoomError> {
    let canonical_cwd = checked_cwd(argv, cwd, allowed_root)?;

    let mut cmd = Command::new(argv[0]);
    for a in &argv[1..] {
        cmd.arg(a);
    }
    cmd.current_dir(&canonical_cwd);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::null());
    #[cfg(unix)]
    cmd.process_group(0);

    let child = cmd
        .spawn()
        .map_err(|e| LoomError::Git(format!("exec: spawn detached {}: {e}", argv[0])))?;
    // Dropping a std `Child` neither kills nor waits; the pid is all we keep.
    Ok(child.id())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn sh(script: &str, cwd: &Path, timeout_ms: u64) -> Result<ExecOut, LoomError> {
        run_checked(
            &["sh", "-c", script],
            cwd,
            cwd,
            Duration::from_millis(timeout_ms),
        )
    }

    #[cfg(unix)]
    #[test]
    fn exit_zero_captured() {
        let dir = tempfile::tempdir().unwrap();
        let out = sh("printf hello; exit 0", dir.path(), 5000).unwrap();
        assert_eq!(out.code, 0);
        assert!(out.stdout.contains("hello"), "stdout was {:?}", out.stdout);
    }

    #[cfg(unix)]
    #[test]
    fn nonzero_code_captured() {
        let dir = tempfile::tempdir().unwrap();
        let out = sh("printf oops 1>&2; exit 7", dir.path(), 5000).unwrap();
        assert_eq!(out.code, 7);
        assert!(out.stderr.contains("oops"), "stderr was {:?}", out.stderr);
    }

    #[cfg(unix)]
    #[test]
    fn timeout_kills_the_whole_tree() {
        // A shell whose backgrounded `sleep` lands in the same new process
        // group. The shell prints the grandchild pid, then waits on it. On
        // timeout we group-kill; the grandchild must die too.
        let dir = tempfile::tempdir().unwrap();
        let script = "sleep 30 & echo $! > pid.txt; wait";
        let start = Instant::now();
        let res = sh(script, dir.path(), 300);
        assert!(matches!(res, Err(LoomError::Timeout)), "expected Timeout, got {res:?}");
        assert!(start.elapsed() < Duration::from_secs(5), "should have killed promptly");

        // Give the OS a moment, then confirm the grandchild sleep is gone.
        std::thread::sleep(Duration::from_millis(250));
        let pid = std::fs::read_to_string(dir.path().join("pid.txt"))
            .unwrap()
            .trim()
            .to_string();
        let out = Command::new("ps")
            .args(["-o", "stat=", "-p", &pid])
            .output()
            .unwrap();
        let stat = String::from_utf8_lossy(&out.stdout).trim().to_string();
        assert!(
            stat.is_empty() || stat.starts_with('Z'),
            "grandchild sleep must be dead after group kill, got stat={stat:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn cwd_outside_root_refused() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        // cwd is a real dir but NOT under `root` → refused, nothing spawned.
        let res = run_checked(
            &["sh", "-c", "echo hi"],
            outside.path(),
            root.path(),
            Duration::from_millis(1000),
        );
        assert!(res.is_err(), "cwd outside root must be refused");
        match res.unwrap_err() {
            LoomError::Parse(m) => assert!(m.contains("escapes"), "msg was {m}"),
            e => panic!("expected Parse(escape), got {e:?}"),
        }
    }

    #[test]
    fn empty_argv_refused() {
        let dir = tempfile::tempdir().unwrap();
        let res = run_checked(&[], dir.path(), dir.path(), Duration::from_millis(100));
        assert!(matches!(res, Err(LoomError::Parse(_))));
    }

    #[cfg(unix)]
    #[test]
    fn output_ring_capped() {
        let dir = tempfile::tempdir().unwrap();
        // Emit far more than RING_LINES lines; only the tail is retained.
        let out = sh("for i in $(seq 1 1000); do echo line$i; done", dir.path(), 8000).unwrap();
        let n = out.stdout.lines().count();
        assert!(n <= RING_LINES, "stdout retained {n} lines, cap is {RING_LINES}");
        assert!(out.stdout.contains("line1000"), "must keep the tail");
        assert!(!out.stdout.contains("line1\n"), "must have dropped the head");
    }

    #[cfg(unix)]
    #[test]
    fn env_pairs_reach_the_child() {
        let dir = tempfile::tempdir().unwrap();
        let out = run_checked_env(
            &["/usr/bin/env"],
            dir.path(),
            dir.path(),
            Duration::from_secs(5),
            &[("LOOM_T", "woven")],
        )
        .unwrap();
        assert_eq!(out.code, 0);
        assert!(out.stdout.contains("LOOM_T=woven"), "stdout was {:?}", out.stdout);
    }

    #[cfg(unix)]
    #[test]
    fn env_variant_still_rejects_escape() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let res = run_checked_env(
            &["/usr/bin/env"],
            outside.path(),
            root.path(),
            Duration::from_secs(1),
            &[("LOOM_T", "woven")],
        );
        assert!(matches!(res, Err(LoomError::Parse(_))), "got {res:?}");
    }

    #[cfg(unix)]
    #[test]
    fn detached_returns_a_live_pid() {
        let dir = tempfile::tempdir().unwrap();
        let pid = run_detached(&["/bin/sleep", "2"], dir.path(), dir.path()).unwrap();
        assert!(pid > 0, "pid must be positive, got {pid}");
        // The child is alive and not waited on: signal 0 probes without killing.
        let alive = unsafe { libc::kill(pid as i32, 0) } == 0;
        assert!(alive, "detached child {pid} should still be running");
        unsafe {
            libc::kill(pid as i32, libc::SIGKILL);
        }
    }

    #[cfg(unix)]
    #[test]
    fn detached_rejects_escape() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let res = run_detached(&["/bin/sleep", "2"], outside.path(), root.path());
        assert!(matches!(res, Err(LoomError::Parse(_))), "got {res:?}");
    }
}
