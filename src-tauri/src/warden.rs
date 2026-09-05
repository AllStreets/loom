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
//! 4. confirmed within `timeoutSecs` → write nothing else, exit. So does a
//!    sentinel stamped with ANOTHER birth's sha: a later swap (a RETURN, a
//!    second weave) owns the body now and has its own warden, and this one's
//!    shas describe a body no longer on disk (round-3 review, Finding 1);
//! 5. not confirmed — the process vanished (`crashed`: `CRASH_SAMPLES`
//!    consecutive empty samples, never one) or the clock ran out (`never
//!    confirmed`) — → HEAL: copy the previous body back over the executable,
//!    re-sign, ledger `current: prev`, the terminal sentinel `healed` last of
//!    the four (round-2 review, Finding 2), recovery record.
//!    Then one of two endings: a body no longer running is killed if any
//!    straggler remains and the app is opened again; a body STILL RUNNING at
//!    the deadline is left alone — no kill, no second window — because the
//!    executable on disk is already the proven one, so the next launch comes
//!    home without taking the owner's session away.
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
    /// The generation being born — and the job's stamp: a job whose
    /// `newSha` is not the sentinel's `applied_sha` guards some earlier
    /// birth, and the pre-main backstop reads it as gone (round-1 review,
    /// Finding 5), however alive its recorded pid looks.
    pub new_sha: String,
    /// The generation to come home to (= the warden's own body).
    pub prev_sha: String,
    pub loomhome: PathBuf,
    pub timeout_secs: u64,
    /// The heal already happened in-process; only open the app.
    pub relaunch_only: bool,
    /// The warden's own pid, written by the warden at start and cleared by it
    /// on the way out (round-2 review, Finding 8) — a pid left behind can be
    /// recycled, and would then read as a guard that is not there.
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
    /// One of the `REASON_*` constants below. `REASON_ROLLBACK_FAILED` is the
    /// one that did NOT come home, and the shell reads it as `rollbackFailed`
    /// rather than as a healed generation.
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
/// The clock ran out while the body was still running and painting: the
/// window was left alone and the executable on disk put back, so the reason
/// the record carries must not claim LOOM already came home.
pub const REASON_NEVER_CONFIRMED_ALIVE: &str =
    "never confirmed — still running when the clock ran out";
/// The heal itself failed: the previous body could not be put back, so LOOM
/// did NOT come home (round-3 review, Finding 3). A record carrying this
/// reason is never reported as a healed generation — `boot_check_in` turns it
/// into `rollbackFailed`, the shell's honest "couldn't come home" path.
pub const REASON_ROLLBACK_FAILED: &str = "the rollback failed";

/// How many consecutive empty samples make a death (round-1 review, Finding
/// 2). One is a hiccup; three in a row, half a second apart, is a body that
/// is gone.
const CRASH_SAMPLES: u32 = 3;
/// How many times `open -n` is asked before a refusal counts as a failed
/// birth (round-1 review, Finding 6), and how long between the asks.
const OPEN_ATTEMPTS: u32 = 3;
const OPEN_BACKOFF: Duration = Duration::from_secs(2);

// ── World ─────────────────────────────────────────────────────────────────────

/// Everything the loop does outside plain file I/O, so it can be scripted.
pub trait World {
    fn pid_alive(&self, pid: u32) -> bool;
    fn open_app(&mut self, app: &Path) -> Result<(), LoomError>;
    /// Every live pid whose command line names `exe` (never our own).
    /// `None` when the sample could not be taken at all — no information,
    /// never evidence of death (round-1 review, Finding 2).
    fn find_pids(&self, exe: &Path) -> Option<Vec<u32>>;
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

    fn find_pids(&self, exe: &Path) -> Option<Vec<u32>> {
        let root = parent_of(exe).ok()?;
        let pattern = exe.to_string_lossy().into_owned();
        let me = std::process::id();
        // `pgrep` exits 1 with no output when nothing matches — that IS the
        // answer "nothing is running". A spawn failure or a timeout is not an
        // answer at all, and must never read as one.
        let out = exec::run_checked(&["/usr/bin/pgrep", "-f", &pattern], &root, &root, Duration::from_secs(10)).ok()?;
        Some(
            out.stdout
                .lines()
                .filter_map(|l| l.trim().parse::<u32>().ok())
                .filter(|p| *p != me)
                .collect(),
        )
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
    /// Nothing was written: either the new body confirmed its boot, or the
    /// birth this warden guarded was superseded by a later swap and is no
    /// longer this warden's to judge (round-3 review, Finding 1).
    Confirmed,
    /// The new body did not confirm; the previous one is back in place.
    Healed { reason: String },
    /// The new body did not confirm but is still running: the owner's window
    /// is left alone, and the file on disk is the previous body, so the NEXT
    /// launch is the one already proven.
    HealedNextLaunch { reason: String },
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

    // 2 · open the app. A single refusal is not a failed birth (Finding 6).
    let opened = open_with_retry(world, &job.app_path);
    if job.relaunch_only {
        // The heal already happened in-process; opening was the whole job.
        return match opened {
            Ok(()) => Verdict::Confirmed,
            Err(e) => Verdict::HealFailed(format!("the app could not be opened after the heal — {e}")),
        };
    }
    // 3–4 · watch for confirmation.
    let reason = match opened {
        Ok(()) => match confirm(job, world) {
            None => return Verdict::Confirmed,
            Some(reason) => reason,
        },
        // The body never ran: it never confirmed.
        Err(_) => REASON_NEVER_CONFIRMED.to_string(),
    };

    // 5 · heal — unless a confirmation landed while we were looking. One last
    // look also decides HOW to heal. A body still running at the
    // deadline is one the owner may be using — `kernel_boot_ok` is vetoed by
    // any ErrorBoundary caught during boot, so a perfectly usable generation
    // can reach this point unconfirmed (Finding 3). It is not killed and no
    // second window is opened over it; the executable on disk goes back, so
    // the NEXT launch is the body already proven.
    let seen = world.find_pids(&job.exe_path).unwrap_or_default();
    // That sample is a `pgrep` with a 10 s ceiling, and a `kernel_boot_ok`
    // can land inside it: the body has by then written the sentinel `ok` and
    // the ledger `confirmed: true`. Healing over that would take back a
    // generation that DID confirm and tell the owner it could not (round-2
    // review, Finding 4). One last look at the sentinel — the same two
    // questions the watch asked, asked once more at the last possible moment:
    // did this birth confirm, and is it still the birth in play at all
    // (round-3 review, Finding 1)?
    let last = world.read_sentinel();
    if last.as_ref().is_some_and(|s| s.status == "ok") || superseded(last.as_ref(), &job.new_sha) {
        return Verdict::Confirmed;
    }
    let (take_it_down, reason) = ending(&reason, !seen.is_empty());
    if take_it_down {
        for pid in seen {
            world.kill(pid);
        }
    }
    let layout = AppLayout { app_path: job.app_path.clone(), exe_path: job.exe_path.clone() };
    let tools = |name: &str| threads::tool_path(home, name);
    match heal(home, &layout, &job.new_sha, &job.prev_sha, &reason, &tools) {
        Ok(()) if !take_it_down => Verdict::HealedNextLaunch { reason },
        Ok(()) => {
            if let Err(e) = open_with_retry(world, &job.app_path) {
                eprintln!("[warden] healed, but the app could not be reopened — {e}");
            }
            Verdict::Healed { reason }
        }
        Err(e) => Verdict::HealFailed(e.to_string()),
    }
}

/// PURE: has the birth this job guards been superseded (round-3 review,
/// Finding 1)? The sentinel's `applied_sha` is the STAMP of the birth the
/// file on disk belongs to, and the pre-main backstop already judges a warden
/// job by it (`kernel.rs`: `j.new_sha == s.applied_sha`). The warden that
/// backstop backs up must ask the same question: a sentinel naming another
/// sha was rewritten by a LATER swap — a RETURN, or a second weave — which
/// moved the ledger and spawned its own guard. This warden's birth is over;
/// its shas describe a body that is no longer on disk, and healing them would
/// destroy the body the owner just asked for.
///
/// `None` (absent or torn) and an EMPTY stamp are no information, never a
/// supersede: the source-edit apply flow writes a sentinel before the commit
/// names its sha, and a warden must not walk away from a birth on that.
pub fn superseded(sentinel: Option<&Sentinel>, new_sha: &str) -> bool {
    sentinel.is_some_and(|s| !s.applied_sha.is_empty() && s.applied_sha != new_sha)
}

/// PURE: how a failed birth ends (round-1 review, Finding 3). `alive` is the
/// last look at the machine. Returns whether the body is taken down — killed
/// if anything of it lingers, and the app opened again once the previous body
/// is back — and the reason the record carries.
///
/// A body still running when the clock ran out is NOT taken down: it is a
/// window the owner may be working in, and `kernel_boot_ok` is vetoed by any
/// ErrorBoundary caught during boot, so a usable generation reaches the
/// deadline unconfirmed. The heal still puts the previous body on disk, so
/// the next launch comes home; the record says which of the two happened.
pub fn ending(reason: &str, alive: bool) -> (bool, String) {
    if alive && reason == REASON_NEVER_CONFIRMED {
        (false, REASON_NEVER_CONFIRMED_ALIVE.to_string())
    } else {
        (true, reason.to_string())
    }
}

/// `open -n`, asked again with a backoff before a refusal counts (Finding 6).
/// LaunchServices refuses transiently — a bundle still settling after the
/// re-sign, a machine mid-login — and one refusal used to roll a generation
/// back, with the heal's own reopen then failing the same way and leaving no
/// LOOM running at all.
fn open_with_retry(world: &mut dyn World, app: &Path) -> Result<(), LoomError> {
    let mut last = None;
    for attempt in 1..=OPEN_ATTEMPTS {
        match world.open_app(app) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last = Some(e);
                if attempt < OPEN_ATTEMPTS {
                    world.sleep(OPEN_BACKOFF * attempt);
                }
            }
        }
    }
    Err(last.unwrap_or_else(|| LoomError::NotFound(format!("open {}", app.display()))))
}

/// Steps 3–4: watch the sentinel and the machine until one of them answers.
/// `None` is a birth this warden must not heal — confirmed, or superseded by
/// a later swap; `Some(reason)` is the fact that ended it.
///
/// Death is only ever declared on `CRASH_SAMPLES` consecutive empty samples
/// (Finding 2): one empty sample is a hiccup, and a sample that could not be
/// taken at all (`None`) is no information — it neither counts toward a
/// death nor clears the count.
fn confirm(job: &Job, world: &mut dyn World) -> Option<String> {
    let launched = world.now();
    let deadline = launched + Duration::from_secs(job.timeout_secs);
    let mut seen_alive = false;
    let mut empty = 0u32;
    loop {
        let s = world.read_sentinel();
        // Confirmed, or no longer this warden's birth to guard — either way
        // there is nothing here to heal (round-3 review, Finding 1).
        if s.as_ref().is_some_and(|s| s.status == "ok") || superseded(s.as_ref(), &job.new_sha) {
            return None;
        }
        match world.find_pids(&job.exe_path) {
            None => {}
            Some(pids) if pids.is_empty() => {
                empty += 1;
                let launched_by_now =
                    seen_alive || world.now().duration_since(launched) >= LAUNCH_GRACE;
                if launched_by_now && empty >= CRASH_SAMPLES {
                    return Some(REASON_CRASHED.to_string());
                }
            }
            Some(_) => {
                seen_alive = true;
                empty = 0;
            }
        }
        if world.now() >= deadline {
            return Some(REASON_NEVER_CONFIRMED.to_string());
        }
        world.sleep(TICK);
    }
}

/// PURE: the ordered steps of a heal. Read by `platform.rs`'s ordering rule
/// the other way round (round-2 review, Finding 2):
///
/// 1. `CopyExe` — here the copy is the RESTORATIVE act, not the destructive
///    one, so it goes FIRST: the proven body is back on the executable before
///    anything else can fail.
/// 2. `Codesign` — Gatekeeper launches what is now on disk.
/// 3. `WriteLedger` — `current: prev`. The ledger is a claim about which body
///    is on disk, and the body on disk is already `prev`, so the claim is now
///    true. Idempotent: a re-heal after an interruption writes it again to
///    the same value.
/// 4. `WriteSentinelHealed` — LAST, because `healed` is TERMINAL. It is the
///    statement that this birth is over and no healer need look again;
///    written before the ledger it asserts, an interruption between the two
///    leaves the previous body on the executable, the ledger still calling
///    the failed generation current, and nothing left to correct it — the
///    same wedge the swap's early ledger made, mirrored.
pub fn heal_plan(home: &Home, layout: &AppLayout, new_sha: &str, prev_sha: &str) -> Vec<Step> {
    vec![
        Step::CopyExe { from: home.generation_exe(prev_sha), to: layout.exe_path.clone() },
        Step::Codesign { path: layout.app_path.clone() },
        Step::WriteLedger { current: prev_sha.to_string(), previous: new_sha.to_string() },
        Step::WriteSentinelHealed { failed: new_sha.to_string(), prev: prev_sha.to_string() },
    ]
}

/// The heal, shared with the pre-main backstop: previous body back over the
/// executable, re-signed, sentinel `healed`, ledger `current: prev`, and the
/// recovery record. On failure the sentinel is marked `rollback-failed` so
/// no healer loops on it — AND the record is written anyway, naming the
/// failure (round-3 review, Finding 3).
///
/// The record was written only on success, and `decide_boot_in`
/// short-circuits on a terminal status and reports `rollback_failed: false`.
/// So a failed body heal printed to stderr, booted the broken body on, and
/// said nothing, while the shell's ready "couldn't come home" path could
/// never fire. The spec's state table says of `rollback-failed`: "terminal;
/// the notice says so."
///
/// Of the two remedies the review offered, the record is the one taken. The
/// alternative — reporting `rollback_failed: true` whenever the sentinel
/// reads `rollback-failed` — would fire on EVERY boot after, because the
/// sentinel is terminal and durable by design (Finding 2 is about keeping it
/// that way): making it fire once would mean consuming or flagging the very
/// statement it is there to preserve. The record is already the one-shot
/// carrier — `take_recovery` deletes it as it is surfaced — it carries the
/// shas and the log tail, and it covers the backstop's heal as well as the
/// warden's. `boot_check_in` routes a record with this reason to
/// `rollbackFailed`, never to `healedGeneration`, so nothing tells the owner
/// LOOM came home to a generation it could not reach.
pub fn heal(
    home: &Home,
    layout: &AppLayout,
    new_sha: &str,
    prev_sha: &str,
    reason: &str,
    tools: &dyn Fn(&str) -> Option<PathBuf>,
) -> Result<(), LoomError> {
    let record = |reason: &str| Recovery {
        failed_sha: new_sha.to_string(),
        prev_sha: prev_sha.to_string(),
        reason: reason.to_string(),
        log_tail: log_tail(home),
    };
    let plan = heal_plan(home, layout, new_sha, prev_sha);
    // The heal itself. Only THIS failing means LOOM did not come home — a
    // heal whose last step wrote the terminal `healed` has come home, and
    // `rollback-failed` must never be written over that (the same rule
    // Finding 2 states: a terminal state is somebody else's verdict).
    if let Err(e) = platform::execute(&plan, home, tools) {
        // Terminal first, so nothing loops on this birth whatever happens
        // next; then the record, so the owner is told. Both best-effort: the
        // error the caller gets is the heal's own.
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
        let _ = threads::write_json_atomic(&home.recovery_json(), &record(REASON_ROLLBACK_FAILED));
        return Err(e);
    }
    threads::write_json_atomic(&home.recovery_json(), &record(reason))
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

/// Unstamp the job as the warden leaves. A pid is not an identity — the
/// system recycles it — so a dead warden's number, handed to some unrelated
/// process, reads as alive to the pre-main backstop, which then Leaves a body
/// that never confirmed unguarded on every boot after (round-2 review,
/// Finding 8). Clearing the stamp on the way out costs one atomic write on a
/// path the warden always takes, and it composes with the job's `newSha`
/// stamp: a leftover job is then inert twice over.
///
/// The alternative was to record the warden's start time and compare it with
/// the pid's, which is the only way to survive a warden that is SIGKILLed —
/// but reading a process's start time means a per-OS process-table read
/// (`sysctl KERN_PROC_PID` on macOS) on the pre-main path, where the rule is
/// panic-free and does as little as it can. The honest residual: a warden
/// killed outright still leaves its pid behind.
pub(crate) fn release_pid(job_path: &Path) {
    let Ok(raw) = std::fs::read_to_string(job_path) else { return };
    let Ok(mut job) = serde_json::from_str::<Job>(&raw) else { return };
    if job.warden_pid.is_none() {
        return;
    }
    job.warden_pid = None;
    if let Err(e) = threads::write_json_atomic(job_path, &job) {
        eprintln!("[warden] my pid could not be cleared as I left — {e}");
    }
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
        // A warden whose pid is not on file is invisible to the pre-main
        // backstop, which would then heal the same birth this loop is
        // guarding — two healers on one body (round-1 review, Finding 5).
        // Better no warden at all: the backstop alone is a coherent guard.
        eprintln!("[warden] my pid could not be recorded — {e}; the birth is left to the body's own backstop");
        return 1;
    }
    let home = Home::at(job.loomhome.clone());
    let mut world = RealWorld::new(&home);
    let verdict = watch(&job, &mut world, &home);
    // Whatever happened, this warden is done. Its pid must stop claiming to
    // guard the birth (round-2 review, Finding 8).
    release_pid(job_path);
    match verdict {
        Verdict::Confirmed => 0,
        Verdict::Healed { reason } => {
            eprintln!("[warden] the new body {reason} — LOOM came home to {}", &job.prev_sha);
            0
        }
        Verdict::HealedNextLaunch { reason } => {
            eprintln!(
                "[warden] the new body {reason} — the window was left running; the next launch is generation {}",
                &job.prev_sha
            );
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
        /// (from_tick, sentinel applied_sha) — the latest row ≤ tick wins.
        /// The sentinel's STAMP: which birth the file on disk is about. A
        /// later swap rewrites it, and that is how a warden learns its own
        /// birth is over (round-3 review, Finding 1).
        applied: Vec<(u32, &'static str)>,
        /// (from_tick, pids) — the latest row ≤ tick wins. `None` is a
        /// sample that could not be taken.
        pids: Vec<(u32, Option<Vec<u32>>)>,
        opens: Vec<PathBuf>,
        /// How many leading `open` calls refuse.
        open_fails: u32,
        kills: Vec<u32>,
        /// How many samples of the machine have been taken. `find_pids` takes
        /// `&self`, so the count lives in a `Cell`.
        samples: std::cell::Cell<u32>,
        /// A `kernel_boot_ok` that lands in the LAST window (round-2 review,
        /// Finding 4): from this sample onwards the sentinel reads `ok`,
        /// whatever the tick rows say. Scripted by sample rather than by tick
        /// because the window the review found is the final `pgrep` — the one
        /// with a 10 s ceiling — taken after the watch has already given up.
        ok_after_samples: Option<u32>,
        /// A LATER swap that lands in the same last window: from this sample
        /// onwards the sentinel is stamped with another birth's sha
        /// (round-3 review, Finding 1).
        superseded_after_samples: Option<u32>,
    }

    impl FakeWorld {
        fn new() -> FakeWorld {
            FakeWorld {
                base: Instant::now(),
                elapsed: Duration::ZERO,
                ticks: 0,
                old_pid_gone_at: 0,
                sentinel: vec![(0, "applied")],
                applied: vec![(0, "bbb222")],
                pids: vec![(0, Some(vec![4242]))],
                opens: Vec::new(),
                open_fails: 0,
                kills: Vec::new(),
                samples: std::cell::Cell::new(0),
                ok_after_samples: None,
                superseded_after_samples: None,
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
            if (self.opens.len() as u32) <= self.open_fails {
                Err(LoomError::Parse("open refused".into()))
            } else {
                Ok(())
            }
        }
        fn find_pids(&self, _exe: &Path) -> Option<Vec<u32>> {
            self.samples.set(self.samples.get() + 1);
            self.latest(&self.pids).cloned().flatten()
        }
        fn kill(&mut self, pid: u32) {
            self.kills.push(pid);
        }
        fn read_sentinel(&self) -> Option<Sentinel> {
            let late = self.ok_after_samples.is_some_and(|n| self.samples.get() >= n);
            let status = if late { "ok" } else { *self.latest(&self.sentinel)? };
            let moved = self.superseded_after_samples.is_some_and(|n| self.samples.get() >= n);
            let applied = if moved { LATER_SHA } else { *self.latest(&self.applied)? };
            Some(Sentinel {
                prev_sha: "aaa111".into(),
                applied_sha: applied.into(),
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

    /// The birth a RETURN starts inside this warden's window: another sha
    /// entirely, stamped on the sentinel by the later swap.
    const LATER_SHA: &str = "ccc333";

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
        w.pids = vec![(0, Some(vec![4242])), (4, Some(vec![]))];
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

    /// Round-1 review, Finding 2. One empty `pgrep` sample was a terminal
    /// crash verdict. A sampling hiccup, a moment between exec and the new
    /// image being named, a machine under load — none of those are evidence
    /// that the body is gone. Only consecutive empty samples are.
    #[test]
    fn one_empty_sample_does_not_roll_back_a_healthy_generation() {
        let fx = fixture();
        let mut w = FakeWorld::new();
        w.sentinel = vec![(0, "applied"), (2, "booting"), (8, "ok")];
        w.pids = vec![(0, Some(vec![4242])), (4, Some(vec![])), (5, Some(vec![4242]))];
        assert_eq!(watch(&fx.job, &mut w, &fx.home), Verdict::Confirmed);
        assert_eq!(fx.exe(), "new body", "a healthy generation stays");
        assert!(w.kills.is_empty());
        assert_eq!(w.opens.len(), 1);
        assert!(!fx.home.recovery_json().exists());
    }

    /// Finding 2, the other half. A sample that could not be TAKEN — pgrep
    /// failed to spawn, timed out, the cwd went away — used to be
    /// byte-identical to "the process is gone".
    #[test]
    fn a_sample_that_could_not_be_taken_is_not_evidence_of_death() {
        let fx = fixture();
        let mut w = FakeWorld::new();
        w.sentinel = vec![(0, "applied"), (2, "booting"), (30, "ok")];
        w.pids = vec![(0, Some(vec![4242])), (3, None)];
        assert_eq!(watch(&fx.job, &mut w, &fx.home), Verdict::Confirmed);
        assert_eq!(fx.exe(), "new body");
        assert!(w.kills.is_empty());
        // Not even a body that was never seen alive: unknown is unknown, and
        // the deadline — not a guess — ends the watch.
        let fx2 = fixture();
        let mut w2 = FakeWorld::new();
        w2.pids = vec![(0, None)];
        assert!(matches!(watch(&fx2.job, &mut w2, &fx2.home), Verdict::Healed { .. }));
        assert!(w2.elapsed >= Duration::from_secs(90), "the whole timeout was granted");
    }

    /// Round-1 review, Finding 3. `markBootOk` is vetoed whenever an
    /// ErrorBoundary caught anything during boot, so a generation that is
    /// running, painting and in use can reach the deadline unconfirmed.
    /// SIGKILLing it takes the owner's session away. The window is left
    /// alone; the file on disk goes back, so the NEXT launch comes home.
    #[test]
    fn a_generation_still_running_is_not_killed_at_the_deadline() {
        let fx = fixture();
        let mut w = FakeWorld::new();
        w.sentinel = vec![(0, "applied"), (2, "booting")];
        let v = watch(&fx.job, &mut w, &fx.home);
        assert_eq!(v, Verdict::HealedNextLaunch { reason: REASON_NEVER_CONFIRMED_ALIVE.into() });
        assert!(w.kills.is_empty(), "the owner's running session is not killed");
        assert_eq!(w.opens.len(), 1, "no second window over the one in use");
        assert!(w.elapsed >= Duration::from_secs(90), "the whole timeout was granted");
        // The next launch is the proven body, and the record says why.
        assert_eq!(fx.exe(), "old body");
        assert_eq!(sentinel_status(&fx.home).as_deref(), Some("healed"));
        let ledger = generations::read(&fx.home);
        assert_eq!(ledger.current.as_deref(), Some("aaa111"));
        assert_eq!(ledger.previous.as_deref(), Some("bbb222"));
        let rec = read_recovery(&fx.home).unwrap();
        assert_eq!(rec.reason, REASON_NEVER_CONFIRMED_ALIVE);
        assert_eq!(rec.failed_sha, "bbb222");
    }

    /// Round-2 review, Finding 4. `watch` gave up, took one more look at the
    /// machine — a `pgrep` with a 10 s ceiling — and healed unconditionally.
    /// A `kernel_boot_ok` landing in that window has already written the
    /// sentinel `ok` and `confirmed: true`; the heal overwrote both and the
    /// record told the owner a generation that DID confirm could not. The
    /// sentinel is re-read immediately before the heal, and a confirmation
    /// stands.
    #[test]
    fn a_confirmation_that_lands_in_the_last_window_is_not_overwritten() {
        // The window is the last sample: count how many this watch takes.
        let probe = fixture();
        let mut w = FakeWorld::new();
        w.sentinel = vec![(0, "applied"), (2, "booting")];
        watch(&probe.job, &mut w, &probe.home);
        let last = w.samples.get();

        let fx = fixture();
        let mut w = FakeWorld::new();
        w.sentinel = vec![(0, "applied"), (2, "booting")];
        w.ok_after_samples = Some(last);
        assert_eq!(watch(&fx.job, &mut w, &fx.home), Verdict::Confirmed);
        assert_eq!(fx.exe(), "new body", "a generation that confirmed is not rolled back");
        assert_eq!(sentinel_status(&fx.home).as_deref(), None, "the warden wrote no sentinel over the `ok`");
        assert!(!fx.home.recovery_json().exists(), "no record claims a birth that did not fail");
        assert!(w.kills.is_empty(), "nothing of a confirmed body is killed");
        assert_eq!(w.opens.len(), 1, "no second window over the one that confirmed");
    }

    /// Round-3 review, Finding 1. A live warden never checked that the birth
    /// it guards is still the one in play. No fault is needed to reach it: a
    /// weave to bbb222 relaunches and this warden guards it; the body boots
    /// and paints but never beacons (the ErrorBoundary veto — a stated
    /// residual); inside the window the owner takes Settings → RETURN to
    /// ccc333, which is seconds because it skips assets and core — it
    /// rewrites the sentinel to `applied`/ccc333, moves the ledger and spawns
    /// its own warden. This clock then ran out, read `applied` rather than
    /// `ok`, and healed ITS OWN shas: the body the owner asked for destroyed,
    /// the second warden's ledger rewritten, a terminal `healed` landed on a
    /// birth still in flight. The sentinel's stamp is the answer — a sentinel
    /// that no longer names this job's `newSha` says this birth is over.
    #[test]
    fn a_warden_whose_birth_was_superseded_heals_nothing() {
        let fx = fixture();
        let mut w = FakeWorld::new();
        w.sentinel = vec![(0, "applied"), (2, "booting"), (6, "applied")];
        w.applied = vec![(0, "bbb222"), (6, LATER_SHA)];
        assert_eq!(
            watch(&fx.job, &mut w, &fx.home),
            Verdict::Confirmed,
            "this birth is over — the heal is not this warden's to do"
        );
        assert_eq!(fx.exe(), "new body", "the body the owner asked for is left in place");
        assert!(w.kills.is_empty(), "no process of a later birth is killed");
        assert_eq!(w.opens.len(), 1, "no second window over the birth in flight");
        assert!(!fx.home.recovery_json().exists(), "no record of a failure that was not one");
        assert!(sentinel_status(&fx.home).is_none(), "no terminal `healed` over a live birth");
        let ledger = generations::read(&fx.home);
        assert_eq!(
            ledger.current.as_deref(),
            Some("bbb222"),
            "the later warden's ledger is untouched"
        );
        assert!(w.ticks < 180, "it left when it saw the stamp move, not at the deadline");
    }

    /// Finding 1, the other window. The supersede can land in the LAST look —
    /// the `pgrep` with a 10 s ceiling, taken after the watch has given up —
    /// exactly as a late `kernel_boot_ok` can. The final look asks the same
    /// question the watch asked.
    #[test]
    fn a_supersede_that_lands_in_the_last_window_is_not_healed_over() {
        let probe = fixture();
        let mut w = FakeWorld::new();
        w.sentinel = vec![(0, "applied"), (2, "booting")];
        watch(&probe.job, &mut w, &probe.home);
        let last = w.samples.get();

        let fx = fixture();
        let mut w = FakeWorld::new();
        w.sentinel = vec![(0, "applied"), (2, "booting")];
        w.superseded_after_samples = Some(last);
        assert_eq!(watch(&fx.job, &mut w, &fx.home), Verdict::Confirmed);
        assert_eq!(fx.exe(), "new body");
        assert!(sentinel_status(&fx.home).is_none());
        assert!(!fx.home.recovery_json().exists());
        assert!(w.kills.is_empty());
        assert_eq!(w.opens.len(), 1);
    }

    /// A sentinel with no stamp at all (`applied_sha` empty — the source-edit
    /// apply flow writes one before the commit names the sha) is no
    /// information, not a supersede: the warden keeps watching.
    #[test]
    fn an_unstamped_sentinel_is_not_a_supersede() {
        assert!(!superseded(None, "bbb222"), "no sentinel is no information");
        let s = |applied: &str| Sentinel {
            prev_sha: "aaa111".into(),
            applied_sha: applied.into(),
            status: "booting".into(),
            source_root: String::new(),
            armed_by: Some("reweave".into()),
        };
        assert!(!superseded(Some(&s("")), "bbb222"), "an unstamped sentinel is no information");
        assert!(!superseded(Some(&s("bbb222")), "bbb222"), "this birth, still in play");
        assert!(superseded(Some(&s(LATER_SHA)), "bbb222"), "another birth entirely");
    }

    /// The kill and the second window are reserved for the path where the
    /// body is gone; the four rows of the rule, read directly.
    #[test]
    fn only_a_body_that_is_gone_is_taken_down() {
        // Gone (however it went) → taken down, reason unchanged.
        assert_eq!(ending(REASON_CRASHED, false), (true, REASON_CRASHED.to_string()));
        assert_eq!(ending(REASON_NEVER_CONFIRMED, false), (true, REASON_NEVER_CONFIRMED.to_string()));
        // Crashed, but something of it lingers → taken down, stragglers killed.
        assert_eq!(ending(REASON_CRASHED, true), (true, REASON_CRASHED.to_string()));
        // Running, and merely never said so → left alone, and the record says
        // that, not that LOOM already came home.
        assert_eq!(
            ending(REASON_NEVER_CONFIRMED, true),
            (false, REASON_NEVER_CONFIRMED_ALIVE.to_string())
        );
    }

    #[test]
    fn a_body_that_crashed_is_healed_and_the_app_reopened() {
        let fx = fixture();
        let mut w = FakeWorld::new();
        w.sentinel = vec![(0, "applied"), (2, "booting")];
        // Three empty samples in a row: gone.
        w.pids = vec![(0, Some(vec![4242])), (4, Some(vec![]))];
        let v = watch(&fx.job, &mut w, &fx.home);
        assert_eq!(v, Verdict::Healed { reason: REASON_CRASHED.into() });
        assert!(w.ticks >= 6, "three consecutive empty samples, not one");
        assert_eq!(w.opens.len(), 2, "opened, then opened again after the heal");
        assert_eq!(fx.exe(), "old body");
    }

    /// Round-1 review, Finding 6. `open -n` can refuse transiently —
    /// LaunchServices busy, the bundle still settling. One refusal is not a
    /// failed birth, and the heal's own reopen used to fail the same way,
    /// leaving no LOOM running at all.
    #[test]
    fn a_transient_open_refusal_is_retried_not_a_failed_birth() {
        let fx = fixture();
        let mut w = FakeWorld::new();
        w.open_fails = OPEN_ATTEMPTS - 1;
        w.sentinel = vec![(0, "applied"), (2, "booting"), (8, "ok")];
        assert_eq!(watch(&fx.job, &mut w, &fx.home), Verdict::Confirmed);
        assert_eq!(w.opens.len(), OPEN_ATTEMPTS as usize, "asked again before giving up");
        assert_eq!(fx.exe(), "new body");
        assert!(!fx.home.recovery_json().exists());
    }

    #[test]
    fn an_open_that_never_works_still_brings_loom_home() {
        let fx = fixture();
        let mut w = FakeWorld::new();
        w.open_fails = u32::MAX;
        w.pids = vec![(0, Some(vec![]))];
        let v = watch(&fx.job, &mut w, &fx.home);
        assert_eq!(v, Verdict::Healed { reason: REASON_NEVER_CONFIRMED.into() });
        assert_eq!(
            w.opens.len(),
            (OPEN_ATTEMPTS * 2) as usize,
            "retried at the birth and again at the reopen"
        );
        assert_eq!(fx.exe(), "old body");
    }

    /// Round-1 review, Finding 5. The warden's pid is what tells the pre-main
    /// backstop that this birth already has a guard. A warden that could not
    /// record it is invisible, and both healers would act on the same body.
    /// It stops instead of watching.
    #[test]
    fn a_warden_that_cannot_record_its_pid_does_not_watch() {
        let fx = fixture();
        let job_path = fx.home.warden_json();
        threads::write_json_atomic(&job_path, &fx.job).unwrap();
        let dir = job_path.parent().unwrap().to_path_buf();
        let ro = std::fs::Permissions::from_mode(0o500);
        let rw = std::fs::Permissions::from_mode(0o755);
        std::fs::set_permissions(&dir, ro).unwrap();
        if std::fs::write(dir.join(".probe"), "x").is_ok() {
            // Running as a user the mode bits do not bind (root): staging this
            // is impossible, and running on would spawn a real `open`.
            std::fs::set_permissions(&dir, rw).unwrap();
            return;
        }
        let code = run_warden(&job_path);
        std::fs::set_permissions(&dir, rw).unwrap();
        assert_eq!(code, 1, "a warden that cannot be seen must not watch");
        assert_eq!(fx.exe(), "new body", "it healed nothing");
        assert!(!fx.home.recovery_json().exists());
    }

    #[test]
    fn warden_empty_log_tail_when_reweave_record_is_absent() {
        let fx = fixture();
        std::fs::remove_file(fx.home.reweave_json()).unwrap();
        let mut w = FakeWorld::new();
        w.pids = vec![(0, Some(vec![4242])), (3, Some(vec![]))];
        assert!(matches!(watch(&fx.job, &mut w, &fx.home), Verdict::Healed { .. }));
        assert!(read_recovery(&fx.home).unwrap().log_tail.is_empty());
    }

    /// Round-2 review, Findings 2 and 3. The heal is a plan too, and the
    /// process running it can die between any two steps. Judged by the same
    /// rule the swap is judged by (`platform::survivable`): after every
    /// prefix a healer can still act, and the ledger names the body actually
    /// on the executable — or lags it while a healer is armed, never leads
    /// it. `healed` is TERMINAL, so a prefix that has written it has no
    /// healer left and the ledger must already be true.
    #[test]
    fn heal_interrupted_after_each_step_leaves_a_way_home() {
        let layout = |fx: &Fx| AppLayout {
            app_path: fx.job.app_path.clone(),
            exe_path: fx.job.exe_path.clone(),
        };
        let steps = {
            let fx = fixture();
            heal_plan(&fx.home, &layout(&fx), "bbb222", "aaa111").len()
        };
        for k in 0..=steps {
            let fx = fixture();
            // The disk as the warden finds it: the new body on the
            // executable, the sentinel `booting` and armed by the reweave.
            kernel::write_sentinel_at(
                &fx.home.sentinel_json(),
                &Sentinel {
                    prev_sha: "aaa111".into(),
                    applied_sha: "bbb222".into(),
                    status: "booting".into(),
                    source_root: fx.home.source().to_string_lossy().into_owned(),
                    armed_by: Some("reweave".into()),
                },
            )
            .unwrap();
            let plan = heal_plan(&fx.home, &layout(&fx), "bbb222", "aaa111");
            let tools = |name: &str| threads::tool_path(&fx.home, name);
            platform::execute(&plan[..k], &fx.home, &tools).unwrap();
            let on_disk = if fx.exe() == "new body" { "bbb222" } else { "aaa111" };
            if let Err(why) = platform::survivable(&fx.home, on_disk, "bbb222", "aaa111") {
                panic!("killed after {k} of {steps} step(s) of the heal: {why}");
            }
        }
    }

    /// Round-3 review, Finding 3. A `rollback-failed` written here used to be
    /// the end of it: `heal` wrote `recovery.json` only on SUCCESS, and
    /// `decide_boot_in` short-circuits on a terminal status and reports
    /// `rollback_failed: false`. So a failed body heal printed to stderr,
    /// booted the broken body on, and told the owner nothing — while the
    /// shell's "couldn't come home" path sat ready and unreachable. The spec's
    /// state table says "terminal; the notice says so." The record is the
    /// carrier that says so, and it is consumed exactly once.
    #[test]
    fn warden_heal_failure_marks_rollback_failed_and_says_so() {
        let fx = fixture();
        std::fs::remove_file(fx.home.generation_exe("aaa111")).unwrap();
        let mut w = FakeWorld::new();
        w.pids = vec![(0, Some(vec![4242])), (3, Some(vec![]))];
        assert!(matches!(watch(&fx.job, &mut w, &fx.home), Verdict::HealFailed(_)));
        assert_eq!(fx.exe(), "new body", "a failed copy leaves the file as it was");
        assert_eq!(sentinel_status(&fx.home).as_deref(), Some("rollback-failed"));
        assert_eq!(w.opens.len(), 1, "no second open of a body that did not heal");
        let rec = read_recovery(&fx.home).expect("the owner is told the body could not come home");
        assert_eq!(
            rec.reason, REASON_ROLLBACK_FAILED,
            "the record names the failure, and never claims a home it did not reach"
        );
        assert_eq!(rec.failed_sha, "bbb222");
        assert_eq!(rec.prev_sha, "aaa111");
        assert!(!rec.log_tail.is_empty(), "what the weave said before the body failed");
        // Once — the same one-shot the healed record uses.
        assert!(take_recovery(&fx.home).is_some());
        assert!(take_recovery(&fx.home).is_none());
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
        w.pids = vec![(0, Some(vec![4242])), (3, Some(vec![]))];
        watch(&fx.job, &mut w, &fx.home);
        assert!(take_recovery(&fx.home).is_some());
        assert!(!fx.home.recovery_json().exists());
        assert!(take_recovery(&fx.home).is_none());
    }

    /// Round-2 review, Finding 8. `warden_alive` is a pid, and pids are
    /// recycled: a dead warden's number handed to some unrelated process
    /// reads as alive, and the pre-main backstop then leaves a bad body
    /// unguarded on every boot after. The warden clears its own pid as it
    /// leaves, so the job it leaves behind names no guard at all.
    #[test]
    fn a_warden_that_has_left_names_no_pid() {
        let fx = fixture();
        let job_path = fx.home.warden_json();
        let mut job = fx.job.clone();
        job.warden_pid = Some(4242);
        threads::write_json_atomic(&job_path, &job).unwrap();

        release_pid(&job_path);
        let after: Job =
            serde_json::from_str(&std::fs::read_to_string(&job_path).unwrap()).unwrap();
        assert_eq!(after.warden_pid, None, "a warden that has left is not a guard");
        assert_eq!(
            Job { warden_pid: Some(4242), ..after },
            job,
            "nothing else about the job may change"
        );
        // A job that is already unstamped, and a job file that is gone, are
        // both fine: this runs on the way out and may never panic.
        release_pid(&job_path);
        assert_eq!(
            serde_json::from_str::<Job>(&std::fs::read_to_string(&job_path).unwrap())
                .unwrap()
                .warden_pid,
            None
        );
        std::fs::remove_file(&job_path).unwrap();
        release_pid(&job_path);
        assert!(!job_path.exists());
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
