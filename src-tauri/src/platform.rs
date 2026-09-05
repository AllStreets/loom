//! platform — the swap plan and its execution (Phase 23 / Rebirth).
//!
//! PROTECTED (kernel.rs `PROTECTED_RUST`): this module replaces the running
//! executable's file. If LOOM could edit it, it could swap in a body the
//! warden cannot return from.
//!
//! Two halves, deliberately separated (spec §Reweave, stage "swap"):
//!
//! - `swap_plan` is PURE. Given the app layout, the home, the running body and the
//!   sha to become, it returns the ordered list of `Step`s — or a typed
//!   refusal (`Unsupported` off macOS or when a body cannot name the
//!   generation it is, `Parse` when that generation is already running). The
//!   plan is enumerable, serializable, and unit-tested without touching a
//!   disk.
//! - `execute` walks a plan against the real filesystem. It is also what the
//!   warden (warden.rs) reuses to heal — the same executor, a shorter plan
//!   ending in `WriteSentinelHealed`.
//!
//! THE ORDERING RULE, and why (round-1 review Finding 1, corrected by round-2
//! review Finding 1). The sentinel and the ledger say different kinds of
//! thing, so they go on opposite sides of the copy:
//!
//! - the SENTINEL is what ARMS every healer, so it is written BEFORE the
//!   executable is replaced. Nothing may destroy the running body while
//!   nothing on disk can bring it back.
//! - the LEDGER is a CLAIM ABOUT WHICH BODY IS ON DISK, so it is written
//!   AFTER the executable is replaced. A ledger that names a body which is
//!   not there is a lie the next healthy `kernel_boot_ok` makes permanent —
//!   that call writes `confirmed: true` over whatever the ledger says — and a
//!   confirmed lie takes every route away: `reweave_start` answers "nothing
//!   new to weave", `generations_return` answers "already running", both
//!   about a body that is not on disk.
//!
//! 1. `EnsureCurrentKept` — generation 0 may predate the ledger; before the
//!    live body's file is overwritten, a copy of it must exist on the shelf,
//!    named in `kept`, or there is nothing to come home to and nothing in
//!    Settings offering the way back.
//! 2. `WriteSentinel` — `applied`, `armedBy: "reweave"`: the warden owns
//!    this birth (spec §Sentinel state machine). The healers are armed.
//! 3. `CopyExe` — `<to>.weaving` then `rename` over `to`. macOS permits
//!    replacing a running executable's file; the running process keeps its
//!    mapped image. The rename is atomic, so a crash mid-copy leaves the old
//!    body intact and a stray `.weaving` file, never a torn executable.
//! 4. `WriteLedger` — `current`/`previous` move, `confirmed: false` until
//!    `kernel_boot_ok` in the new body says otherwise. It follows the copy by
//!    two syscalls, not by a `codesign` subprocess.
//! 5. `Codesign` — ad-hoc re-sign of the bundle so Gatekeeper launches it.
//!
//! A death between 2 and 3 leaves the old body on disk, the ledger still
//! naming it, and the sentinel armed: the next boot heals to a body that is
//! already the right one — a no-op. A death between 3 and 4 leaves the new
//! body on disk with the ledger one generation behind it: the ledger LAGS,
//! and the swap is simply offered again (the genome is still ahead of what
//! the ledger calls current) and succeeds. That direction is survivable; the
//! opposite one is not, which is why the ledger never runs ahead of the file.
//! `survivable` below states the rule the tests judge every prefix by.
//!
//! The HEAL plan (warden.rs) obeys the same rule read the other way: there
//! `CopyExe` is the RESTORATIVE act, so the file goes back first, the ledger
//! records where it went, and only then is the terminal `healed` sentinel
//! written — a terminal state written over an unwritten ledger would wedge
//! the owner exactly as an early ledger does here.
//!
//! Every spawn goes through `exec::run_checked` (fixed argv, canonicalized cwd
//! inside an allowed root, no shell). The only tool here is `codesign`, whose
//! path comes from the threading manifest via the `tools` lookup.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::error::LoomError;
use crate::exec;
use crate::generations;
use crate::kernel::{self, Sentinel};
use crate::loomhome::Home;
// The plan no longer reads the ledger or the baked sha — the caller passes the
// running body in — so these are the tests' alone.
#[cfg(test)]
use crate::generations::Ledger;
#[cfg(test)]
use crate::loomhome;

// ── Layout ────────────────────────────────────────────────────────────────────

/// Where the running app lives on disk.
#[derive(Debug, Clone, PartialEq)]
pub struct AppLayout {
    /// `…/LOOM.app`
    pub app_path: PathBuf,
    /// `…/LOOM.app/Contents/MacOS/loom` — the file the swap replaces.
    pub exe_path: PathBuf,
}

/// The layout of THIS process's bundle, from `current_exe()`. `Unsupported`
/// when not inside a `.app` (dev) or not on macOS.
pub fn app_layout() -> Result<AppLayout, LoomError> {
    let exe = std::env::current_exe()
        .map_err(|e| LoomError::Unsupported(format!("current_exe: {e}")))?;
    layout_from_exe(&exe, std::env::consts::OS)
}

/// Pure: walk up from `exe` to the nearest `*.app` directory.
pub fn layout_from_exe(exe: &Path, os: &str) -> Result<AppLayout, LoomError> {
    if os != "macos" {
        return Err(LoomError::Unsupported(UNSUPPORTED_SWAP.into()));
    }
    let mut cur = exe.parent();
    while let Some(dir) = cur {
        if dir.extension().and_then(|e| e.to_str()) == Some("app") {
            return Ok(AppLayout { app_path: dir.to_path_buf(), exe_path: exe.to_path_buf() });
        }
        cur = dir.parent();
    }
    Err(LoomError::Unsupported(format!(
        "not inside an app bundle ({}) — in dev, restart tauri dev to load the core",
        exe.display()
    )))
}

// ── Plan ──────────────────────────────────────────────────────────────────────

/// One step of a swap (or a heal). Serializable so a plan can be logged to
/// `reweave.json` before it runs.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "step", rename_all = "camelCase")]
pub enum Step {
    /// Copy the live executable at `from` to `generations/<sha>/loom` if that
    /// file is absent — generation 0 may predate the ledger — and name it in
    /// the ledger's `kept`, which is what Settings reads.
    EnsureCurrentKept { sha: String, from: PathBuf },
    /// `<to>.weaving` ← `from`, then rename over `to`.
    CopyExe { from: PathBuf, to: PathBuf },
    /// `codesign --force --deep --sign - <path>`.
    Codesign { path: PathBuf },
    /// Sentinel `{ status: "applied", armedBy: "reweave" }`.
    WriteSentinel { applied: String, prev: String },
    /// Sentinel `{ status: "healed" }` — written by the warden (and the
    /// pre-main backstop) after a heal.
    WriteSentinelHealed { failed: String, prev: String },
    /// Ledger `{ current, previous, confirmed: false }`.
    WriteLedger { current: String, previous: String },
}

pub const UNSUPPORTED_SWAP: &str =
    "the swap is macOS-only in this generation — the build and the ledger still work";
pub const ALREADY_RUNNING: &str = "that generation is already running";
/// What `build.rs` bakes into a binary built outside a repo.
pub const UNKNOWN_SHA: &str = "unknown";
pub const UNKNOWN_GENERATION: &str =
    "this body cannot say which generation it is — it was built outside the genome, so there is no name to shelve it under and no way back to it; rebuild LOOM from a clone of the genome first";

/// Pure: the ordered steps that make `new_sha` the running body.
pub fn swap_plan(
    layout: &AppLayout,
    home: &Home,
    new_sha: &str,
    os: &str,
    running: &str,
) -> Result<Vec<Step>, LoomError> {
    if os != "macos" {
        return Err(LoomError::Unsupported(UNSUPPORTED_SWAP.into()));
    }
    // WHAT IS RUNNING IS THE BAKED SHA, which the caller passes in.
    //
    // Round-3 review: the ledger is a claim about what is on disk and is
    // allowed to LAG the body (see `survivable` below), while `genome_sha()` is
    // compiled into the executing binary and cannot be wrong about which body
    // this is. Reading `ledger.current` here shelved the live executable under
    // whatever name the ledger happened to hold, and wrote that name into the
    // sentinel as `prev` — the sha a healer comes home to. Injected rather than
    // read so the plan stays a pure function of its inputs.
    let current = running.to_string();
    // `build.rs` bakes `unknown` for a build made outside a repo, and
    // `unknown` is not a sha: `generations_return` refuses it, so a body
    // shelved under that name could never be come home to (round-2 review,
    // Finding 7). Refuse the whole swap here, before anything is copied,
    // rather than destroy the running body for a way back that cannot be
    // spelled.
    if current == UNKNOWN_SHA || new_sha == UNKNOWN_SHA {
        return Err(LoomError::Unsupported(UNKNOWN_GENERATION.into()));
    }
    if new_sha == current {
        return Err(LoomError::Parse(ALREADY_RUNNING.into()));
    }
    Ok(vec![
        Step::EnsureCurrentKept { sha: current.clone(), from: layout.exe_path.clone() },
        Step::WriteSentinel { applied: new_sha.to_string(), prev: current.clone() },
        Step::CopyExe { from: home.generation_exe(new_sha), to: layout.exe_path.clone() },
        Step::WriteLedger { current: new_sha.to_string(), previous: current.clone() },
        Step::Codesign { path: layout.app_path.clone() },
    ])
}

// ── Execute ───────────────────────────────────────────────────────────────────

/// Walk a plan against the filesystem. `tools` resolves a tool name (only
/// `codesign` here) to its recorded path; `None` refuses with `NotFound`.
pub fn execute(
    plan: &[Step],
    home: &Home,
    tools: &dyn Fn(&str) -> Option<PathBuf>,
) -> Result<(), LoomError> {
    for step in plan {
        match step {
            Step::EnsureCurrentKept { sha, from } => {
                // A body that is present but cut short is not a way home
                // (round-1 review, Finding 8): re-shelve it from the live one.
                if !generations::shelved_whole(home, sha) {
                    copy_atomic(from, &home.generation_exe(sha))?;
                }
                // And a shelved body the ledger does not name is invisible to
                // `generations_list`, so Settings — the protected road home —
                // cannot offer it (round-2 review, Finding 5).
                generations::keep(home, sha)?;
            }
            Step::CopyExe { from, to } => copy_atomic(from, to)?,
            Step::Codesign { path } => codesign(path, tools)?,
            Step::WriteSentinel { applied, prev } => {
                write_sentinel(home, "applied", applied, prev)?
            }
            Step::WriteSentinelHealed { failed, prev } => {
                write_sentinel(home, "healed", failed, prev)?
            }
            Step::WriteLedger { current, previous } => {
                let mut ledger = generations::read(home);
                ledger.current = Some(current.clone());
                ledger.previous = Some(previous.clone());
                ledger.confirmed = false;
                generations::write(home, &ledger)?;
            }
        }
    }
    Ok(())
}

fn io_err(what: &str, path: &Path, e: std::io::Error) -> LoomError {
    LoomError::Git(format!("{what} {}: {e}", path.display()))
}

/// `<to>.weaving` ← `from` (mode bits carried by `fs::copy`, then set
/// explicitly so the body stays executable), flushed to the platter, then
/// renamed over `to`. A crash before the rename leaves `to` untouched.
/// `pub(crate)` so the shelf (generations.rs) copies a body exactly the way
/// the swap does.
///
/// The `sync_all` is not a nicety (round-2 review, Finding 6): the rename is
/// atomic in the directory, but the bytes it names need not have reached the
/// disk. Lose power in that gap and the file is the right SIZE — so
/// `shelved_whole`'s length check passes it — while holding whatever the
/// filesystem had not written yet. A body that passes the check and does not
/// run is worse than one that is visibly cut short.
pub(crate) fn copy_atomic(from: &Path, to: &Path) -> Result<(), LoomError> {
    if !from.is_file() {
        return Err(LoomError::NotFound(format!("executable: {}", from.display())));
    }
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(|e| io_err("create", parent, e))?;
    }
    let mut staged = to.as_os_str().to_owned();
    staged.push(".weaving");
    let staged = Path::new(&staged);
    let flushed = (|| -> std::io::Result<()> {
        std::fs::copy(from, staged)?;
        let perms = std::fs::metadata(from)?.permissions();
        std::fs::set_permissions(staged, perms)?;
        std::fs::OpenOptions::new().write(true).open(staged)?.sync_all()
    })();
    if let Err(e) = flushed {
        let _ = std::fs::remove_file(staged);
        return Err(io_err("stage", staged, e));
    }
    std::fs::rename(staged, to).map_err(|e| {
        let _ = std::fs::remove_file(staged);
        io_err("rename", to, e)
    })
}

/// Ad-hoc re-sign of a bundle: fixed argv, cwd and root = the bundle's
/// parent. The tool path comes from the threading manifest; absent → refused.
fn codesign(path: &Path, tools: &dyn Fn(&str) -> Option<PathBuf>) -> Result<(), LoomError> {
    let tool = tools("codesign").ok_or_else(|| {
        LoomError::NotFound("codesign — thread the loom first, it records the tool".into())
    })?;
    let root = path
        .parent()
        .ok_or_else(|| LoomError::NotFound(format!("parent of {}", path.display())))?;
    let tool = tool.to_string_lossy().into_owned();
    let target = path.to_string_lossy().into_owned();
    let argv = [tool.as_str(), "--force", "--deep", "--sign", "-", target.as_str()];
    let out = exec::run_checked(&argv, root, root, Duration::from_secs(120))?;
    if out.code != 0 {
        // No claim about the running generation here: this runs at the end of
        // a swap (the file is already the new body), at the end of a heal, and
        // over a shelved body at `stage`. Each caller adds its own context.
        return Err(LoomError::Git(format!(
            "codesign exited {} — the body is unsigned: {}",
            out.code,
            out.stderr.trim()
        )));
    }
    Ok(())
}

fn write_sentinel(home: &Home, status: &str, applied: &str, prev: &str) -> Result<(), LoomError> {
    kernel::write_sentinel_at(
        &home.sentinel_json(),
        &Sentinel {
            prev_sha: prev.to_string(),
            applied_sha: applied.to_string(),
            status: status.to_string(),
            source_root: home.source().to_string_lossy().into_owned(),
            armed_by: Some("reweave".into()),
        },
    )
}

// ── The invariant, judged ─────────────────────────────────────────────────────

/// THE INVARIANT (round-2 review, Findings 1–3), in one place so the swap and
/// the heal are judged by the same rule.
///
/// The sentinel is what ARMS every healer, so it is written BEFORE the
/// executable is replaced. The ledger is a CLAIM ABOUT WHICH BODY IS ON DISK,
/// so it is written AFTER the executable is replaced.
///
/// A plan is executed by a process that can die between any two steps. After
/// every prefix the disk must answer two questions:
///
/// 1 · Can LOOM come home? Either the file at `exe_path` is already the body
///     that is proven (`home_to`), or something on disk arms a healer and the
///     shelf holds that body.
/// 2 · Does the ledger tell the truth? `current` is a claim about which body
///     is on disk. It may LAG the file — a copy and a ledger write are two
///     files, and nothing makes them one — but only while a healer is still
///     armed to finish or undo the move and write the ledger either way. It
///     may NEVER LEAD it. A ledger naming a body that is not there is a lie
///     the next healthy `kernel_boot_ok` makes permanent: that call writes
///     `confirmed: true` over whatever the ledger says, and a confirmed lie
///     takes every route away — `reweave_start` answers "nothing new to weave
///     — the body already matches the genome" and `generations_return`
///     answers "that generation is already running", both about a body that
///     is not on disk.
///
/// `on_disk` is the generation whose body is the file at `exe_path` right
/// now; `was` is the one it held before the plan started; `home_to` is the
/// proven body a healer would restore.
#[cfg(test)]
pub(crate) fn survivable(
    home: &Home,
    on_disk: &str,
    was: &str,
    home_to: &str,
) -> Result<(), String> {
    let armed = kernel::read_sentinel(&home.sentinel_json()).filter(|s| {
        kernel::is_unconfirmed(&s.status) && s.armed_by.as_deref() == Some("reweave")
    });
    // 1 · a way home.
    if on_disk != home_to {
        let s = armed
            .as_ref()
            .ok_or("the body on disk is not the proven one and nothing on disk arms a healer")?;
        if s.prev_sha != home_to {
            return Err(format!("the sentinel would come home to {}, not {home_to}", s.prev_sha));
        }
        if !home.generation_exe(home_to).is_file() {
            return Err(format!("{home_to} is not on the shelf — there is nothing to come home to"));
        }
    }
    // 2 · a ledger that does not lie.
    let claim = generations::read(home).current.unwrap_or_default();
    if claim == on_disk {
        return Ok(());
    }
    if claim != was {
        return Err(format!(
            "the ledger calls {claim} current and the body on disk is {on_disk} — it names a body that is not there"
        ));
    }
    if armed.is_none() {
        return Err(format!(
            "the ledger still calls {claim} current, the body on disk is {on_disk}, and nothing is armed to correct it"
        ));
    }
    Ok(())
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn layout(root: &Path) -> AppLayout {
        let app_path = root.join("LOOM.app");
        AppLayout { exe_path: app_path.join("Contents/MacOS/loom"), app_path }
    }

    fn ledger(current: Option<&str>, previous: Option<&str>) -> Ledger {
        Ledger {
            current: current.map(str::to_string),
            previous: previous.map(str::to_string),
            kept: current.into_iter().chain(previous).map(str::to_string).collect(),
            keep: 3,
            confirmed: true,
        }
    }

    // ── layout ──

    #[test]
    fn layout_walks_up_to_the_app_bundle() {
        let exe = Path::new("/Applications/LOOM.app/Contents/MacOS/loom");
        let l = layout_from_exe(exe, "macos").unwrap();
        assert_eq!(l.app_path, Path::new("/Applications/LOOM.app"));
        assert_eq!(l.exe_path, exe);
        // Nested bundles resolve to the NEAREST .app — the one this exe is in.
        let inner = Path::new("/x/Outer.app/Contents/Helpers/Inner.app/Contents/MacOS/h");
        assert_eq!(
            layout_from_exe(inner, "macos").unwrap().app_path,
            Path::new("/x/Outer.app/Contents/Helpers/Inner.app")
        );
    }

    #[test]
    fn layout_refuses_outside_a_bundle() {
        let dev = Path::new("/repo/src-tauri/target/debug/loom");
        assert!(matches!(layout_from_exe(dev, "macos"), Err(LoomError::Unsupported(_))));
        // A directory merely NAMED like an app in the middle of a filename
        // does not count — the component must end in `.app`.
        let odd = Path::new("/repo/appish/target/loom");
        assert!(matches!(layout_from_exe(odd, "macos"), Err(LoomError::Unsupported(_))));
        // Off macOS, even a bundle-shaped path is refused.
        let exe = Path::new("/Applications/LOOM.app/Contents/MacOS/loom");
        assert!(matches!(layout_from_exe(exe, "linux"), Err(LoomError::Unsupported(_))));
    }

    // ── plan ──

    #[test]
    fn plan_first_swap_keeps_current_first() {
        let d = tempfile::tempdir().unwrap();
        let home = Home::at(d.path().join("loom"));
        let lay = layout(d.path());
        let led = ledger(Some("aaa111"), None);
        let plan = swap_plan(&lay, &home, "bbb222", "macos", "aaa111").unwrap();
        // The sentinel — which arms every healer — is written BEFORE the body
        // is replaced; the ledger — which claims which body is on disk — is
        // written AFTER it (round-2 review, Finding 1).
        assert_eq!(
            plan,
            vec![
                Step::EnsureCurrentKept { sha: "aaa111".into(), from: lay.exe_path.clone() },
                Step::WriteSentinel { applied: "bbb222".into(), prev: "aaa111".into() },
                Step::CopyExe { from: home.generation_exe("bbb222"), to: lay.exe_path.clone() },
                Step::WriteLedger { current: "bbb222".into(), previous: "aaa111".into() },
                Step::Codesign { path: lay.app_path.clone() },
            ]
        );
        // The ledger follows the copy by two syscalls, not by a `codesign`
        // subprocess: the window in which the two disagree is as short as two
        // separate files can make it.
        assert_eq!(
            plan.iter().position(|s| matches!(s, Step::WriteLedger { .. })),
            plan.iter().position(|s| matches!(s, Step::CopyExe { .. })).map(|i| i + 1)
        );
        // Generation 0 predates the ledger: no `current` on file, so the
        // running body is named by the sha baked into this binary.
        let g0 = loomhome::genome_sha().to_string();
        let plan0 = swap_plan(&lay, &home, "bbb222", "macos", &g0).unwrap();
        let g0 = loomhome::genome_sha().to_string();
        assert_eq!(plan0[0], Step::EnsureCurrentKept { sha: g0.clone(), from: lay.exe_path.clone() });
        assert_eq!(plan0[1], Step::WriteSentinel { applied: "bbb222".into(), prev: g0.clone() });
        assert_eq!(plan0[3], Step::WriteLedger { current: "bbb222".into(), previous: g0 });
        // The plan is serializable — it is logged before it runs.
        let v = serde_json::to_value(&plan).unwrap();
        assert_eq!(v[0]["step"], "ensureCurrentKept");
        assert_eq!(v[1]["step"], "writeSentinel");
        assert_eq!(v[2]["step"], "copyExe");
        assert_eq!(v[3]["step"], "writeLedger");
    }

    #[test]
    fn plan_rejects_same_sha() {
        let d = tempfile::tempdir().unwrap();
        let home = Home::at(d.path().join("loom"));
        let lay = layout(d.path());
        let err = swap_plan(&lay, &home, "aaa111", "macos", "aaa111").unwrap_err();
        match err {
            LoomError::Parse(m) => assert_eq!(m, ALREADY_RUNNING),
            other => panic!("expected Parse, got {other:?}"),
        }
        // Same rule for generation 0 — the baked sha is what is running.
        let g0 = loomhome::genome_sha();
        assert!(matches!(
            swap_plan(&lay, &home, g0, "macos", g0),
            Err(LoomError::Parse(_))
        ));
    }

    /// Round-2 review, Finding 7. `build.rs` bakes `unknown` for a build made
    /// outside a repo. `unknown` is not a sha, so `generations_return` refuses
    /// it (`is_sha`) and the body shelved under that name can never be come
    /// home to. The swap refuses at the plan, before anything is copied,
    /// rather than shelving a body under a name the road home cannot spell.
    #[test]
    fn plan_refuses_a_body_that_cannot_name_itself() {
        let d = tempfile::tempdir().unwrap();
        let home = Home::at(d.path().join("loom"));
        let lay = layout(d.path());
        // Generation 0 outside a repo: no ledger, and the baked sha is
        // `unknown`, so the running body has no name to be shelved under.
        let unnamed = Ledger { current: Some(UNKNOWN_SHA.into()), ..Ledger::default() };
        match swap_plan(&lay, &home, "bbb222", "macos", UNKNOWN_SHA) {
            Err(LoomError::Unsupported(m)) => assert_eq!(m, UNKNOWN_GENERATION),
            other => panic!("expected Unsupported, got {other:?}"),
        }
        // Neither may a body be woven INTO a generation with no name.
        assert!(matches!(
            swap_plan(&lay, &home, UNKNOWN_SHA, "macos", "aaa111"),
            Err(LoomError::Unsupported(_))
        ));
        // A named body is unaffected.
        assert!(swap_plan(&lay, &home, "bbb222", "macos", "aaa111").is_ok());
    }

    #[test]
    fn plan_unsupported_off_macos() {
        let d = tempfile::tempdir().unwrap();
        let home = Home::at(d.path().join("loom"));
        let lay = layout(d.path());
        for os in ["linux", "windows", ""] {
            match swap_plan(&lay, &home, "bbb222", os, "aaa111") {
                Err(LoomError::Unsupported(m)) => assert_eq!(m, UNSUPPORTED_SWAP, "os={os}"),
                other => panic!("os={os}: expected Unsupported, got {other:?}"),
            }
        }
    }

    // ── execute ──

    struct Fake {
        _dir: tempfile::TempDir,
        home: Home,
        lay: AppLayout,
        argv_file: PathBuf,
        codesign: PathBuf,
    }

    impl Fake {
        fn tools(&self) -> impl Fn(&str) -> Option<PathBuf> + '_ {
            move |name: &str| (name == "codesign").then(|| self.codesign.clone())
        }
        fn exe_content(&self) -> String {
            std::fs::read_to_string(&self.lay.exe_path).unwrap()
        }
    }

    /// A fake `.app` tree with an "old body" executable, a shelved "new body"
    /// generation, and a fake `codesign` that records its argv to a file.
    fn fake_app(current: &str, new: &str) -> Fake {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let home = Home::at(root.join("loom"));
        std::fs::create_dir_all(home.root.clone()).unwrap();
        let lay = layout(&root);
        std::fs::create_dir_all(lay.exe_path.parent().unwrap()).unwrap();
        std::fs::write(&lay.exe_path, "old body").unwrap();
        std::fs::set_permissions(&lay.exe_path, std::fs::Permissions::from_mode(0o755)).unwrap();
        let new_exe = home.generation_exe(new);
        std::fs::create_dir_all(new_exe.parent().unwrap()).unwrap();
        std::fs::write(&new_exe, "new body").unwrap();
        std::fs::set_permissions(&new_exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        generations::write(&home, &ledger(Some(current), None)).unwrap();

        let argv_file = root.join("codesign-argv.txt");
        let codesign = root.join("bin").join("codesign");
        std::fs::create_dir_all(codesign.parent().unwrap()).unwrap();
        std::fs::write(
            &codesign,
            format!("#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\n", argv_file.display()),
        )
        .unwrap();
        std::fs::set_permissions(&codesign, std::fs::Permissions::from_mode(0o755)).unwrap();
        Fake { _dir: dir, home, lay, argv_file, codesign }
    }

    #[test]
    fn execute_replaces_exe_atomically() {
        let f = fake_app("aaa111", "bbb222");
        let led = generations::read(&f.home);
        let plan = swap_plan(&f.lay, &f.home, "bbb222", "macos", "aaa111").unwrap();
        execute(&plan, &f.home, &f.tools()).unwrap();

        // The file changed, in place, and no `.weaving` staging file remains.
        assert_eq!(f.exe_content(), "new body");
        let dir_entries: Vec<String> = std::fs::read_dir(f.lay.exe_path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(dir_entries, vec!["loom".to_string()], "no .weaving may remain");
        // Executable bits survived the copy.
        let mode = std::fs::metadata(&f.lay.exe_path).unwrap().permissions().mode();
        assert_eq!(mode & 0o111, 0o111, "mode {mode:o} lost its exec bits");
        // The current body was shelved BEFORE it was overwritten.
        assert_eq!(std::fs::read_to_string(f.home.generation_exe("aaa111")).unwrap(), "old body");
        // codesign ran with the fixed argv against the bundle.
        let argv = std::fs::read_to_string(&f.argv_file).unwrap();
        let lines: Vec<&str> = argv.lines().collect();
        assert_eq!(lines, vec!["--force", "--deep", "--sign", "-", f.lay.app_path.to_str().unwrap()]);
        // The ledger moved and is unconfirmed until the new body boots ok.
        let after = generations::read(&f.home);
        assert_eq!(after.current.as_deref(), Some("bbb222"));
        assert_eq!(after.previous.as_deref(), Some("aaa111"));
        assert!(!after.confirmed);
        // The shelved body is NAMED in the ledger, or Settings cannot offer
        // the way back to it (round-2 review, Finding 5). `current`/`previous`
        // are still the swap's business alone.
        assert_eq!(after.kept, vec!["aaa111".to_string()]);
    }

    /// Round-1 review, Finding 1; round-2 review, Findings 1 and 3. The plan
    /// is executed by a process that can die at any point — a `codesign` that
    /// hangs, an owner who force-quits, a panic. After EVERY prefix the disk
    /// must still be survivable, by both halves of the rule `survivable`
    /// states: a healer can act, AND the ledger's `current` names the body
    /// actually on disk (or lags it while a healer is armed — never leads it).
    #[test]
    fn execute_interrupted_after_each_step_leaves_a_way_home() {
        let steps = {
            let f = fake_app("aaa111", "bbb222");
            swap_plan(&f.lay, &f.home, "bbb222", "macos", "aaa111").unwrap().len()
        };
        for k in 0..=steps {
            let f = fake_app("aaa111", "bbb222");
            let plan = swap_plan(&f.lay, &f.home, "bbb222", "macos", "aaa111").unwrap();
            execute(&plan[..k], &f.home, &f.tools()).unwrap();
            let on_disk = if f.exe_content() == "old body" { "aaa111" } else { "bbb222" };
            if let Err(why) = survivable(&f.home, on_disk, "aaa111", "aaa111") {
                panic!("killed after {k} of {steps} step(s): {why}");
            }
        }
    }

    /// Round-1 review, Finding 1 (the inner sentence). `codesign` runs AFTER
    /// the file is replaced, so its failure may not claim the running
    /// generation is untouched.
    #[test]
    fn codesign_failure_does_not_claim_the_body_is_untouched() {
        let f = fake_app("aaa111", "bbb222");
        std::fs::write(&f.codesign, "#!/bin/sh\necho 'refused' >&2\nexit 1\n").unwrap();
        std::fs::set_permissions(&f.codesign, std::fs::Permissions::from_mode(0o755)).unwrap();
        let plan = swap_plan(&f.lay, &f.home, "bbb222", "macos", "aaa111").unwrap();
        let err = execute(&plan, &f.home, &f.tools()).unwrap_err().to_string();
        assert!(err.contains("unsigned"), "the fact is the missing signature: {err}");
        assert!(
            !err.contains("untouched"),
            "the body was already replaced when codesign ran — the sentence must not say otherwise: {err}"
        );
        assert_eq!(f.exe_content(), "new body", "the swap reached codesign");
    }

    #[test]
    fn execute_keeps_current_only_if_absent() {
        let f = fake_app("aaa111", "bbb222");
        let shelved = f.home.generation_exe("aaa111");
        std::fs::create_dir_all(shelved.parent().unwrap()).unwrap();
        std::fs::write(&shelved, "already shelved").unwrap();
        let step = Step::EnsureCurrentKept { sha: "aaa111".into(), from: f.lay.exe_path.clone() };
        execute(&[step], &f.home, &f.tools()).unwrap();
        assert_eq!(std::fs::read_to_string(&shelved).unwrap(), "already shelved");
    }

    /// Round-2 review, Finding 5. The step copies the running body to the
    /// shelf; until the ledger NAMES it, `generations_list` cannot see it and
    /// Settings — the protected road home — has nothing to offer. On a first
    /// weave that body is the only way back there is.
    #[test]
    fn execute_names_the_body_it_shelves() {
        let f = fake_app("aaa111", "bbb222");
        // Generation 0: the ledger knows what is running and has never
        // shelved anything.
        generations::write(
            &f.home,
            &Ledger { current: Some("aaa111".into()), previous: None, kept: vec![], keep: 3, confirmed: true },
        )
        .unwrap();
        let step = Step::EnsureCurrentKept { sha: "aaa111".into(), from: f.lay.exe_path.clone() };
        execute(std::slice::from_ref(&step), &f.home, &f.tools()).unwrap();
        assert_eq!(generations::read(&f.home).kept, vec!["aaa111".to_string()]);
        assert_eq!(generations::list(&f.home).unwrap()[0].sha, "aaa111");
        // Twice is once: the running body is not news.
        execute(&[step], &f.home, &f.tools()).unwrap();
        assert_eq!(generations::read(&f.home).kept, vec!["aaa111".to_string()]);
    }

    /// Round-1 review, Finding 8. A shelved body cut short by an earlier
    /// crash is not a way home: the step re-shelves it from the live one.
    #[test]
    fn execute_reshelves_a_body_cut_short() {
        let f = fake_app("aaa111", "bbb222");
        let src = f.home.root.join("built-loom");
        std::fs::write(&src, "old body").unwrap();
        std::fs::set_permissions(&src, std::fs::Permissions::from_mode(0o755)).unwrap();
        generations::record(&f.home, "aaa111", &src, "reweave").unwrap();
        // The crash: half a body on the shelf, its meta still naming the size.
        std::fs::write(f.home.generation_exe("aaa111"), "old").unwrap();

        let step = Step::EnsureCurrentKept { sha: "aaa111".into(), from: f.lay.exe_path.clone() };
        execute(&[step], &f.home, &f.tools()).unwrap();
        assert_eq!(std::fs::read_to_string(f.home.generation_exe("aaa111")).unwrap(), "old body");
    }

    #[test]
    fn execute_writes_sentinel_applied_by_reweave() {
        let f = fake_app("aaa111", "bbb222");
        let step = Step::WriteSentinel { applied: "bbb222".into(), prev: "aaa111".into() };
        execute(&[step], &f.home, &f.tools()).unwrap();
        let raw = std::fs::read_to_string(f.home.sentinel_json()).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["status"], "applied");
        assert_eq!(v["armedBy"], "reweave");
        assert_eq!(v["applied_sha"], "bbb222");
        assert_eq!(v["prev_sha"], "aaa111");
        assert_eq!(v["source_root"], f.home.source().to_string_lossy().as_ref());
        // It parses back as the kernel's own Sentinel and reads as unconfirmed.
        let s: Sentinel = serde_json::from_str(&raw).unwrap();
        assert!(kernel::is_unconfirmed(&s.status));
        assert_eq!(s.armed_by.as_deref(), Some("reweave"));
    }

    #[test]
    fn execute_writes_sentinel_healed_after_a_heal() {
        let f = fake_app("aaa111", "bbb222");
        let step = Step::WriteSentinelHealed { failed: "bbb222".into(), prev: "aaa111".into() };
        execute(&[step], &f.home, &f.tools()).unwrap();
        let raw = std::fs::read_to_string(f.home.sentinel_json()).unwrap();
        let s: Sentinel = serde_json::from_str(&raw).unwrap();
        assert_eq!(s.status, "healed");
        assert_eq!(s.applied_sha, "bbb222");
        assert_eq!(s.prev_sha, "aaa111");
        assert_eq!(s.armed_by.as_deref(), Some("reweave"));
        assert!(!kernel::is_unconfirmed(&s.status), "healed is terminal");
    }

    #[test]
    fn execute_codesign_without_a_tool_is_not_found_and_leaves_the_exe() {
        let f = fake_app("aaa111", "bbb222");
        let step = Step::Codesign { path: f.lay.app_path.clone() };
        let none = |_: &str| None::<PathBuf>;
        assert!(matches!(execute(&[step], &f.home, &none), Err(LoomError::NotFound(_))));
        assert_eq!(f.exe_content(), "old body");
        assert!(!f.argv_file.exists());
    }

    #[test]
    fn execute_stops_at_the_first_failing_step() {
        let f = fake_app("aaa111", "bbb222");
        let plan = vec![
            Step::CopyExe { from: f.home.generation_exe("nope"), to: f.lay.exe_path.clone() },
            Step::WriteSentinel { applied: "bbb222".into(), prev: "aaa111".into() },
        ];
        assert!(execute(&plan, &f.home, &f.tools()).is_err());
        assert_eq!(f.exe_content(), "old body", "a failed copy leaves the old body intact");
        assert!(!f.home.sentinel_json().exists(), "later steps must not run");
    }
}
