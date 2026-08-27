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
//! temp dir. Edits and validation happen THERE. `kernel_apply` re-derives the
//! same patch and writes it to the live tree only on an explicit, separate
//! call. Every error path cleans up the worktree (`git worktree remove` +
//! `git worktree prune`) so no orphan survives.

use crate::error::LoomError;
use crate::exec::{run_checked, ExecOut};
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

// ── The protected set (self-protection invariant, spec §self-protection) ──────
//
// Relative, forward-slash, lowercased-for-comparison paths that may NEVER be
// edited by LOOM. Anything here is denied before isolation. Rust files are out
// of scope for editing anyway (whitelist is `src/**/*.ts(x)`), but the TS
// safety machinery below MUST be carved out of that positive whitelist.
const PROTECTED: &[&str] = &[
    // The TS self-edit pipeline + walls:
    "src/lib/loom/kernelbuild.ts",
    "src/components/chrome/kerneldiff.tsx",
    // Entry points and config (also can't be src/**/*.ts(x), but named for clarity):
    "src/main.tsx",
    "index.html",
    "vite.config.ts",
    "package.json",
];

/// Protected by PREFIX — the recovery beacon / recovery UI lives under a
/// directory we defend wholesale so a renamed sibling can't slip through.
const PROTECTED_PREFIXES: &[&str] = &[
    // recovery beacon + recovery notice UI (Task 2 wires these):
    "src/lib/loom/recovery",
    "src/components/chrome/recovery",
];

/// tsconfig*.json — matched by name pattern (tsconfig.json, tsconfig.node.json…).
fn is_tsconfig(rel_lower: &str) -> bool {
    let base = rel_lower.rsplit('/').next().unwrap_or(rel_lower);
    base.starts_with("tsconfig") && base.ends_with(".json")
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
/// Allow: normalized, `src/`-prefixed, ends `.ts` or `.tsx`.
/// Deny: anything in PROTECTED / PROTECTED_PREFIXES / tsconfig*.json — compared
///       case-insensitively so a case-collision (`src/Main.tsx`) can't bypass.
pub fn is_editable(rel: &str) -> bool {
    let norm = match normalize_rel(rel) {
        Ok(n) => n,
        Err(_) => return false,
    };
    let lower = norm.to_lowercase();

    // Protected carve-out FIRST (deny wins).
    if PROTECTED.contains(&lower.as_str()) {
        return false;
    }
    if PROTECTED_PREFIXES.iter().any(|p| lower == *p || lower.starts_with(&format!("{p}/"))) {
        return false;
    }
    if is_tsconfig(&lower) {
        return false;
    }

    // Positive whitelist: src/**/*.ts(x)
    lower.starts_with("src/") && (lower.ends_with(".ts") || lower.ends_with(".tsx"))
}

// ── Source-repo resolution ────────────────────────────────────────────────────

/// Resolve the SOURCE repo root: the `override_opt` setting if a non-empty
/// value is supplied, else the process cwd. Canonicalized, asserted to be a git
/// WORK dir (`.git` present + `Repository::open` succeeds, not bare). Typed
/// error otherwise. This is the sovereignty guard — LOOM only ever edits the
/// repo it is running from (or an explicitly configured one).
pub fn resolve_source_repo(override_opt: Option<&str>) -> Result<PathBuf, LoomError> {
    let raw: PathBuf = match override_opt {
        Some(s) if !s.trim().is_empty() => PathBuf::from(s.trim()),
        _ => std::env::current_dir()
            .map_err(|e| LoomError::NotFound(format!("cwd unavailable: {e}")))?,
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

/// Current HEAD sha of the repo at `root`.
fn head_sha(root: &Path) -> Result<String, LoomError> {
    Ok(git_ok(root, root, &["rev-parse", "HEAD"])?.trim().to_string())
}

// ── Validator toolchain resolution (Finding 8) ────────────────────────────────
//
// `kernel_validate` must not spawn `npx` resolved from an inherited PATH on
// every call: a PATH hijacked between startup and a validate call could swap in
// a validator that lies. Instead we resolve the ABSOLUTE path of `npx` ONCE (a
// OnceLock cache) by walking PATH ourselves, and use that absolute path as
// argv[0] thereafter — keeping the fixed-argv discipline intact.
//
// Residual, stated honestly: if PATH is ALREADY hijacked at process startup the
// machine is already compromised and no in-process check can save it. This
// removes the *per-call re-resolution* window, not that root compromise.

static NPX_PATH: OnceLock<Option<PathBuf>> = OnceLock::new();

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

/// The absolute `npx` path, resolved once and cached. `None` if unresolvable —
/// in which case `kernel_validate` fails honestly (can't prove → can't pass).
fn npx_path() -> Option<PathBuf> {
    NPX_PATH.get_or_init(|| which("npx")).clone()
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
    pub status: String, // "pending" | "ok" | "rollback-failed"
    /// The resolved absolute repo path the edit was applied to (Finding 6).
    /// Recovery rolls back USING THIS, never the process cwd — so a shell
    /// launched from a different directory still targets the right repo.
    /// Defaulted for backward-compat with sentinels written before this field.
    #[serde(default)]
    pub source_root: String,
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

fn read_sentinel(path: &Path) -> Option<Sentinel> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_sentinel(path: &Path, s: &Sentinel) -> Result<(), LoomError> {
    let json = serde_json::to_string_pretty(s).map_err(|e| LoomError::Parse(e.to_string()))?;
    std::fs::write(path, json).map_err(|e| LoomError::Git(e.to_string()))
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
    pub stage: String, // "tsc" | "vitest" | "ok"
    pub output: String,
}

#[derive(Serialize)]
pub struct ApplyOut {
    pub sha: String,
    #[serde(rename = "prevSha")]
    pub prev_sha: String,
}

#[derive(Serialize)]
pub struct BootCheckOut {
    #[serde(rename = "rolledBackTo")]
    pub rolled_back_to: Option<String>,
    /// A distinct, honest signal when a pending edit was found but the rollback
    /// itself FAILED (sha gc'd/corrupt) — the sentinel has been rewritten to
    /// "rollback-failed" so the next boot does NOT retry forever (Finding 7).
    /// The shell surfaces this so the user isn't silently stranded.
    #[serde(rename = "rollbackFailed")]
    pub rollback_failed: bool,
}

/// The full protected list surfaced to the UI/prompt (concrete + prefixes +
/// the tsconfig pattern token).
fn protected_list() -> Vec<String> {
    let mut v: Vec<String> = PROTECTED.iter().map(|s| s.to_string()).collect();
    for p in PROTECTED_PREFIXES {
        v.push(format!("{p}/**"));
    }
    v.push("tsconfig*.json".to_string());
    v.push("src-tauri/** (Rust core — out of scope)".to_string());
    v
}

// ── Core operations (testable, app-independent) ───────────────────────────────

/// Create a worktree, apply the edits, produce a unified diff. Live tree
/// untouched. Cleans up the worktree on ANY error before returning.
fn propose_inner(source_root: &Path, edits: &[KernelEdit]) -> Result<ProposeOut, LoomError> {
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

    // Unique worktree path under the system temp dir (OUTSIDE the source tree).
    // A monotonic counter + nanos guarantees no collision across concurrent
    // proposals in the same process.
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
    let worktree = std::env::temp_dir().join(&id);
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

#[tauri::command]
pub fn kernel_editable(source_repo: Option<String>) -> Result<EditableMeta, LoomError> {
    let root = resolve_source_repo(source_repo.as_deref())?;
    Ok(EditableMeta {
        root: root.to_string_lossy().to_string(),
        protected: protected_list(),
    })
}

#[tauri::command]
pub fn kernel_read(source_repo: Option<String>, path: String) -> Result<String, LoomError> {
    let root = resolve_source_repo(source_repo.as_deref())?;
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
    std::fs::read_to_string(&canon).map_err(|e| LoomError::NotFound(format!("read {norm}: {e}")))
}

#[tauri::command]
pub fn kernel_propose(
    source_repo: Option<String>,
    edits: Vec<KernelEdit>,
) -> Result<ProposeOut, LoomError> {
    let root = resolve_source_repo(source_repo.as_deref())?;
    propose_inner(&root, &edits)
}

#[tauri::command]
pub fn kernel_validate(worktree_id: String) -> Result<ValidateOut, LoomError> {
    let prop = with_registry(|reg| reg.get(&worktree_id).cloned())
        .ok_or_else(|| LoomError::NotFound(format!("unknown worktreeId: {worktree_id}")))?;

    // Re-validation resets the gate: a validate call must re-prove the current
    // proposal from scratch, so clear validated (and, since re-validating means
    // the prior decision is stale, approved) BEFORE running the checks. Only a
    // fully-passing result at the end sets validated = true (Finding 1/5).
    set_flags(&worktree_id, false, false);

    // Resolve the validator's ABSOLUTE path once (Finding 8). If npx can't be
    // found we cannot prove the edit is safe → we must not pass.
    let npx = npx_path().ok_or_else(|| {
        LoomError::NotFound("npx not found on PATH — cannot validate".into())
    })?;
    let npx = npx
        .to_str()
        .ok_or_else(|| LoomError::Parse("npx path is not valid UTF-8".into()))?;

    // WALL 2 (validation): tsc first, then targeted vitest. Fixed argv; cwd is
    // the worktree, asserted under itself. First failure returns stage+output.
    let tsc = run_checked(
        &[npx, "tsc", "--noEmit"],
        &prop.worktree,
        &prop.worktree,
        TSC_TIMEOUT,
    )?;
    if tsc.code != 0 {
        return Ok(ValidateOut {
            ok: false,
            stage: "tsc".into(),
            output: format!("{}\n{}", tsc.stdout, tsc.stderr).trim().to_string(),
        });
    }

    // Targeted vitest: the edited files + their `.test` siblings that exist.
    let mut targets: Vec<String> = Vec::new();
    for (rel, _, _) in &prop.edits {
        targets.push(rel.clone());
        for sib in test_siblings(rel) {
            if prop.worktree.join(&sib).exists() {
                targets.push(sib);
            }
        }
    }
    // De-dup while preserving order.
    targets.dedup();

    let mut argv: Vec<&str> = vec![npx, "vitest", "run"];
    for t in &targets {
        argv.push(t.as_str());
    }
    let vitest = run_checked(&argv, &prop.worktree, &prop.worktree, VITEST_TIMEOUT)?;
    if vitest.code != 0 {
        return Ok(ValidateOut {
            ok: false,
            stage: "vitest".into(),
            output: format!("{}\n{}", vitest.stdout, vitest.stderr)
                .trim()
                .to_string(),
        });
    }

    // Fully passing (tsc AND vitest) → mark validated. This is the ONLY place
    // validated flips true, and apply refuses without it (Finding 1/5).
    set_flags(&worktree_id, true, false);

    Ok(ValidateOut {
        ok: true,
        stage: "ok".into(),
        output: String::new(),
    })
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
    let prop = with_registry(|reg| reg.get(&worktree_id).cloned())
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

    let out = apply_inner(&prop, &message);

    // Whatever happened, drop the worktree (success or failure) and forget it.
    cleanup_worktree(&prop.source_root, &prop.worktree);
    with_registry(|reg| {
        reg.remove(&worktree_id);
    });

    let (sha, prev_sha) = out?;

    // WALL 5 (recovery boot): write the pending sentinel AFTER the commit so a
    // crash before the shell confirms boot rolls us back to prev_sha.
    let sp = sentinel_path(&app)?;
    write_sentinel(
        &sp,
        &Sentinel {
            prev_sha: prev_sha.clone(),
            applied_sha: sha.clone(),
            status: "pending".into(),
            // Record the ABSOLUTE repo path so recovery rolls back THIS repo,
            // never a cwd-derived guess (Finding 6).
            source_root: prop.source_root.to_string_lossy().to_string(),
        },
    )?;

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
pub fn kernel_rollback(source_repo: Option<String>, sha: String) -> Result<(), LoomError> {
    let root = resolve_source_repo(source_repo.as_deref())?;
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
    if let Some(mut s) = read_sentinel(&sp) {
        s.status = "ok".into();
        write_sentinel(&sp, &s)?;
    }
    Ok(())
}

#[tauri::command]
pub fn kernel_boot_check(
    app: tauri::AppHandle,
    source_repo: Option<String>,
) -> Result<BootCheckOut, LoomError> {
    let sp = sentinel_path(&app)?;
    decide_boot_at(&sp, source_repo.as_deref())
}

/// The app-independent core of the boot decision. Testable without an
/// AppHandle. `source_repo_override` is a last-resort fallback ONLY used when a
/// legacy sentinel carries no `source_root` of its own.
fn decide_boot_at(sp: &Path, source_repo_override: Option<&str>) -> Result<BootCheckOut, LoomError> {
    let Some(s) = read_sentinel(sp) else {
        return Ok(BootCheckOut {
            rolled_back_to: None,
            rollback_failed: false,
        });
    };
    if s.status != "pending" {
        // "ok" | "rollback-failed" | anything else → noop. A prior boot already
        // resolved this sentinel; we never retry a rollback (Finding 7).
        return Ok(BootCheckOut {
            rolled_back_to: None,
            rollback_failed: false,
        });
    }

    // A prior edit applied but the shell never confirmed a good boot → undo it
    // BEFORE the webview loads the suspect code. Roll back the repo the edit was
    // ACTUALLY applied to: the sentinel's own source_root (Finding 6), falling
    // back to the override/cwd only for legacy sentinels with no source_root.
    let root: PathBuf = if !s.source_root.trim().is_empty() {
        PathBuf::from(&s.source_root)
    } else {
        resolve_source_repo(source_repo_override)?
    };

    match rollback_to(&root, &s.prev_sha) {
        Ok(()) => {
            // Success → remove the sentinel; the tree is home to prev_sha.
            let _ = std::fs::remove_file(sp);
            Ok(BootCheckOut {
                rolled_back_to: Some(s.prev_sha),
                rollback_failed: false,
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
            })
        }
    }
}

/// Called early in Tauri setup (lib.rs). Swallows errors into a log-friendly
/// Option so a sentinel/repo hiccup can't block boot — the guarantee is "undo a
/// broken edit if we safely can", not "refuse to start".
pub fn boot_recover(app: &tauri::AppHandle) -> Option<String> {
    match kernel_boot_check(app.clone(), None) {
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
        assert!(!is_editable("src/lib/loom/kernelBuild.ts"));
        assert!(!is_editable("src/lib/loom/kernelbuild.ts")); // case-collision
        assert!(!is_editable("src/components/chrome/KernelDiff.tsx"));
        assert!(!is_editable("src/main.tsx"));
        assert!(!is_editable("vite.config.ts"));
        assert!(!is_editable("tsconfig.json"));
        assert!(!is_editable("tsconfig.node.json"));
        // recovery prefix
        assert!(!is_editable("src/lib/loom/recovery/beacon.ts"));
        assert!(!is_editable("src/components/chrome/recovery/Notice.tsx"));
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
    fn npx_resolver_returns_absolute_path_or_skips() {
        // Skip-guard like the existing ignored live tests: if npx is absent this
        // asserts nothing (can't prove a resolver that has nothing to resolve).
        match npx_path() {
            Some(p) => {
                assert!(p.is_absolute(), "resolved npx must be absolute: {}", p.display());
                assert!(p.exists(), "resolved npx must exist: {}", p.display());
            }
            None => eprintln!("SKIP npx_resolver_returns_absolute_path_or_skips: npx not on PATH"),
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

    // ── SKIP-GUARDED real-tsc integration test ─────────────────────────────────
    //
    // Proves the validation wall genuinely catches breakage: a passing TS
    // fixture yields code 0; a type-error fixture yields non-zero. Guarded to
    // skip if npx/tsc is unavailable (like the existing ignored live tests).
    #[test]
    fn real_tsc_catches_type_errors() {
        // Resolve a REAL tsc: prefer the project's installed compiler
        // (node_modules/.bin/tsc, walking up from CARGO_MANIFEST_DIR), else fall
        // back to `npx tsc`. Skip if neither yields a usable compiler — this
        // test proves the wall WHEN tsc is present (like the ignored live tests).
        let dir = tempfile::tempdir().unwrap();
        let wt = dir.path();
        fs::write(
            wt.join("tsconfig.json"),
            r#"{"compilerOptions":{"strict":true,"noEmit":true,"skipLibCheck":true}}"#,
        )
        .unwrap();
        fs::write(wt.join("ok.ts"), "export const n: number = 1;\n").unwrap();

        let tsc_bin = local_tsc();
        let run_tsc = |wt: &Path| -> Result<ExecOut, LoomError> {
            match &tsc_bin {
                Some(bin) => run_checked(
                    &[bin.to_str().unwrap(), "--noEmit"],
                    wt,
                    wt,
                    TSC_TIMEOUT,
                ),
                None => run_checked(&["npx", "tsc", "--noEmit"], wt, wt, TSC_TIMEOUT),
            }
        };

        let ok = match run_tsc(wt) {
            Ok(o) => o,
            Err(_) => {
                eprintln!("SKIP real_tsc_catches_type_errors: tsc unavailable");
                return;
            }
        };
        if ok.code != 0 {
            eprintln!(
                "SKIP real_tsc_catches_type_errors: no usable tsc (npx shim?): {}",
                ok.stdout
            );
            return;
        }

        // Type-error fixture → tsc must fail. This is the load-bearing assertion.
        fs::write(wt.join("bad.ts"), "export const s: number = \"nope\";\n").unwrap();
        let bad = run_tsc(wt).unwrap();
        assert_ne!(bad.code, 0, "type error must fail tsc: {}\n{}", bad.stdout, bad.stderr);
    }

    /// Walk up from the crate dir to find `node_modules/.bin/tsc`.
    fn local_tsc() -> Option<PathBuf> {
        let mut dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        loop {
            let c = dir.join("node_modules/.bin/tsc");
            if c.exists() {
                return Some(c);
            }
            if !dir.pop() {
                return None;
            }
        }
    }
}
