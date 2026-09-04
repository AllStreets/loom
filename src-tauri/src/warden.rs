//! warden — the previous generation guards the birth of the next (Phase 23 / Rebirth).
//!
//! PROTECTED (kernel.rs `PROTECTED_RUST`): this module is the fifth wall for
//! a binary. If LOOM could edit it, a broken body could disarm the one thing
//! that brings it home.
//!
//! The warden is the PREVIOUS generation's executable — a body already proven
//! to boot — started as `<generations/<prev>/loom> --warden <warden.json>`.
//! `dispatch` is the first statement of `run()` in lib.rs: it runs before
//! `preboot_heal`, before Tauri, and never constructs an app. The loop
//! (spec §The warden):
//!
//! 1. wait for `oldPid` to exit (poll, 30 s cap, then proceed);
//! 2. `open -n <appPath>` — a LaunchServices launch: dock icon, permissions,
//!    one instance;
//! 3. watch the sentinel: the new body's pre-main marks `booting`, a healthy
//!    shell's `kernel_boot_ok` marks `ok` and confirms the ledger;
//! 4. confirmed within `timeoutSecs` → write nothing else, exit;
//! 5. not confirmed — the process vanished (`crashed`) or the clock ran out
//!    (`never confirmed`) — → HEAL: kill any lingering new process, copy the
//!    previous body back over the executable, re-sign, sentinel `healed`,
//!    ledger `current: prev`, recovery record, `open -n` again, exit.
//!
//! `relaunchOnly` jobs come from the pre-main backstop (kernel.rs): the heal
//! already happened in-process; the warden only waits for that process to
//! leave and opens the app.
//!
//! Everything the loop touches outside the filesystem goes through `World`,
//! so the whole state machine is unit-tested against a scripted `FakeWorld`.
//! `RealWorld` spawns only `/usr/bin/open` and `/usr/bin/pgrep` through
//! `exec::run_checked` (fixed argv, contained cwd, no shell) and signals with
//! `libc::kill`.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::error::LoomError;
use crate::exec;
use crate::kernel::{self, Sentinel};
use crate::loomhome::Home;
use crate::platform::{self, AppLayout, Step};
use crate::reweave;
use crate::threads;

// ── Job ───────────────────────────────────────────────────────────────────────

/// `warden.json` (spec §Reweave step 5), camelCase. Written by the reweave's
/// relaunch stage (and by the pre-main backstop with `relaunch_only: true`);
/// the warden adds `warden_pid` at start so the backstop can tell a live
/// warden from a dead one.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    /// The LOOM that spawned the warden — the warden waits for it to exit.
    pub old_pid: u32,
    /// `…/LOOM.app`
    pub app_path: PathBuf,
    /// `…/LOOM.app/Contents/MacOS/loom`
    pub exe_path: PathBuf,
    /// The generation being born.
    pub new_sha: String,
    /// The generation to come home to (= the warden's own body).
    pub prev_sha: String,
    pub loomhome: PathBuf,
    pub timeout_secs: u64,
    /// The heal already happened in-process; only open the app.
    pub relaunch_only: bool,
    /// The warden's own pid, written by the warden at start.
    #[serde(default)]
    pub warden_pid: Option<u32>,
}

/// The warden's recovery record, `loomhome/recovery.json`. Surfaced once by
/// `kernel_boot_check` as `healedGeneration`, then deleted.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Recovery {
    pub failed_sha: String,
    pub prev_sha: String,
    /// `"crashed"` | `"never confirmed"`.
    pub reason: String,
    /// The last ≤ 40 lines of `reweave.json`'s tail — what the weave said
    /// before the body failed. Empty when there is no record.
    pub log_tail: Vec<String>,
}

/// How many lines of the reweave's tail the recovery record keeps.
const LOG_TAIL_LINES: usize = 40;
/// Step 1's cap on waiting for the old LOOM to leave.
const OLD_PID_WAIT: Duration = Duration::from_secs(30);
/// After `open`, how long a body may take to appear in `pgrep` before its
/// absence counts as a crash.
const LAUNCH_GRACE: Duration = Duration::from_secs(10);
const TICK: Duration = Duration::from_millis(500);

pub const REASON_CRASHED: &str = "crashed";
pub const REASON_NEVER_CONFIRMED: &str = "never confirmed";

// ── World ─────────────────────────────────────────────────────────────────────

/// Everything the loop does outside plain file I/O, so it can be scripted.
pub trait World {
    fn pid_alive(&self, pid: u32) -> bool;
    fn open_app(&mut self, app: &Path) -> Result<(), LoomError>;
    /// Every live pid whose command line names `exe` (never our own).
    fn find_pids(&self, exe: &Path) -> Vec<u32>;
    fn kill(&mut self, pid: u32);
    fn read_sentinel(&self) -> Option<Sentinel>;
    fn now(&self) -> Instant;
    fn sleep(&mut self, d: Duration);
}

/// The real machine: `/usr/bin/open -n`, `/usr/bin/pgrep -f`, `libc::kill`.
pub struct RealWorld {
    sentinel: PathBuf,
}

impl RealWorld {
    pub fn new(home: &Home) -> RealWorld {
        RealWorld { sentinel: home.sentinel_json() }
    }
}

/// The directory a spawn is contained in: the app bundle's (or exe's) parent.
fn parent_of(path: &Path) -> Result<PathBuf, LoomError> {
    path.parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| LoomError::NotFound(format!("parent of {}", path.display())))
}

/// Is `pid` a live process? `kill(pid, 0)` — EPERM still means alive.
pub fn pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        let rc = unsafe { libc::kill(pid as libc::pid_t, 0) };
        rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

impl World for RealWorld {
    fn pid_alive(&self, pid: u32) -> bool {
        pid_alive(pid)
    }

    fn open_app(&mut self, app: &Path) -> Result<(), LoomError> {
        let root = parent_of(app)?;
        let target = app.to_string_lossy().into_owned();
        let out = exec::run_checked(&["/usr/bin/open", "-n", &target], &root, &root, Duration::from_secs(60))?;
        if out.code != 0 {
            return Err(LoomError::Git(format!("open exited {}: {}", out.code, out.stderr.trim())));
        }
        Ok(())
    }

    fn find_pids(&self, exe: &Path) -> Vec<u32> {
        let Ok(root) = parent_of(exe) else { return Vec::new() };
        let pattern = exe.to_string_lossy().into_owned();
        let me = std::process::id();
        match exec::run_checked(&["/usr/bin/pgrep", "-f", &pattern], &root, &root, Duration::from_secs(10)) {
            Ok(out) => out
                .stdout
                .lines()
                .filter_map(|l| l.trim().parse::<u32>().ok())
                .filter(|p| *p != me)
                .collect(),
            Err(_) => Vec::new(),
        }
    }

    fn kill(&mut self, pid: u32) {
        #[cfg(unix)]
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGKILL);
        }
        #[cfg(not(unix))]
        let _ = pid;
    }

    fn read_sentinel(&self) -> Option<Sentinel> {
        kernel::read_sentinel(&self.sentinel)
    }

    fn now(&self) -> Instant {
        Instant::now()
    }

    fn sleep(&mut self, d: Duration) {
        std::thread::sleep(d)
    }
}

// ── Watch ─────────────────────────────────────────────────────────────────────

#[derive(Debug, PartialEq)]
pub enum Verdict {
    /// The new body confirmed its boot; nothing was written.
    Confirmed,
    /// The new body did not confirm; the previous one is back in place.
    Healed { reason: String },
    /// The new body did not confirm AND the heal failed — the sentinel says
    /// `rollback-failed` so nothing loops.
    HealFailed(String),
}

/// Steps 1–5. Returns what happened; the caller turns it into an exit code.
pub fn watch(job: &Job, world: &mut dyn World, home: &Home) -> Verdict {
    // 1 · wait for the old LOOM to leave (30 s cap, then proceed anyway).
    let start = world.now();
    while world.pid_alive(job.old_pid) && world.now().duration_since(start) < OLD_PID_WAIT {
        world.sleep(Duration::from_millis(250));
    }

    // 2 · open the app.
    let opened = world.open_app(&job.app_path);
    if job.relaunch_only {
        // The heal already happened in-process; opening was the whole job.
        return match opened {
            Ok(()) => Verdict::Confirmed,
            Err(e) => Verdict::HealFailed(format!("the app could not be opened after the heal — {e}")),
        };
    }
    let reason = match opened {
        Ok(()) => {
            // 3–4 · watch for confirmation.
            let launched = world.now();
            let deadline = launched + Duration::from_secs(job.timeout_secs);
            let mut seen_alive = false;
            loop {
                if world.read_sentinel().map(|s| s.status == "ok").unwrap_or(false) {
                    return Verdict::Confirmed;
                }
                let pids = world.find_pids(&job.exe_path);
                if pids.is_empty() {
                    if seen_alive || world.now().duration_since(launched) >= LAUNCH_GRACE {
                        break REASON_CRASHED.to_string();
                    }
                } else {
                    seen_alive = true;
                }
                if world.now() >= deadline {
                    break REASON_NEVER_CONFIRMED.to_string();
                }
                world.sleep(TICK);
            }
        }
        // The body never ran: it never confirmed.
        Err(_) => REASON_NEVER_CONFIRMED.to_string(),
    };

    // 5 · heal.
    for pid in world.find_pids(&job.exe_path) {
        world.kill(pid);
    }
    let layout = AppLayout { app_path: job.app_path.clone(), exe_path: job.exe_path.clone() };
    let tools = |name: &str| threads::tool_path(home, name);
    match heal(home, &layout, &job.new_sha, &job.prev_sha, &reason, &tools) {
        Ok(()) => {
            if let Err(e) = world.open_app(&job.app_path) {
                eprintln!("[warden] healed, but the app could not be reopened — {e}");
            }
            Verdict::Healed { reason }
        }
        Err(e) => Verdict::HealFailed(e.to_string()),
    }
}

/// The heal, shared with the pre-main backstop: previous body back over the
/// executable, re-signed, sentinel `healed`, ledger `current: prev`, and the
/// recovery record. On failure the sentinel is marked `rollback-failed` so
/// no healer loops on it.
pub fn heal(
    home: &Home,
    layout: &AppLayout,
    new_sha: &str,
    prev_sha: &str,
    reason: &str,
    tools: &dyn Fn(&str) -> Option<PathBuf>,
) -> Result<(), LoomError> {
    let plan = [
        Step::CopyExe { from: home.generation_exe(prev_sha), to: layout.exe_path.clone() },
        Step::Codesign { path: layout.app_path.clone() },
        Step::WriteSentinelHealed { failed: new_sha.to_string(), prev: prev_sha.to_string() },
        Step::WriteLedger { current: prev_sha.to_string(), previous: new_sha.to_string() },
    ];
    let done = platform::execute(&plan, home, tools).and_then(|()| {
        let record = Recovery {
            failed_sha: new_sha.to_string(),
            prev_sha: prev_sha.to_string(),
            reason: reason.to_string(),
            log_tail: log_tail(home),
        };
        threads::write_json_atomic(&home.recovery_json(), &record)
    });
    if done.is_err() {
        let _ = kernel::write_sentinel_at(
            &home.sentinel_json(),
            &Sentinel {
                prev_sha: prev_sha.to_string(),
                applied_sha: new_sha.to_string(),
                status: "rollback-failed".into(),
                source_root: home.source().to_string_lossy().into_owned(),
                armed_by: Some("reweave".into()),
            },
        );
    }
    done
}

/// The last ≤ 40 lines of `reweave.json`'s tail; empty when absent or torn.
fn log_tail(home: &Home) -> Vec<String> {
    let mode = crate::loomhome::mode();
    let tail = reweave::read_state(home, mode).tail;
    let skip = tail.len().saturating_sub(LOG_TAIL_LINES);
    tail.into_iter().skip(skip).collect()
}

/// The recovery record, if the warden (or the backstop) left one.
pub fn read_recovery(home: &Home) -> Option<Recovery> {
    let raw = std::fs::read_to_string(home.recovery_json()).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Read the record and delete it — it is surfaced exactly once.
pub fn take_recovery(home: &Home) -> Option<Recovery> {
    let r = read_recovery(home)?;
    let _ = std::fs::remove_file(home.recovery_json());
    Some(r)
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

/// `--warden <job.json>` on argv → the warden loop's exit code; anything else
/// → `None`, and the app boots as usual. A `--warden` with no path is a
/// malformed warden invocation, not an app launch: exit 2.
pub fn dispatch(args: impl Iterator<Item = String>) -> Option<i32> {
    let mut args = args.skip(1);
    while let Some(a) = args.next() {
        if a == "--warden" {
            return Some(match args.next() {
                Some(path) => run_warden(Path::new(&path)),
                None => {
                    eprintln!("[warden] --warden needs the job file's path");
                    2
                }
            });
        }
    }
    None
}

fn run_warden(job_path: &Path) -> i32 {
    let mut job: Job = match std::fs::read_to_string(job_path)
        .map_err(|e| LoomError::Git(format!("read {}: {e}", job_path.display())))
        .and_then(|raw| serde_json::from_str(&raw).map_err(|e| LoomError::Parse(e.to_string())))
    {
        Ok(j) => j,
        Err(e) => {
            eprintln!("[warden] no job — {e}");
            return 1;
        }
    };
    job.warden_pid = Some(std::process::id());
    if let Err(e) = threads::write_json_atomic(job_path, &job) {
        eprintln!("[warden] could not record my pid — {e}");
    }
    let home = Home::at(job.loomhome.clone());
    let mut world = RealWorld::new(&home);
    match watch(&job, &mut world, &home) {
        Verdict::Confirmed => 0,
        Verdict::Healed { reason } => {
            eprintln!("[warden] the new body {reason} — LOOM came home to {}", &job.prev_sha);
            0
        }
        Verdict::HealFailed(m) => {
            eprintln!("[warden] the new body did not confirm and the heal failed — {m}");
            1
        }
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generations;
    use std::os::unix::fs::PermissionsExt;

    /// A scripted machine. Time only moves when the loop sleeps; every
    /// scripted value is keyed on the number of sleeps so far (the tick).
    struct FakeWorld {
        base: Instant,
        elapsed: Duration,
        ticks: u32,
        old_pid_gone_at: u32,
        /// (from_tick, sentinel status) — the latest row ≤ tick wins.
        sentinel: Vec<(u32, &'static str)>,
        /// (from_tick, pids) — the latest row ≤ tick wins.
        pids: Vec<(u32, Vec<u32>)>,
        opens: Vec<PathBuf>,
        open_fails: bool,
        kills: Vec<u32>,
    }

    impl FakeWorld {
        fn new() -> FakeWorld {
            FakeWorld {
                base: Instant::now(),
                elapsed: Duration::ZERO,
                ticks: 0,
                old_pid_gone_at: 0,
                sentinel: vec![(0, "applied")],
                pids: vec![(0, vec![4242])],
                opens: Vec::new(),
                open_fails: false,
                kills: Vec::new(),
            }
        }
        fn latest<'a, T>(&self, rows: &'a [(u32, T)]) -> Option<&'a T> {
            rows.iter().filter(|(t, _)| *t <= self.ticks).last().map(|(_, v)| v)
        }
    }

    impl World for FakeWorld {
        fn pid_alive(&self, pid: u32) -> bool {
            pid == 1111 && self.ticks < self.old_pid_gone_at
        }
        fn open_app(&mut self, app: &Path) -> Result<(), LoomError> {
            self.opens.push(app.to_path_buf());
            if self.open_fails { Err(LoomError::Git("open refused".into())) } else { Ok(()) }
        }
        fn find_pids(&self, _exe: &Path) -> Vec<u32> {
            self.latest(&self.pids).cloned().unwrap_or_default()
        }
        fn kill(&mut self, pid: u32) {
            self.kills.push(pid);
        }
        fn read_sentinel(&self) -> Option<Sentinel> {
            let status = *self.latest(&self.sentinel)?;
            Some(Sentinel {
                prev_sha: "aaa111".into(),
                applied_sha: "bbb222".into(),
                status: status.into(),
                source_root: String::new(),
                armed_by: Some("reweave".into()),
            })
        }
        fn now(&self) -> Instant {
            self.base + self.elapsed
        }
        fn sleep(&mut self, d: Duration) {
            self.elapsed += d;
            self.ticks += 1;
        }
    }

    struct Fx {
        _dir: tempfile::TempDir,
        home: Home,
        job: Job,
    }

    impl Fx {
        fn exe(&self) -> String {
            std::fs::read_to_string(&self.job.exe_path).unwrap()
        }
    }

    /// A fake `.app` whose executable is the "new body", a shelved "old body"
    /// for `aaa111`, a ledger that says bbb222 is current and unconfirmed,
    /// a fake `codesign` recorded in threads.json, and a reweave tail.
    fn fixture() -> Fx {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let home = Home::at(root.join("loom"));
        std::fs::create_dir_all(&home.root).unwrap();
        let app_path = root.join("LOOM.app");
        let exe_path = app_path.join("Contents/MacOS/loom");
        std::fs::create_dir_all(exe_path.parent().unwrap()).unwrap();
        std::fs::write(&exe_path, "new body").unwrap();
        std::fs::set_permissions(&exe_path, std::fs::Permissions::from_mode(0o755)).unwrap();
        let prev = home.generation_exe("aaa111");
        std::fs::create_dir_all(prev.parent().unwrap()).unwrap();
        std::fs::write(&prev, "old body").unwrap();
        std::fs::set_permissions(&prev, std::fs::Permissions::from_mode(0o755)).unwrap();
        generations::write(
            &home,
            &generations::Ledger {
                current: Some("bbb222".into()),
                previous: Some("aaa111".into()),
                kept: vec!["aaa111".into(), "bbb222".into()],
                keep: 3,
                confirmed: false,
            },
        )
        .unwrap();

        let codesign = root.join("bin/codesign");
        std::fs::create_dir_all(codesign.parent().unwrap()).unwrap();
        std::fs::write(&codesign, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&codesign, std::fs::Permissions::from_mode(0o755)).unwrap();
        threads::write(
            &home,
            &threads::Threads {
                threaded: true,
                threaded_at: None,
                threaded_sha: None,
                tools: vec![threads::Tool {
                    name: "codesign".into(),
                    path: Some(codesign.to_string_lossy().into_owned()),
                    version: None,
                    required_for: "signing".into(),
                    install: String::new(),
                }],
                steps: threads::ThreadSteps { seed: true, deps: true, vendor: true, warm: true, register: true },
            },
        )
        .unwrap();

        // A reweave record with a 50-line tail: the recovery keeps the last 40.
        let mut state = reweave::ReweaveState::idle(crate::loomhome::Mode::Packaged);
        state.stage = "relaunch".into();
        state.tail = (1..=50).map(|i| format!("line {i}")).collect();
        threads::write_json_atomic(&home.reweave_json(), &state).unwrap();

        let job = Job {
            old_pid: 1111,
            app_path,
            exe_path,
            new_sha: "bbb222".into(),
            prev_sha: "aaa111".into(),
            loomhome: home.root.clone(),
            timeout_secs: 90,
            relaunch_only: false,
            warden_pid: None,
        };
        Fx { _dir: dir, home, job }
    }

    fn sentinel_status(home: &Home) -> Option<String> {
        kernel::read_sentinel(&home.sentinel_json()).map(|s| s.status)
    }

    #[test]
    fn job_round_trips_camel_case_with_optional_warden_pid() {
        let fx = fixture();
        let raw = serde_json::to_string(&fx.job).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["oldPid"], 1111);
        assert_eq!(v["relaunchOnly"], false);
        assert_eq!(v["timeoutSecs"], 90);
        assert!(v["wardenPid"].is_null());
        // A file written before the warden started carries no `wardenPid`.
        let without: Job = serde_json::from_str(
            r#"{"oldPid":1,"appPath":"/a","exePath":"/a/b","newSha":"n","prevSha":"p","loomhome":"/l","timeoutSecs":9,"relaunchOnly":true}"#,
        )
        .unwrap();
        assert_eq!(without.warden_pid, None);
        assert!(without.relaunch_only);
    }

    #[test]
    fn warden_confirmed_exits_clean() {
        let fx = fixture();
        let mut w = FakeWorld::new();
        w.old_pid_gone_at = 2;
        w.sentinel = vec![(0, "applied"), (3, "booting"), (6, "ok")];
        let v = watch(&fx.job, &mut w, &fx.home);
        assert_eq!(v, Verdict::Confirmed);
        assert_eq!(w.opens, vec![fx.job.app_path.clone()], "exactly one open");
        assert!(w.kills.is_empty(), "nothing killed");
        assert_eq!(fx.exe(), "new body", "the new body stays");
        assert!(!fx.home.recovery_json().exists(), "nothing written");
        assert!(sentinel_status(&fx.home).is_none(), "the warden writes no sentinel on a good birth");
        assert!(w.ticks >= 2, "waited for the old pid to leave before opening");
    }

    #[test]
    fn warden_crash_heals_and_relaunches() {
        let fx = fixture();
        let mut w = FakeWorld::new();
        w.sentinel = vec![(0, "applied"), (2, "booting")];
        w.pids = vec![(0, vec![4242]), (4, vec![])];
        let v = watch(&fx.job, &mut w, &fx.home);
        assert_eq!(v, Verdict::Healed { reason: REASON_CRASHED.into() });
        assert_eq!(w.opens.len(), 2, "opened, then opened again after the heal");
        assert_eq!(fx.exe(), "old body", "the previous body is back in place");
        assert_eq!(sentinel_status(&fx.home).as_deref(), Some("healed"));
        let ledger = generations::read(&fx.home);
        assert_eq!(ledger.current.as_deref(), Some("aaa111"));
        assert_eq!(ledger.previous.as_deref(), Some("bbb222"));
        assert!(!ledger.confirmed);
        let rec = read_recovery(&fx.home).expect("a recovery record");
        assert_eq!(rec.failed_sha, "bbb222");
        assert_eq!(rec.prev_sha, "aaa111");
        assert_eq!(rec.reason, "crashed");
        assert_eq!(rec.log_tail.len(), 40);
        assert_eq!(rec.log_tail.first().map(String::as_str), Some("line 11"));
        assert_eq!(rec.log_tail.last().map(String::as_str), Some("line 50"));
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(fx.home.recovery_json()).unwrap()).unwrap();
        assert_eq!(v["failedSha"], "bbb222");
        assert!(v["logTail"].is_array());
        // No `.weaving` staging file remains beside the executable.
        let names: Vec<String> = std::fs::read_dir(fx.job.exe_path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["loom".to_string()]);
    }

    #[test]
    fn warden_timeout_heals() {
        let fx = fixture();
        let mut w = FakeWorld::new();
        // The body lives but never confirms: pids stay, sentinel stays booting.
        w.sentinel = vec![(0, "applied"), (2, "booting")];
        let v = watch(&fx.job, &mut w, &fx.home);
        assert_eq!(v, Verdict::Healed { reason: REASON_NEVER_CONFIRMED.into() });
        assert!(w.elapsed >= Duration::from_secs(90), "the whole timeout was granted");
        assert_eq!(w.kills, vec![4242], "the lingering body was killed before the heal");
        assert_eq!(fx.exe(), "old body");
        assert_eq!(read_recovery(&fx.home).unwrap().reason, "never confirmed");
        assert_eq!(w.opens.len(), 2);
    }

    #[test]
    fn warden_empty_log_tail_when_reweave_record_is_absent() {
        let fx = fixture();
        std::fs::remove_file(fx.home.reweave_json()).unwrap();
        let mut w = FakeWorld::new();
        w.pids = vec![(0, vec![4242]), (3, vec![])];
        assert!(matches!(watch(&fx.job, &mut w, &fx.home), Verdict::Healed { .. }));
        assert!(read_recovery(&fx.home).unwrap().log_tail.is_empty());
    }

    #[test]
    fn warden_heal_failure_marks_rollback_failed() {
        let fx = fixture();
        std::fs::remove_file(fx.home.generation_exe("aaa111")).unwrap();
        let mut w = FakeWorld::new();
        w.pids = vec![(0, vec![4242]), (3, vec![])];
        assert!(matches!(watch(&fx.job, &mut w, &fx.home), Verdict::HealFailed(_)));
        assert_eq!(fx.exe(), "new body", "a failed copy leaves the file as it was");
        assert_eq!(sentinel_status(&fx.home).as_deref(), Some("rollback-failed"));
        assert!(!fx.home.recovery_json().exists(), "no record claims a home it did not reach");
        assert_eq!(w.opens.len(), 1, "no second open of a body that did not heal");
    }

    #[test]
    fn warden_relaunch_only_waits_and_opens() {
        let mut fx = fixture();
        fx.job.relaunch_only = true;
        let mut w = FakeWorld::new();
        w.old_pid_gone_at = 3;
        w.sentinel = vec![(0, "healed")];
        assert_eq!(watch(&fx.job, &mut w, &fx.home), Verdict::Confirmed);
        assert_eq!(w.opens.len(), 1);
        assert!(w.ticks >= 3);
        assert_eq!(fx.exe(), "new body", "relaunch-only never touches the executable");
        assert!(!fx.home.recovery_json().exists());
    }

    #[test]
    fn take_recovery_surfaces_once() {
        let fx = fixture();
        let mut w = FakeWorld::new();
        w.pids = vec![(0, vec![4242]), (3, vec![])];
        watch(&fx.job, &mut w, &fx.home);
        assert!(take_recovery(&fx.home).is_some());
        assert!(!fx.home.recovery_json().exists());
        assert!(take_recovery(&fx.home).is_none());
    }

    #[test]
    fn dispatch_ignores_normal_args() {
        let argv = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>().into_iter();
        assert_eq!(dispatch(argv(&["loom"])), None);
        assert_eq!(dispatch(argv(&["loom", "--some-flag", "value"])), None);
        assert_eq!(dispatch(argv(&["loom", "warden"])), None);
        assert_eq!(dispatch(argv(&[])), None);
        // `--warden` is only ever an argument, never argv[0].
        assert_eq!(dispatch(argv(&["--warden"])), None);
        // A missing job file is a warden that could not run — not an app launch.
        let d = tempfile::tempdir().unwrap();
        let missing = d.path().join("nope.json").to_string_lossy().into_owned();
        assert_eq!(dispatch(argv(&["loom", "--warden", &missing])), Some(1));
        assert_eq!(dispatch(argv(&["loom", "--warden"])), Some(2));
    }
}
