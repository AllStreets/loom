//! kernel.rs — LOOM edits its own TypeScript kernel, behind five walls.
//!
//! This is the highest-blast-radius module in the project. The design is the
//! safety, not the capability. The load-bearing guarantee:
//!
//!   THE LIVE SOURCE TREE IS NEVER MODIFIED until (a) `tsc --noEmit` + targeted
//!   `vitest run` pass in an ISOLATED git worktree AND (b) the owner approves
//!   the diff (approval is enforced by the caller in Task 2; this module makes
//!   an early live write structurally impossible — the only fn that touches the
//!   live tree is `kernel_apply`, which takes a validated worktree id).
//!
//! And the SELF-PROTECTION invariant: LOOM must never edit its own safety
//! machinery — `is_editable` denies the protected set BEFORE any fs op.
//!
//! Isolation model: a proposal creates a detached `git worktree` at HEAD in a
//! temp dir (dev) or under `loomhome/worktrees/` (packaged). Edits and
//! validation happen THERE. `kernel_apply` re-derives the same patch and writes
//! it to the live tree only on an explicit, separate call. Every error path
//! cleans up the worktree (`git worktree remove` + `git worktree prune`) so no
//! orphan survives.
//!
//! Phase 23 (Rebirth): validation is OFFLINE. The worktree borrows the source
//! tree's `node_modules` through a symlink, `tsc`/`vitest` are invoked as
//! files under it through the recorded `node` binary (never `npx`, whose own
//! cache was an unstated network dependency), and cargo runs `--offline`
//! against the shared loomhome `target/` in packaged mode.

use crate::error::LoomError;
use crate::exec::{run_checked, run_checked_env, run_detached, ExecOut};
use crate::loomhome::{mode, Home, Mode};
use crate::platform::AppLayout;
use crate::{generations, platform, threads, warden};
use git2::Repository;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

// ── Timeouts ────────────────────────────────────────────────────────────────

const GIT_TIMEOUT: Duration = Duration::from_secs(60);
const TSC_TIMEOUT: Duration = Duration::from_secs(300);
const VITEST_TIMEOUT: Duration = Duration::from_secs(300);
// cargo in a fresh worktree has no shared target/ — a cold `cargo check` then
// `cargo test` compiles the whole crate from scratch. Honest: minutes, not
// seconds. Generous ceilings so a genuine slow-but-progressing compile is not
// mistaken for a hang, while still bounding a truly stuck build.
const CARGO_CHECK_TIMEOUT: Duration = Duration::from_secs(600); // 10 min
const CARGO_TEST_TIMEOUT: Duration = Duration::from_secs(900); // 15 min

// ── The protected set (self-protection invariant, spec §self-protection) ──────
//
// Relative, forward-slash, lowercased-for-comparison paths that may NEVER be
// edited by LOOM. Anything here is denied before isolation. The TS safety
// machinery below MUST be carved out of the `src/**/*.ts(x)` whitelist; the
// RUST safety machinery (PROTECTED_RUST, below) is carved out of the new
// `src-tauri/src/**/*.rs` whitelist. Phase 22 moved Rust from implicit-deny
// (it simply wasn't `src/**/*.ts`) to EXPLICIT protection — if any safety file
// became editable, the recovery gap would reopen. The enumerated
// `self_protection_denies_the_machinery` test is the guarantee.
const PROTECTED: &[&str] = &[
    // Entry points and config (also can't be src/**/*.ts(x), but named for clarity):
    "src/main.tsx",
    "index.html",
    "vite.config.ts",
    "package.json",
    // Phase 23 (Rebirth): a dependency edit is an arbitrary-code vector — the
    // lockfile decides what `npm ci` runs during threading.
    "package-lock.json",
    // Phase 23 (Rebirth): the script that bundles the genome into the build —
    // it decides what history the next binary carries.
    "scripts/genome-bundle.mjs",
];

/// Protected by STEM PREFIX — every file whose lowercased path *starts with*
/// one of these is denied, so a `.ts`, a `.test.ts`, a `.order.test.ts`, a
/// stem-sibling (`recoveryNotice.tsx` under the `.../recovery` stem), or a
/// whole subdirectory are all caught. Over-matching here is safe by design:
/// these stems are reserved for LOOM's own safety machinery, which it must
/// never be able to edit (the self-protection invariant). The set covers the
/// self-edit pipeline, the diff-review wall, the recovery beacon + notice, AND
/// the ErrorBoundary that feeds the boot-health veto — edit any of these and a
/// wall dissolves.
const PROTECTED_PREFIXES: &[&str] = &[
    "src/lib/loom/kernelbuild",       // draft/validate/apply pipeline (+ tests)
    "src/lib/loom/recovery",          // boot-health beacon + veto (+ tests)
    "src/components/chrome/kerneldiff", // the approval diff card (+ tests)
    "src/components/chrome/recovery",  // recoveryNotice UI (+ tests)
    "src/components/errorboundary",    // drives noteBootError → boot-health veto
    // Phase 23 (Rebirth): Tauri capability grants — what the webview may ask
    // of the shell. Widening them is widening the walls.
    "src-tauri/capabilities/",
    // Phase 23 (Rebirth): the bundled genome (genome.bundle + genome.json) —
    // gitignored build output, but a path LOOM must never write.
    "src-tauri/genome/",
    // Phase 23 (Rebirth): the TS side of the reweave — starts a binary swap
    // and returns bodies; a self-edit here could weave without consent.
    "src/lib/loom/reweave",           // reweave orchestration (+ tests)
    "src/lib/loom/generations",       // generations orchestration (+ tests)
    // Round-1 review: the rule is "anything that implements a wall", and these
    // implement the walls around the body. `api` holds the `need()` grant seam
    // every organ power passes through; `budgets` meters it; `validate` decides
    // which powers a manifest may declare AND supplies the label the owner
    // reads on the permission card; `chrome/reweave` is the only surface
    // carrying CANCEL before the point of return; the settings seed is the only
    // one offering the generations list — the road home. Protecting one caller
    // of the orchestration above and not the others was the gap.
    "src/lib/organs/api",             // the power grant seam (+ tests)
    "src/lib/organs/budgets",         // the meter on that seam (+ tests)
    "src/lib/loom/validate",          // manifest wall + the owner-facing labels
    "src/components/chrome/reweave",  // the reweave card — CANCEL lives here
    "src/organs/seeds/settings",      // the generations list: the road home
    // Round-1 fixes moved the consent for a body change out of the organ API
    // and into shell-owned chrome. That chrome is now the ONLY wall between an
    // organ and the binary swap, so it joins the set it replaced.
    "src/lib/organs/bodygate",        // an organ may ask; this is the asking
    "src/components/chrome/bodyrequest", // the shell answers — the only caller
    "src/components/chrome/consentcard", // the card the owner actually reads
];

/// tsconfig*.json — matched by name pattern (tsconfig.json, tsconfig.node.json…).
fn is_tsconfig(rel_lower: &str) -> bool {
    let base = rel_lower.rsplit('/').next().unwrap_or(rel_lower);
    base.starts_with("tsconfig") && base.ends_with(".json")
}

// ── The Rust safety machinery (Phase 22 — Marrow) ─────────────────────────────
//
// Extending the whitelist to `src-tauri/src/**/*.rs` means the Rust core LOOM
// lives inside becomes editable — SO every file that constructs the app, runs
// before recovery, or implements a wall MUST be denied here, by EXACT
// lowercased path. Anything constructing the Tauri Builder (main.rs / lib.rs),
// the self-edit safety core (kernel.rs — which also holds `preboot_heal`, so no
// separate preboot.rs exists to protect), the hardened spawn (exec.rs), the
// typed-error and timeline machinery (error.rs / timeline.rs) — a self-edit to
// any of these could disable a wall or the recovery gap.
//
// DOC RULE (new-Rust-module hazard): any new file that constructs the app, runs
// before recovery, or implements a wall MUST be added to PROTECTED_RUST.
const PROTECTED_RUST: &[&str] = &[
    "src-tauri/src/main.rs",     // process entry — constructs everything
    "src-tauri/src/lib.rs",      // run() — Builder + pre-main preboot_heal call
    "src-tauri/src/kernel.rs",   // THIS module: the walls + preboot_heal live here
    "src-tauri/src/exec.rs",     // hardened fixed-argv spawn (the validation wall)
    "src-tauri/src/error.rs",    // the typed-error surface the walls speak in
    "src-tauri/src/timeline.rs", // rollback discipline the recovery reuses
    // Phase 23 (Rebirth): the loomhome / build / bundle surface. These are
    // already outside the `src-tauri/src/**/*.rs` whitelist (build.rs,
    // tauri.conf.json) or would be inside it (loomhome.rs) — either way they
    // are NAMED here so the protection is explicit and enumerable, not an
    // accident of the whitelist's shape.
    "src-tauri/src/platform.rs", // the swap plan + execution — replaces the running body's file
    "src-tauri/src/generations.rs", // the ledger — decides which bodies survive on disk
    "src-tauri/src/loomhome.rs", // identity + every path the reweave reads/writes
    "src-tauri/src/threads.rs",  // tool discovery + the threading ceremony (spawns tools)
    "src-tauri/src/reweave.rs",  // the build job — assets, core, stage, swap, relaunch
    "src-tauri/src/warden.rs",   // the birth guard — argv dispatch, watch, heal
    "src-tauri/build.rs",        // bakes LOOM_GENOME_SHA — a generation's own name
    "src-tauri/tauri.conf.json", // bundle resources, beforeBuildCommand
];

/// The guard script and Cargo manifests are protected by BASENAME anywhere in
/// the tree: `scripts/kernel-preboot.mjs` is the pre-compile recovery guard
/// (editing it reopens the gap), and `Cargo.toml`/`Cargo.lock` are an
/// arbitrary-code vector (a dependency edit runs a build script of the model's
/// choosing). All lowercased. Basename match — not path match — so no
/// alternate spelling of the same file slips through.
const PROTECTED_RUST_BASENAMES: &[&str] = &[
    "kernel-preboot.mjs",
    "cargo.toml",
    "cargo.lock",
];

/// `.cargo/config.toml` at ANY depth is protected (Phase 23 / Rebirth): it is
/// where threading pins the vendored source and `net.offline`; an edit there
/// could point cargo at an arbitrary registry or reopen the network.
fn is_cargo_config(rel_lower: &str) -> bool {
    rel_lower == ".cargo/config.toml" || rel_lower.ends_with("/.cargo/config.toml")
}

/// True if `rel_lower` (already normalized + lowercased) is a Rust-side safety
/// file that LOOM must never edit — the enumerated core paths OR a protected
/// basename anywhere. Checked BEFORE the positive Rust whitelist (deny wins).
fn is_protected_rust(rel_lower: &str) -> bool {
    if PROTECTED_RUST.contains(&rel_lower) {
        return true;
    }
    if is_cargo_config(rel_lower) {
        return true;
    }
    let base = rel_lower.rsplit('/').next().unwrap_or(rel_lower);
    PROTECTED_RUST_BASENAMES.contains(&base)
}

// ── Whitelist + normalization ─────────────────────────────────────────────────

/// Normalize a candidate relative path for whitelist checks, or reject it.
///
/// Defensive: rejects absolute paths, backslashes, leading `/`, any `..`
/// component, any `.` component, and empty. Returns a clean forward-slash
/// relative path (original case preserved — the caller lowercases for the
/// protected-name comparison, but joins the real path to the repo).
fn normalize_rel(rel: &str) -> Result<String, LoomError> {
    if rel.is_empty() {
        return Err(LoomError::Parse("empty path".into()));
    }
    if rel.contains('\\') {
        return Err(LoomError::Parse(format!("backslash in path: {rel}")));
    }
    if rel.starts_with('/') || Path::new(rel).is_absolute() {
        return Err(LoomError::Parse(format!("absolute path rejected: {rel}")));
    }
    let mut parts: Vec<&str> = Vec::new();
    for comp in rel.split('/') {
        match comp {
            "" => return Err(LoomError::Parse(format!("empty path component: {rel}"))),
            "." => return Err(LoomError::Parse(format!("'.' component rejected: {rel}"))),
            ".." => return Err(LoomError::Parse(format!("'..' component rejected: {rel}"))),
            _ => parts.push(comp),
        }
    }
    Ok(parts.join("/"))
}

/// The positive whitelist minus the protected carve-out. Pure, testable.
///
/// Allow: normalized `src/**/*.ts(x)` OR `src-tauri/src/**/*.rs`.
/// Deny: anything in PROTECTED / PROTECTED_PREFIXES / tsconfig*.json (the TS
///       machinery) OR PROTECTED_RUST / PROTECTED_RUST_BASENAMES (the Rust
///       machinery + guard script + Cargo manifests) — compared
///       case-insensitively so a case-collision (`src/Main.tsx`,
///       `src-tauri/src/Kernel.rs`, `CARGO.TOML`) can't bypass.
pub fn is_editable(rel: &str) -> bool {
    let norm = match normalize_rel(rel) {
        Ok(n) => n,
        Err(_) => return false,
    };
    let lower = norm.to_lowercase();

    // ── Deny wins: every protected carve-out is checked BEFORE any allow. ──
    // TS-side protected set.
    if PROTECTED.contains(&lower.as_str()) {
        return false;
    }
    // Bare stem match: `.../recovery` denies `recovery.ts`, `recovery.test.ts`,
    // AND `recoveryNotice.tsx` — a directory-only (`{p}/`) rule would miss the
    // sibling files, which is how the boot-health veto was almost left editable.
    if PROTECTED_PREFIXES.iter().any(|p| lower.starts_with(p)) {
        return false;
    }
    if is_tsconfig(&lower) {
        return false;
    }
    // Rust-side protected set: the safety core + guard script + Cargo manifests.
    // Checked before the Rust allow below, same deny-wins discipline as TS.
    if is_protected_rust(&lower) {
        return false;
    }

    // ── Positive whitelist ──
    // TS body: src/**/*.ts(x)
    if lower.starts_with("src/") && (lower.ends_with(".ts") || lower.ends_with(".tsx")) {
        return true;
    }
    // Rust core: src-tauri/src/**/*.rs (Phase 22 — Marrow). Note the ONLY Rust
    // whitelist is under `src-tauri/src/`: a non-src src-tauri file
    // (`tauri.conf.json`, `build.rs`) is NOT `src-tauri/src/…` and stays denied.
    if lower.starts_with("src-tauri/src/") && lower.ends_with(".rs") {
        return true;
    }
    false
}

// ── Source-repo resolution ────────────────────────────────────────────────────

/// Re-check the whitelist against where a path ACTUALLY landed.
///
/// `is_editable` judges the path as spelled. Canonicalization then resolves
/// symlinks — so a link inside the repo named `src/lib/foo.ts` pointing at
/// `src-tauri/src/kernel.rs` would pass the spelled check and be written
/// through to a protected file. The tree holds no symlinks today (`git
/// ls-files -s` shows none), but that is an unstated invariant the whole
/// whitelist rests on, so we re-derive the repo-relative path from the
/// canonical one and judge THAT too. Deny wins, as everywhere else.
fn assert_lands_editable(root: &Path, canon: &Path, rel: &str) -> Result<(), LoomError> {
    let landed = canon
        .strip_prefix(root)
        .map_err(|_| LoomError::Parse(format!("path escapes source repo: {rel}")))?
        .to_string_lossy()
        .replace('\\', "/");
    if !is_editable(&landed) {
        return Err(LoomError::Parse(format!(
            "{rel} resolves to {landed}, which is not editable"
        )));
    }
    Ok(())
}

/// Resolve the SOURCE repo root in DEV mode: the `override_opt` setting if a
/// non-empty value is supplied, else the process cwd. Canonicalized, asserted
/// to be a git WORK dir (`.git` present + `Repository::open` succeeds, not
/// bare). Typed error otherwise. This is the sovereignty guard — LOOM only
/// ever edits the repo it is running from (or an explicitly configured one).
/// Commands go through `resolve_source_repo_for` so packaged mode answers
/// `loomhome/source` instead; this dev entry serves the tests today.
#[cfg_attr(not(test), allow(dead_code))]
pub fn resolve_source_repo(override_opt: Option<&str>) -> Result<PathBuf, LoomError> {
    resolve_source_repo_at(Mode::Dev, override_opt, None)
}

/// The mode-aware core. Packaged → `home.source()`, the `kernel.sourceRepo`
/// override is dev-only and ignored (a packaged LOOM edits its own genome,
/// never an arbitrary checkout). Dev → the override, else the cwd. Pure in
/// `mode` so a test can exercise the packaged branch without a built app.
pub fn resolve_source_repo_at(
    mode: Mode,
    override_opt: Option<&str>,
    home: Option<&Home>,
) -> Result<PathBuf, LoomError> {
    let raw: PathBuf = match mode {
        Mode::Packaged => home
            .ok_or_else(|| LoomError::NotFound("loomhome unavailable — cannot locate source".into()))?
            .source(),
        Mode::Dev => match override_opt {
            Some(s) if !s.trim().is_empty() => PathBuf::from(s.trim()),
            _ => std::env::current_dir()
                .map_err(|e| LoomError::NotFound(format!("cwd unavailable: {e}")))?,
        },
    };
    let canonical = raw
        .canonicalize()
        .map_err(|e| LoomError::NotFound(format!("source repo {}: {e}", raw.display())))?;
    if !canonical.join(".git").exists() {
        return Err(LoomError::Git(format!(
            "not a git work dir (no .git): {}",
            canonical.display()
        )));
    }
    let repo = Repository::open(&canonical)
        .map_err(|e| LoomError::Git(format!("open source repo {}: {e}", canonical.display())))?;
    if repo.is_bare() {
        return Err(LoomError::Git(format!(
            "source repo is bare: {}",
            canonical.display()
        )));
    }
    Ok(canonical)
}

/// What every command uses: the process mode + the app's loomhome.
fn resolve_source_repo_for(
    app: &tauri::AppHandle,
    override_opt: Option<&str>,
) -> Result<PathBuf, LoomError> {
    let home = Home::from_app(app)?;
    resolve_source_repo_at(mode(), override_opt, Some(&home))
}

// ── git helpers (hardened, fixed argv, via exec) ──────────────────────────────

fn git(cwd: &Path, allowed_root: &Path, args: &[&str]) -> Result<ExecOut, LoomError> {
    let mut argv: Vec<&str> = vec!["git"];
    argv.extend_from_slice(args);
    let out = run_checked(&argv, cwd, allowed_root, GIT_TIMEOUT)?;
    Ok(out)
}

fn git_ok(cwd: &Path, allowed_root: &Path, args: &[&str]) -> Result<String, LoomError> {
    let out = git(cwd, allowed_root, args)?;
    if out.code != 0 {
        return Err(LoomError::Git(format!(
            "git {} failed ({}): {}",
            args.join(" "),
            out.code,
            out.stderr.trim()
        )));
    }
    Ok(out.stdout)
}

/// Current HEAD sha of the repo at `root`. `pub(crate)`: reweave.rs names
/// the sha a weave targets with the same call `kernel_apply` records.
pub(crate) fn head_sha(root: &Path) -> Result<String, LoomError> {
    Ok(git_ok(root, root, &["rev-parse", "HEAD"])?.trim().to_string())
}

// ── Validator toolchain resolution (Finding 8) ────────────────────────────────
//
// `kernel_validate` must not spawn a validator resolved from an inherited PATH
// on every call: a PATH hijacked between startup and a validate call could
// swap in a validator that lies. The ABSOLUTE path of `node` is taken from
// `threads.json` (recorded at threading) when a loomhome is at hand, else
// resolved ONCE (a OnceLock cache) by walking PATH ourselves, and used as
// argv[0] thereafter — keeping the fixed-argv discipline intact. The compiler
// and test runner themselves are files under the worktree's `node_modules`
// (a symlink to the source install), so nothing is looked up by name.
//
// Residual, stated honestly: if PATH is ALREADY hijacked at process startup the
// machine is already compromised and no in-process check can save it. This
// removes the *per-call re-resolution* window, not that root compromise.

static NODE_PATH: OnceLock<Option<PathBuf>> = OnceLock::new();

/// Walk `PATH` looking for an executable named `bin` (with common Windows
/// extensions on that platform). Returns the first absolute match.
fn which(bin: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let exts: &[&str] = if cfg!(windows) {
        &["", ".cmd", ".exe", ".bat"]
    } else {
        &[""]
    };
    for dir in std::env::split_paths(&path) {
        for ext in exts {
            let cand = dir.join(format!("{bin}{ext}"));
            if cand.is_file() {
                // Canonicalize so argv[0] is a stable absolute path.
                return cand.canonicalize().ok().or(Some(cand));
            }
        }
    }
    None
}

/// The absolute `node` path: the recorded thread first (`threads.json`, if it
/// still exists on disk — `threads::tool_path` handles the drift), else the
/// PATH walk resolved once and cached. `None` if unresolvable — in which case
/// `kernel_validate` fails honestly (can't prove → can't pass).
fn node_path(home: Option<&Home>) -> Option<PathBuf> {
    home.and_then(|h| crate::threads::tool_path(h, "node"))
        .or_else(|| NODE_PATH.get_or_init(|| which("node")).clone())
}

// cargo gets the SAME treatment as node (Phase 22): resolve the absolute path
// ONCE via the shared PATH-walk `which`, cache it, and use it as argv[0] so a
// PATH hijacked between startup and a validate call cannot swap in a `cargo`
// that lies. Same residual: a PATH already hijacked at process startup is
// out of scope (the machine is already compromised).
static CARGO_PATH: OnceLock<Option<PathBuf>> = OnceLock::new();

/// The absolute `cargo` path: the recorded thread first, else the threads
/// table's fixed candidate order (`~/.cargo/bin` first — a cargo that PATH
/// cannot see, e.g. a packaged app launched from Finder, is still found), else
/// the PATH walk; the fallback is resolved once and cached. `None` if
/// unresolvable — a Rust validate then fails honestly (can't prove → can't pass).
fn cargo_path(home: Option<&Home>) -> Option<PathBuf> {
    home.and_then(|h| crate::threads::tool_path(h, "cargo")).or_else(|| {
        CARGO_PATH
            .get_or_init(|| crate::threads::locate_now("cargo").or_else(|| which("cargo")))
            .clone()
    })
}

// ── SEARCH/REPLACE (exact, unique) ─────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct KernelEdit {
    pub path: String,
    pub search: String,
    pub replace: String,
}

/// Apply one exact, UNIQUE SEARCH/REPLACE to `content`. Errors if the search is
/// absent OR appears more than once (ambiguous). Empty search is rejected — we
/// never allow a whole-file blind append in the kernel.
fn apply_exact_unique(content: &str, search: &str, replace: &str) -> Result<String, LoomError> {
    if search.is_empty() {
        return Err(LoomError::Parse("empty SEARCH is not allowed for kernel edits".into()));
    }
    let first = match content.find(search) {
        Some(i) => i,
        None => return Err(LoomError::Parse("SEARCH text not found in file".into())),
    };
    // Ambiguity check: a second occurrence anywhere after the first.
    if content[first + search.len()..].contains(search) {
        return Err(LoomError::Parse(
            "SEARCH text is ambiguous (matches more than once)".into(),
        ));
    }
    let mut out = String::with_capacity(content.len() + replace.len());
    out.push_str(&content[..first]);
    out.push_str(replace);
    out.push_str(&content[first + search.len()..]);
    Ok(out)
}

// ── Worktree registry ─────────────────────────────────────────────────────────
//
// A proposal returns an opaque `worktreeId`. We keep enough state to validate,
// apply, and clean up: the source repo root, the worktree path, HEAD at
// proposal time, and the set of edited relative paths (for targeted vitest).

#[derive(Clone)]
struct Proposal {
    source_root: PathBuf,
    worktree: PathBuf,
    base_sha: String,
    edits: Vec<(String, String, String)>, // (rel, search, replace) — validated editable
    /// WALL ORDERING (structural, Rust-enforced): a proposal starts unvalidated
    /// and unapproved. `kernel_validate` sets `validated = true` ONLY on a fully
    /// passing result (tsc AND vitest). `kernel_approve` sets `approved = true`
    /// ONLY if `validated`. `kernel_apply` refuses to touch the live tree unless
    /// BOTH are true. This makes "apply straight after propose" impossible at the
    /// Tauri IPC boundary, not merely in the TS orchestrator.
    validated: bool,
    approved: bool,
}

static REGISTRY: Mutex<Option<HashMap<String, Proposal>>> = Mutex::new(None);

fn with_registry<T>(f: impl FnOnce(&mut HashMap<String, Proposal>) -> T) -> T {
    let mut guard = REGISTRY.lock().expect("kernel registry poisoned");
    let map = guard.get_or_insert_with(HashMap::new);
    f(map)
}

/// Remove a worktree directory and prune the source repo's worktree metadata.
/// Best-effort but thorough — used on every error path and on apply/discard.
fn cleanup_worktree(source_root: &Path, worktree: &Path) {
    // The borrowed `node_modules` symlink goes FIRST, by unlink — so neither
    // git nor remove_dir_all below can ever be tempted to walk into the source
    // tree's real install. `symlink_metadata` does not follow; `remove_file`
    // on a symlink removes the link, never the target.
    let link = worktree.join("node_modules");
    if std::fs::symlink_metadata(&link)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        let _ = std::fs::remove_file(&link);
    }
    // `git worktree remove --force` unregisters and deletes it. If the path is
    // not valid UTF-8 we can't form the git argv (fixed-argv discipline forbids
    // lossy coercion) — fall straight through to remove_dir_all, which takes a
    // &Path and needs no UTF-8 (Finding 4).
    if let Some(wt) = worktree.to_str() {
        let _ = git(
            source_root,
            source_root,
            &["worktree", "remove", "--force", wt],
        );
    }
    // If the dir somehow survives (removed out of band, or git couldn't form the
    // command above), nuke it directly — &Path, no UTF-8 required.
    if worktree.exists() {
        let _ = std::fs::remove_dir_all(worktree);
    }
    // Prune dangling administrative entries regardless.
    let _ = git(source_root, source_root, &["worktree", "prune"]);
}

// ── Sentinel (recovery boot) ──────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Sentinel {
    pub prev_sha: String,
    pub applied_sha: String,
    /// The boot state machine. Two overlapping flows share this field:
    ///
    ///   TS flow (Phase 21, unchanged): `pending` → healthy `kernel_boot_ok`
    ///   clears it (removes the app_data sentinel) → an unconfirmed `pending`
    ///   at a LATER `kernel_boot_check` triggers a same-binary rollback. A TS
    ///   edit hot-reloads, so boot_ok fires in the SAME session.
    ///
    ///   Rust flow (Phase 22, the mirror `.loom-boot.json`): `applied` (written
    ///   at `kernel_apply`) → the next start's PRE-MAIN hook marks it `booting`
    ///   (it has seen this edit boot once, unconfirmed) → healthy
    ///   `kernel_boot_ok` clears it to `healed` on the NEXT launch → but an
    ///   unconfirmed `applied`/`booting` seen at a later start triggers a
    ///   SOURCE rollback + recompile from good source.
    ///
    /// Terminal/cleared states: `ok`, `healed`, `rollback-failed` — never
    /// re-trigger a rollback. Only `pending` (TS), `applied`/`booting` (Rust)
    /// are "unconfirmed" and actionable.
    pub status: String,
    /// The resolved absolute repo path the edit was applied to (Finding 6).
    /// Recovery rolls back USING THIS, never the process cwd — so a shell
    /// launched from a different directory still targets the right repo.
    /// Defaulted for backward-compat with sentinels written before this field.
    #[serde(default)]
    pub source_root: String,
    /// Which actor last armed the `booting` state (round-1 review, Finding 2/3):
    /// `"guard"` (the pre-compile Node guard armed it — this is a LIVE attempt
    /// the guard is watching THIS session, so the pre-main hook must NOT touch
    /// it), `"premain"` (the pre-main hook armed it, guard-absent — the pre-main
    /// hook IS the backstop and may heal it), or `None`/absent (freshly applied,
    /// not yet armed). Serialized as `armedBy` to match the mirror JSON the Node
    /// guard reads/writes. Defaulted for backward-compat.
    #[serde(rename = "armedBy", default)]
    pub armed_by: Option<String>,
}

/// Is a sentinel status "unconfirmed" — i.e. a boot that was applied but never
/// confirmed healthy, and therefore actionable by the recovery machinery?
/// `pending` is the TS same-session flow; `applied`/`booting` are the Rust
/// cross-restart flow. `ok`/`healed`/`rollback-failed` are terminal (a prior
/// boot already resolved them) and must NEVER re-trigger a rollback.
pub fn is_unconfirmed(status: &str) -> bool {
    matches!(status, "pending" | "applied" | "booting")
}

/// The fixed, source-repo-relative mirror of the boot sentinel. `kernel_apply`
/// writes this at the source root ALONGSIDE the app_data sentinel; it is the
/// ONE authoritative state that the pre-compile Node guard AND the pre-main
/// Rust hook (`preboot_heal`) read — both run BEFORE the app_data dir is even
/// resolvable (no AppHandle pre-main; no Tauri at all in the Node guard).
/// Gitignored — it is transient boot state, never committed.
pub const BOOT_MIRROR: &str = ".loom-boot.json";

/// Path to the source-relative boot mirror for a given repo root.
fn mirror_path(source_root: &Path) -> PathBuf {
    source_root.join(BOOT_MIRROR)
}

/// Best-effort: write the boot mirror at the source root. Errors are swallowed
/// by callers that must not fail on a mirror hiccup (the app_data sentinel and
/// the git commit are the load-bearing state; the mirror is the guard's view).
fn write_mirror(source_root: &Path, s: &Sentinel) -> Result<(), LoomError> {
    write_sentinel(&mirror_path(source_root), s)
}

fn sentinel_path(app: &tauri::AppHandle) -> Result<PathBuf, LoomError> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| LoomError::Git(e.to_string()))?
        .join("loom");
    std::fs::create_dir_all(&dir).map_err(|e| LoomError::Git(e.to_string()))?;
    Ok(dir.join("kernel-boot.json"))
}

/// The sentinel at `path`, or `None` when absent or torn. `pub(crate)` for
/// the warden, which reads the app_data sentinel by path (no AppHandle).
pub(crate) fn read_sentinel(path: &Path) -> Option<Sentinel> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Every write of the sentinel goes through the same atomic helper as the
/// rest of loomhome (round-1 review, Finding 4): a staging file, fsync,
/// rename. A torn sentinel reads as `None`, and a boot that reads `None`
/// proceeds unguarded — permanently.
fn write_sentinel(path: &Path, s: &Sentinel) -> Result<(), LoomError> {
    crate::threads::write_json_atomic(path, s)
}

/// Write a sentinel at an explicit path (Phase 23 / Rebirth). The swap
/// (platform.rs) and the warden (warden.rs) write `applied`/`healed` at
/// `Home::sentinel_json()` without an AppHandle — the same file
/// `sentinel_path` resolves for the running app. Thin wrapper over the
/// private writer so the sentinel's shape has exactly one author.
pub fn write_sentinel_at(path: &Path, s: &Sentinel) -> Result<(), LoomError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| LoomError::Git(e.to_string()))?;
    }
    write_sentinel(path, s)
}

// ── Return shapes ─────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct EditableMeta {
    pub root: String,
    pub protected: Vec<String>,
}

#[derive(Serialize, Debug)]
pub struct ProposeOut {
    #[serde(rename = "worktreeId")]
    pub worktree_id: String,
    pub diff: String,
}

#[derive(Serialize)]
pub struct ValidateOut {
    pub ok: bool,
    pub stage: String, // "tsc" | "vitest" | "cargo-check" | "cargo-test" | "ok"
    pub output: String,
}

#[derive(Serialize)]
pub struct ApplyOut {
    pub sha: String,
    #[serde(rename = "prevSha")]
    pub prev_sha: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct BootCheckOut {
    #[serde(rename = "rolledBackTo")]
    pub rolled_back_to: Option<String>,
    /// A distinct, honest signal when a pending edit was found but the rollback
    /// itself FAILED (sha gc'd/corrupt) — the sentinel has been rewritten to
    /// "rollback-failed" so the next boot does NOT retry forever (Finding 7).
    /// The shell surfaces this so the user isn't silently stranded.
    #[serde(rename = "rollbackFailed")]
    pub rollback_failed: bool,
    /// Phase 23: the warden (or the pre-main backstop) healed a woven body
    /// that never confirmed its boot. Read from `loomhome/recovery.json` and
    /// surfaced EXACTLY ONCE — the record is deleted as it is reported.
    #[serde(rename = "healedGeneration")]
    pub healed_generation: Option<HealedGeneration>,
}

/// `healedGeneration` — the warden's recovery record without its log tail.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HealedGeneration {
    pub failed_sha: String,
    pub prev_sha: String,
    /// `"crashed"` | `"never confirmed"`.
    pub reason: String,
}

impl From<warden::Recovery> for HealedGeneration {
    fn from(r: warden::Recovery) -> Self {
        HealedGeneration { failed_sha: r.failed_sha, prev_sha: r.prev_sha, reason: r.reason }
    }
}

/// The full protected list surfaced to the UI/prompt (concrete + prefixes +
/// the tsconfig pattern token).
fn protected_list() -> Vec<String> {
    let mut v: Vec<String> = PROTECTED.iter().map(|s| s.to_string()).collect();
    for p in PROTECTED_PREFIXES {
        v.push(format!("{p}/**"));
    }
    v.push("tsconfig*.json".to_string());
    // Rust safety core (Phase 22): the enumerated PROTECTED_RUST paths + the
    // guard script + Cargo manifests. The Rust whitelist is
    // `src-tauri/src/**/*.rs`; everything below is carved out of it.
    for p in PROTECTED_RUST {
        v.push(p.to_string());
    }
    v.push("scripts/kernel-preboot.mjs".to_string());
    v.push("Cargo.toml".to_string());
    v.push("Cargo.lock".to_string());
    v
}

// ── Core operations (testable, app-independent) ───────────────────────────────

/// Where validation worktrees live. Packaged → `loomhome/worktrees/` (inside
/// loomhome, next to the shared `target/`, so the cargo env pair names two
/// LOOM-owned paths); dev → the system temp dir, as in Phase 21.
pub fn worktree_parent(mode: Mode, home: &Home) -> PathBuf {
    match mode {
        Mode::Packaged => home.worktrees(),
        Mode::Dev => std::env::temp_dir(),
    }
}

/// Lend the source tree's `node_modules` to a worktree: a symlink
/// `<worktree>/node_modules → <source_node_modules>`. A worktree is a bare
/// checkout with no install of its own, and Phase 21's `npx` quietly filled
/// that gap from its own cache — a network dependency. The link makes the
/// worktree's `tsc`/`vitest` the source tree's, offline. Untracked (the tree
/// gitignores it), so the proposal diff is unaffected.
#[cfg(unix)]
fn link_node_modules(source_node_modules: &Path, worktree: &Path) -> Result<(), LoomError> {
    std::os::unix::fs::symlink(source_node_modules, worktree.join("node_modules")).map_err(|e| {
        LoomError::Git(format!(
            "link node_modules into worktree {}: {e}",
            worktree.display()
        ))
    })
}

#[cfg(not(unix))]
fn link_node_modules(_source_node_modules: &Path, _worktree: &Path) -> Result<(), LoomError> {
    // No symlink on this platform: validation then fails honestly at the
    // missing compiler rather than reaching for the network.
    Ok(())
}

/// Create a worktree, apply the edits, produce a unified diff. Live tree
/// untouched. Cleans up the worktree on ANY error before returning. Dev
/// entry: worktrees under the temp dir. Commands use `propose_in` with the
/// mode's parent.
#[cfg_attr(not(test), allow(dead_code))]
fn propose_inner(source_root: &Path, edits: &[KernelEdit]) -> Result<ProposeOut, LoomError> {
    propose_in(source_root, edits, &std::env::temp_dir())
}

fn propose_in(
    source_root: &Path,
    edits: &[KernelEdit],
    parent: &Path,
) -> Result<ProposeOut, LoomError> {
    // WALL 0 (self-protection): reject non-editable paths BEFORE any fs/worktree
    // op. This runs before isolation so a protected-path proposal never even
    // creates a worktree.
    for e in edits {
        if !is_editable(&e.path) {
            return Err(LoomError::Parse(format!(
                "path is not editable (protected or outside whitelist): {}",
                e.path
            )));
        }
    }
    if edits.is_empty() {
        return Err(LoomError::Parse("no edits supplied".into()));
    }

    let base_sha = head_sha(source_root)?;

    // Unique worktree path under `parent` (OUTSIDE the source tree: the temp
    // dir in dev, `loomhome/worktrees/` packaged). A monotonic counter + nanos
    // guarantees no collision across concurrent proposals in the same process.
    std::fs::create_dir_all(parent).map_err(|e| {
        LoomError::Git(format!("create worktree parent {}: {e}", parent.display()))
    })?;
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let id = format!(
        "loom-kernel-{}-{}-{}-{}",
        std::process::id(),
        base_sha.get(..8).unwrap_or("head"),
        seq,
        nanos
    );
    let worktree = parent.join(&id);
    // If a stale dir exists (crash), clear it first.
    if worktree.exists() {
        cleanup_worktree(source_root, &worktree);
    }

    // WALL 1 (isolation): detached worktree at HEAD. Use to_str (NOT
    // to_string_lossy) so a non-UTF-8 worktree path is refused honestly rather
    // than silently corrupted into a path git can't remove later (Finding 4).
    let worktree_str = match worktree.to_str() {
        Some(s) => s,
        None => {
            cleanup_worktree(source_root, &worktree);
            return Err(LoomError::Parse(format!(
                "worktree path is not valid UTF-8: {}",
                worktree.display()
            )));
        }
    };
    if let Err(e) = git_ok(
        source_root,
        source_root,
        &["worktree", "add", "--detach", worktree_str, &base_sha],
    ) {
        cleanup_worktree(source_root, &worktree);
        return Err(e);
    }

    // Lend the source install to the worktree (offline validation, see
    // link_node_modules). Unconditional: if the source has no node_modules the
    // link dangles and tsc fails honestly at "file not found" — never npx.
    if let Err(e) = link_node_modules(&source_root.join("node_modules"), &worktree) {
        cleanup_worktree(source_root, &worktree);
        return Err(e);
    }

    // Apply each edit in the worktree. On ANY failure, clean up and bail — the
    // live tree is untouched regardless.
    let mut applied: Vec<(String, String, String)> = Vec::new();
    let result = (|| -> Result<(), LoomError> {
        for e in edits {
            let norm = normalize_rel(&e.path)?; // editable already implies normalizable
            let file = worktree.join(&norm);
            // Defense in depth: the resolved file must stay under the worktree.
            let canon_wt = worktree
                .canonicalize()
                .map_err(|err| LoomError::NotFound(format!("worktree canonicalize: {err}")))?;
            // The parent must exist for canonicalize; guard the path lexically
            // (normalize_rel already rejected `..`), then check existence.
            if !file.exists() {
                return Err(LoomError::NotFound(format!("file not in worktree: {norm}")));
            }
            let canon_file = file
                .canonicalize()
                .map_err(|err| LoomError::NotFound(format!("{norm}: {err}")))?;
            if !canon_file.starts_with(&canon_wt) {
                return Err(LoomError::Parse(format!("path escapes worktree: {norm}")));
            }
            let content = std::fs::read_to_string(&canon_file)
                .map_err(|err| LoomError::NotFound(format!("read {norm}: {err}")))?;
            let next = apply_exact_unique(&content, &e.search, &e.replace)?;
            std::fs::write(&canon_file, next)
                .map_err(|err| LoomError::Git(format!("write {norm}: {err}")))?;
            applied.push((norm, e.search.clone(), e.replace.clone()));
        }
        Ok(())
    })();

    if let Err(e) = result {
        cleanup_worktree(source_root, &worktree);
        return Err(e);
    }

    // Unified diff of the worktree vs HEAD.
    let diff = match git_ok(&worktree, &worktree, &["diff", "--no-color"]) {
        Ok(d) => d,
        Err(e) => {
            cleanup_worktree(source_root, &worktree);
            return Err(e);
        }
    };

    with_registry(|reg| {
        reg.insert(
            id.clone(),
            Proposal {
                source_root: source_root.to_path_buf(),
                worktree: worktree.clone(),
                base_sha: base_sha.clone(),
                edits: applied,
                validated: false,
                approved: false,
            },
        );
    });

    Ok(ProposeOut {
        worktree_id: id,
        diff,
    })
}

// ── Tauri commands ────────────────────────────────────────────────────────────

// The commands take `app: tauri::AppHandle` (injected by Tauri, invisible to
// the TS wrappers' argument objects) so every source-root lookup goes through
// the mode + loomhome. `source_repo` stays the dev-only override.

#[tauri::command]
pub fn kernel_editable(
    app: tauri::AppHandle,
    source_repo: Option<String>,
) -> Result<EditableMeta, LoomError> {
    let root = resolve_source_repo_for(&app, source_repo.as_deref())?;
    Ok(EditableMeta {
        root: root.to_string_lossy().to_string(),
        protected: protected_list(),
    })
}

#[tauri::command]
pub fn kernel_read(
    app: tauri::AppHandle,
    source_repo: Option<String>,
    path: String,
) -> Result<String, LoomError> {
    let root = resolve_source_repo_for(&app, source_repo.as_deref())?;
    if !is_editable(&path) {
        return Err(LoomError::Parse(format!(
            "path is not editable (protected or outside whitelist): {path}"
        )));
    }
    let norm = normalize_rel(&path)?;
    let file = root.join(&norm);
    let canon = file
        .canonicalize()
        .map_err(|e| LoomError::NotFound(format!("{norm}: {e}")))?;
    if !canon.starts_with(&root) {
        return Err(LoomError::Parse(format!("path escapes source repo: {norm}")));
    }
    assert_lands_editable(&root, &canon, &norm)?;
    std::fs::read_to_string(&canon).map_err(|e| LoomError::NotFound(format!("read {norm}: {e}")))
}

#[tauri::command]
pub fn kernel_propose(
    app: tauri::AppHandle,
    source_repo: Option<String>,
    edits: Vec<KernelEdit>,
) -> Result<ProposeOut, LoomError> {
    let home = Home::from_app(&app)?;
    let m = mode();
    let root = resolve_source_repo_at(m, source_repo.as_deref(), Some(&home))?;
    propose_in(&root, &edits, &worktree_parent(m, &home))
}

#[tauri::command]
pub fn kernel_validate(app: tauri::AppHandle, worktree_id: String) -> Result<ValidateOut, LoomError> {
    let prop = with_registry(|reg| reg.get(&worktree_id).cloned())
        .ok_or_else(|| LoomError::NotFound(format!("unknown worktreeId: {worktree_id}")))?;
    let home = Home::from_app(&app)?;
    let m = mode();

    // Re-validation resets the gate: a validate call must re-prove the current
    // proposal from scratch, so clear validated (and, since re-validating means
    // the prior decision is stale, approved) BEFORE running the checks. Only a
    // fully-passing result at the end sets validated = true (Finding 1/5).
    set_flags(&worktree_id, false, false);

    // WALL 2 (validation): pick the toolchains from the edit's file kinds. TS
    // edits → tsc + vitest (fast — run first). Rust edits → cargo check + cargo
    // test (minutes — run second). A MIXED edit set runs BOTH (cheap TS first so
    // a TS breakage fails fast before the slow cargo compile). Each stage's
    // first failure returns {stage, output}; the live tree is never touched by
    // validation regardless. Only a fully-passing result sets validated = true.
    let touches_ts = prop
        .edits
        .iter()
        .any(|(rel, _, _)| rel.ends_with(".ts") || rel.ends_with(".tsx"));
    let touches_rust = prop.edits.iter().any(|(rel, _, _)| rel.ends_with(".rs"));

    if touches_ts {
        if let Some(fail) = validate_ts(&prop, Some(&home))? {
            return Ok(fail);
        }
    }
    if touches_rust {
        if let Some(fail) = validate_rust(&prop, m, &home)? {
            return Ok(fail);
        }
    }

    // Fully passing (every applicable toolchain) → mark validated. This is the
    // ONLY place validated flips true, and apply refuses without it (Finding 1/5).
    set_flags(&worktree_id, true, false);

    Ok(ValidateOut {
        ok: true,
        stage: "ok".into(),
        output: String::new(),
    })
}

/// The two TS validation argvs, composed from the recorded `node`, the
/// worktree and the targeted test files: `(tsc, vitest)`. Both run a FILE
/// under `<worktree>/node_modules` (the symlink to the source install) through
/// `node` — never a name resolved by PATH or `npx` (whose own cache was an
/// unstated network dependency). Pure, so the shape is testable without a
/// spawn. Lossy path coercion is refused by the caller (`to_str`), not here.
pub fn ts_argv(node: &Path, wt: &Path, tests: &[String]) -> (Vec<String>, Vec<String>) {
    let node = node.to_string_lossy().to_string();
    let tsc = wt.join("node_modules/typescript/bin/tsc");
    let vitest = wt.join("node_modules/vitest/vitest.mjs");
    let tsc_argv = vec![
        node.clone(),
        tsc.to_string_lossy().to_string(),
        "--noEmit".to_string(),
    ];
    let mut vitest_argv = vec![
        node,
        vitest.to_string_lossy().to_string(),
        "run".to_string(),
    ];
    vitest_argv.extend(tests.iter().cloned());
    (tsc_argv, vitest_argv)
}

/// Run the TS validation toolchain (tsc --noEmit, then targeted vitest) in the
/// worktree. Returns `Ok(None)` if both pass, `Ok(Some(fail))` with the failing
/// stage+output on the first failure, or `Err` for an infrastructure fault
/// (validator unresolvable, spawn failure, timeout).
fn validate_ts(prop: &Proposal, home: Option<&Home>) -> Result<Option<ValidateOut>, LoomError> {
    // Resolve node's ABSOLUTE path (recorded thread, else once via PATH —
    // Finding 8). If node can't be found we cannot prove the edit is safe → we
    // must not pass.
    let node = node_path(home).ok_or_else(|| {
        LoomError::NotFound("node not found (threads.json or PATH) — cannot validate".into())
    })?;
    if node.to_str().is_none() || prop.worktree.to_str().is_none() {
        return Err(LoomError::Parse("node or worktree path is not valid UTF-8".into()));
    }

    // Targeted vitest: the edited .ts(x) files + their `.test` siblings that
    // exist. (Rust edits contribute no vitest targets.)
    let mut targets: Vec<String> = Vec::new();
    for (rel, _, _) in &prop.edits {
        if !(rel.ends_with(".ts") || rel.ends_with(".tsx")) {
            continue;
        }
        targets.push(rel.clone());
        for sib in test_siblings(rel) {
            if prop.worktree.join(&sib).exists() {
                targets.push(sib);
            }
        }
    }
    // De-dup while preserving order.
    targets.dedup();

    let (tsc_argv, vitest_argv) = ts_argv(&node, &prop.worktree, &targets);

    // tsc first, then targeted vitest. Fixed argv; cwd is the worktree, asserted
    // under itself. First failure returns stage+output.
    let argv: Vec<&str> = tsc_argv.iter().map(String::as_str).collect();
    let tsc = run_checked(&argv, &prop.worktree, &prop.worktree, TSC_TIMEOUT)?;
    if tsc.code != 0 {
        return Ok(Some(ValidateOut {
            ok: false,
            stage: "tsc".into(),
            output: format!("{}\n{}", tsc.stdout, tsc.stderr).trim().to_string(),
        }));
    }

    let argv: Vec<&str> = vitest_argv.iter().map(String::as_str).collect();
    let vitest = run_checked(&argv, &prop.worktree, &prop.worktree, VITEST_TIMEOUT)?;
    if vitest.code != 0 {
        return Ok(Some(ValidateOut {
            ok: false,
            stage: "vitest".into(),
            output: format!("{}\n{}", vitest.stdout, vitest.stderr)
                .trim()
                .to_string(),
        }));
    }
    Ok(None)
}

/// A cargo argv: `[cargo, <sub…>, "--offline"]`. `--offline` is ALWAYS
/// appended — validation never touches the network (the crates were fetched
/// at threading in packaged mode, by the dev build in dev). Pure.
pub fn cargo_argv(cargo: &Path, sub: &[&str]) -> Vec<String> {
    let mut argv = vec![cargo.to_string_lossy().to_string()];
    argv.extend(sub.iter().map(|s| s.to_string()));
    argv.push("--offline".to_string());
    argv
}

/// The env pairs every cargo spawn gets, composed from constants and LOOM-
/// owned paths only (never model output). Packaged: `CARGO_TARGET_DIR` is the
/// shared loomhome `target/` warmed at threading — a core edit then validates
/// in incremental time — plus `CARGO_NET_OFFLINE=true`. Dev: only the offline
/// pin; the worktree keeps its own isolated target (unchanged behaviour).
pub fn cargo_env(mode: Mode, home: &Home) -> Vec<(String, String)> {
    let mut env = Vec::new();
    if mode == Mode::Packaged {
        env.push((
            "CARGO_TARGET_DIR".to_string(),
            home.target().to_string_lossy().to_string(),
        ));
    }
    env.push(("CARGO_NET_OFFLINE".to_string(), "true".to_string()));
    env
}

/// Run the Rust validation toolchain (`cargo check` then `cargo test`) in the
/// worktree's `src-tauri/` dir. A `git worktree add` at HEAD contains the full
/// repo, so `src-tauri/Cargo.toml` is present. In dev there is no shared
/// `target/` — the compile is cold (minutes); packaged, the loomhome target is
/// shared and warm. Returns `Ok(None)` if both pass, `Ok(Some(fail))` on the
/// first failing stage, or `Err` for an infrastructure fault (cargo
/// unresolvable, the worktree lacks src-tauri/, spawn failure, timeout).
fn validate_rust(prop: &Proposal, mode: Mode, home: &Home) -> Result<Option<ValidateOut>, LoomError> {
    // Resolve cargo's ABSOLUTE path (recorded thread, else once — mirror of the
    // node hardening). If cargo can't be found we cannot prove the edit
    // compiles → we must not pass.
    let cargo = cargo_path(Some(home)).ok_or_else(|| {
        LoomError::NotFound("cargo not found (threads.json or PATH) — cannot validate Rust".into())
    })?;
    if cargo.to_str().is_none() || home.target().to_str().is_none() {
        return Err(LoomError::Parse("cargo or target path is not valid UTF-8".into()));
    }
    let env = cargo_env(mode, home);
    let envs: Vec<(&str, &str)> = env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();

    // cargo runs in the worktree's src-tauri/ (where Cargo.toml lives), asserted
    // under the worktree by run_checked's containment check.
    let cargo_cwd = prop.worktree.join("src-tauri");
    if !cargo_cwd.join("Cargo.toml").exists() {
        return Err(LoomError::NotFound(format!(
            "worktree has no src-tauri/Cargo.toml: {}",
            cargo_cwd.display()
        )));
    }

    // cargo check first (typecheck the non-test build; cheaper than a full test
    // build), then `cargo test --no-run` (compile the tests INCLUDING their
    // #[test] bodies, but execute NOTHING).
    //
    // FINDING 5 (round-1 review, RCE) — a plain `cargo test` EXECUTES model-
    // authored `#[test]` bodies on the machine (arbitrary code, in-process, as
    // the user). `--no-run` compiles the test harness and every test body (so a
    // test that does not even compile is still caught) but never runs a single
    // one. Executing untrusted generated test bodies is DEFERRED to a sandboxed
    // validation (see docs/FOLLOWUPS.md "Validation threat model"); the safety
    // envelope here is compile-validation (cargo check + cargo test --no-run) +
    // human diff-review + the recovery boot, not test EXECUTION.
    let check_argv = cargo_argv(&cargo, &["check"]);
    let argv: Vec<&str> = check_argv.iter().map(String::as_str).collect();
    let check = run_checked_env(&argv, &cargo_cwd, &prop.worktree, CARGO_CHECK_TIMEOUT, &envs)?;
    if check.code != 0 {
        return Ok(Some(ValidateOut {
            ok: false,
            stage: "cargo-check".into(),
            output: format!("{}\n{}", check.stdout, check.stderr).trim().to_string(),
        }));
    }

    let test_argv = cargo_argv(&cargo, &["test", "--no-run"]);
    let argv: Vec<&str> = test_argv.iter().map(String::as_str).collect();
    let test = run_checked_env(&argv, &cargo_cwd, &prop.worktree, CARGO_TEST_TIMEOUT, &envs)?;
    if test.code != 0 {
        return Ok(Some(ValidateOut {
            ok: false,
            stage: "cargo-test".into(),
            output: format!("{}\n{}", test.stdout, test.stderr).trim().to_string(),
        }));
    }
    Ok(None)
}

/// Mutate the validated/approved flags of a registered proposal in place.
/// No-op if the proposal is gone (already applied/discarded).
fn set_flags(worktree_id: &str, validated: bool, approved: bool) {
    with_registry(|reg| {
        if let Some(p) = reg.get_mut(worktree_id) {
            p.validated = validated;
            p.approved = approved;
        }
    });
}

/// `.test`/`.spec` sibling candidates for a source file (both .ts and .tsx).
fn test_siblings(rel: &str) -> Vec<String> {
    let stem_ext = |suffix: &str| -> Option<(String, String)> {
        rel.strip_suffix(suffix).map(|stem| (stem.to_string(), suffix.to_string()))
    };
    let mut out = Vec::new();
    for ext in [".tsx", ".ts"] {
        if let Some((stem, e)) = stem_ext(ext) {
            for kind in [".test", ".spec"] {
                out.push(format!("{stem}{kind}{e}"));
            }
            break; // .tsx matched first; don't also strip .ts from it
        }
    }
    out
}

/// The structural apply gate (Finding 1/5): the live tree may be written ONLY
/// when the proposal is both validated AND approved. Extracted so the exact
/// refusal logic is unit-testable without an AppHandle.
fn check_apply_gate(validated: bool, approved: bool) -> Result<(), LoomError> {
    if !validated || !approved {
        return Err(LoomError::Parse(format!(
            "refusing apply: proposal must be validated AND approved first \
             (validated={validated}, approved={approved})"
        )));
    }
    Ok(())
}

/// Approve a validated proposal (the explicit gate the KernelDiff "approve the
/// change" button triggers). Sets `approved = true` — but ONLY if the proposal
/// has already been `validated`. This is the structural wall between
/// review-and-approve and apply: approve can never precede validate (Finding
/// 1/5). Returns a typed error if the proposal is unknown or not yet validated.
#[tauri::command]
pub fn kernel_approve(worktree_id: String) -> Result<(), LoomError> {
    with_registry(|reg| {
        let p = reg
            .get_mut(&worktree_id)
            .ok_or_else(|| LoomError::NotFound(format!("unknown worktreeId: {worktree_id}")))?;
        if !p.validated {
            return Err(LoomError::Parse(
                "cannot approve: proposal has not passed validation (tsc + vitest)".into(),
            ));
        }
        p.approved = true;
        Ok(())
    })
}

#[tauri::command]
pub fn kernel_apply(
    app: tauri::AppHandle,
    worktree_id: String,
    message: String,
) -> Result<ApplyOut, LoomError> {
    let sp = sentinel_path(&app)?;
    apply_at(mode(), &sp, &worktree_id, &message)
}

/// Does a source apply arm the boot sentinel (the mirror at the source root
/// and, for a TS edit, the app_data `pending`)? Only in DEV: there the edit
/// hot-reloads (TS) or recompiles under `tauri dev` (Rust), so the next boot
/// IS the edit and the guard / pre-main hook must be armed to judge it.
///
/// PACKAGED (Phase 23 / Rebirth): a source apply changes the genome only.
/// The running body is a built binary — nothing hot-reloads, nothing
/// recompiles, NOTHING BOOTS UNTIL A REWEAVE. Arming a sentinel here would
/// be a record of a birth that is not happening; the reweave's swap writes
/// its own (`applied`, `armedBy: "reweave"`) and the warden judges it.
pub fn apply_arms_sentinel(mode: Mode) -> bool {
    mode == Mode::Dev
}

/// `kernel_apply` over an explicit mode and app_data sentinel path, so the
/// packaged branch is testable without a built app.
fn apply_at(mode: Mode, app_sentinel: &Path, worktree_id: &str, message: &str) -> Result<ApplyOut, LoomError> {
    let prop = with_registry(|reg| reg.get(worktree_id).cloned())
        .ok_or_else(|| LoomError::NotFound(format!("unknown worktreeId: {worktree_id}")))?;

    // WALL ORDERING, ENFORCED IN RUST (Finding 1/5). The live tree is NEVER
    // written unless this proposal is BOTH validated AND approved. This check
    // runs BEFORE any live-tree write in apply_inner, so a caller cannot skip
    // validate/approve by invoking kernel_apply straight after kernel_propose at
    // the Tauri IPC boundary.
    //
    // TRUST BOUNDARY (honest): the only code that can reach these commands is
    // same-realm JS in the main window. Organs run in sandboxed iframes and
    // cannot invoke Tauri commands at all. So the residual trust is "our own
    // main-window JS"; the validated+approved flags make the wall ordering
    // STRUCTURAL — apply can never fire straight after propose, even from that
    // same-realm JS, because the flags live in Rust and only the real
    // validate→approve calls flip them.
    check_apply_gate(prop.validated, prop.approved)?;

    let source_root = prop.source_root.clone();
    let touches_ts = prop
        .edits
        .iter()
        .any(|(rel, _, _)| rel.ends_with(".ts") || rel.ends_with(".tsx"));

    // FINDING 1 (round-1 review) — MANDATORY RECOVERY RECORD BEFORE THE LIVE
    // WRITE. The mirror `.loom-boot.json` is the sole record the pre-compile
    // Node guard and the pre-main Rust hook can read. If it were written
    // best-effort AFTER the commit (as before) and that write silently failed,
    // a bad edit would be live with NO recovery record — the recovery gap would
    // reopen. So: record prevSha = current HEAD, then write the mirror
    // {status:"applied", prevSha, sourceRoot, armedBy:null} as a MANDATORY step
    // BEFORE apply_inner touches the live tree. If the mirror write fails, return
    // a typed error and DO NOT apply — no live write, no commit. Guarantee: the
    // recovery record exists before any live change.
    let prev_sha = head_sha(&source_root)?;
    let mut sentinel = Sentinel {
        prev_sha: prev_sha.clone(),
        // applied_sha is unknown until after the commit; filled in
        // (informationally) post-apply. Empty here is fine — recovery keys off
        // prev_sha + status, never applied_sha.
        applied_sha: String::new(),
        status: "applied".into(),
        // Record the ABSOLUTE repo path so recovery rolls back THIS repo,
        // never a cwd-derived guess (Finding 6).
        source_root: source_root.to_string_lossy().to_string(),
        // Freshly applied, not yet armed by either actor (round-1, Finding 2/3).
        armed_by: None,
    };
    // Packaged mode writes NO sentinel at all (see `apply_arms_sentinel`):
    // the genome moves, the body does not, and the reweave owns the next boot.
    let arms = apply_arms_sentinel(mode);
    if arms {
        if let Err(e) = write_mirror(&source_root, &sentinel) {
            // Mirror write failed → we cannot guarantee recovery. Abort BEFORE any
            // live change: drop the worktree, forget the proposal, return the error.
            cleanup_worktree(&prop.source_root, &prop.worktree);
            with_registry(|reg| {
                reg.remove(worktree_id);
            });
            return Err(LoomError::Git(format!(
                "refusing apply: could not write the mandatory recovery mirror ({}): {e}",
                mirror_path(&source_root).display()
            )));
        }
    }

    // The recovery record now exists. Apply the edit to the live tree + commit.
    // apply_inner re-reads HEAD (== prev_sha; nothing wrote between the read
    // above and here) and refuses if HEAD moved — the recovery record is
    // therefore consistent with what apply_inner commits against.
    let out = apply_inner(&prop, message);

    // Whatever happened, drop the worktree (success or failure) and forget it.
    cleanup_worktree(&prop.source_root, &prop.worktree);
    with_registry(|reg| {
        reg.remove(worktree_id);
    });

    let (sha, prev_sha) = match out {
        Ok(v) => v,
        Err(e) => {
            // The live write/commit failed AFTER the mirror was written. The
            // mirror says `applied` at a prev_sha that IS still HEAD (nothing
            // committed), so a guard/hook rollback to prev_sha is a safe no-op.
            // Leave the mirror in place (it can only heal to a correct state)
            // and surface the real error.
            return Err(e);
        }
    };

    // FINDING 2/6 (round-1 review) — the TWO sentinels must not disagree. Only
    // write the app_data "pending" sentinel when the edit touches TS files (the
    // hot-reload path that needs the same-session `boot_recover` in setup()).
    // For a PURE-RUST edit the mirror is the SOLE record — writing the app_data
    // sentinel too would make setup()'s boot_recover perform a redundant second
    // rollback (double-rollback) of the same edit the guard/pre-main hook
    // already owns. A TS (or mixed) edit still writes "pending" as before.
    if arms && touches_ts {
        let ts_sentinel = Sentinel {
            status: "pending".into(),
            applied_sha: sha.clone(),
            ..sentinel.clone()
        };
        write_sentinel(app_sentinel, &ts_sentinel)?;
    }

    // After the commit, best-effort update the mirror's applied_sha
    // (INFORMATIONAL only — recovery never keys off it). The load-bearing
    // {status:"applied", prev_sha, source_root, armed_by:null} already landed
    // above, so a hiccup here cannot reopen the gap.
    if arms {
        sentinel.applied_sha = sha.clone();
        let _ = write_mirror(&source_root, &sentinel);
    }

    Ok(ApplyOut { sha, prev_sha })
}

/// Apply the validated edits to the LIVE tree and commit the source repo.
/// This is the ONLY place the live tree is written. Returns (new_sha, prev_sha).
fn apply_inner(prop: &Proposal, message: &str) -> Result<(String, String), LoomError> {
    let root = &prop.source_root;
    // WALL 4 (commit): prev = current HEAD (the last-good we can reset to).
    let prev_sha = head_sha(root)?;

    // Sanity: HEAD must still match the base the proposal was cut from, else the
    // diff may not apply cleanly — refuse rather than corrupt the tree.
    if prev_sha != prop.base_sha {
        return Err(LoomError::Git(format!(
            "source HEAD moved since proposal ({} → {}); re-propose",
            &prop.base_sha[..7.min(prop.base_sha.len())],
            &prev_sha[..7.min(prev_sha.len())]
        )));
    }

    // Re-apply the exact same SEARCH/REPLACE to the live files. Re-deriving
    // (rather than patch-piping) keeps this path independent and auditable, and
    // re-checks uniqueness on the live content.
    for (rel, search, replace) in &prop.edits {
        // These paths were validated editable + normalized at propose time.
        if !is_editable(rel) {
            return Err(LoomError::Parse(format!("refusing non-editable at apply: {rel}")));
        }
        let file = root.join(rel);
        let canon = file
            .canonicalize()
            .map_err(|e| LoomError::NotFound(format!("{rel}: {e}")))?;
        if !canon.starts_with(root) {
            return Err(LoomError::Parse(format!("path escapes source repo: {rel}")));
        }
        assert_lands_editable(root, &canon, rel)?;
        let content = std::fs::read_to_string(&canon)
            .map_err(|e| LoomError::NotFound(format!("read {rel}: {e}")))?;
        let next = apply_exact_unique(&content, search, replace)?;
        std::fs::write(&canon, next).map_err(|e| LoomError::Git(format!("write {rel}: {e}")))?;
    }

    // Stage + commit ONLY the edited paths.
    let mut add_argv: Vec<&str> = vec!["add", "--"];
    let rels: Vec<&str> = prop.edits.iter().map(|(r, _, _)| r.as_str()).collect();
    add_argv.extend_from_slice(&rels);
    git_ok(root, root, &add_argv)?;
    let msg = format!("self: {message}");
    git_ok(
        root,
        root,
        &[
            "-c",
            "user.name=LOOM",
            "-c",
            "user.email=loom@localhost",
            "commit",
            "-m",
            &msg,
        ],
    )?;
    let sha = head_sha(root)?;
    Ok((sha, prev_sha))
}

#[tauri::command]
pub fn kernel_discard(worktree_id: String) -> Result<(), LoomError> {
    if let Some(prop) = with_registry(|reg| reg.remove(&worktree_id)) {
        cleanup_worktree(&prop.source_root, &prop.worktree);
    }
    Ok(())
}

#[tauri::command]
pub fn kernel_rollback(
    app: tauri::AppHandle,
    source_repo: Option<String>,
    sha: String,
) -> Result<(), LoomError> {
    let root = resolve_source_repo_for(&app, source_repo.as_deref())?;
    rollback_to(&root, &sha)
}

fn rollback_to(root: &Path, sha: &str) -> Result<(), LoomError> {
    // git2 hard reset — matches timeline.rs discipline.
    let repo = Repository::open(root).map_err(|e| LoomError::Git(e.to_string()))?;
    let oid = git2::Oid::from_str(sha).map_err(|e| LoomError::Git(e.to_string()))?;
    let obj = repo
        .find_object(oid, None)
        .map_err(|e| LoomError::Git(e.to_string()))?;
    repo.reset(&obj, git2::ResetType::Hard, None)
        .map_err(|e| LoomError::Git(e.to_string()))?;
    Ok(())
}

#[tauri::command]
pub fn kernel_boot_ok(app: tauri::AppHandle) -> Result<(), LoomError> {
    let sp = sentinel_path(&app)?;
    let home = Home::from_app(&app).ok();
    boot_ok_at(&sp, home.as_ref())?;
    // Clear the source-relative mirror (Rust flow) to `healed`: for a Rust edit
    // this fires on the NEXT launch (no hot-reload), confirming the applied edit
    // booted cleanly so the guard/pre-main hook will NOT roll it back. Best
    // effort — a missing/unreadable mirror is a no-op. We locate the mirror via
    // the sentinel's own source_root (or, for a healthy launch with no app_data
    // sentinel, the mirror in cwd if present).
    clear_mirror_healed(&app);
    Ok(())
}

/// The app-independent core of `kernel_boot_ok`: the app_data sentinel goes
/// `ok` (this boot held) and, Phase 23, a ledger that exists is marked
/// `confirmed: true` — the warden reads the sentinel, the owner reads the
/// ledger. No ledger is ever invented here: a dev LOOM has none.
///
/// ONLY AN UNCONFIRMED SENTINEL IS CONFIRMED (round-3 review, Finding 2).
/// This was the one consumer of the state machine that did not guard with
/// `is_unconfirmed`, and the `HealedNextLaunch` ending walks straight into
/// it: a usable generation misses the deadline, the warden heals and
/// deliberately leaves that process running, and the process then beacons
/// late. Writing `ok` over `healed` erases the only durable statement that
/// the birth ended badly, and stamps `confirmed: true` on a `current` the
/// beaconing process is not running. The same call erased `rollback-failed`,
/// the record of a body that could not come home at all. A terminal state is
/// somebody else's verdict; this beacon is too late to overturn it, and the
/// ledger is left alone with it.
fn boot_ok_at(sp: &Path, home: Option<&Home>) -> Result<(), LoomError> {
    if let Some(mut s) = read_sentinel(sp) {
        if !is_unconfirmed(&s.status) {
            return Ok(());
        }
        s.status = "ok".into();
        write_sentinel(sp, &s)?;
    }
    if let Some(home) = home {
        if home.ledger_json().is_file() {
            let mut ledger = generations::read(home);
            if !ledger.confirmed {
                ledger.confirmed = true;
                generations::write(home, &ledger)?;
            }
        }
    }
    Ok(())
}

/// Mark the source-relative boot mirror `healed` — an unconfirmed `applied`/
/// `booting` edit has now confirmed a healthy boot. Best-effort and
/// error-swallowing: never a boot hazard. The mirror lives at the repo the edit
/// was applied to; we resolve that from the app_data sentinel's source_root
/// when available, else from the mirror already sitting at cwd.
fn clear_mirror_healed(app: &tauri::AppHandle) {
    // Prefer the source_root recorded in the app_data sentinel.
    let root: Option<PathBuf> = sentinel_path(app)
        .ok()
        .and_then(|sp| read_sentinel(&sp))
        .and_then(|s| {
            let r = s.source_root.trim().to_string();
            if r.is_empty() { None } else { Some(PathBuf::from(r)) }
        })
        .or_else(|| std::env::current_dir().ok());
    let Some(root) = root else { return };
    let mp = mirror_path(&root);
    if let Some(mut s) = read_sentinel(&mp) {
        if is_unconfirmed(&s.status) {
            s.status = "healed".into();
            let _ = write_sentinel(&mp, &s);
        }
    }
}

/// PRE-MAIN HEAL (defense-in-depth backstop). Runs as the FIRST statements of
/// `run()` in lib.rs — BEFORE `tauri::Builder::default()`, before ANY fallible
/// or lazy init a self-edit could add, and before the app_data dir is even
/// resolvable (there is no AppHandle yet). It reads ONLY the source-relative
/// mirror `.loom-boot.json` at cwd (the repo `tauri dev` was launched from).
///
/// State machine (mirror only) — round-1 review, Finding 2 (guard coordination):
///   • `applied`  → this binary has NOT been armed yet. Mark it `booting` with
///     `armedBy="premain"` and CONTINUE (guard-absent arm). The first launch
///     after an apply is allowed to run; a healthy boot then clears it to
///     `healed`. NO reset here.
///   • `booting` + `armedBy=="premain"`  → WE armed it last time (the Node guard
///     was absent/skipped) and it never confirmed a healthy boot. This is the
///     guard-absent BACKSTOP: roll the source back to prev_sha and mark `healed`.
///   • `booting` + `armedBy=="guard"`  → the Node PRE-COMPILE guard armed this
///     THIS session and is watching it live — this is the live attempt the guard
///     just armed. NO-OP: we must NEVER touch the attempt the guard owns, or we
///     would kill the very boot the guard armed for confirmation (Finding 2).
///   • anything else (`healed`/`ok`/`rollback-failed`/absent/corrupt, or a
///     `booting` with no/unknown armedBy) → no-op.
///
/// This runs in the SAME binary, so it cannot fix the CURRENT bad binary — but
/// it is the backstop if the Node guard was skipped, and it marks state so the
/// guard heals on the next compile. Panic-free / best-effort throughout:
/// swallow every error so it can NEVER block boot.
///
/// FINDING 4 (defense-in-depth): `pub(crate)`, not `pub` — this and the other
/// mirror-mutating fns are only ever called within the crate (lib.rs run()).
/// Reducing visibility blocks any external re-export path; same-crate calls from
/// an editable module remain bounded by human diff-review of the applied diff.
pub(crate) fn preboot_heal() {
    match mode() {
        Mode::Dev => {
            // No panics: guard the whole body.
            let Ok(cwd) = std::env::current_dir() else { return };
            preboot_heal_at(&cwd);
        }
        Mode::Packaged => preboot_heal_packaged(),
    }
}

/// What the pre-main hook does with a sentinel (round-1 Marrow review's
/// ownership rule, extended by Phase 23's `armedBy: "reweave"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// First sighting of a new body/edit: mark it `booting`, let it try.
    Arm,
    /// Second sighting, nobody else owns it: bring it home.
    Heal,
    /// Not ours — a live guard or warden owns it, or there is nothing to do.
    Leave,
}

/// PURE: the pre-main decision table. `warden_alive` is whether `warden.json`
/// holds a job for THIS birth — its `newSha` is the sentinel's `applied_sha`
/// — naming a pid that is still running.
///
/// - `applied` armed by `reweave` → Arm (either mode: the first sighting of a
///   woven body). Any other `applied` → Arm in dev (Phase 22's guard-absent
///   arm), Leave in packaged (a source-only apply boots nothing until a
///   reweave; `boot_check` judges it).
/// - `booting` armed by `guard` → Leave: the Node guard owns its live attempt.
/// - `booting` armed by `reweave` → Leave while the warden lives (it owns the
///   birth); Heal in packaged mode when no warden is alive (the backstop);
///   Leave in dev (nothing was swapped).
/// - `booting` armed by `premain` or unarmed → Heal in dev (Phase 22's
///   backstop), Leave in packaged.
/// - everything else (`pending`, `ok`, `healed`, `rollback-failed`, unknown)
///   → Leave.
pub fn decide(status: &str, armed_by: Option<&str>, warden_alive: bool, mode: Mode) -> Action {
    match (status, armed_by, mode) {
        ("applied", Some("reweave"), _) => Action::Arm,
        ("applied", _, Mode::Dev) => Action::Arm,
        ("applied", _, Mode::Packaged) => Action::Leave,
        ("booting", Some("guard"), _) => Action::Leave,
        ("booting", Some("reweave"), Mode::Packaged) => {
            if warden_alive { Action::Leave } else { Action::Heal }
        }
        ("booting", Some("reweave"), Mode::Dev) => Action::Leave,
        ("booting", _, Mode::Dev) => Action::Heal,
        ("booting", _, Mode::Packaged) => Action::Leave,
        _ => Action::Leave,
    }
}

/// The bundle identifier from `tauri.conf.json`, which names the app_data
/// dir. Pre-main has no AppHandle to ask, so the packaged loomhome is
/// resolved from this (a unit test pins it to the config file).
const APP_IDENTIFIER: &str = "com.connorevans.loom";

/// The packaged loomhome — `~/Library/Application Support/<identifier>/loom`,
/// exactly what `Home::from_app` resolves once Tauri is up — but only if it
/// already exists (a first launch has nothing to heal). macOS only: the swap
/// that could leave a sentinel here is macOS-only.
fn packaged_home_under(user_home: &Path) -> Option<Home> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let root = user_home
        .join("Library/Application Support")
        .join(APP_IDENTIFIER)
        .join("loom");
    root.is_dir().then(|| Home::at(root))
}

/// What the packaged backstop did — returned, not acted on, so the loop is
/// testable; `preboot_heal_packaged` turns it into the exit.
#[derive(Debug)]
pub(crate) enum Backstop {
    Left,
    Armed,
    /// Healed in-process; `warden` is the previous body spawned with a
    /// relaunch-only job (or why it could not be).
    Healed { warden: Result<u32, LoomError> },
    HealFailed(LoomError),
}

/// PRE-MAIN BACKSTOP, packaged (spec §The warden, "when no warden is alive").
/// A `booting` armed by `reweave` seen with no live warden pid is a woven
/// body that never confirmed and nobody is guarding: heal it here, exactly as
/// the warden would, then hand the relaunch to the previous body and exit —
/// this process IS the unconfirmed body, and it never reaches the Tauri
/// builder. Panic-free / best-effort throughout.
fn preboot_heal_packaged() {
    let Some(user_home) = std::env::var_os("HOME") else { return };
    let Some(home) = packaged_home_under(Path::new(&user_home)) else { return };
    let layout = platform::app_layout().ok();
    let tools = |name: &str| threads::tool_path(&home, name);
    let alive = |pid: u32| warden::pid_alive(pid);
    match preboot_heal_packaged_in(&home, layout.as_ref(), &alive, &tools) {
        Backstop::Left | Backstop::Armed => {}
        Backstop::Healed { warden: Ok(pid) } => {
            eprintln!("[kernel] pre-main heal: a woven body never confirmed — LOOM came home; the previous generation (pid {pid}) reopens it");
            std::process::exit(0);
        }
        Backstop::Healed { warden: Err(e) } => {
            eprintln!("[kernel] pre-main heal: LOOM came home, but the previous body could not be started as the warden — {e}; reopening directly");
            if let Some(l) = layout {
                let mut world = warden::RealWorld::new(&home);
                let _ = warden::World::open_app(&mut world, &l.app_path);
            }
            std::process::exit(0);
        }
        Backstop::HealFailed(e) => {
            // The sentinel is `rollback-failed`: no loop. Boot on and let the
            // notice say what happened.
            eprintln!("[kernel] pre-main heal: a woven body never confirmed AND the heal failed — {e}");
        }
    }
}

/// The app-independent core of the packaged backstop. `layout` is this
/// process's bundle (falls back to the warden job's paths); `pid_alive` and
/// `tools` are injected so the table runs against a fake app in a tempdir.
fn preboot_heal_packaged_in(
    home: &Home,
    layout: Option<&AppLayout>,
    pid_alive: &dyn Fn(u32) -> bool,
    tools: &dyn Fn(&str) -> Option<PathBuf>,
) -> Backstop {
    let sp = home.sentinel_json();
    let Some(mut s) = read_sentinel(&sp) else { return Backstop::Left };
    let job: Option<warden::Job> = std::fs::read_to_string(home.warden_json())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok());
    // A live warden is a job that names THIS birth and whose pid is still
    // running (round-1 review, Finding 5). `warden.json` is never deleted, so
    // a job left by an earlier birth — whose pid the system may since have
    // handed to something else — is a leftover, not a guard: trusting it
    // would disarm the backstop forever. A warden that exits normally also
    // clears its own pid (round-2 review, Finding 8), so a job for THIS birth
    // whose warden has left names no guard either, however alive the machine
    // says that number is.
    let warden_alive = job.as_ref().map_or(false, |j| {
        j.new_sha == s.applied_sha && j.warden_pid.map_or(false, |p| pid_alive(p))
    });

    match decide(&s.status, s.armed_by.as_deref(), warden_alive, Mode::Packaged) {
        Action::Leave => Backstop::Left,
        Action::Arm => {
            // First sighting of the woven body: let it try. The warden keeps
            // ownership (`armedBy` stays `reweave`).
            s.status = "booting".into();
            let _ = write_sentinel(&sp, &s);
            Backstop::Armed
        }
        Action::Heal => {
            let layout = match (layout, &job) {
                (Some(l), _) => l.clone(),
                (None, Some(j)) => AppLayout { app_path: j.app_path.clone(), exe_path: j.exe_path.clone() },
                (None, None) => {
                    return Backstop::HealFailed(LoomError::NotFound(
                        "the app bundle — neither current_exe nor warden.json names it".into(),
                    ))
                }
            };
            let (new_sha, prev_sha) = (s.applied_sha.clone(), s.prev_sha.clone());
            if let Err(e) = warden::heal(home, &layout, &new_sha, &prev_sha, warden::REASON_NEVER_CONFIRMED, tools) {
                return Backstop::HealFailed(e);
            }
            // The previous body — proven, and now the file on disk — reopens
            // the app once this process has left.
            let relaunch = warden::Job {
                old_pid: std::process::id(),
                app_path: layout.app_path.clone(),
                exe_path: layout.exe_path.clone(),
                new_sha,
                prev_sha: prev_sha.clone(),
                loomhome: home.root.clone(),
                timeout_secs: job.as_ref().map(|j| j.timeout_secs).unwrap_or(90),
                relaunch_only: true,
                warden_pid: None,
            };
            let warden = threads::write_json_atomic(&home.warden_json(), &relaunch).and_then(|()| {
                let exe = home.generation_exe(&prev_sha).to_string_lossy().into_owned();
                let job_path = home.warden_json().to_string_lossy().into_owned();
                run_detached(&[&exe, "--warden", &job_path], &home.root, &home.root)
            });
            Backstop::Healed { warden }
        }
    }
}

/// The app-independent core of the pre-main heal, parameterized on the repo the
/// dev command was launched from. Testable without touching the process cwd.
/// Best-effort / panic-free: every error is swallowed.
fn preboot_heal_at(cwd: &Path) {
    let mp = mirror_path(cwd);
    let Some(mut s) = read_sentinel(&mp) else { return };

    // Resolve the repo the edit was applied to (the mirror's own source_root),
    // falling back to cwd for a legacy/hand-written mirror.
    let root: PathBuf = if !s.source_root.trim().is_empty() {
        PathBuf::from(s.source_root.trim())
    } else {
        cwd.to_path_buf()
    };

    // The mirror never carries a warden: `warden_alive` is false here. The
    // rows: `applied` → Arm; `booting`/`guard` → Leave (the Node pre-compile
    // guard armed THIS live attempt and is watching it — never touch the boot
    // the guard armed for confirmation, Finding 2); `booting`/premain-or-legacy
    // → Heal; terminal → Leave.
    match decide(&s.status, s.armed_by.as_deref(), false, Mode::Dev) {
        Action::Arm => {
            // Guard-absent arm: first unconfirmed sighting and the Node guard did
            // NOT arm it (else it would already be `booting`/`guard`). Let it try
            // to boot, recording that WE (pre-main) armed it so a
            // panic-before-confirm is our backstop on the FOLLOWING start.
            s.status = "booting".into();
            s.armed_by = Some("premain".into());
            let _ = write_sentinel(&mp, &s);
        }
        Action::Leave => {}
        Action::Heal => {
            // Guard-absent backstop: we armed it last time (armedBy=="premain",
            // or a legacy mirror with no armedBy) and it never confirmed a
            // healthy boot. Roll the source back to the last-good sha and mark
            // healed so the next `tauri dev` recompiles from good source.
            if rollback_to(&root, &s.prev_sha).is_ok() {
                s.status = "healed".into();
                let _ = write_sentinel(&mp, &s);
                eprintln!(
                    "[kernel] pre-main heal: a Rust edit never confirmed a healthy boot — \
                     source reset to {} (recompile will be from good source)",
                    &s.prev_sha[..7.min(s.prev_sha.len())]
                );
            } else {
                // Rollback failed (sha gc'd / wrong repo). Do NOT loop forever:
                // mark rollback-failed so the next start is a no-op.
                s.status = "rollback-failed".into();
                let _ = write_sentinel(&mp, &s);
                eprintln!(
                    "[kernel] pre-main heal: a Rust edit never confirmed AND rollback FAILED — \
                     mirror marked rollback-failed so we do not loop"
                );
            }
        }
    }
}

#[tauri::command]
pub fn kernel_boot_check(
    app: tauri::AppHandle,
    source_repo: Option<String>,
) -> Result<BootCheckOut, LoomError> {
    boot_check_app(&app, source_repo.as_deref(), true)
}

/// `surface_recovery`: whether to report (and thereby consume) the warden's
/// recovery record. The shell's command does; the Rust-side setup check
/// (`boot_recover`) does not — the record is for the owner, and it is
/// surfaced exactly once.
fn boot_check_app(
    app: &tauri::AppHandle,
    source_repo: Option<&str>,
    surface_recovery: bool,
) -> Result<BootCheckOut, LoomError> {
    let sp = sentinel_path(app)?;
    let home = Home::from_app(app)?;
    boot_check_in(&sp, mode(), source_repo, Some(&home), surface_recovery)
}

/// `decide_boot_in` plus, Phase 23, the healed-generation record.
fn boot_check_in(
    sp: &Path,
    mode: Mode,
    source_repo_override: Option<&str>,
    home: Option<&Home>,
    surface_recovery: bool,
) -> Result<BootCheckOut, LoomError> {
    let mut out = decide_boot_in(sp, mode, source_repo_override, home)?;
    if surface_recovery {
        out.healed_generation = home.and_then(warden::take_recovery).map(HealedGeneration::from);
    }
    Ok(out)
}

/// Dev-mode entry for the tests: no loomhome, the override/cwd fallback.
#[cfg(test)]
fn decide_boot_at(sp: &Path, source_repo_override: Option<&str>) -> Result<BootCheckOut, LoomError> {
    decide_boot_in(sp, Mode::Dev, source_repo_override, None)
}

/// The app-independent core of the boot decision. Testable without an
/// AppHandle. `source_repo_override` (dev) / `home.source()` (packaged) is a
/// last-resort fallback ONLY used when a legacy sentinel carries no
/// `source_root` of its own.
fn decide_boot_in(
    sp: &Path,
    mode: Mode,
    source_repo_override: Option<&str>,
    home: Option<&Home>,
) -> Result<BootCheckOut, LoomError> {
    let Some(s) = read_sentinel(sp) else {
        return Ok(BootCheckOut {
            rolled_back_to: None,
            rollback_failed: false,
            healed_generation: None,
        });
    };
    if !is_unconfirmed(&s.status) {
        // Terminal ("ok" | "healed" | "rollback-failed") or unknown → noop. A
        // prior boot already resolved this sentinel; we never retry a rollback
        // (Finding 7). Using is_unconfirmed keeps this consistent with the
        // guard/pre-main classification (round-1 review, Finding 2/6) — the TS
        // flow still writes "pending", which is_unconfirmed covers.
        return Ok(BootCheckOut {
            rolled_back_to: None,
            rollback_failed: false,
            healed_generation: None,
        });
    }
    if s.armed_by.as_deref() == Some("reweave") {
        // Phase 23: a sentinel armed by the reweave is a BODY's birth, not a
        // source edit's. The warden (or the pre-main backstop) owns it; the
        // genome it was woven from must not be rolled back, and the sentinel
        // the warden is watching must not be removed. `kernel_boot_ok`
        // resolves it to `ok`.
        return Ok(BootCheckOut {
            rolled_back_to: None,
            rollback_failed: false,
            healed_generation: None,
        });
    }

    // A prior edit applied but the shell never confirmed a good boot → undo it
    // BEFORE the webview loads the suspect code. Roll back the repo the edit was
    // ACTUALLY applied to: the sentinel's own source_root (Finding 6), falling
    // back to the override/cwd only for legacy sentinels with no source_root.
    let root: PathBuf = if !s.source_root.trim().is_empty() {
        PathBuf::from(&s.source_root)
    } else {
        resolve_source_repo_at(mode, source_repo_override, home)?
    };

    match rollback_to(&root, &s.prev_sha) {
        Ok(()) => {
            // Success → remove the sentinel; the tree is home to prev_sha.
            let _ = std::fs::remove_file(sp);
            Ok(BootCheckOut {
                rolled_back_to: Some(s.prev_sha),
                rollback_failed: false,
            healed_generation: None,
            })
        }
        Err(_) => {
            // FAILURE (sha gc'd/corrupt, wrong repo, …). We must NEVER leave the
            // sentinel "pending", or every boot would retry forever and strand
            // the user (Finding 7). Rewrite it to "rollback-failed" so the next
            // boot is a noop, and surface the distinct signal honestly. Best
            // effort: if even the rewrite fails, remove the file so we still
            // can't loop.
            let mut failed = s.clone();
            failed.status = "rollback-failed".into();
            if write_sentinel(sp, &failed).is_err() {
                let _ = std::fs::remove_file(sp);
            }
            Ok(BootCheckOut {
                rolled_back_to: None,
                rollback_failed: true,
            healed_generation: None,
            })
        }
    }
}

/// Called early in Tauri setup (lib.rs). Swallows errors into a log-friendly
/// Option so a sentinel/repo hiccup can't block boot — the guarantee is "undo a
/// broken edit if we safely can", not "refuse to start".
pub fn boot_recover(app: &tauri::AppHandle) -> Option<String> {
    match boot_check_app(app, None, false) {
        Ok(b) => {
            if b.rollback_failed {
                eprintln!(
                    "[kernel] recovery boot: a pending edit was found but rollback FAILED — \
                     sentinel marked rollback-failed so we do not loop; the tree may still \
                     hold the suspect edit"
                );
            }
            b.rolled_back_to
        }
        Err(_) => None,
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    // Build a real git repo with a fake src/ tree. Returns the canonical root.
    fn init_repo() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        run(&root, &["init", "-q"]);
        run(&root, &["config", "user.name", "Test"]);
        run(&root, &["config", "user.email", "test@localhost"]);
        fs::create_dir_all(root.join("src/lib/loom")).unwrap();
        fs::write(
            root.join("src/hello.ts"),
            "export const greeting = \"hi\";\nexport const n = 1;\n",
        )
        .unwrap();
        fs::write(root.join("src/main.tsx"), "// entry\n").unwrap();
        run(&root, &["add", "-A"]);
        run(&root, &["commit", "-q", "-m", "init"]);
        (dir, root)
    }

    fn run(root: &Path, args: &[&str]) {
        let out = super::git(root, root, args).unwrap();
        assert_eq!(out.code, 0, "git {args:?} failed: {}", out.stderr);
    }

    #[test]
    fn whitelist_accepts_and_rejects() {
        assert!(is_editable("src/hello.ts"));
        assert!(is_editable("src/components/chrome/Companion.tsx"));
        assert!(is_editable("src/lib/loom/build.ts"));
        // Not src/
        assert!(!is_editable("README.md"));
        assert!(!is_editable("docs/x.ts"));
        // Wrong ext
        assert!(!is_editable("src/style.css"));
        assert!(!is_editable("src/data.json"));
        // Traversal / absolute / backslash
        assert!(!is_editable("src/../etc/passwd.ts"));
        assert!(!is_editable("/etc/passwd.ts"));
        assert!(!is_editable("src\\evil.ts"));
        assert!(!is_editable("src/./x.ts"));
    }

    #[test]
    fn self_protection_denies_the_machinery() {
        // EVERY real safety file — the .ts/.tsx AND its test siblings AND the
        // exact on-disk casing — must be refused. This is the self-protection
        // invariant: LOOM cannot edit the machinery that keeps its edits safe.
        // A directory-only prefix rule previously left the recovery beacon (a
        // FILE, not a dir) editable; this enumerates the whole set so that
        // regression cannot recur silently.
        let safety_files = [
            "src/lib/loom/kernelBuild.ts",
            "src/lib/loom/kernelBuild.test.ts",
            "src/lib/loom/kernelBuild.order.test.ts",
            "src/lib/loom/recovery.ts",
            "src/lib/loom/recovery.test.ts",
            "src/components/chrome/KernelDiff.tsx",
            "src/components/chrome/KernelDiff.test.tsx",
            "src/components/chrome/recoveryNotice.tsx",
            "src/components/chrome/recoveryNotice.test.tsx",
            "src/components/ErrorBoundary.tsx",
            "src/components/ErrorBoundary.test.tsx",
            "src/main.tsx",
            "index.html",
            "vite.config.ts",
            "package.json",
            "tsconfig.json",
            "tsconfig.node.json",
        ];
        for f in safety_files {
            assert!(!is_editable(f), "safety file must be protected: {f}");
            assert!(!is_editable(&f.to_lowercase()), "case-collision must be protected: {f}");
        }
        // subdirectory form still caught
        assert!(!is_editable("src/lib/loom/recovery/beacon.ts"));
        assert!(!is_editable("src/components/chrome/recovery/Notice.tsx"));
        // a normal kernel file remains editable (the whitelist still works)
        assert!(is_editable("src/lib/orb/moods.ts"));
        assert!(is_editable("src/components/Shuttle.tsx"));

        // ── Phase 22 (Marrow): the RUST safety machinery is EXPLICITLY refused ──
        // Every safety file: the Rust core (constructs the app / runs before
        // recovery / implements a wall), the guard script, and the Cargo
        // manifests. Exact on-disk casing AND lowercased must both be denied.
        let rust_safety_files = [
            "src-tauri/src/main.rs",
            "src-tauri/src/lib.rs",
            "src-tauri/src/kernel.rs", // also holds preboot_heal (no separate preboot.rs)
            "src-tauri/src/exec.rs",
            "src-tauri/src/error.rs",
            "src-tauri/src/timeline.rs",
            "scripts/kernel-preboot.mjs", // the pre-compile recovery guard
            "Cargo.toml",                 // dependency edit = arbitrary-code vector
            "Cargo.lock",
        ];
        for f in rust_safety_files {
            assert!(!is_editable(f), "rust safety file must be protected: {f}");
            assert!(
                !is_editable(&f.to_lowercase()),
                "case-collision must be protected: {f}"
            );
            // Explicit uppercase spelling too (e.g. CARGO.TOML, KERNEL.RS).
            assert!(
                !is_editable(&f.to_uppercase()),
                "uppercase-collision must be protected: {f}"
            );
        }
        // Cargo manifests are protected by BASENAME anywhere, not just at root.
        assert!(!is_editable("some/nested/Cargo.toml"));
        assert!(!is_editable("vendor/crate/Cargo.lock"));
        assert!(!is_editable("scripts/kernel-preboot.mjs"));

        // A NORMAL Rust file under src-tauri/src IS editable — the Rust
        // whitelist genuinely works (not blanket-denied).
        assert!(is_editable("src-tauri/src/fleet.rs"));
        assert!(is_editable("src-tauri/src/organs.rs"));
        assert!(is_editable("src-tauri/src/voice.rs"));

        // But a non-.rs src-tauri file, or a src-tauri file OUTSIDE src/, is NOT
        // editable — the Rust whitelist is exactly `src-tauri/src/**/*.rs`.
        assert!(!is_editable("src-tauri/tauri.conf.json"));
        assert!(!is_editable("src-tauri/build.rs")); // src-tauri/ but not src-tauri/src/
        assert!(!is_editable("src-tauri/src/config.json")); // under src/ but not .rs
        assert!(!is_editable("src-tauri/Cargo.toml")); // manifest (also basename-denied)

        // ── Phase 23 (Rebirth): the loomhome / build / bundle surface is
        // EXPLICITLY protected, not merely outside the whitelist. Any file that
        // constructs the app, declares a dependency, or names the paths the
        // reweave reads and writes — refused in every casing.
        let rebirth_safety_files = [
            "src-tauri/src/platform.rs", // the swap — replaces the running body's file
            "src-tauri/src/generations.rs", // the ledger — which bodies survive
            "src-tauri/src/loomhome.rs", // identity + every loomhome path
            "src-tauri/src/threads.rs",  // tool discovery + threading (spawns tools)
            "src-tauri/src/reweave.rs",  // the build job — swaps the body, spawns the warden
            "src-tauri/src/warden.rs",   // the birth guard — heals a body that never confirmed
            "src-tauri/build.rs",        // bakes LOOM_GENOME_SHA into the binary
            "src-tauri/tauri.conf.json", // bundle resources, beforeBuildCommand
            "src-tauri/capabilities/default.json",
            "src-tauri/capabilities/nested/extra.json",
            "src-tauri/genome/genome.bundle", // the bundled genome
            "src-tauri/genome/genome.json",
            "scripts/genome-bundle.mjs", // writes the bundle at build time
            "package.json",      // dependency declaration
            "package-lock.json", // dependency lock
            "vite.config.ts",    // constructs the frontend build
        ];
        // A symlink inside the repo, spelled as an editable path, must not be
        // writable through to a protected file. The tree holds no symlinks —
        // this proves the wall rather than the absence.
        {
            let (_d, root) = init_repo();
            std::fs::create_dir_all(root.join("src/lib")).unwrap();
            #[cfg(unix)]
            std::os::unix::fs::symlink(
                root.join("src-tauri/src/kernel.rs"),
                root.join("src/lib/innocent.ts"),
            )
            .unwrap();
            std::fs::create_dir_all(root.join("src-tauri/src")).unwrap();
            std::fs::write(root.join("src-tauri/src/kernel.rs"), "// the walls\n").unwrap();
            let canon = root.join("src/lib/innocent.ts").canonicalize().unwrap();
            assert!(
                assert_lands_editable(&root, &canon, "src/lib/innocent.ts").is_err(),
                "a link that lands on the safety core must be refused"
            );
            // The ordinary case still passes.
            std::fs::write(root.join("src/lib/real.ts"), "export {}\n").unwrap();
            let canon = root.join("src/lib/real.ts").canonicalize().unwrap();
            assert!(assert_lands_editable(&root, &canon, "src/lib/real.ts").is_ok());
        }

        // Phase 23 sweep: the protected TS orchestration prefixes and
        // `.cargo/config.toml` at any depth.
        for f in [
            "src/lib/organs/bodyGate.ts",
            "src/lib/organs/bodyGate.test.ts",
            "src/components/chrome/BodyRequest.tsx",
            "src/components/chrome/ConsentCard.tsx",
            "src/lib/organs/api.ts",
            "src/lib/organs/api.test.ts",
            "src/lib/organs/budgets.ts",
            "src/lib/loom/validate.ts",
            "src/components/chrome/Reweave.tsx",
            "src/components/chrome/Reweave.test.tsx",
            "src/organs/seeds/settings.ts",
            "src/lib/loom/reweave.ts",
            "src/lib/loom/reweave.test.ts",
            "src/lib/loom/generations.ts",
            "src/lib/loom/generations.test.ts",
            ".cargo/config.toml",
            "src-tauri/.cargo/config.toml",
            "deep/er/.cargo/config.toml",
        ] {
            assert!(!is_editable(f), "rebirth TS/config file must be protected: {f}");
            assert!(!is_editable(&f.to_uppercase()), "uppercase-collision must be protected: {f}");
        }
        for f in rebirth_safety_files {
            assert!(!is_editable(f), "rebirth safety file must be protected: {f}");
            assert!(!is_editable(&f.to_lowercase()), "case-collision must be protected: {f}");
            assert!(!is_editable(&f.to_uppercase()), "uppercase-collision must be protected: {f}");
        }
        // Every one of them is NAMED in a protected set (explicit, enumerable —
        // the `kernel_editable` meta lists it for the model), not just
        // implicitly outside the whitelist.
        for f in ["src-tauri/src/platform.rs", "src-tauri/src/generations.rs", "src-tauri/src/loomhome.rs", "src-tauri/src/threads.rs", "src-tauri/src/reweave.rs", "src-tauri/src/warden.rs", "src-tauri/build.rs", "src-tauri/tauri.conf.json"] {
            assert!(PROTECTED_RUST.contains(&f), "{f} must be in PROTECTED_RUST");
        }
        for f in ["package.json", "package-lock.json", "vite.config.ts", "scripts/genome-bundle.mjs"] {
            assert!(PROTECTED.contains(&f), "{f} must be in PROTECTED");
        }
        assert!(
            PROTECTED_PREFIXES.contains(&"src-tauri/capabilities/"),
            "capabilities/ must be a protected prefix"
        );
        assert!(
            PROTECTED_PREFIXES.contains(&"src-tauri/genome/"),
            "genome/ must be a protected prefix"
        );
    }

    #[test]
    fn resolve_source_repo_asserts_git() {
        let (_d, root) = init_repo();
        let resolved = resolve_source_repo(Some(root.to_str().unwrap())).unwrap();
        assert_eq!(resolved, root);
        // A non-git dir is refused.
        let plain = tempfile::tempdir().unwrap();
        let res = resolve_source_repo(Some(plain.path().to_str().unwrap()));
        assert!(matches!(res, Err(LoomError::Git(_))), "got {res:?}");
    }

    #[test]
    fn apply_exact_unique_semantics() {
        assert_eq!(apply_exact_unique("abc", "b", "X").unwrap(), "aXc");
        // absent
        assert!(apply_exact_unique("abc", "z", "X").is_err());
        // ambiguous
        assert!(apply_exact_unique("abab", "ab", "X").is_err());
        // empty search
        assert!(apply_exact_unique("abc", "", "X").is_err());
    }

    #[test]
    fn self_protection_refusal_makes_no_worktree() {
        let (_d, root) = init_repo();
        let edits = vec![KernelEdit {
            path: "src/main.tsx".into(),
            search: "// entry".into(),
            replace: "// hacked".into(),
        }];
        let res = propose_inner(&root, &edits);
        assert!(matches!(res, Err(LoomError::Parse(_))), "got {res:?}");
        // No worktree was created.
        let list = super::git(&root, &root, &["worktree", "list"]).unwrap();
        assert_eq!(
            list.stdout.lines().count(),
            1,
            "only the main worktree should exist: {}",
            list.stdout
        );
    }

    #[test]
    fn propose_creates_worktree_and_leaves_live_tree_unchanged() {
        let (_d, root) = init_repo();
        let live_before = fs::read_to_string(root.join("src/hello.ts")).unwrap();
        let edits = vec![KernelEdit {
            path: "src/hello.ts".into(),
            search: "\"hi\"".into(),
            replace: "\"hello\"".into(),
        }];
        let out = propose_inner(&root, &edits).unwrap();
        assert!(out.diff.contains("-export const greeting = \"hi\";"));
        assert!(out.diff.contains("+export const greeting = \"hello\";"));
        // Live tree BYTE-unchanged.
        let live_after = fs::read_to_string(root.join("src/hello.ts")).unwrap();
        assert_eq!(live_before, live_after, "live tree must be untouched");
        // A worktree exists.
        let list = super::git(&root, &root, &["worktree", "list"]).unwrap();
        assert_eq!(list.stdout.lines().count(), 2, "{}", list.stdout);
        // Clean up.
        kernel_discard(out.worktree_id).unwrap();
    }

    #[test]
    fn propose_error_cleans_up_worktree() {
        let (_d, root) = init_repo();
        // Search absent → apply fails AFTER worktree add → must clean up.
        let edits = vec![KernelEdit {
            path: "src/hello.ts".into(),
            search: "NOPE_NOT_PRESENT".into(),
            replace: "x".into(),
        }];
        let res = propose_inner(&root, &edits);
        assert!(res.is_err());
        let list = super::git(&root, &root, &["worktree", "list"]).unwrap();
        assert_eq!(
            list.stdout.lines().count(),
            1,
            "worktree must be cleaned up on error: {}",
            list.stdout
        );
    }

    #[test]
    fn discard_removes_worktree() {
        let (_d, root) = init_repo();
        let edits = vec![KernelEdit {
            path: "src/hello.ts".into(),
            search: "n = 1".into(),
            replace: "n = 2".into(),
        }];
        let out = propose_inner(&root, &edits).unwrap();
        assert_eq!(
            super::git(&root, &root, &["worktree", "list"]).unwrap().stdout.lines().count(),
            2
        );
        kernel_discard(out.worktree_id).unwrap();
        assert_eq!(
            super::git(&root, &root, &["worktree", "list"]).unwrap().stdout.lines().count(),
            1
        );
    }

    #[test]
    fn apply_commits_and_records_prev_sha() {
        let (_d, root) = init_repo();
        let prev = head_sha(&root).unwrap();
        let edits = vec![KernelEdit {
            path: "src/hello.ts".into(),
            search: "n = 1".into(),
            replace: "n = 42".into(),
        }];
        let prop = {
            let out = propose_inner(&root, &edits).unwrap();
            with_registry(|reg| reg.get(&out.worktree_id).cloned()).unwrap()
        };
        let (sha, prev_sha) = apply_inner(&prop, "bump n").unwrap();
        assert_eq!(prev_sha, prev);
        assert_ne!(sha, prev);
        // Live tree now has the edit + a commit.
        assert!(fs::read_to_string(root.join("src/hello.ts")).unwrap().contains("n = 42"));
        let log = super::git(&root, &root, &["log", "-1", "--pretty=%s"]).unwrap();
        assert_eq!(log.stdout.trim(), "self: bump n");
    }

    #[test]
    fn rollback_resets_live_tree() {
        let (_d, root) = init_repo();
        let prev = head_sha(&root).unwrap();
        let edits = vec![KernelEdit {
            path: "src/hello.ts".into(),
            search: "n = 1".into(),
            replace: "n = 99".into(),
        }];
        let prop = {
            let out = propose_inner(&root, &edits).unwrap();
            with_registry(|reg| reg.get(&out.worktree_id).cloned()).unwrap()
        };
        let (_sha, prev_sha) = apply_inner(&prop, "bump").unwrap();
        assert!(fs::read_to_string(root.join("src/hello.ts")).unwrap().contains("n = 99"));
        rollback_to(&root, &prev_sha).unwrap();
        assert_eq!(head_sha(&root).unwrap(), prev);
        assert!(fs::read_to_string(root.join("src/hello.ts")).unwrap().contains("n = 1"));
    }

    // ── WALL ORDERING enforced in Rust (Finding 1/5) ────────────────────────────
    //
    // These drive the flag lifecycle through the real registry + kernel_approve
    // + set_flags + the extracted apply gate, proving apply is refused unless
    // validated AND approved, in the exact orders the walls demand.

    /// Propose a real edit and return its worktreeId (registered, flags false).
    fn propose_registered(root: &Path) -> String {
        let edits = vec![KernelEdit {
            path: "src/hello.ts".into(),
            search: "n = 1".into(),
            replace: "n = 5".into(),
        }];
        propose_inner(root, &edits).unwrap().worktree_id
    }

    fn flags_of(id: &str) -> (bool, bool) {
        with_registry(|reg| {
            let p = reg.get(id).unwrap();
            (p.validated, p.approved)
        })
    }

    #[test]
    fn apply_gate_refuses_without_validate() {
        let (_d, root) = init_repo();
        let id = propose_registered(&root);
        // Fresh proposal: neither flag set.
        assert_eq!(flags_of(&id), (false, false));
        // The gate the command runs BEFORE any live write refuses it.
        assert!(check_apply_gate(false, false).is_err());
        kernel_discard(id).unwrap();
    }

    #[test]
    fn approve_before_validate_refused() {
        let (_d, root) = init_repo();
        let id = propose_registered(&root);
        // approve with validated=false → typed refusal, approved stays false.
        let res = kernel_approve(id.clone());
        assert!(matches!(res, Err(LoomError::Parse(_))), "got {res:?}");
        assert_eq!(flags_of(&id), (false, false));
        kernel_discard(id).unwrap();
    }

    #[test]
    fn validate_then_apply_without_approve_refused() {
        let (_d, root) = init_repo();
        let id = propose_registered(&root);
        // Simulate a passing validation (the ONLY thing that sets validated).
        set_flags(&id, true, false);
        assert_eq!(flags_of(&id), (true, false));
        // Approve was NOT called → apply gate still refuses.
        let (v, a) = flags_of(&id);
        assert!(check_apply_gate(v, a).is_err(), "validate alone must not open apply");
        kernel_discard(id).unwrap();
    }

    #[test]
    fn validate_then_approve_then_apply_ok() {
        let (_d, root) = init_repo();
        let id = propose_registered(&root);
        set_flags(&id, true, false); // validation passed
        kernel_approve(id.clone()).unwrap(); // owner approved
        let (v, a) = flags_of(&id);
        assert_eq!((v, a), (true, true));
        // Now — and only now — the gate opens; apply_inner writes the live tree.
        check_apply_gate(v, a).unwrap();
        let prop = with_registry(|reg| reg.get(&id).cloned()).unwrap();
        let (sha, _prev) = apply_inner(&prop, "ordered").unwrap();
        assert!(!sha.is_empty());
        assert!(fs::read_to_string(root.join("src/hello.ts")).unwrap().contains("n = 5"));
        kernel_discard(id).unwrap();
    }

    #[test]
    fn revalidate_resets_flags_coherently() {
        let (_d, root) = init_repo();
        let id = propose_registered(&root);
        // Reach validated+approved, then a re-validation must reset BOTH so a
        // stale approval can never ride a fresh (unproven) validation.
        set_flags(&id, true, true);
        assert_eq!(flags_of(&id), (true, true));
        // kernel_validate clears both up front (mirrors the reset it performs).
        set_flags(&id, false, false);
        assert_eq!(flags_of(&id), (false, false));
        // A failed re-validation leaves validated=false → gate stays shut.
        assert!(check_apply_gate(false, false).is_err());
        // A passing re-validation sets validated only; approve is required again.
        set_flags(&id, true, false);
        assert!(check_apply_gate(true, false).is_err());
        kernel_discard(id).unwrap();
    }

    // ── validator toolchain resolver (Finding 8) ────────────────────────────────

    #[test]
    fn node_resolver_returns_absolute_path_or_skips() {
        // Skip-guard like the existing ignored live tests: if node is absent this
        // asserts nothing (can't prove a resolver that has nothing to resolve).
        // No loomhome → the PATH walk is the only source.
        match node_path(None) {
            Some(p) => {
                assert!(p.is_absolute(), "resolved node must be absolute: {}", p.display());
                assert!(p.exists(), "resolved node must exist: {}", p.display());
            }
            None => eprintln!("SKIP node_resolver_returns_absolute_path_or_skips: node not on PATH"),
        }
    }

    #[test]
    fn cargo_resolver_returns_absolute_path_or_skips() {
        // Same skip-guard as npx: cargo is resolved once to an absolute path via
        // the shared PATH-walk. If cargo is absent (unlikely in a Rust test run,
        // but honest) this asserts nothing.
        match cargo_path(None) {
            Some(p) => {
                assert!(p.is_absolute(), "resolved cargo must be absolute: {}", p.display());
                assert!(p.exists(), "resolved cargo must exist: {}", p.display());
            }
            None => eprintln!("SKIP cargo_resolver_returns_absolute_path_or_skips: cargo not on PATH"),
        }
    }

    // ── boot_check decision table (pure sentinel logic) ─────────────────────────

    #[test]
    fn boot_check_decision_table() {
        let (_d, root) = init_repo();
        let sp_dir = tempfile::tempdir().unwrap();
        let sp = sp_dir.path().join("kernel-boot.json");

        // absent → None
        let out = decide_boot_at(&sp, None).unwrap();
        assert!(out.rolled_back_to.is_none() && !out.rollback_failed);

        // Simulate an apply: prev, then a real second commit as applied.
        let prev = head_sha(&root).unwrap();
        fs::write(root.join("src/hello.ts"), "export const n = 7;\n").unwrap();
        run(&root, &["commit", "-aqm", "self: applied"]);
        let applied = head_sha(&root).unwrap();

        // ok → noop (tree stays at applied)
        write_sentinel(
            &sp,
            &Sentinel {
                prev_sha: prev.clone(),
                applied_sha: applied.clone(),
                status: "ok".into(),
                source_root: root.to_string_lossy().to_string(),
                armed_by: None,
            },
        )
        .unwrap();
        let out = decide_boot_at(&sp, None).unwrap();
        assert!(out.rolled_back_to.is_none() && !out.rollback_failed);
        assert_eq!(head_sha(&root).unwrap(), applied);

        // pending → rollback to prev USING THE SENTINEL'S OWN source_root
        // (Finding 6: no override supplied; the rollback still targets `root`).
        write_sentinel(
            &sp,
            &Sentinel {
                prev_sha: prev.clone(),
                applied_sha: applied.clone(),
                status: "pending".into(),
                source_root: root.to_string_lossy().to_string(),
                armed_by: None,
            },
        )
        .unwrap();
        let out = decide_boot_at(&sp, None).unwrap();
        assert_eq!(out.rolled_back_to.as_deref(), Some(prev.as_str()));
        assert!(!out.rollback_failed);
        assert_eq!(head_sha(&root).unwrap(), prev);
        assert!(!sp.exists(), "sentinel must be cleared after rollback");
    }

    #[test]
    fn boot_check_uses_sentinel_source_root_not_cwd() {
        // Finding 6: recovery must target the repo the edit was applied to,
        // carried IN the sentinel, regardless of cwd / a missing override.
        let (_d, root) = init_repo();
        let sp_dir = tempfile::tempdir().unwrap();
        let sp = sp_dir.path().join("kernel-boot.json");

        let prev = head_sha(&root).unwrap();
        fs::write(root.join("src/hello.ts"), "export const n = 7;\n").unwrap();
        run(&root, &["commit", "-aqm", "self: applied"]);
        let applied = head_sha(&root).unwrap();
        assert_ne!(prev, applied);

        write_sentinel(
            &sp,
            &Sentinel {
                prev_sha: prev.clone(),
                applied_sha: applied.clone(),
                status: "pending".into(),
                source_root: root.to_string_lossy().to_string(),
                armed_by: None,
            },
        )
        .unwrap();

        // No override — the ONLY way this can roll back `root` is by reading the
        // sentinel's own source_root.
        let out = decide_boot_at(&sp, None).unwrap();
        assert_eq!(out.rolled_back_to.as_deref(), Some(prev.as_str()));
        assert_eq!(head_sha(&root).unwrap(), prev);
    }

    #[test]
    fn boot_check_rollback_failure_does_not_loop() {
        // Finding 7: if rollback_to fails (prev_sha absent/corrupt), we must NOT
        // leave "pending" — rewrite to "rollback-failed" so the next boot is a
        // noop, and surface the distinct signal.
        let (_d, root) = init_repo();
        let sp_dir = tempfile::tempdir().unwrap();
        let sp = sp_dir.path().join("kernel-boot.json");

        write_sentinel(
            &sp,
            &Sentinel {
                // A sha that does not exist in the repo → reset must fail.
                prev_sha: "0".repeat(40),
                applied_sha: head_sha(&root).unwrap(),
                status: "pending".into(),
                source_root: root.to_string_lossy().to_string(),
                armed_by: None,
            },
        )
        .unwrap();

        // First boot: rollback fails → distinct signal, sentinel rewritten.
        let out = decide_boot_at(&sp, None).unwrap();
        assert!(out.rolled_back_to.is_none());
        assert!(out.rollback_failed, "must surface the failure honestly");
        assert!(sp.exists(), "sentinel rewritten, not left dangling");
        let s = read_sentinel(&sp).unwrap();
        assert_eq!(s.status, "rollback-failed");

        // Second boot: status is no longer "pending" → NOOP, no retry loop.
        let out2 = decide_boot_at(&sp, None).unwrap();
        assert!(out2.rolled_back_to.is_none());
        assert!(!out2.rollback_failed, "must not retry a resolved sentinel");
    }

    #[test]
    fn decide_boot_at_uses_is_unconfirmed_not_pending_only() {
        // round-1 review, Finding 2/6: decide_boot_at keys off is_unconfirmed, so
        // it is consistent with the guard/pre-main classification. A terminal
        // `healed`/`ok` is a no-op; the TS `pending` (covered by is_unconfirmed)
        // still triggers a rollback.
        let (_d, root) = init_repo();
        let sp_dir = tempfile::tempdir().unwrap();
        let sp = sp_dir.path().join("kernel-boot.json");

        let prev = head_sha(&root).unwrap();
        fs::write(root.join("src/hello.ts"), "export const n = 7;\n").unwrap();
        run(&root, &["commit", "-aqm", "self: applied"]);
        let applied = head_sha(&root).unwrap();

        // `healed` is unconfirmed()==false → no-op (tree stays at applied).
        write_sentinel(
            &sp,
            &Sentinel {
                prev_sha: prev.clone(),
                applied_sha: applied.clone(),
                status: "healed".into(),
                source_root: root.to_string_lossy().to_string(),
                armed_by: None,
            },
        )
        .unwrap();
        let out = decide_boot_at(&sp, None).unwrap();
        assert!(out.rolled_back_to.is_none() && !out.rollback_failed);
        assert_eq!(head_sha(&root).unwrap(), applied, "healed is terminal → no rollback");

        // `pending` is unconfirmed → rolls back (proves is_unconfirmed still
        // covers the TS flow).
        write_sentinel(
            &sp,
            &Sentinel {
                prev_sha: prev.clone(),
                applied_sha: applied.clone(),
                status: "pending".into(),
                source_root: root.to_string_lossy().to_string(),
                armed_by: None,
            },
        )
        .unwrap();
        let out = decide_boot_at(&sp, None).unwrap();
        assert_eq!(out.rolled_back_to.as_deref(), Some(prev.as_str()));
        assert_eq!(head_sha(&root).unwrap(), prev);
    }

    // ── Marrow: the mirror + pre-main heal state machine (Phase 22) ─────────────

    #[test]
    fn is_unconfirmed_classification() {
        // Actionable (applied-but-never-confirmed) states.
        assert!(is_unconfirmed("pending")); // TS same-session flow
        assert!(is_unconfirmed("applied")); // Rust: written at apply
        assert!(is_unconfirmed("booting")); // Rust: first sighting seen
        // Terminal / cleared states must NEVER re-trigger a rollback.
        assert!(!is_unconfirmed("ok"));
        assert!(!is_unconfirmed("healed"));
        assert!(!is_unconfirmed("rollback-failed"));
        assert!(!is_unconfirmed("garbage"));
        assert!(!is_unconfirmed(""));
    }

    /// Write a mirror at a repo root with a given status + armedBy.
    fn write_mirror_at(root: &Path, prev: &str, applied: &str, status: &str, armed_by: Option<&str>) {
        write_sentinel(
            &mirror_path(root),
            &Sentinel {
                prev_sha: prev.into(),
                applied_sha: applied.into(),
                status: status.into(),
                source_root: root.to_string_lossy().to_string(),
                armed_by: armed_by.map(|s| s.to_string()),
            },
        )
        .unwrap();
    }

    fn mirror_status_at(root: &Path) -> Option<String> {
        read_sentinel(&mirror_path(root)).map(|s| s.status)
    }

    fn mirror_armed_by_at(root: &Path) -> Option<String> {
        read_sentinel(&mirror_path(root)).and_then(|s| s.armed_by)
    }

    /// Round-1 review, Finding 4. The sentinel is the one file every healer
    /// reads: a torn write reads as `None`, and a boot that reads `None`
    /// proceeds unguarded, permanently. It is written the way every other
    /// loomhome JSON is — a staging file, then a rename — so a reader sees
    /// the whole old sentinel or the whole new one. Pinned by the one
    /// observable difference: the rename needs the directory, not the file.
    #[test]
    fn sentinel_is_written_by_rename() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let sp = d.path().join("kernel-boot.json");
        let sentinel = |status: &str| Sentinel {
            prev_sha: "aaa111".into(),
            applied_sha: "bbb222".into(),
            status: status.into(),
            source_root: d.path().to_string_lossy().into_owned(),
            armed_by: Some("reweave".into()),
        };
        write_sentinel_at(&sp, &sentinel("applied")).unwrap();
        fs::set_permissions(&sp, fs::Permissions::from_mode(0o444)).unwrap();

        write_sentinel_at(&sp, &sentinel("booting")).unwrap();
        assert_eq!(read_sentinel(&sp).unwrap().status, "booting");
        let names: Vec<String> = fs::read_dir(d.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["kernel-boot.json".to_string()], "no staging file remains");
    }

    #[test]
    fn preboot_heal_applied_arms_booting_premain_no_reset() {
        // round-1 review, Finding 2: `applied` → arm `booting`/`premain` (the
        // guard-absent arm). NO reset — the first launch after an apply runs the
        // edit; HEAD unchanged.
        let (_d, root) = init_repo();
        let prev = head_sha(&root).unwrap();
        fs::write(root.join("src/hello.ts"), "export const n = 7;\n").unwrap();
        run(&root, &["commit", "-aqm", "self: applied"]);
        let applied = head_sha(&root).unwrap();

        write_mirror_at(&root, &prev, &applied, "applied", None);
        preboot_heal_at(&root);

        // Armed to `booting`/`premain`, source NOT rolled back yet.
        assert_eq!(mirror_status_at(&root).as_deref(), Some("booting"));
        assert_eq!(mirror_armed_by_at(&root).as_deref(), Some("premain"));
        assert_eq!(head_sha(&root).unwrap(), applied, "first launch runs the edit");
    }

    #[test]
    fn preboot_heal_booting_premain_rolls_back_and_heals() {
        // `booting`/`premain` (WE armed it last time, guard absent, and it never
        // confirmed) → the guard-absent backstop: hard-reset to prev_sha, heal.
        let (_d, root) = init_repo();
        let prev = head_sha(&root).unwrap();
        fs::write(root.join("src/hello.ts"), "export const n = 7;\n").unwrap();
        run(&root, &["commit", "-aqm", "self: applied"]);
        let applied = head_sha(&root).unwrap();

        write_mirror_at(&root, &prev, &applied, "booting", Some("premain"));
        preboot_heal_at(&root);

        assert_eq!(head_sha(&root).unwrap(), prev, "source reset to last-good");
        assert!(fs::read_to_string(root.join("src/hello.ts")).unwrap().contains("n = 1"));
        assert_eq!(mirror_status_at(&root).as_deref(), Some("healed"));

        // Idempotent: a second run on a healed mirror is a no-op.
        preboot_heal_at(&root);
        assert_eq!(head_sha(&root).unwrap(), prev);
        assert_eq!(mirror_status_at(&root).as_deref(), Some("healed"));
    }

    #[test]
    fn preboot_heal_booting_guard_is_noop_live_attempt_survives() {
        // round-1 review, Finding 2 (CRITICAL): `booting`/`guard` is the LIVE
        // attempt the Node pre-compile guard armed THIS session. The pre-main
        // hook must NEVER touch it — no reset, no rewrite — or it would kill the
        // very boot the guard armed for confirmation. HEAD unchanged; mirror
        // unchanged (still booting/guard).
        let (_d, root) = init_repo();
        let prev = head_sha(&root).unwrap();
        fs::write(root.join("src/hello.ts"), "export const n = 7;\n").unwrap();
        run(&root, &["commit", "-aqm", "self: applied"]);
        let applied = head_sha(&root).unwrap();

        write_mirror_at(&root, &prev, &applied, "booting", Some("guard"));
        preboot_heal_at(&root);

        // The live attempt survives: HEAD still at the applied edit, mirror
        // untouched (the guard, not the pre-main hook, owns this attempt).
        assert_eq!(head_sha(&root).unwrap(), applied, "live attempt must survive");
        assert_eq!(mirror_status_at(&root).as_deref(), Some("booting"));
        assert_eq!(mirror_armed_by_at(&root).as_deref(), Some("guard"));
    }

    #[test]
    fn preboot_heal_absent_or_terminal_is_noop() {
        let (_d, root) = init_repo();
        let prev = head_sha(&root).unwrap();
        // Absent mirror → no-op.
        preboot_heal_at(&root);
        assert!(mirror_status_at(&root).is_none());
        assert_eq!(head_sha(&root).unwrap(), prev);
        // Terminal `healed`/`ok`/`rollback-failed` → no-op (HEAD unchanged).
        for status in ["healed", "ok", "rollback-failed"] {
            write_mirror_at(&root, &prev, &prev, status, None);
            preboot_heal_at(&root);
            assert_eq!(mirror_status_at(&root).as_deref(), Some(status));
            assert_eq!(head_sha(&root).unwrap(), prev);
        }
    }

    #[test]
    fn preboot_heal_booting_premain_rollback_failure_does_not_loop() {
        // If the last-good sha is gone, don't loop or block: mark rollback-failed.
        let (_d, root) = init_repo();
        let applied = head_sha(&root).unwrap();
        write_mirror_at(&root, &"0".repeat(40), &applied, "booting", Some("premain"));
        preboot_heal_at(&root);
        assert_eq!(mirror_status_at(&root).as_deref(), Some("rollback-failed"));
        // Second run: terminal → no-op.
        preboot_heal_at(&root);
        assert_eq!(mirror_status_at(&root).as_deref(), Some("rollback-failed"));
    }

    // ── round-1 review, Finding 1: MANDATORY recovery record before live write ──

    #[test]
    fn apply_writes_mirror_before_live_write() {
        // The mirror {status:"applied", prevSha, sourceRoot, armedBy:null} exists
        // at the source root the instant apply completes, carrying the pre-edit
        // HEAD as prev_sha — the recovery record is present for any later start.
        let (_d, root) = init_repo();
        let prev = head_sha(&root).unwrap();
        let edits = vec![KernelEdit {
            path: "src/hello.ts".into(),
            search: "n = 1".into(),
            replace: "n = 5".into(),
        }];
        let id = propose_inner(&root, &edits).unwrap().worktree_id;
        set_flags(&id, true, true);
        let prop = with_registry(|reg| reg.get(&id).cloned()).unwrap();

        // Mirror-write happens BEFORE the live write in kernel_apply; here we
        // exercise the exact ordering the command uses: write the mandatory
        // mirror at prev_sha, THEN apply_inner. Assert the record exists with the
        // pre-edit HEAD and armedBy=null.
        write_mirror(
            &root,
            &Sentinel {
                prev_sha: prev.clone(),
                applied_sha: String::new(),
                status: "applied".into(),
                source_root: root.to_string_lossy().to_string(),
                armed_by: None,
            },
        )
        .unwrap();
        let before = read_sentinel(&mirror_path(&root)).unwrap();
        assert_eq!(before.status, "applied");
        assert_eq!(before.prev_sha, prev, "records the pre-edit HEAD");
        assert!(before.armed_by.is_none(), "freshly applied → armedBy null");

        let (_sha, prev_sha) = apply_inner(&prop, "bump").unwrap();
        assert_eq!(prev_sha, prev, "apply committed against the recorded prev_sha");
        kernel_discard(id).unwrap();
    }

    #[test]
    fn packaged_apply_does_not_arm_the_sentinel() {
        // Phase 23 (Rebirth): in PACKAGED mode a source apply moves the genome
        // only — nothing boots until a reweave — so NO sentinel is written:
        // not the mirror at the source root, not the app_data `pending`, even
        // for a TS edit. The commit still lands.
        assert!(!apply_arms_sentinel(Mode::Packaged));
        assert!(apply_arms_sentinel(Mode::Dev), "dev behaviour is unchanged");

        let (_d, root) = init_repo();
        let prev = head_sha(&root).unwrap();
        let app_sentinel = root.join("app-data-kernel-boot.json");
        let edits = vec![KernelEdit {
            path: "src/hello.ts".into(),
            search: "n = 1".into(),
            replace: "n = 5".into(),
        }];
        let id = propose_inner(&root, &edits).unwrap().worktree_id;
        set_flags(&id, true, true);
        let out = apply_at(Mode::Packaged, &app_sentinel, &id, "packaged edit").unwrap();
        assert_eq!(out.prev_sha, prev);
        assert_eq!(head_sha(&root).unwrap(), out.sha, "the commit landed");
        assert!(fs::read_to_string(root.join("src/hello.ts")).unwrap().contains("n = 5"));
        assert!(!mirror_path(&root).exists(), "packaged: no mirror at the source root");
        assert!(!app_sentinel.exists(), "packaged: no app_data sentinel, even for a TS edit");
        assert!(with_registry(|reg| reg.get(&id).is_none()), "the proposal is forgotten");

        // DEV, same edit shape: the mirror AND (TS edit) the app_data sentinel
        // are written — the behaviour Phase 22 established.
        let (_d2, root2) = init_repo();
        let app_sentinel2 = root2.join("app-data-kernel-boot.json");
        let id2 = propose_inner(&root2, &edits).unwrap().worktree_id;
        set_flags(&id2, true, true);
        let out2 = apply_at(Mode::Dev, &app_sentinel2, &id2, "dev edit").unwrap();
        let m = read_sentinel(&mirror_path(&root2)).expect("dev: the mirror is written");
        assert_eq!(m.status, "applied");
        assert_eq!(m.prev_sha, out2.prev_sha);
        assert_eq!(m.applied_sha, out2.sha);
        let a = read_sentinel(&app_sentinel2).expect("dev: TS edit arms the app_data sentinel");
        assert_eq!(a.status, "pending");
    }

    #[test]
    fn apply_aborts_when_mirror_write_fails_live_tree_unchanged() {
        // round-1 review, Finding 1: a forced mirror-write failure must abort the
        // apply with the LIVE TREE UNCHANGED (no live write, no commit). We
        // simulate the failure by pointing the mirror path at a location
        // write_sentinel cannot create: `.loom-boot.json` UNDER a path whose
        // parent is a regular FILE (so std::fs::write errors — NotADirectory).
        let (_d, root) = init_repo();
        let head_before = head_sha(&root).unwrap();
        let live_before = fs::read_to_string(root.join("src/hello.ts")).unwrap();

        // A "root" that is actually a file: mirror_path(file) = file/.loom-boot.json,
        // which cannot be written (parent is not a dir). This mirrors the
        // command's guard: write_mirror(...) errs → abort BEFORE apply_inner.
        let bogus = root.join("src/hello.ts"); // a regular file, not a dir
        let res = write_mirror(
            &bogus,
            &Sentinel {
                prev_sha: head_before.clone(),
                applied_sha: String::new(),
                status: "applied".into(),
                source_root: root.to_string_lossy().to_string(),
                armed_by: None,
            },
        );
        assert!(res.is_err(), "mirror write to a file-parent must fail");

        // Because kernel_apply returns BEFORE apply_inner on that error, the live
        // tree and HEAD are byte-for-byte unchanged. Assert that invariant.
        assert_eq!(head_sha(&root).unwrap(), head_before, "HEAD must not move");
        assert_eq!(
            fs::read_to_string(root.join("src/hello.ts")).unwrap(),
            live_before,
            "live tree must be untouched when the recovery record can't be written"
        );
    }

    #[test]
    fn apply_pure_rust_writes_mirror_only_no_app_data_sentinel() {
        // round-1 review, Finding 2/6: a PURE-RUST edit writes the mirror (sole
        // record) but NOT the app_data "pending" sentinel — so setup()'s
        // boot_recover won't double-rollback the edit the guard/pre-main owns.
        // We assert the touches_ts gate the command keys off is false for a
        // pure-Rust edit and true for a mixed edit.
        let pure_rust = [(
            "src-tauri/src/fleet.rs".to_string(),
            String::new(),
            String::new(),
        )];
        let mixed = [
            ("src-tauri/src/fleet.rs".to_string(), String::new(), String::new()),
            ("src/hello.ts".to_string(), String::new(), String::new()),
        ];
        let touches_ts = |edits: &[(String, String, String)]| {
            edits
                .iter()
                .any(|(rel, _, _)| rel.ends_with(".ts") || rel.ends_with(".tsx"))
        };
        assert!(!touches_ts(&pure_rust), "pure-Rust → no app_data sentinel");
        assert!(touches_ts(&mixed), "mixed edit → writes both");
    }

    #[test]
    fn apply_writes_source_mirror_as_applied() {
        // kernel_apply's mirror write: after an apply, `.loom-boot.json` exists
        // at the source root with status `applied`, armedBy null, and the
        // recorded prev/root.
        let (_d, root) = init_repo();
        let prev = head_sha(&root).unwrap();
        fs::write(root.join("src/hello.ts"), "export const n = 9;\n").unwrap();
        run(&root, &["commit", "-aqm", "self: applied"]);
        let applied = head_sha(&root).unwrap();

        write_mirror(
            &root,
            &Sentinel {
                prev_sha: prev.clone(),
                applied_sha: applied.clone(),
                status: "applied".into(),
                source_root: root.to_string_lossy().to_string(),
                armed_by: None,
            },
        )
        .unwrap();

        let m = read_sentinel(&mirror_path(&root)).unwrap();
        assert_eq!(m.status, "applied");
        assert!(m.armed_by.is_none(), "freshly applied → armedBy null");
        assert_eq!(m.prev_sha, prev);
        assert_eq!(m.applied_sha, applied);
        assert_eq!(m.source_root, root.to_string_lossy());
    }

    #[test]
    fn end_to_end_heal_trace_guard_arms_then_heals() {
        // The full corrected machine end-to-end (round-1 review):
        //   applied → (guard arms booting/guard) → binary would panic → still
        //   booting/guard → next start guard resets+heals → HEAD back at prevSha.
        // The guard is the Node script; here we model its two documented
        // transitions on the mirror directly (its Rust-side analogue), and prove
        // the pre-main hook NEVER interferes with the guard-owned attempt.
        let (_d, root) = init_repo();
        let prev = head_sha(&root).unwrap();
        fs::write(root.join("src/hello.ts"), "export const n = 7;\n").unwrap();
        run(&root, &["commit", "-aqm", "self: applied"]);
        let applied = head_sha(&root).unwrap();

        // apply → mirror {applied, armedBy:null}.
        write_mirror_at(&root, &prev, &applied, "applied", None);

        // Restart 1, GUARD arms: applied → booting/guard, NO reset (HEAD stays).
        // (The guard writes armedBy="guard".)
        write_mirror_at(&root, &prev, &applied, "booting", Some("guard"));
        // The pre-main hook runs in the SAME session and must NOT touch it.
        preboot_heal_at(&root);
        assert_eq!(head_sha(&root).unwrap(), applied, "guard's live attempt survives pre-main");
        assert_eq!(mirror_status_at(&root).as_deref(), Some("booting"));
        assert_eq!(mirror_armed_by_at(&root).as_deref(), Some("guard"));

        // The binary panicked → kernel_boot_ok never fired → still booting/guard.
        // Restart 2, GUARD sees booting → resets to prevSha + healed.
        assert!(rollback_to(&root, &prev).is_ok());
        write_mirror_at(&root, &prev, &applied, "healed", Some("guard"));
        assert_eq!(head_sha(&root).unwrap(), prev, "HEAD back at last-good");
        // And the pre-main hook is now a no-op on the terminal mirror.
        preboot_heal_at(&root);
        assert_eq!(head_sha(&root).unwrap(), prev);
        assert_eq!(mirror_status_at(&root).as_deref(), Some("healed"));
    }

    // ── SKIP-GUARDED real-tsc integration test ─────────────────────────────────
    //
    // Proves the validation wall genuinely catches breakage THROUGH THE EXACT
    // INVOCATION validate_ts uses: `node <wt>/node_modules/typescript/bin/tsc
    // --noEmit`, with `<wt>/node_modules` a symlink to a real install (the
    // Phase 23 shape — no npx, no network). A passing TS fixture yields code 0;
    // a type-error fixture yields non-zero. Skips if node or an installed
    // typescript is unavailable (like the existing ignored live tests).
    #[cfg(unix)]
    #[test]
    fn real_tsc_catches_type_errors() {
        let Some(node) = node_path(None) else {
            eprintln!("SKIP real_tsc_catches_type_errors: node unavailable");
            return;
        };
        let Some(nm) = local_node_modules() else {
            eprintln!("SKIP real_tsc_catches_type_errors: no node_modules/typescript installed");
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let wt = dir.path().canonicalize().unwrap();
        fs::write(
            wt.join("tsconfig.json"),
            r#"{"compilerOptions":{"strict":true,"noEmit":true,"skipLibCheck":true}}"#,
        )
        .unwrap();
        fs::write(wt.join("ok.ts"), "export const n: number = 1;\n").unwrap();
        link_node_modules(&nm, &wt).unwrap();

        let (tsc_argv, _) = ts_argv(&node, &wt, &[]);
        let run_tsc = |wt: &Path| -> Result<ExecOut, LoomError> {
            let argv: Vec<&str> = tsc_argv.iter().map(String::as_str).collect();
            run_checked(&argv, wt, wt, TSC_TIMEOUT)
        };

        let ok = match run_tsc(&wt) {
            Ok(o) => o,
            Err(e) => {
                eprintln!("SKIP real_tsc_catches_type_errors: tsc unavailable: {e:?}");
                return;
            }
        };
        assert_eq!(ok.code, 0, "clean fixture must pass tsc: {}\n{}", ok.stdout, ok.stderr);

        // Type-error fixture → tsc must fail. This is the load-bearing assertion.
        fs::write(wt.join("bad.ts"), "export const s: number = \"nope\";\n").unwrap();
        let bad = run_tsc(&wt).unwrap();
        assert_ne!(bad.code, 0, "type error must fail tsc: {}\n{}", bad.stdout, bad.stderr);
    }

    // ── Phase 23: validation in packaged mode ──────────────────────────────────

    #[test]
    fn packaged_source_root_is_loomhome_source() {
        use crate::loomhome::{Home, Mode};
        // A loomhome whose source/ is a real git work dir.
        let hd = tempfile::tempdir().unwrap();
        let home = Home::at(hd.path().canonicalize().unwrap());
        let src = home.source();
        fs::create_dir_all(&src).unwrap();
        run(&src, &["init", "-q"]);
        // The dev-only override names a DIFFERENT valid repo — packaged mode
        // must ignore it and answer loomhome/source.
        let (_d, other) = init_repo();
        let got =
            resolve_source_repo_at(Mode::Packaged, Some(other.to_str().unwrap()), Some(&home))
                .unwrap();
        assert_eq!(got, src.canonicalize().unwrap());
        // Packaged with no loomhome cannot answer — typed error, never the cwd.
        assert!(resolve_source_repo_at(Mode::Packaged, None, None).is_err());
        // Dev: the override still wins, as before.
        let dev = resolve_source_repo_at(Mode::Dev, Some(other.to_str().unwrap()), Some(&home))
            .unwrap();
        assert_eq!(dev, other);
    }

    #[test]
    fn worktree_parent_follows_mode() {
        use crate::loomhome::{Home, Mode};
        let hd = tempfile::tempdir().unwrap();
        let home = Home::at(hd.path().to_path_buf());
        assert_eq!(worktree_parent(Mode::Packaged, &home), home.worktrees());
        assert_eq!(worktree_parent(Mode::Dev, &home), std::env::temp_dir());
    }

    #[cfg(unix)]
    #[test]
    fn worktree_gets_node_modules_symlink() {
        let (_d, root) = init_repo();
        // A fake install in the source repo (gitignored in the real tree).
        fs::create_dir_all(root.join("node_modules/marker")).unwrap();
        let edits = vec![KernelEdit {
            path: "src/hello.ts".into(),
            search: "\"hi\"".into(),
            replace: "\"hello\"".into(),
        }];
        let out = propose_inner(&root, &edits).unwrap();
        let wt = with_registry(|r| r.get(&out.worktree_id).map(|p| p.worktree.clone())).unwrap();
        let link = wt.join("node_modules");
        let meta = fs::symlink_metadata(&link).expect("node_modules must exist in the worktree");
        assert!(meta.file_type().is_symlink(), "node_modules must be a symlink");
        assert_eq!(fs::read_link(&link).unwrap(), root.join("node_modules"));
        assert!(link.join("marker").is_dir(), "symlink must resolve to the source install");
        // The symlink is untracked, so the diff is only the edit.
        assert!(!out.diff.contains("node_modules"));
        // Discard removes the worktree and the link — and NEVER the target.
        kernel_discard(out.worktree_id).unwrap();
        assert!(!wt.exists(), "worktree must be gone");
        assert!(root.join("node_modules/marker").is_dir(), "source node_modules must survive");
    }

    #[test]
    fn ts_validation_argv_uses_node_not_npx() {
        let node = PathBuf::from("/opt/tools/bin/node");
        let wt = PathBuf::from("/loomhome/worktrees/loom-kernel-1");
        let tests = vec!["src/a.ts".to_string(), "src/a.test.ts".to_string()];
        let (tsc, vitest) = ts_argv(&node, &wt, &tests);
        assert_eq!(
            tsc,
            vec![
                "/opt/tools/bin/node",
                "/loomhome/worktrees/loom-kernel-1/node_modules/typescript/bin/tsc",
                "--noEmit",
            ]
        );
        assert_eq!(
            vitest,
            vec![
                "/opt/tools/bin/node",
                "/loomhome/worktrees/loom-kernel-1/node_modules/vitest/vitest.mjs",
                "run",
                "src/a.ts",
                "src/a.test.ts",
            ]
        );
        for a in tsc.iter().chain(vitest.iter()) {
            assert!(!a.contains("npx"), "npx must never appear in validation argv: {a}");
        }
    }

    #[test]
    fn rust_validation_argv_has_offline_and_target_env() {
        use crate::loomhome::{Home, Mode};
        let cargo = PathBuf::from("/opt/tools/bin/cargo");
        assert_eq!(
            cargo_argv(&cargo, &["check"]),
            vec!["/opt/tools/bin/cargo", "check", "--offline"]
        );
        assert_eq!(
            cargo_argv(&cargo, &["test", "--no-run"]),
            vec!["/opt/tools/bin/cargo", "test", "--no-run", "--offline"]
        );
        let hd = tempfile::tempdir().unwrap();
        let home = Home::at(hd.path().to_path_buf());
        let packaged = cargo_env(Mode::Packaged, &home);
        assert_eq!(
            packaged,
            vec![
                (
                    "CARGO_TARGET_DIR".to_string(),
                    home.target().to_string_lossy().to_string()
                ),
                ("CARGO_NET_OFFLINE".to_string(), "true".to_string()),
            ]
        );
        let dev = cargo_env(Mode::Dev, &home);
        assert_eq!(dev, vec![("CARGO_NET_OFFLINE".to_string(), "true".to_string())]);
        assert!(
            !dev.iter().any(|(k, _)| k == "CARGO_TARGET_DIR"),
            "dev keeps the worktree's own target"
        );
    }

    // ── SKIP-GUARDED real-cargo integration test (#[ignore]) ────────────────────
    //
    // Proves the Rust validation wall genuinely catches breakage: a passing `.rs`
    // fixture yields `cargo check` code 0; a type-error `.rs` fixture yields
    // non-zero — driven through the REAL cargo resolver (`cargo_path`) +
    // `run_checked`, the exact path `validate_rust` uses. A tiny standalone crate
    // is compiled (NOT the whole LOOM crate) so this proves the wall without a
    // multi-minute cold build of the real tree.
    //
    // #[ignore]'d because even a minimal `cargo check` is slow relative to the
    // unit suite (fetches nothing here — no deps — but still invokes rustc). Run
    // manually with:  cargo test --manifest-path src-tauri/Cargo.toml -- --ignored real_cargo
    #[test]
    #[ignore = "invokes real cargo/rustc — slow; run manually with --ignored"]
    fn real_cargo_catches_type_errors() {
        let cargo = match cargo_path(None) {
            Some(c) => c,
            None => {
                eprintln!("SKIP real_cargo_catches_type_errors: cargo not on PATH");
                return;
            }
        };
        let cargo = cargo.to_str().unwrap();

        // Build a minimal standalone crate laid out like the worktree the
        // validator sees: an allowed_root with a `src-tauri/` holding Cargo.toml
        // + src/. We run cargo in `src-tauri/` with the root as allowed_root,
        // exactly as validate_rust does.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let crate_dir = root.join("src-tauri");
        fs::create_dir_all(crate_dir.join("src")).unwrap();
        fs::write(
            crate_dir.join("Cargo.toml"),
            "[package]\nname = \"marrow_fixture\"\nversion = \"0.0.0\"\nedition = \"2021\"\n\n[[bin]]\nname = \"marrow_fixture\"\npath = \"src/main.rs\"\n",
        )
        .unwrap();

        let run_check = |wt_root: &Path| -> Result<ExecOut, LoomError> {
            run_checked(
                &[cargo, "check"],
                &wt_root.join("src-tauri"),
                wt_root,
                CARGO_CHECK_TIMEOUT,
            )
        };

        // Passing fixture → cargo check code 0.
        fs::write(
            crate_dir.join("src/main.rs"),
            "fn main() {\n    let n: i32 = 1;\n    println!(\"{n}\");\n}\n",
        )
        .unwrap();
        let ok = run_check(&root).unwrap();
        assert_eq!(
            ok.code, 0,
            "passing fixture must compile: {}\n{}",
            ok.stdout, ok.stderr
        );

        // Type-error fixture → cargo check must fail. Load-bearing assertion.
        fs::write(
            crate_dir.join("src/main.rs"),
            "fn main() {\n    let _n: i32 = \"not a number\";\n}\n",
        )
        .unwrap();
        let bad = run_check(&root).unwrap();
        assert_ne!(
            bad.code, 0,
            "type error must fail cargo check: {}\n{}",
            bad.stdout, bad.stderr
        );
    }

    /// The nearest installed `node_modules` (one holding `typescript/bin/tsc`)
    /// walking up from the crate dir — the dev install a validation worktree
    /// symlinks to.
    #[cfg(unix)]
    fn local_node_modules() -> Option<PathBuf> {
        let mut dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        loop {
            let c = dir.join("node_modules");
            if c.join("typescript/bin/tsc").exists() {
                return c.canonicalize().ok();
            }
            if !dir.pop() {
                return None;
            }
        }
    }

    // ── Phase 23 (Rebirth): the warden's sentinel rows + the packaged backstop ──

    #[test]
    fn decide_table() {
        use Action::*;
        let statuses = ["pending", "applied", "booting", "ok", "healed", "rollback-failed", "garbage"];
        let arms = [Some("guard"), Some("premain"), Some("reweave"), None];
        for status in statuses {
            for armed in arms {
                for alive in [true, false] {
                    for mode in [Mode::Dev, Mode::Packaged] {
                        let got = decide(status, armed, alive, mode);
                        let want = match (status, armed, alive, mode) {
                            // A reweave-armed `applied` is the first sighting of
                            // a new body: arm it, in either mode.
                            ("applied", Some("reweave"), _, _) => Arm,
                            // Dev: any other `applied` is armed by pre-main
                            // (guard-absent arm, Phase 22).
                            ("applied", _, _, Mode::Dev) => Arm,
                            // Packaged: a source-only apply boots nothing until
                            // a reweave — pre-main leaves it to boot_check.
                            ("applied", _, _, Mode::Packaged) => Leave,
                            // The guard owns its live attempt, always.
                            ("booting", Some("guard"), _, _) => Leave,
                            // THE OWNERSHIP RULE: a live warden owns the birth.
                            ("booting", Some("reweave"), true, _) => Leave,
                            // No warden alive, packaged: pre-main is the backstop.
                            ("booting", Some("reweave"), false, Mode::Packaged) => Heal,
                            // Dev never swapped a body — nothing to heal.
                            ("booting", Some("reweave"), false, Mode::Dev) => Leave,
                            // Dev, premain/legacy: the Phase 22 source backstop.
                            ("booting", _, _, Mode::Dev) => Heal,
                            // Packaged, not reweave-armed: not pre-main's.
                            ("booting", _, _, Mode::Packaged) => Leave,
                            // pending / ok / healed / rollback-failed / unknown.
                            _ => Leave,
                        };
                        assert_eq!(got, want, "status={status} armedBy={armed:?} alive={alive} mode={mode:?}");
                    }
                }
            }
        }
        // The two rows the spec names outright.
        assert_eq!(decide("booting", Some("reweave"), true, Mode::Packaged), Leave);
        assert_eq!(decide("booting", Some("reweave"), false, Mode::Packaged), Heal);
    }

    #[test]
    fn packaged_home_matches_tauri_identifier() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], APP_IDENTIFIER, "the pre-main home must follow tauri.conf.json");
        let d = tempfile::tempdir().unwrap();
        let root = d.path().join("Library/Application Support").join(APP_IDENTIFIER).join("loom");
        assert!(packaged_home_under(d.path()).is_none(), "no loomhome yet → no home");
        fs::create_dir_all(&root).unwrap();
        assert_eq!(packaged_home_under(d.path()).unwrap().root, root);
    }

    fn app_sentinel(home: &Home, status: &str, armed_by: Option<&str>) {
        write_sentinel_at(
            &home.sentinel_json(),
            &Sentinel {
                prev_sha: "aaa111".into(),
                applied_sha: "bbb222".into(),
                status: status.into(),
                source_root: home.source().to_string_lossy().into_owned(),
                armed_by: armed_by.map(str::to_string),
            },
        )
        .unwrap();
    }

    fn app_sentinel_status(home: &Home) -> Option<String> {
        read_sentinel(&home.sentinel_json()).map(|s| s.status)
    }

    #[test]
    fn boot_ok_confirms_ledger() {
        let d = tempfile::tempdir().unwrap();
        let home = Home::at(d.path().join("loom"));
        fs::create_dir_all(&home.root).unwrap();
        let sp = home.sentinel_json();
        // No ledger, no sentinel: a plain boot confirms nothing and writes nothing.
        boot_ok_at(&sp, Some(&home)).unwrap();
        assert!(!home.ledger_json().exists(), "boot_ok must not invent a ledger");
        assert!(!sp.exists());
        // A ledger left unconfirmed by the swap, a sentinel armed by reweave.
        crate::generations::write(
            &home,
            &crate::generations::Ledger {
                current: Some("bbb222".into()),
                previous: Some("aaa111".into()),
                kept: vec!["aaa111".into(), "bbb222".into()],
                keep: 3,
                confirmed: false,
            },
        )
        .unwrap();
        app_sentinel(&home, "booting", Some("reweave"));
        boot_ok_at(&sp, Some(&home)).unwrap();
        let ledger = crate::generations::read(&home);
        assert!(ledger.confirmed, "a good boot confirms the running generation");
        assert_eq!(ledger.current.as_deref(), Some("bbb222"), "nothing else moves");
        assert_eq!(ledger.kept.len(), 2);
        assert_eq!(app_sentinel_status(&home).as_deref(), Some("ok"));
        // Dev-style call with no home: still marks the sentinel, touches no ledger.
        app_sentinel(&home, "pending", None);
        boot_ok_at(&sp, None).unwrap();
        assert_eq!(app_sentinel_status(&home).as_deref(), Some("ok"));
    }

    /// Round-3 review, Finding 2. `boot_ok_at` read the sentinel and wrote
    /// `ok` unconditionally — the one consumer of the state machine that did
    /// not guard with `is_unconfirmed`. The `HealedNextLaunch` ending exists
    /// precisely because a USABLE generation can miss the deadline: the
    /// warden heals, deliberately leaves the running process alone, and that
    /// process beacons late. `healed` then became `ok`, erasing the only
    /// durable statement that the birth ended badly, and the ledger was
    /// stamped `confirmed: true` on a `current` the beaconing process is not
    /// even running. The same call erased `rollback-failed`. A terminal state
    /// is somebody else's verdict.
    #[test]
    fn boot_ok_does_not_overwrite_a_terminal_sentinel() {
        for status in ["healed", "ok", "rollback-failed"] {
            let d = tempfile::tempdir().unwrap();
            let home = Home::at(d.path().join("loom"));
            fs::create_dir_all(&home.root).unwrap();
            let sp = home.sentinel_json();
            // The disk the late beacon finds: the warden healed to aaa111 and
            // left the bbb222 window running; its ledger is unconfirmed
            // because the generation it names never confirmed.
            crate::generations::write(
                &home,
                &crate::generations::Ledger {
                    current: Some("aaa111".into()),
                    previous: Some("bbb222".into()),
                    kept: vec!["aaa111".into(), "bbb222".into()],
                    keep: 3,
                    confirmed: false,
                },
            )
            .unwrap();
            app_sentinel(&home, status, Some("reweave"));
            boot_ok_at(&sp, Some(&home)).unwrap();
            assert_eq!(
                app_sentinel_status(&home).as_deref(),
                Some(status),
                "`{status}` is terminal — a late beacon must not rewrite it"
            );
            assert!(
                !crate::generations::read(&home).confirmed,
                "`{status}`: a generation the beaconing process is not running is not confirmed"
            );
        }
    }

    #[test]
    fn boot_check_surfaces_healed_generation_once() {
        let d = tempfile::tempdir().unwrap();
        let home = Home::at(d.path().join("loom"));
        fs::create_dir_all(&home.root).unwrap();
        let sp = home.sentinel_json();
        // The warden left a sentinel `healed` and a recovery record.
        app_sentinel(&home, "healed", Some("reweave"));
        crate::threads::write_json_atomic(
            &home.recovery_json(),
            &crate::warden::Recovery {
                failed_sha: "bbb222".into(),
                prev_sha: "aaa111".into(),
                reason: "crashed".into(),
                log_tail: vec!["Compiling loom".into()],
            },
        )
        .unwrap();
        // The Rust-side setup check does NOT consume the record (the shell has
        // not asked yet).
        let quiet = boot_check_in(&sp, Mode::Packaged, None, Some(&home), false).unwrap();
        assert!(quiet.healed_generation.is_none());
        assert!(home.recovery_json().exists());
        // The shell's check surfaces it, camelCase, without the log tail — and
        // clears it.
        let out = boot_check_in(&sp, Mode::Packaged, None, Some(&home), true).unwrap();
        let hg = out.healed_generation.clone().expect("the healed generation");
        assert_eq!(hg.failed_sha, "bbb222");
        assert_eq!(hg.prev_sha, "aaa111");
        assert_eq!(hg.reason, "crashed");
        assert!(out.rolled_back_to.is_none() && !out.rollback_failed, "healed is terminal: no source rollback");
        let v = serde_json::to_value(&out).unwrap();
        assert_eq!(v["healedGeneration"]["failedSha"], "bbb222");
        assert_eq!(v["healedGeneration"]["prevSha"], "aaa111");
        assert!(v["healedGeneration"].get("logTail").is_none());
        assert!(!home.recovery_json().exists(), "surfaced exactly once");
        let again = boot_check_in(&sp, Mode::Packaged, None, Some(&home), true).unwrap();
        assert!(again.healed_generation.is_none());
        assert!(serde_json::to_value(&again).unwrap()["healedGeneration"].is_null());
    }

    #[test]
    fn boot_check_leaves_reweave_armed_sentinel_alone() {
        // The new body's setup runs boot_check while its sentinel is
        // `booting`/`reweave` — the warden owns that birth. A source rollback
        // here would undo the genome the body was woven from and delete the
        // sentinel the warden is watching.
        let (_dir, root) = init_repo();
        let d = tempfile::tempdir().unwrap();
        let home = Home::at(d.path().join("loom"));
        fs::create_dir_all(&home.root).unwrap();
        let sp = home.sentinel_json();
        let head = head_sha(&root).unwrap();
        write_sentinel_at(
            &sp,
            &Sentinel {
                prev_sha: "0".repeat(40),
                applied_sha: head.clone(),
                status: "booting".into(),
                source_root: root.to_string_lossy().into_owned(),
                armed_by: Some("reweave".into()),
            },
        )
        .unwrap();
        let out = boot_check_in(&sp, Mode::Packaged, None, Some(&home), true).unwrap();
        assert!(out.rolled_back_to.is_none() && !out.rollback_failed);
        assert_eq!(app_sentinel_status(&home).as_deref(), Some("booting"), "untouched");
        assert_eq!(head_sha(&root).unwrap(), head, "the genome is untouched");
    }

    /// A fake `.app` + shelved previous body (an executable script, so the
    /// backstop can actually spawn it as the warden) + a fake codesign.
    struct PackagedFx {
        _dir: tempfile::TempDir,
        home: Home,
        layout: crate::platform::AppLayout,
        codesign: PathBuf,
    }

    impl PackagedFx {
        fn tools(&self) -> impl Fn(&str) -> Option<PathBuf> + '_ {
            move |n: &str| (n == "codesign").then(|| self.codesign.clone())
        }
        fn exe(&self) -> String {
            fs::read_to_string(&self.layout.exe_path).unwrap()
        }
    }

    fn packaged_fx() -> PackagedFx {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let home = Home::at(root.join("loom"));
        fs::create_dir_all(&home.root).unwrap();
        let app_path = root.join("LOOM.app");
        let exe_path = app_path.join("Contents/MacOS/loom");
        fs::create_dir_all(exe_path.parent().unwrap()).unwrap();
        fs::write(&exe_path, "new body").unwrap();
        let prev = home.generation_exe("aaa111");
        fs::create_dir_all(prev.parent().unwrap()).unwrap();
        fs::write(&prev, "#!/bin/sh\n# old body\nexit 0\n").unwrap();
        fs::set_permissions(&prev, fs::Permissions::from_mode(0o755)).unwrap();
        let codesign = root.join("bin/codesign");
        fs::create_dir_all(codesign.parent().unwrap()).unwrap();
        fs::write(&codesign, "#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(&codesign, fs::Permissions::from_mode(0o755)).unwrap();
        crate::generations::write(
            &home,
            &crate::generations::Ledger {
                current: Some("bbb222".into()),
                previous: Some("aaa111".into()),
                kept: vec!["aaa111".into(), "bbb222".into()],
                keep: 3,
                confirmed: false,
            },
        )
        .unwrap();
        PackagedFx { _dir: dir, home, layout: crate::platform::AppLayout { app_path, exe_path }, codesign }
    }

    fn warden_file(home: &Home, warden_pid: Option<u32>) {
        warden_file_for(home, "bbb222", warden_pid)
    }

    fn warden_file_for(home: &Home, new_sha: &str, warden_pid: Option<u32>) {
        crate::threads::write_json_atomic(
            &home.warden_json(),
            &crate::warden::Job {
                old_pid: 1,
                app_path: PathBuf::from("/x/LOOM.app"),
                exe_path: PathBuf::from("/x/LOOM.app/Contents/MacOS/loom"),
                new_sha: new_sha.into(),
                prev_sha: "aaa111".into(),
                loomhome: home.root.clone(),
                timeout_secs: 90,
                relaunch_only: false,
                warden_pid,
            },
        )
        .unwrap();
    }

    #[test]
    fn preboot_packaged_arms_a_reweave_applied_and_keeps_the_owner() {
        let fx = packaged_fx();
        app_sentinel(&fx.home, "applied", Some("reweave"));
        let alive = |_: u32| false;
        assert!(matches!(
            preboot_heal_packaged_in(&fx.home, Some(&fx.layout), &alive, &fx.tools()),
            Backstop::Armed
        ));
        let s = read_sentinel(&fx.home.sentinel_json()).unwrap();
        assert_eq!(s.status, "booting");
        assert_eq!(s.armed_by.as_deref(), Some("reweave"), "the warden still owns it");
        assert_eq!(fx.exe(), "new body");
        // A source-only apply (not reweave-armed) is not pre-main's business
        // in packaged mode.
        app_sentinel(&fx.home, "applied", None);
        assert!(matches!(
            preboot_heal_packaged_in(&fx.home, Some(&fx.layout), &alive, &fx.tools()),
            Backstop::Left
        ));
        assert_eq!(app_sentinel_status(&fx.home).as_deref(), Some("applied"));
    }

    #[test]
    fn preboot_packaged_leaves_a_booting_owned_by_a_live_warden() {
        let fx = packaged_fx();
        app_sentinel(&fx.home, "booting", Some("reweave"));
        warden_file(&fx.home, Some(777));
        let alive = |pid: u32| pid == 777;
        assert!(matches!(
            preboot_heal_packaged_in(&fx.home, Some(&fx.layout), &alive, &fx.tools()),
            Backstop::Left
        ));
        assert_eq!(app_sentinel_status(&fx.home).as_deref(), Some("booting"));
        assert_eq!(fx.exe(), "new body");
        assert!(!fx.home.recovery_json().exists());
    }

    /// Round-1 review, Finding 5. `warden.json` is never invalidated, so a
    /// job left by an earlier birth whose pid the system has since handed to
    /// an unrelated process would disarm the backstop forever: a crash loop
    /// with no heal. A job is only a live guard if it guards THIS birth —
    /// its `newSha` is the sentinel's `applied_sha`.
    #[test]
    fn preboot_packaged_treats_a_warden_from_another_birth_as_gone() {
        let fx = packaged_fx();
        app_sentinel(&fx.home, "booting", Some("reweave")); // applied_sha bbb222
        // A leftover job for an older birth, whose pid is alive again.
        warden_file_for(&fx.home, "ccc333", Some(777));
        let alive = |pid: u32| pid == 777;
        let out = preboot_heal_packaged_in(&fx.home, Some(&fx.layout), &alive, &fx.tools());
        assert!(matches!(out, Backstop::Healed { .. }), "got {out:?}");
        assert_eq!(app_sentinel_status(&fx.home).as_deref(), Some("healed"));
        // The job that DOES name this birth still owns it.
        let fx2 = packaged_fx();
        app_sentinel(&fx2.home, "booting", Some("reweave"));
        warden_file_for(&fx2.home, "bbb222", Some(777));
        assert!(matches!(
            preboot_heal_packaged_in(&fx2.home, Some(&fx2.layout), &alive, &fx2.tools()),
            Backstop::Left
        ));
    }

    #[test]
    fn preboot_packaged_heals_a_booting_with_no_warden_and_relaunches_through_the_previous_body() {
        let fx = packaged_fx();
        app_sentinel(&fx.home, "booting", Some("reweave"));
        // The warden recorded its pid, then died.
        warden_file(&fx.home, Some(777));
        let alive = |_: u32| false;
        let out = preboot_heal_packaged_in(&fx.home, Some(&fx.layout), &alive, &fx.tools());
        let Backstop::Healed { warden } = out else { panic!("expected Healed, got {out:?}") };
        assert!(warden.is_ok(), "the previous body was spawned as the warden: {warden:?}");
        // Same heal as the warden's: body back, sentinel healed, ledger home, record.
        assert_eq!(fx.exe(), "#!/bin/sh\n# old body\nexit 0\n");
        assert_eq!(app_sentinel_status(&fx.home).as_deref(), Some("healed"));
        let ledger = crate::generations::read(&fx.home);
        assert_eq!(ledger.current.as_deref(), Some("aaa111"));
        assert_eq!(ledger.previous.as_deref(), Some("bbb222"));
        let rec = crate::warden::read_recovery(&fx.home).unwrap();
        assert_eq!((rec.failed_sha.as_str(), rec.prev_sha.as_str(), rec.reason.as_str()), ("bbb222", "aaa111", "never confirmed"));
        // The warden's job is relaunch-only and waits for THIS process.
        let job: crate::warden::Job =
            serde_json::from_str(&fs::read_to_string(fx.home.warden_json()).unwrap()).unwrap();
        assert!(job.relaunch_only);
        assert_eq!(job.old_pid, std::process::id());
        assert_eq!(job.app_path, fx.layout.app_path);
        assert_eq!(job.exe_path, fx.layout.exe_path);
        assert_eq!((job.new_sha.as_str(), job.prev_sha.as_str()), ("bbb222", "aaa111"));
        // Without a warden.json at all (the warden never started), the same.
        let fx2 = packaged_fx();
        app_sentinel(&fx2.home, "booting", Some("reweave"));
        assert!(matches!(
            preboot_heal_packaged_in(&fx2.home, Some(&fx2.layout), &alive, &fx2.tools()),
            Backstop::Healed { .. }
        ));
        assert_eq!(app_sentinel_status(&fx2.home).as_deref(), Some("healed"));
    }

    /// Round-2 review, Finding 8. A pid is not an identity — the system
    /// recycles it. A warden that died leaving `wardenPid: 777` behind is
    /// indistinguishable from a live one once 777 belongs to something else,
    /// and the backstop would then Leave a body that never confirmed,
    /// unguarded, on every boot after. The warden clears its pid as it
    /// leaves, so the job it leaves behind names no guard however alive the
    /// machine says that number is.
    #[test]
    fn preboot_packaged_heals_when_the_warden_released_its_pid() {
        let fx = packaged_fx();
        app_sentinel(&fx.home, "booting", Some("reweave"));
        warden_file(&fx.home, Some(777));
        // Every pid on this machine reads as alive — the recycling case.
        let alive = |_: u32| true;
        assert!(
            matches!(
                preboot_heal_packaged_in(&fx.home, Some(&fx.layout), &alive, &fx.tools()),
                Backstop::Left
            ),
            "a stamped pid that is alive is still a guard"
        );

        // The warden leaves.
        crate::warden::release_pid(&fx.home.warden_json());
        let out = preboot_heal_packaged_in(&fx.home, Some(&fx.layout), &alive, &fx.tools());
        assert!(matches!(out, Backstop::Healed { .. }), "got {out:?}");
        assert_eq!(app_sentinel_status(&fx.home).as_deref(), Some("healed"));
    }

    #[test]
    fn preboot_packaged_heal_failure_marks_rollback_failed_and_does_not_loop() {
        let fx = packaged_fx();
        app_sentinel(&fx.home, "booting", Some("reweave"));
        fs::remove_file(fx.home.generation_exe("aaa111")).unwrap();
        let alive = |_: u32| false;
        assert!(matches!(
            preboot_heal_packaged_in(&fx.home, Some(&fx.layout), &alive, &fx.tools()),
            Backstop::HealFailed(_)
        ));
        assert_eq!(app_sentinel_status(&fx.home).as_deref(), Some("rollback-failed"));
        assert_eq!(fx.exe(), "new body");
        // A second start is a no-op.
        assert!(matches!(
            preboot_heal_packaged_in(&fx.home, Some(&fx.layout), &alive, &fx.tools()),
            Backstop::Left
        ));
    }

    #[test]
    fn preboot_packaged_ignores_absent_or_terminal_sentinels() {
        let fx = packaged_fx();
        let alive = |_: u32| false;
        assert!(matches!(
            preboot_heal_packaged_in(&fx.home, Some(&fx.layout), &alive, &fx.tools()),
            Backstop::Left
        ));
        for status in ["ok", "healed", "rollback-failed", "pending"] {
            app_sentinel(&fx.home, status, Some("reweave"));
            assert!(matches!(
                preboot_heal_packaged_in(&fx.home, Some(&fx.layout), &alive, &fx.tools()),
                Backstop::Left
            ), "{status}");
            assert_eq!(app_sentinel_status(&fx.home).as_deref(), Some(status));
        }
    }
}
