//! reweave — the build job (Phase 23 / Rebirth): assets · core · stage · swap · relaunch.
//!
//! PROTECTED (kernel.rs `PROTECTED_RUST`): this module turns the edited genome
//! into a new body and hands the running one over to it. If LOOM could edit
//! it, a broken self-edit could skip the shelf, skip the warden, or swap in a
//! body nothing can return from.
//!
//! The job (spec §Reweave), one background thread in the global `exec::JOB`
//! slot shared with threading — the two never overlap:
//!
//! 1. `assets`   — `npm run build` in `source/` (10 min).
//! 2. `core`     — `cargo build --release --offline` in `source/src-tauri`,
//!                 `CARGO_TARGET_DIR = loomhome/target` (30 min), tail streamed.
//! 3. `stage`    — the body goes on the shelf (`generations::record`) and is
//!                 ad-hoc signed. Dev mode stops here, honestly: `tauri dev`
//!                 owns the binary.
//! 4. `swap`     — the point of return. `platform::swap_plan` + `execute`:
//!                 shelve the running body, replace the file, re-sign, sentinel
//!                 `applied` armed by reweave, ledger moved and unconfirmed.
//! 5. `relaunch` — `warden.json` is written and the PREVIOUS generation's body
//!                 is spawned detached as the warden; the command then exits
//!                 the app so the warden can open the new one.
//!
//! `generations_return(sha)` is the same job with 1–3 replaced by a checkout
//! of the genome onto `generation/<sha7>` so body and genome agree.
//!
//! Every state change is written to `reweave.json` (atomically) and emitted
//! as `loom-reweave`; the shape is `ReweaveState`, camelCase, matching
//! `src/lib/core.ts`. Cancel is a group kill through `exec::JOB` and is
//! refused from `swap` on — the card says so before starting it.
//!
//! The job is factored over a `Runner` so tests inject fake tools and a
//! scripted runner; `ExecRunner` is the production one (fixed argv through
//! `exec::run_job_stream`, cwd contained in the source root, no shell).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use crate::error::LoomError;
use crate::exec::{self, ExecOut, JOB};
use crate::generations;
use crate::kernel;
use crate::loomhome::{self, Home, Mode};
use crate::platform::{self, AppLayout, Step};
use crate::threads;
use crate::warden;

// ── State ─────────────────────────────────────────────────────────────────────

/// The event every state change rides on.
pub const REWEAVE_EVENT: &str = "loom-reweave";
/// The tail keeps at most this many lines of the running tool.
pub const TAIL_CAP: usize = 400;
/// How often a stream of tool lines is written and emitted (stage changes
/// always are). Cargo prints hundreds of lines a second; the card needs a
/// handful of paints.
const TAIL_EVERY: Duration = Duration::from_millis(250);

const ASSETS_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const CORE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const GIT_TIMEOUT: Duration = Duration::from_secs(60);
/// The warden gives the new body this long to confirm its boot.
const WARDEN_TIMEOUT_SECS: u64 = 90;
/// How long the card shows "LOOM will close" before the app exits.
const RELAUNCH_GRACE: Duration = Duration::from_millis(1500);

/// `reweave.json` and the `loom-reweave` payload. `stage` walks
/// idle · assets · core · stage · swap · relaunch and ends in done · failed ·
/// cancelled. `cancellable` goes false at `swap`, the point of return.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReweaveState {
    pub stage: String,
    pub target_sha: Option<String>,
    pub started_at: Option<String>,
    pub elapsed_ms: u64,
    /// The last ≤ `TAIL_CAP` lines of the running tool.
    pub tail: Vec<String>,
    /// The calm sentence for done / failed / cancelled — and, at relaunch,
    /// the line the card counts down under.
    pub outcome: Option<String>,
    pub cancellable: bool,
    pub mode: Mode,
}

impl ReweaveState {
    pub fn idle(mode: Mode) -> ReweaveState {
        ReweaveState {
            stage: "idle".into(),
            target_sha: None,
            started_at: None,
            elapsed_ms: 0,
            tail: Vec::new(),
            outcome: None,
            cancellable: false,
            mode,
        }
    }
}

/// A stage a job is still inside — as opposed to idle or a terminal one.
fn in_progress(stage: &str) -> bool {
    matches!(stage, "assets" | "core" | "stage" | "swap" | "relaunch")
}

/// The persisted state, or idle when absent or torn.
pub fn read_state(home: &Home, mode: Mode) -> ReweaveState {
    std::fs::read_to_string(home.reweave_json())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| ReweaveState::idle(mode))
}

/// Pure: what a persisted state means to the process reading it. A live job
/// (`active`) is reported as-is. A record that says the job is mid-stage but
/// no job runs in this process is a fact about the past, not a live stage —
/// `relaunch` read by the body it relaunched into (`running == target`) is
/// the weave that succeeded; read by any other body it is the weave the
/// warden brought LOOM home from; anything earlier was interrupted.
pub fn settle(state: ReweaveState, active: bool, running: Option<&str>) -> ReweaveState {
    if active || !in_progress(&state.stage) {
        return state;
    }
    let (stage, outcome) = if state.stage == "relaunch" {
        if running.is_some() && running == state.target_sha.as_deref() {
            ("done", "woven — this is the generation the weave made".to_string())
        } else {
            ("failed", "the weave did not hold — LOOM came home to the previous generation".to_string())
        }
    } else {
        ("failed", "the weave was interrupted — LOOM closed before it finished; start it again".to_string())
    };
    ReweaveState { stage: stage.into(), outcome: Some(outcome), cancellable: false, ..state }
}

// ── Progress: the one writer of state ─────────────────────────────────────────

/// Owns the state during a job. Every mutation goes through here so the file
/// and the event never disagree; line pushes are throttled, stage changes
/// are not.
pub struct Progress<'a> {
    home: &'a Home,
    state: ReweaveState,
    started: Instant,
    last_flush: Option<Instant>,
    emit: &'a mut dyn FnMut(&ReweaveState),
}

impl<'a> Progress<'a> {
    pub fn begin(home: &'a Home, mode: Mode, target: &str, emit: &'a mut dyn FnMut(&ReweaveState)) -> Progress<'a> {
        let state = ReweaveState {
            target_sha: Some(target.to_string()),
            started_at: Some(generations::now_rfc3339()),
            ..ReweaveState::idle(mode)
        };
        Progress { home, state, started: Instant::now(), last_flush: None, emit }
    }

    /// Enter a stage. Always written and emitted.
    pub fn stage(&mut self, stage: &str, cancellable: bool) {
        self.state.stage = stage.into();
        self.state.cancellable = cancellable;
        self.flush();
    }

    /// A line from the running tool. Kept in the capped tail; written and
    /// emitted at most every `TAIL_EVERY`.
    pub fn line(&mut self, l: &str) {
        if l.trim().is_empty() {
            return;
        }
        if self.state.tail.len() == TAIL_CAP {
            self.state.tail.remove(0);
        }
        self.state.tail.push(l.to_string());
        if self.last_flush.map_or(true, |t| t.elapsed() >= TAIL_EVERY) {
            self.flush();
        }
    }

    /// End the job in a terminal stage with its sentence.
    pub fn finish(&mut self, stage: &str, outcome: &str) {
        self.state.outcome = Some(outcome.to_string());
        self.stage(stage, false);
    }

    /// Set the sentence without ending the job (the relaunch countdown).
    pub fn say(&mut self, outcome: &str) {
        self.state.outcome = Some(outcome.to_string());
        self.flush();
    }

    fn flush(&mut self) {
        self.state.elapsed_ms = self.started.elapsed().as_millis() as u64;
        // The file is the record; a write failure must not stop the job —
        // the event still carries the state to the card.
        let _ = threads::write_json_atomic(&self.home.reweave_json(), &self.state);
        (self.emit)(&self.state);
        self.last_flush = Some(Instant::now());
    }
}

// ── Runner: what the job asks of the world ────────────────────────────────────

/// The job's only way to spawn. Production (`ExecRunner`) is `exec`; tests
/// script it. `stage` names the caller so a runner can pick the timeout.
pub trait Runner {
    fn run(
        &mut self,
        stage: &str,
        argv: &[&str],
        cwd: &Path,
        root: &Path,
        envs: &[(&str, &str)],
        on_line: &mut dyn FnMut(&str),
    ) -> Result<ExecOut, LoomError>;
    /// Spawn and let go — the warden must outlive us.
    fn detach(&mut self, argv: &[&str], cwd: &Path, root: &Path) -> Result<u32, LoomError>;
    /// Was the last run's non-zero exit a cancel, not a failure?
    fn cancelled(&self) -> bool;
}

/// The production runner: `exec::run_job_stream` in the global `JOB` slot
/// (so `reweave_cancel` can group-kill the tree), `exec::run_detached` for
/// the warden. Fixed argv, contained cwd, no shell — exec's rules.
pub struct ExecRunner;

fn timeout_for(stage: &str) -> Duration {
    match stage {
        "assets" => ASSETS_TIMEOUT,
        "core" => CORE_TIMEOUT,
        _ => GIT_TIMEOUT,
    }
}

impl Runner for ExecRunner {
    fn run(
        &mut self,
        stage: &str,
        argv: &[&str],
        cwd: &Path,
        root: &Path,
        envs: &[(&str, &str)],
        on_line: &mut dyn FnMut(&str),
    ) -> Result<ExecOut, LoomError> {
        exec::run_job_stream(&JOB, argv, cwd, root, timeout_for(stage), envs, on_line)
    }
    fn detach(&mut self, argv: &[&str], cwd: &Path, root: &Path) -> Result<u32, LoomError> {
        exec::run_detached(argv, cwd, root)
    }
    fn cancelled(&self) -> bool {
        JOB.cancelled()
    }
}

// ── Preconditions (pure) ──────────────────────────────────────────────────────

pub const NOT_THREADED: &str = "the loom isn't threaded — open Settings";
pub const NOTHING_NEW: &str = "nothing new to weave — the body already matches the genome";
pub const IN_FLIGHT: &str = "a weave is already under way";
pub const PAST_RETURN: &str = "past the point of return — the swap is under way";
pub const NOTHING_TO_CANCEL: &str = "nothing to cancel — no weave is under way";

/// The running body's sha: the ledger's `current`, or — generation 0, which
/// predates the ledger — the sha baked into this binary.
fn running_sha(current: Option<&str>) -> String {
    current.map(str::to_string).unwrap_or_else(|| loomhome::genome_sha().to_string())
}

/// `reweave_start`'s rules (spec §Reweave): threaded; in packaged mode the
/// genome's HEAD must differ from the running body unless `force`. Dev never
/// swaps, so it always has something to prove.
pub fn check_start(threaded: bool, mode: Mode, head: &str, current: Option<&str>, force: bool) -> Result<(), LoomError> {
    if !threaded {
        return Err(LoomError::Parse(NOT_THREADED.into()));
    }
    if mode == Mode::Packaged && !force && head == running_sha(current) {
        return Err(LoomError::Parse(NOTHING_NEW.into()));
    }
    Ok(())
}

/// `generations_return`'s rules: the body must be on the shelf WHOLE (round-1
/// review, Finding 8 — a body a crash cut short is not a body to return to)
/// and must not be the one already running.
pub fn check_return(exe_whole: bool, current: Option<&str>, sha: &str) -> Result<(), LoomError> {
    if !exe_whole {
        return Err(LoomError::NotFound(format!(
            "generation {} isn't on the shelf whole — it was pruned, never woven, or cut short",
            short(sha)
        )));
    }
    if sha == running_sha(current) {
        return Err(LoomError::Parse(platform::ALREADY_RUNNING.into()));
    }
    Ok(())
}

/// `reweave_cancel`'s rule: only a job still before the point of return.
pub fn cancel_with(state: &ReweaveState) -> Result<(), LoomError> {
    if !in_progress(&state.stage) {
        return Err(LoomError::Parse(NOTHING_TO_CANCEL.into()));
    }
    if !state.cancellable {
        return Err(LoomError::Parse(PAST_RETURN.into()));
    }
    Ok(())
}

fn short(sha: &str) -> &str {
    &sha[..7.min(sha.len())]
}

// ── The job ───────────────────────────────────────────────────────────────────

/// What kind of job: a weave of the genome's HEAD, or a return to a shelved sha.
pub enum Kind {
    Weave,
    Return { sha: String },
}

/// Everything the job needs from the process, resolved by the command so the
/// job itself is pure over its inputs.
pub struct Ctx<'a> {
    pub home: &'a Home,
    pub mode: Mode,
    /// `std::env::consts::OS` in the app; injected so tests reach the macOS
    /// branches on any unix.
    pub os: &'a str,
    /// The genome's work tree (dev: the checkout; packaged: `home.source()`).
    pub source: PathBuf,
    /// The running app bundle, when there is one (packaged on macOS).
    pub layout: Option<AppLayout>,
    /// Tool name → absolute path (`threads::tool_path` in the app).
    pub tools: &'a dyn Fn(&str) -> Option<PathBuf>,
    /// This process, which the warden waits for.
    pub old_pid: u32,
}

/// How a job ended well.
#[derive(Debug, PartialEq)]
pub enum Finish {
    /// Dev: built and shelved; nothing swapped.
    Built,
    /// Packaged: the warden is running; the caller exits the app.
    Relaunching { warden_pid: u32 },
}

/// A stage's failure: the sentence for the card plus the typed error for
/// the caller.
struct Failed {
    outcome: String,
    err: LoomError,
}

fn failed(outcome: String, err: LoomError) -> Failed {
    Failed { outcome, err }
}

const UNTOUCHED: &str = "the running generation is untouched";

/// Run the job to its end. Emits every state; returns how it finished. The
/// terminal state (done / failed / cancelled / relaunch) is already written
/// and emitted when this returns.
pub fn run_job(
    ctx: &Ctx,
    kind: Kind,
    runner: &mut dyn Runner,
    emit: &mut dyn FnMut(&ReweaveState),
) -> Result<Finish, LoomError> {
    let target = match &kind {
        Kind::Weave => kernel::head_sha(&ctx.source)?,
        Kind::Return { sha } => sha.clone(),
    };
    let mut p = Progress::begin(ctx.home, ctx.mode, &target, emit);
    match job_steps(ctx, &kind, &target, runner, &mut p) {
        Ok(fin) => Ok(fin),
        Err(Failed { outcome, err }) => {
            let stage = if runner.cancelled() { "cancelled" } else { "failed" };
            p.finish(stage, &outcome);
            Err(err)
        }
    }
}

fn job_steps(
    ctx: &Ctx,
    kind: &Kind,
    target: &str,
    runner: &mut dyn Runner,
    p: &mut Progress,
) -> Result<Finish, Failed> {
    let home = ctx.home;
    let source = &ctx.source;

    match kind {
        Kind::Weave => {
            // 1 · assets
            p.stage("assets", true);
            let npm = need_tool(ctx.tools, "npm")?;
            let out = run(runner, p, "assets", &[&npm, "run", "build"], source, source, &[])?;
            if out.code != 0 {
                return Err(exit_failed(runner, "assets", "the assets did not build", &out));
            }

            // 2 · core — `--offline` is appended by `cargo_argv`, always.
            p.stage("core", true);
            let cargo = need_tool(ctx.tools, "cargo")?;
            let argv = kernel::cargo_argv(Path::new(&cargo), &["build", "--release"]);
            let argv: Vec<&str> = argv.iter().map(String::as_str).collect();
            let target_dir = home.target().to_string_lossy().into_owned();
            let envs = [("CARGO_TARGET_DIR", target_dir.as_str()), ("CARGO_NET_OFFLINE", "true")];
            let core = source.join("src-tauri");
            let out = run(runner, p, "core", &argv, &core, source, &envs)?;
            if out.code != 0 {
                return Err(exit_failed(runner, "core", "the core did not compile", &out));
            }

            // 3 · stage — onto the shelf, signed.
            p.stage("stage", true);
            let built = home.target().join("release").join("loom");
            generations::record(home, target, &built, "reweave").map_err(|e| {
                failed(format!("the woven body could not be shelved — {e}; {UNTOUCHED}"), e)
            })?;
            if ctx.os == "macos" {
                platform::execute(&[Step::Codesign { path: home.generation_exe(target) }], home, ctx.tools)
                    .map_err(|e| failed(format!("the woven body could not be signed — {e}; {UNTOUCHED}"), e))?;
            } else {
                p.line("codesign skipped — not macOS");
            }

            if ctx.mode == Mode::Dev {
                p.finish("done", "built — in dev, restart tauri dev to load the core");
                return Ok(Finish::Built);
            }
        }
        Kind::Return { sha } => {
            // 3 · stage — the genome is made to agree with the body: a branch
            // `generation/<sha7>` at the sha. Newer commits stay on main.
            p.stage("stage", true);
            let git = need_tool(ctx.tools, "git")?;
            let branch = format!("generation/{}", short(sha));
            let out = run(runner, p, "stage", &[&git, "checkout", "-B", &branch, sha], source, source, &[])?;
            if out.code != 0 {
                return Err(exit_failed(runner, "stage", "the genome could not be checked out at that generation", &out));
            }
        }
    }

    // 4 · swap — the point of return. Not cancellable from here.
    p.stage("swap", false);
    let layout = ctx.layout.clone().ok_or_else(|| {
        let e = LoomError::Unsupported(platform::UNSUPPORTED_SWAP.into());
        failed(format!("{} — the body is on the shelf", platform::UNSUPPORTED_SWAP), e)
    })?;
    let ledger = generations::read(home);
    let plan = platform::swap_plan(&ledger, &layout, home, target, ctx.os)
        .map_err(|e| failed(format!("the swap could not be planned — {e}; {UNTOUCHED}"), e))?;
    for step in &plan {
        if let Ok(v) = serde_json::to_string(step) {
            p.line(&format!("swap: {v}"));
        }
    }
    platform::execute(&plan, home, ctx.tools).map_err(|e| {
        failed(
            format!("the swap did not complete — {e}; this process is unchanged, the file on disk may not be — return to a kept generation from Settings"),
            e,
        )
    })?;
    let prev = generations::read(home)
        .previous
        .unwrap_or_else(|| running_sha(ledger.current.as_deref()));

    // 5 · relaunch — the previous generation guards the birth.
    p.stage("relaunch", false);
    let job = warden::Job {
        old_pid: ctx.old_pid,
        app_path: layout.app_path.clone(),
        exe_path: layout.exe_path.clone(),
        new_sha: target.to_string(),
        prev_sha: prev.clone(),
        loomhome: home.root.clone(),
        timeout_secs: WARDEN_TIMEOUT_SECS,
        relaunch_only: false,
        warden_pid: None,
    };
    let after_swap = "the new body is in place — the next launch guards itself";
    threads::write_json_atomic(&home.warden_json(), &job)
        .map_err(|e| failed(format!("the warden's job could not be written — {e}; {after_swap}"), e))?;
    let warden_exe = home.generation_exe(&prev).to_string_lossy().into_owned();
    let warden_json = home.warden_json().to_string_lossy().into_owned();
    let warden_pid = runner
        .detach(&[&warden_exe, "--warden", &warden_json], &home.root, &home.root)
        .map_err(|e| failed(format!("the warden could not be started — {e}; {after_swap}"), e))?;
    p.line(&format!("warden: generation {} pid {warden_pid}", short(&prev)));
    p.say("LOOM will close and return in a moment");
    Ok(Finish::Relaunching { warden_pid })
}

fn need_tool(tools: &dyn Fn(&str) -> Option<PathBuf>, name: &str) -> Result<String, Failed> {
    match tools(name) {
        Some(p) => Ok(p.to_string_lossy().into_owned()),
        None => {
            let install = threads::spec(name).map(|s| s.install).unwrap_or("");
            let e = LoomError::NotFound(format!("{name} is missing — install it with `{install}`"));
            Err(failed(format!("{name} is missing — thread the loom again to record it; {UNTOUCHED}"), e))
        }
    }
}

/// One spawn, its lines into the tail. A spawn error or timeout is a failure
/// with its own sentence.
fn run(
    runner: &mut dyn Runner,
    p: &mut Progress,
    stage: &str,
    argv: &[&str],
    cwd: &Path,
    root: &Path,
    envs: &[(&str, &str)],
) -> Result<ExecOut, Failed> {
    // A cancel that landed between two spawns must not start the next one.
    if runner.cancelled() {
        return Err(failed(
            format!("the weave was cancelled — {UNTOUCHED}"),
            LoomError::Parse("cancelled".into()),
        ));
    }
    runner
        .run(stage, argv, cwd, root, envs, &mut |line| p.line(line))
        .map_err(|e| match e {
            LoomError::Timeout => failed(format!("{stage} ran out of time — {UNTOUCHED}; start again"), e),
            other => failed(format!("{stage} could not start — {other}; {UNTOUCHED}"), other),
        })
}

/// A tool exited non-zero: cancelled if the slot says so, else the stage's
/// honest line. The tail already holds the tool's words.
fn exit_failed(runner: &dyn Runner, stage: &str, fact: &str, out: &ExecOut) -> Failed {
    if runner.cancelled() {
        return failed(
            format!("the weave was cancelled — {UNTOUCHED}"),
            LoomError::Parse("cancelled".into()),
        );
    }
    failed(
        format!("{fact} — the tail below says where; {UNTOUCHED}"),
        LoomError::Parse(format!("{stage} failed (exit {})", out.code)),
    )
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Is a job thread of THIS process alive? `exec::JOB` says whether any job
/// holds the slot (threading too); this says whether it is ours.
static ACTIVE: AtomicBool = AtomicBool::new(false);

fn ctx_for(app: &tauri::AppHandle) -> Result<(Home, Mode, PathBuf, Option<AppLayout>), LoomError> {
    let home = Home::from_app(app)?;
    let mode = loomhome::mode();
    let source = kernel::resolve_source_repo_at(mode, None, Some(&home))?;
    // Dev has no bundle; a packaged LOOM off macOS has none either — the
    // build and the shelf still work, the swap says so at its stage.
    let layout = match mode {
        Mode::Packaged => platform::app_layout().ok(),
        Mode::Dev => None,
    };
    Ok((home, mode, source, layout))
}

/// PURE: does the job thread give the exec slot back? (Round-1 review,
/// Finding 7.) A job that handed the body over to the warden holds the slot
/// until the process exits — the slot released 1.5 s before `app.exit(0)`
/// was a window in which `generations_return` could start a second swap on
/// top of a just-armed one. Every other ending, live or failed, releases it.
pub fn releases_the_slot(fin: &Result<Finish, LoomError>) -> bool {
    !matches!(fin, Ok(Finish::Relaunching { .. }))
}

/// Spawn the job thread; the slot is already ours. Releases it at the end —
/// except on the handover, which keeps it until the app exits.
fn spawn_job(app: tauri::AppHandle, home: Home, mode: Mode, source: PathBuf, layout: Option<AppLayout>, kind: Kind) {
    use tauri::Emitter;
    ACTIVE.store(true, Ordering::SeqCst);
    std::thread::spawn(move || {
        let tools = |name: &str| threads::tool_path(&home, name);
        let ctx = Ctx {
            home: &home,
            mode,
            os: std::env::consts::OS,
            source,
            layout,
            tools: &tools,
            old_pid: std::process::id(),
        };
        let mut emit = |s: &ReweaveState| {
            let _ = app.emit(REWEAVE_EVENT, s.clone());
        };
        let fin = run_job(&ctx, kind, &mut ExecRunner, &mut emit);
        ACTIVE.store(false, Ordering::SeqCst);
        if releases_the_slot(&fin) {
            JOB.release();
        } else {
            // The card has its line; the warden is waiting for this pid. The
            // slot is NOT given back: nothing may start a second swap over
            // the one already armed in the seconds before we exit.
            std::thread::sleep(RELAUNCH_GRACE);
            app.exit(0);
        }
    });
}

/// Start a weave of the genome's HEAD. Returns as soon as the job is
/// spawned; progress arrives as `loom-reweave`.
#[tauri::command]
pub fn reweave_start(app: tauri::AppHandle, force: bool) -> Result<(), LoomError> {
    let (home, mode, source, layout) = ctx_for(&app)?;
    if !JOB.try_take() {
        return Err(LoomError::Parse(IN_FLIGHT.into()));
    }
    let checked = (|| {
        let head = kernel::head_sha(&source)?;
        let current = generations::read(&home).current;
        check_start(loomhome::read_threaded(&home), mode, &head, current.as_deref(), force)
    })();
    if let Err(e) = checked {
        JOB.release();
        return Err(e);
    }
    spawn_job(app, home, mode, source, layout, Kind::Weave);
    Ok(())
}

/// Kill the job tree — only before the point of return.
#[tauri::command]
pub fn reweave_cancel(app: tauri::AppHandle) -> Result<(), LoomError> {
    let home = Home::from_app(&app)?;
    if !ACTIVE.load(Ordering::SeqCst) {
        return Err(LoomError::Parse(NOTHING_TO_CANCEL.into()));
    }
    cancel_with(&read_state(&home, loomhome::mode()))?;
    JOB.kill();
    Ok(())
}

/// The persisted state, settled for the process reading it.
#[tauri::command]
pub fn reweave_state(app: tauri::AppHandle) -> Result<ReweaveState, LoomError> {
    let home = Home::from_app(&app)?;
    let running = generations::read(&home).current;
    Ok(settle(
        read_state(&home, loomhome::mode()),
        ACTIVE.load(Ordering::SeqCst),
        Some(&running_sha(running.as_deref())),
    ))
}

/// Return to a shelved generation: the same job with the build stages
/// skipped. Packaged, on a bundle, only — there is nothing to swap in dev.
#[tauri::command]
pub fn generations_return(app: tauri::AppHandle, sha: String) -> Result<(), LoomError> {
    let (home, mode, source, layout) = ctx_for(&app)?;
    let layout = match (mode, layout) {
        (Mode::Packaged, Some(l)) => l,
        _ => return Err(LoomError::Unsupported(platform::UNSUPPORTED_SWAP.into())),
    };
    let current = generations::read(&home).current;
    check_return(generations::shelved_whole(&home, &sha), current.as_deref(), &sha)?;
    if !JOB.try_take() {
        return Err(LoomError::Parse(IN_FLIGHT.into()));
    }
    spawn_job(app, home, mode, source, Some(layout), Kind::Return { sha });
    Ok(())
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generations;
    use std::collections::HashMap;
    use std::os::unix::fs::PermissionsExt;

    // ── fixtures ──

    /// A loomhome with a real genome (one commit) under `source/`, a fake
    /// `.app` tree beside it, and a `bin/` of fake tools that record their
    /// argv. `os` is injected, so the macOS branches run on any unix.
    struct Fx {
        _dir: tempfile::TempDir,
        root: PathBuf,
        home: Home,
        head: String,
        lay: AppLayout,
        bin: PathBuf,
    }

    fn git(args: &[&str], cwd: &Path) -> String {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn script(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn fixture() -> Fx {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let home = Home::at(root.join("loom"));
        std::fs::create_dir_all(home.source()).unwrap();
        git(&["init", "-q", "-b", "main"], &home.source());
        std::fs::write(home.source().join("a.txt"), "one").unwrap();
        git(&["add", "."], &home.source());
        git(&["commit", "-q", "-m", "one"], &home.source());
        let head = git(&["rev-parse", "HEAD"], &home.source());
        std::fs::create_dir_all(home.source().join("src-tauri")).unwrap();

        let app_path = root.join("LOOM.app");
        let lay = AppLayout { exe_path: app_path.join("Contents/MacOS/loom"), app_path };
        std::fs::create_dir_all(lay.exe_path.parent().unwrap()).unwrap();
        std::fs::write(&lay.exe_path, "old body").unwrap();
        std::fs::set_permissions(&lay.exe_path, std::fs::Permissions::from_mode(0o755)).unwrap();

        let bin = root.join("bin");
        // npm: record argv, print a line.
        script(&bin.join("npm"), &format!(
            "printf '%s\\n' \"$@\" > '{}'\necho 'vite built dist/'",
            root.join("npm-argv.txt").display()
        ));
        // cargo: record argv, honour CARGO_TARGET_DIR, produce the body.
        script(&bin.join("cargo"), &format!(
            "printf '%s\\n' \"$@\" > '{}'\nmkdir -p \"$CARGO_TARGET_DIR/release\"\nprintf 'new body' > \"$CARGO_TARGET_DIR/release/loom\"\nchmod 755 \"$CARGO_TARGET_DIR/release/loom\"\necho 'Compiling loom v0.1.0'\necho 'Finished release'",
            root.join("cargo-argv.txt").display()
        ));
        // codesign: append argv (it runs twice on a full weave).
        script(&bin.join("codesign"), &format!(
            "printf '%s\\n' \"$@\" >> '{}'",
            root.join("codesign-argv.txt").display()
        ));
        Fx { _dir: dir, root, home, head, lay, bin }
    }

    impl Fx {
        fn tools(&self) -> impl Fn(&str) -> Option<PathBuf> + '_ {
            move |name: &str| match name {
                "git" => Some(PathBuf::from("git")),
                "npm" | "cargo" | "codesign" => Some(self.bin.join(name)),
                _ => None,
            }
        }
        fn ctx<'a>(&'a self, mode: Mode, tools: &'a dyn Fn(&str) -> Option<PathBuf>) -> Ctx<'a> {
            Ctx {
                home: &self.home,
                mode,
                os: "macos",
                source: self.home.source(),
                layout: Some(self.lay.clone()),
                tools,
                old_pid: std::process::id(),
            }
        }
        fn argv(&self, tool: &str) -> Vec<String> {
            std::fs::read_to_string(self.root.join(format!("{tool}-argv.txt")))
                .map(|s| s.lines().map(str::to_string).collect())
                .unwrap_or_default()
        }
        /// Shelve a fake generation `sha` with a body that records being
        /// launched (as the warden) to `<root>/warden-launched.txt`.
        fn shelve(&self, sha: &str, body: &str) {
            let exe = self.home.generation_exe(sha);
            script(&exe, &format!(
                "printf '%s\\n' \"$@\" > '{}'\nprintf '{body}' > '{}'",
                self.root.join("warden-launched.txt").display(),
                self.root.join("warden-body.txt").display()
            ));
        }
        fn states<'a>(&self, seen: &'a mut Vec<ReweaveState>) -> impl FnMut(&ReweaveState) + 'a {
            move |s: &ReweaveState| seen.push(s.clone())
        }
    }

    fn stages(seen: &[ReweaveState]) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for s in seen {
            if out.last().map(String::as_str) != Some(s.stage.as_str()) {
                out.push(s.stage.clone());
            }
        }
        out
    }

    fn persisted(home: &Home) -> ReweaveState {
        let raw = std::fs::read_to_string(home.reweave_json()).unwrap();
        serde_json::from_str(&raw).unwrap()
    }

    /// A scripted runner: per stage, an exit code and the lines it "prints".
    struct FakeRunner {
        script: HashMap<&'static str, (i32, Vec<&'static str>)>,
        calls: Vec<(String, Vec<String>)>,
        detached: Vec<Vec<String>>,
    }

    impl Runner for FakeRunner {
        fn run(
            &mut self,
            stage: &str,
            argv: &[&str],
            _cwd: &Path,
            _root: &Path,
            _envs: &[(&str, &str)],
            on_line: &mut dyn FnMut(&str),
        ) -> Result<ExecOut, LoomError> {
            self.calls.push((stage.to_string(), argv.iter().map(|s| s.to_string()).collect()));
            let (code, lines) = self.script.get(stage).cloned().unwrap_or((0, vec![]));
            for l in &lines {
                on_line(l);
            }
            Ok(ExecOut { code, stdout: String::new(), stderr: lines.join("\n") })
        }
        fn detach(&mut self, argv: &[&str], _cwd: &Path, _root: &Path) -> Result<u32, LoomError> {
            self.detached.push(argv.iter().map(|s| s.to_string()).collect());
            Ok(4242)
        }
        fn cancelled(&self) -> bool {
            false
        }
    }

    // ── the seven ──

    #[test]
    fn job_runs_assets_then_core_then_stage_then_done_in_dev() {
        let fx = fixture();
        let tools = fx.tools();
        let ctx = fx.ctx(Mode::Dev, &tools);
        let mut seen = Vec::new();
        let fin = run_job(&ctx, Kind::Weave, &mut ExecRunner, &mut fx.states(&mut seen)).unwrap();
        assert_eq!(fin, Finish::Built);

        assert_eq!(stages(&seen), vec!["assets", "core", "stage", "done"]);
        let last = seen.last().unwrap();
        assert_eq!(last.stage, "done");
        assert_eq!(last.outcome.as_deref(), Some("built — in dev, restart tauri dev to load the core"));
        assert_eq!(last.target_sha.as_deref(), Some(fx.head.as_str()));
        assert!(!last.cancellable, "a finished job has nothing to cancel");
        assert_eq!(last.mode, Mode::Dev);
        assert!(last.started_at.as_deref().map_or(false, |t| t.ends_with('Z')));
        assert!(last.tail.iter().any(|l| l.contains("Compiling loom")), "the core's tail streams: {:?}", last.tail);
        assert!(last.tail.iter().any(|l| l.contains("vite built")), "the assets' tail streams too");
        // The build stages are cancellable; done is not.
        assert!(seen.iter().filter(|s| s.stage == "assets" || s.stage == "core").all(|s| s.cancellable));

        // Fixed argv: npm run build; cargo build --release --offline.
        assert_eq!(fx.argv("npm"), vec!["run", "build"]);
        assert_eq!(fx.argv("cargo"), vec!["build", "--release", "--offline"]);
        // The body was shelved from the shared target dir, and signed.
        assert_eq!(std::fs::read_to_string(fx.home.generation_exe(&fx.head)).unwrap(), "new body");
        let ledger = generations::read(&fx.home);
        assert_eq!(ledger.kept, vec![fx.head.clone()]);
        assert!(ledger.current.is_none(), "dev never swaps — current stays unset");
        let sign = fx.argv("codesign");
        assert_eq!(sign, vec!["--force", "--deep", "--sign", "-", fx.home.generation_exe(&fx.head).to_str().unwrap()]);
        // Nothing beyond stage ran: the live exe and the warden file are untouched.
        assert_eq!(std::fs::read_to_string(&fx.lay.exe_path).unwrap(), "old body");
        assert!(!fx.home.warden_json().exists());
        // The state is persisted, camelCase, after the last change.
        let raw = std::fs::read_to_string(fx.home.reweave_json()).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["stage"], "done");
        assert_eq!(v["targetSha"], fx.head);
        assert!(v.get("elapsedMs").is_some() && v.get("startedAt").is_some() && v.get("cancellable").is_some());
        assert!(v.get("target_sha").is_none(), "snake_case must not leak");
        assert_eq!(&persisted(&fx.home), last);
    }

    #[test]
    fn job_failure_at_core_reports_honest_outcome_and_leaves_running_generation() {
        let fx = fixture();
        let tools = fx.tools();
        let ctx = fx.ctx(Mode::Packaged, &tools);
        let mut runner = FakeRunner {
            script: HashMap::from([
                ("assets", (0, vec!["vite built dist/"])),
                ("core", (101, vec!["Compiling loom v0.1.0", "error[E0308]: mismatched types", "error: could not compile `loom`"])),
            ]),
            calls: vec![],
            detached: vec![],
        };
        let mut seen = Vec::new();
        let err = run_job(&ctx, Kind::Weave, &mut runner, &mut fx.states(&mut seen)).unwrap_err();
        assert!(matches!(err, LoomError::Parse(_)), "got {err:?}");

        assert_eq!(stages(&seen), vec!["assets", "core", "failed"]);
        let last = seen.last().unwrap();
        assert_eq!(last.stage, "failed");
        assert_eq!(
            last.outcome.as_deref(),
            Some("the core did not compile — the tail below says where; the running generation is untouched")
        );
        assert!(last.tail.iter().any(|l| l.contains("E0308")), "the tail carries the compiler's words: {:?}", last.tail);
        assert!(!last.cancellable);
        assert_eq!(&persisted(&fx.home), last);
        // Only assets and core were asked for; nothing was staged, swapped or launched.
        let stages_called: Vec<&str> = runner.calls.iter().map(|(s, _)| s.as_str()).collect();
        assert_eq!(stages_called, vec!["assets", "core"]);
        assert!(runner.detached.is_empty());
        assert!(!fx.home.generation_exe(&fx.head).exists());
        assert_eq!(generations::read(&fx.home), generations::Ledger::default());
        assert_eq!(std::fs::read_to_string(&fx.lay.exe_path).unwrap(), "old body");
        assert!(!fx.home.sentinel_json().exists());
        assert!(!fx.home.warden_json().exists());
    }

    #[test]
    fn start_refuses_when_not_threaded() {
        let err = check_start(false, Mode::Packaged, "aaa", Some("bbb"), false).unwrap_err();
        match err {
            LoomError::Parse(m) => assert!(m.contains("isn't threaded"), "msg was {m}"),
            other => panic!("expected Parse, got {other:?}"),
        }
        // force does not bypass threading; neither does dev mode.
        assert!(check_start(false, Mode::Packaged, "aaa", Some("bbb"), true).is_err());
        assert!(check_start(false, Mode::Dev, "aaa", None, true).is_err());
        assert!(check_start(true, Mode::Packaged, "aaa", Some("bbb"), false).is_ok());
    }

    #[test]
    fn start_refuses_when_head_equals_current_unless_force() {
        let err = check_start(true, Mode::Packaged, "aaa", Some("aaa"), false).unwrap_err();
        match err {
            LoomError::Parse(m) => assert!(m.contains("nothing new to weave"), "msg was {m}"),
            other => panic!("expected Parse, got {other:?}"),
        }
        assert!(check_start(true, Mode::Packaged, "aaa", Some("aaa"), true).is_ok(), "force weaves anyway");
        assert!(check_start(true, Mode::Packaged, "bbb", Some("aaa"), false).is_ok());
        // Generation 0 predates the ledger: the running body is the baked sha.
        let g0 = crate::loomhome::genome_sha();
        assert!(check_start(true, Mode::Packaged, g0, None, false).is_err());
        assert!(check_start(true, Mode::Packaged, "bbb", None, false).is_ok());
        // Dev never swaps, so the head/current rule does not apply.
        assert!(check_start(true, Mode::Dev, "aaa", Some("aaa"), false).is_ok());
    }

    #[test]
    fn cancel_refused_after_swap_begins() {
        let fx = fixture();
        let tools = fx.tools();
        let ctx = fx.ctx(Mode::Packaged, &tools);
        generations::write(&fx.home, &generations::Ledger {
            current: Some("aaa111".into()),
            previous: None,
            kept: vec!["aaa111".into()],
            keep: 3,
            confirmed: true,
        }).unwrap();
        fx.shelve("aaa111", "prev");
        fx.shelve(&fx.head.clone(), "next");
        let mut seen = Vec::new();
        let kind = Kind::Return { sha: fx.head.clone() };
        run_job(&ctx, kind, &mut ExecRunner, &mut fx.states(&mut seen)).unwrap();

        let before = seen.iter().find(|s| s.stage == "stage").expect("a stage state");
        assert!(before.cancellable);
        assert!(cancel_with(before).is_ok(), "before the swap, cancel is allowed");
        let swap = seen.iter().find(|s| s.stage == "swap").expect("a swap state");
        assert!(!swap.cancellable, "the swap is the point of return");
        match cancel_with(swap).unwrap_err() {
            LoomError::Parse(m) => assert_eq!(m, "past the point of return — the swap is under way"),
            other => panic!("expected Parse, got {other:?}"),
        }
        let relaunch = seen.iter().find(|s| s.stage == "relaunch").expect("a relaunch state");
        assert!(!relaunch.cancellable);
        assert!(cancel_with(relaunch).is_err());
        // Nothing running → nothing to cancel.
        let idle = ReweaveState { stage: "idle".into(), ..swap.clone() };
        assert!(cancel_with(&idle).is_err());
        let done = ReweaveState { stage: "done".into(), ..swap.clone() };
        assert!(cancel_with(&done).is_err());
    }

    #[test]
    fn return_skips_build_stages() {
        let fx = fixture();
        let tools = fx.tools();
        let ctx = fx.ctx(Mode::Packaged, &tools);
        // Two bodies on the shelf: the running one and an older one to return to.
        std::fs::write(fx.home.source().join("a.txt"), "two").unwrap();
        git(&["commit", "-qam", "two"], &fx.home.source());
        let newer = git(&["rev-parse", "HEAD"], &fx.home.source());
        let older = fx.head.clone();
        generations::write(&fx.home, &generations::Ledger {
            current: Some(newer.clone()),
            previous: Some(older.clone()),
            kept: vec![older.clone(), newer.clone()],
            keep: 3,
            confirmed: true,
        }).unwrap();
        fx.shelve(&newer, "newer body");
        fx.shelve(&older, "older body");

        let mut seen = Vec::new();
        let fin = run_job(&ctx, Kind::Return { sha: older.clone() }, &mut ExecRunner, &mut fx.states(&mut seen)).unwrap();
        let pid = match fin {
            Finish::Relaunching { warden_pid } => warden_pid,
            other => panic!("expected Relaunching, got {other:?}"),
        };
        assert!(pid > 0);

        // No assets, no core: the fake npm/cargo were never run.
        assert_eq!(stages(&seen), vec!["stage", "swap", "relaunch"]);
        assert!(fx.argv("npm").is_empty() && fx.argv("cargo").is_empty());
        assert_eq!(seen.last().unwrap().target_sha.as_deref(), Some(older.as_str()));
        assert_eq!(seen.last().unwrap().outcome.as_deref(), Some("LOOM will close and return in a moment"));

        // The genome agrees with the body: a branch generation/<sha7> at the sha,
        // and the newer commit is still on main.
        let src = fx.home.source();
        assert_eq!(git(&["rev-parse", "HEAD"], &src), older);
        assert_eq!(git(&["rev-parse", "--abbrev-ref", "HEAD"], &src), format!("generation/{}", &older[..7]));
        assert_eq!(git(&["rev-parse", "main"], &src), newer);

        // The swap happened: the live file is the older body, signed, sentinel
        // applied by reweave, ledger moved and unconfirmed.
        assert_eq!(std::fs::read_to_string(&fx.lay.exe_path).unwrap().contains("older body"), true);
        let sign = fx.argv("codesign");
        assert_eq!(sign, vec!["--force", "--deep", "--sign", "-", fx.lay.app_path.to_str().unwrap()]);
        let s: crate::kernel::Sentinel =
            serde_json::from_str(&std::fs::read_to_string(fx.home.sentinel_json()).unwrap()).unwrap();
        assert_eq!(s.status, "applied");
        assert_eq!(s.armed_by.as_deref(), Some("reweave"));
        assert_eq!(s.applied_sha, older);
        assert_eq!(s.prev_sha, newer);
        let ledger = generations::read(&fx.home);
        assert_eq!(ledger.current.as_deref(), Some(older.as_str()));
        assert_eq!(ledger.previous.as_deref(), Some(newer.as_str()));
        assert!(!ledger.confirmed);

        // The warden job file, camelCase, as Task 10's `warden::Job` reads it.
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(fx.home.warden_json()).unwrap()).unwrap();
        assert_eq!(v["oldPid"], std::process::id());
        assert_eq!(v["appPath"], fx.lay.app_path.to_str().unwrap());
        assert_eq!(v["exePath"], fx.lay.exe_path.to_str().unwrap());
        assert_eq!(v["newSha"], older);
        assert_eq!(v["prevSha"], newer);
        assert_eq!(v["loomhome"], fx.home.root.to_str().unwrap());
        assert_eq!(v["timeoutSecs"], 90);
        assert_eq!(v["relaunchOnly"], false);
        assert!(v.get("old_pid").is_none());

        // The PREVIOUS generation's body was launched as the warden with the
        // job file — detached, so it outlives us.
        let launched = fx.root.join("warden-launched.txt");
        let start = std::time::Instant::now();
        while !launched.exists() && start.elapsed() < std::time::Duration::from_secs(5) {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let argv: Vec<String> = std::fs::read_to_string(&launched).unwrap().lines().map(str::to_string).collect();
        assert_eq!(argv, vec!["--warden".to_string(), fx.home.warden_json().to_string_lossy().into_owned()]);
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert_eq!(std::fs::read_to_string(fx.root.join("warden-body.txt")).unwrap(), "newer body");
    }

    /// Round-1 review, Finding 7. The job slot was given back before the
    /// 1.5 s countdown, so a second swap could be planned on top of a
    /// just-armed one — with the sentinel and the ledger already naming a
    /// birth that had not happened yet. The handover keeps the slot.
    #[test]
    fn the_handover_keeps_the_slot_until_the_app_exits() {
        assert!(!releases_the_slot(&Ok(Finish::Relaunching { warden_pid: 42 })));
        // Every other ending gives it back: dev's built-and-shelved, and
        // every failure, cancel included.
        assert!(releases_the_slot(&Ok(Finish::Built)));
        assert!(releases_the_slot(&Err(LoomError::Parse("cancelled".into()))));
        assert!(releases_the_slot(&Err(LoomError::Unsupported(platform::UNSUPPORTED_SWAP.into()))));
    }

    #[test]
    fn return_refuses_an_absent_or_running_generation() {
        match check_return(false, Some("aaa"), "bbb").unwrap_err() {
            LoomError::NotFound(m) => assert!(m.contains("isn't on the shelf whole"), "msg was {m}"),
            other => panic!("expected NotFound, got {other:?}"),
        }
        match check_return(true, Some("aaa"), "aaa").unwrap_err() {
            LoomError::Parse(m) => assert_eq!(m, crate::platform::ALREADY_RUNNING),
            other => panic!("expected Parse, got {other:?}"),
        }
        assert!(check_return(true, Some("aaa"), "bbb").is_ok());
        assert!(check_return(true, None, "bbb").is_ok());
    }

    #[test]
    fn state_tail_is_capped_at_400() {
        let d = tempfile::tempdir().unwrap();
        let home = Home::at(d.path().join("loom"));
        let mut seen = Vec::new();
        {
            let mut emit = |s: &ReweaveState| seen.push(s.clone());
            let mut p = Progress::begin(&home, Mode::Dev, "abc", &mut emit);
            p.stage("core", true);
            for i in 1..=1000 {
                p.line(&format!("line{i}"));
            }
            p.stage("stage", true);
        };
        let final_state = seen.last().unwrap().clone();
        assert_eq!(final_state.tail.len(), TAIL_CAP);
        assert_eq!(final_state.tail.first().map(String::as_str), Some("line601"));
        assert_eq!(final_state.tail.last().map(String::as_str), Some("line1000"));
        // Persisted with the same cap, and the last emit matches.
        let on_disk = persisted(&home);
        assert_eq!(on_disk.tail.len(), TAIL_CAP);
        assert_eq!(&on_disk, seen.last().unwrap());
        assert!(seen.len() < 1000, "line pushes are throttled, not emitted one by one ({})", seen.len());
        assert!(seen.iter().all(|s| s.tail.len() <= TAIL_CAP));
        assert_eq!(on_disk.target_sha.as_deref(), Some("abc"));
    }

    // ── beyond the seven ──

    #[test]
    fn state_settles_when_no_job_is_alive() {
        let d = tempfile::tempdir().unwrap();
        let home = Home::at(d.path().join("loom"));
        std::fs::create_dir_all(&home.root).unwrap();
        // Absent → idle in the given mode.
        let idle = read_state(&home, Mode::Packaged);
        assert_eq!(idle.stage, "idle");
        assert_eq!(idle.mode, Mode::Packaged);
        assert!(!idle.cancellable && idle.outcome.is_none() && idle.target_sha.is_none());
        // Torn → idle too.
        std::fs::write(home.reweave_json(), "{ nope").unwrap();
        assert_eq!(read_state(&home, Mode::Dev).stage, "idle");

        let mid = ReweaveState { stage: "core".into(), cancellable: true, target_sha: Some("new".into()), ..idle.clone() };
        // A live job is reported as-is.
        assert_eq!(settle(mid.clone(), true, None), mid);
        // A job that this process never ran (LOOM quit mid-build) is a fact, not a live stage.
        let s = settle(mid.clone(), false, None);
        assert_eq!(s.stage, "failed");
        assert!(!s.cancellable);
        assert!(s.outcome.as_deref().unwrap().contains("interrupted"));
        // A relaunch record read by the body it was relaunching into → done.
        let rl = ReweaveState { stage: "relaunch".into(), cancellable: false, ..mid.clone() };
        let s = settle(rl.clone(), false, Some("new"));
        assert_eq!(s.stage, "done");
        assert!(s.outcome.as_deref().unwrap().contains("this is the generation"));
        // … read by the body the warden brought LOOM home to → failed, honestly.
        let s = settle(rl, false, Some("prev"));
        assert_eq!(s.stage, "failed");
        assert!(s.outcome.as_deref().unwrap().contains("came home"));
        // Terminal states are left alone.
        let done = ReweaveState { stage: "done".into(), ..mid };
        assert_eq!(settle(done.clone(), false, None), done);
    }
}
