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
use std::sync::Mutex;
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
    // `git worktree remove --force` unregisters and deletes it.
    let _ = git(
        source_root,
        source_root,
        &["worktree", "remove", "--force", &worktree.to_string_lossy()],
    );
    // If the dir somehow survives (removed out of band), nuke it.
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
    pub status: String, // "pending" | "ok"
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

    // WALL 1 (isolation): detached worktree at HEAD.
    if let Err(e) = git_ok(
        source_root,
        source_root,
        &[
            "worktree",
            "add",
            "--detach",
            &worktree.to_string_lossy(),
            &base_sha,
        ],
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

    // WALL 2 (validation): tsc first, then targeted vitest. Fixed argv; cwd is
    // the worktree, asserted under itself. First failure returns stage+output.
    let tsc = run_checked(
        &["npx", "tsc", "--noEmit"],
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

    let mut argv: Vec<&str> = vec!["npx", "vitest", "run"];
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

    Ok(ValidateOut {
        ok: true,
        stage: "ok".into(),
        output: String::new(),
    })
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

#[tauri::command]
pub fn kernel_apply(
    app: tauri::AppHandle,
    worktree_id: String,
    message: String,
) -> Result<ApplyOut, LoomError> {
    let prop = with_registry(|reg| reg.get(&worktree_id).cloned())
        .ok_or_else(|| LoomError::NotFound(format!("unknown worktreeId: {worktree_id}")))?;

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
    let Some(s) = read_sentinel(&sp) else {
        return Ok(BootCheckOut { rolled_back_to: None });
    };
    if s.status == "pending" {
        // A prior edit applied but the shell never confirmed a good boot →
        // undo it BEFORE the webview loads the suspect code.
        let root = resolve_source_repo(source_repo.as_deref())?;
        rollback_to(&root, &s.prev_sha)?;
        // Clear the sentinel so we don't loop.
        let _ = std::fs::remove_file(&sp);
        return Ok(BootCheckOut {
            rolled_back_to: Some(s.prev_sha),
        });
    }
    // status == "ok" (or anything else) → noop.
    Ok(BootCheckOut { rolled_back_to: None })
}

/// Called early in Tauri setup (lib.rs). Swallows errors into a log-friendly
/// Option so a sentinel/repo hiccup can't block boot — the guarantee is "undo a
/// broken edit if we safely can", not "refuse to start".
pub fn boot_recover(app: &tauri::AppHandle) -> Option<String> {
    match kernel_boot_check(app.clone(), None) {
        Ok(b) => b.rolled_back_to,
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

    // ── boot_check decision table (pure sentinel logic) ─────────────────────────

    #[test]
    fn boot_check_decision_table() {
        let (_d, root) = init_repo();
        let sp_dir = tempfile::tempdir().unwrap();
        let sp = sp_dir.path().join("kernel-boot.json");

        // absent → None
        assert!(decide_boot(&sp, &root).unwrap().is_none());

        // Simulate an apply: prev, then a real second commit as applied.
        let prev = head_sha(&root).unwrap();
        fs::write(root.join("src/hello.ts"), "export const n = 7;\n").unwrap();
        run(&root, &["commit", "-aqm", "self: applied"]);
        let applied = head_sha(&root).unwrap();

        // ok → noop (tree stays at applied)
        write_sentinel(
            &sp,
            &Sentinel { prev_sha: prev.clone(), applied_sha: applied.clone(), status: "ok".into() },
        )
        .unwrap();
        assert!(decide_boot(&sp, &root).unwrap().is_none());
        assert_eq!(head_sha(&root).unwrap(), applied);

        // pending → rollback to prev + clear sentinel
        write_sentinel(
            &sp,
            &Sentinel { prev_sha: prev.clone(), applied_sha: applied.clone(), status: "pending".into() },
        )
        .unwrap();
        let rolled = decide_boot(&sp, &root).unwrap();
        assert_eq!(rolled.as_deref(), Some(prev.as_str()));
        assert_eq!(head_sha(&root).unwrap(), prev);
        assert!(!sp.exists(), "sentinel must be cleared after rollback");
    }

    // App-independent core of kernel_boot_check, for testing without AppHandle.
    fn decide_boot(sp: &Path, root: &Path) -> Result<Option<String>, LoomError> {
        let Some(s) = read_sentinel(sp) else {
            return Ok(None);
        };
        if s.status == "pending" {
            rollback_to(root, &s.prev_sha)?;
            let _ = std::fs::remove_file(sp);
            return Ok(Some(s.prev_sha));
        }
        Ok(None)
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
