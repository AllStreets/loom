//! platform — the swap plan and its execution (Phase 23 / Rebirth).
//!
//! PROTECTED (kernel.rs `PROTECTED_RUST`): this module replaces the running
//! executable's file. If LOOM could edit it, it could swap in a body the
//! warden cannot return from.
//!
//! Two halves, deliberately separated (spec §Reweave, stage "swap"):
//!
//! - `swap_plan` is PURE. Given the ledger, the app layout, the home, and the
//!   sha to become, it returns the ordered list of `Step`s — or a typed
//!   refusal (`Unsupported` off macOS, `Parse` when that generation is already
//!   running). The plan is enumerable, serializable, and unit-tested without
//!   touching a disk.
//! - `execute` walks a plan against the real filesystem. It is also what the
//!   warden (warden.rs) reuses to heal — the same executor, a shorter plan
//!   ending in `WriteSentinelHealed`.
//!
//! Ordering of the swap plan, and why:
//!
//! 1. `EnsureCurrentKept` — generation 0 may predate the ledger; before the
//!    live body's file is overwritten, a copy of it must exist on the shelf
//!    or there is nothing to come home to.
//! 2. `CopyExe` — `<to>.weaving` then `rename` over `to`. macOS permits
//!    replacing a running executable's file; the running process keeps its
//!    mapped image. The rename is atomic, so a crash mid-copy leaves the old
//!    body intact and a stray `.weaving` file, never a torn executable.
//! 3. `Codesign` — ad-hoc re-sign of the bundle so Gatekeeper launches it.
//! 4. `WriteSentinel` — `applied`, `armedBy: "reweave"`: the warden owns
//!    this birth (spec §Sentinel state machine).
//! 5. `WriteLedger` — `current`/`previous` move, `confirmed: false` until
//!    `kernel_boot_ok` in the new body says otherwise.
//!
//! Every spawn goes through `exec::run_checked` (fixed argv, canonicalized cwd
//! inside an allowed root, no shell). The only tool here is `codesign`, whose
//! path comes from the threading manifest via the `tools` lookup.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::error::LoomError;
use crate::exec;
use crate::generations::{self, Ledger};
use crate::kernel::{self, Sentinel};
use crate::loomhome::{self, Home};

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
    /// file is absent — generation 0 may predate the ledger.
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

/// Pure: the ordered steps that make `new_sha` the running body.
pub fn swap_plan(
    ledger: &Ledger,
    layout: &AppLayout,
    home: &Home,
    new_sha: &str,
    os: &str,
) -> Result<Vec<Step>, LoomError> {
    if os != "macos" {
        return Err(LoomError::Unsupported(UNSUPPORTED_SWAP.into()));
    }
    // Generation 0 predates the ledger: what is running is the sha baked into
    // this binary, not a `current` on file.
    let current = ledger
        .current
        .clone()
        .unwrap_or_else(|| loomhome::genome_sha().to_string());
    if new_sha == current {
        return Err(LoomError::Parse(ALREADY_RUNNING.into()));
    }
    Ok(vec![
        Step::EnsureCurrentKept { sha: current.clone(), from: layout.exe_path.clone() },
        Step::CopyExe { from: home.generation_exe(new_sha), to: layout.exe_path.clone() },
        Step::Codesign { path: layout.app_path.clone() },
        Step::WriteSentinel { applied: new_sha.to_string(), prev: current.clone() },
        Step::WriteLedger { current: new_sha.to_string(), previous: current },
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
                let dest = home.generation_exe(sha);
                if !dest.is_file() {
                    copy_atomic(from, &dest)?;
                }
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
/// explicitly so the body stays executable), then rename over `to`. A crash
/// before the rename leaves `to` untouched.
fn copy_atomic(from: &Path, to: &Path) -> Result<(), LoomError> {
    if !from.is_file() {
        return Err(LoomError::NotFound(format!("executable: {}", from.display())));
    }
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(|e| io_err("create", parent, e))?;
    }
    let mut staged = to.as_os_str().to_owned();
    staged.push(".weaving");
    let staged = Path::new(&staged);
    std::fs::copy(from, staged).map_err(|e| io_err("copy", staged, e))?;
    let perms = std::fs::metadata(from).map_err(|e| io_err("stat", from, e))?.permissions();
    std::fs::set_permissions(staged, perms).map_err(|e| io_err("chmod", staged, e))?;
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
        return Err(LoomError::Git(format!(
            "codesign exited {} — the body is unsigned; the running generation is untouched: {}",
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
        let plan = swap_plan(&led, &lay, &home, "bbb222", "macos").unwrap();
        assert_eq!(
            plan,
            vec![
                Step::EnsureCurrentKept { sha: "aaa111".into(), from: lay.exe_path.clone() },
                Step::CopyExe { from: home.generation_exe("bbb222"), to: lay.exe_path.clone() },
                Step::Codesign { path: lay.app_path.clone() },
                Step::WriteSentinel { applied: "bbb222".into(), prev: "aaa111".into() },
                Step::WriteLedger { current: "bbb222".into(), previous: "aaa111".into() },
            ]
        );
        // Generation 0 predates the ledger: no `current` on file, so the
        // running body is named by the sha baked into this binary.
        let plan0 = swap_plan(&Ledger::default(), &lay, &home, "bbb222", "macos").unwrap();
        let g0 = loomhome::genome_sha().to_string();
        assert_eq!(plan0[0], Step::EnsureCurrentKept { sha: g0.clone(), from: lay.exe_path.clone() });
        assert_eq!(plan0[3], Step::WriteSentinel { applied: "bbb222".into(), prev: g0.clone() });
        assert_eq!(plan0[4], Step::WriteLedger { current: "bbb222".into(), previous: g0 });
        // The plan is serializable — it is logged before it runs.
        let v = serde_json::to_value(&plan).unwrap();
        assert_eq!(v[0]["step"], "ensureCurrentKept");
        assert_eq!(v[3]["step"], "writeSentinel");
    }

    #[test]
    fn plan_rejects_same_sha() {
        let d = tempfile::tempdir().unwrap();
        let home = Home::at(d.path().join("loom"));
        let lay = layout(d.path());
        let err = swap_plan(&ledger(Some("aaa111"), None), &lay, &home, "aaa111", "macos").unwrap_err();
        match err {
            LoomError::Parse(m) => assert_eq!(m, ALREADY_RUNNING),
            other => panic!("expected Parse, got {other:?}"),
        }
        // Same rule for generation 0 — the baked sha is what is running.
        let g0 = loomhome::genome_sha();
        assert!(matches!(
            swap_plan(&Ledger::default(), &lay, &home, g0, "macos"),
            Err(LoomError::Parse(_))
        ));
    }

    #[test]
    fn plan_unsupported_off_macos() {
        let d = tempfile::tempdir().unwrap();
        let home = Home::at(d.path().join("loom"));
        let lay = layout(d.path());
        for os in ["linux", "windows", ""] {
            match swap_plan(&ledger(Some("aaa111"), None), &lay, &home, "bbb222", os) {
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
        let plan = swap_plan(&led, &f.lay, &f.home, "bbb222", "macos").unwrap();
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
        assert_eq!(after.kept, vec!["aaa111".to_string()], "kept is the shelf's business, not the swap's");
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
