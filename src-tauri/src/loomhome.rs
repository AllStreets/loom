//! loomhome — where a packaged LOOM lives (Phase 23 / Rebirth).
//!
//! PROTECTED (kernel.rs `PROTECTED_RUST`): this module names every path the
//! reweave machinery reads and writes, and reports the binary's own identity.
//!
//! Layout (spec §Loomhome layout), all under `<app_data>/loom/`:
//!
//! ```text
//!   source/                   the genome — a full git work tree
//!   threads.json              threading manifest (tool paths, threadedAt, threadedSha)
//!   vendor/                   `cargo vendor` output — every crate, offline
//!   target/                   ONE warm cargo target dir, shared by validation + reweave
//!   worktrees/                validation worktrees (packaged mode keeps them here)
//!   generations/<sha>/loom    the executable for that generation
//!   generations/<sha>/meta.json
//!   generations.json          the ledger { current, previous, kept, keep }
//!   reweave.json              stage of the current/last reweave
//!   warden.json               the warden's job file
//!   kernel-boot.json          the sentinel (Phase 21)
//!   recovery.json             the warden's recovery record
//! ```
//!
//! Nothing here spawns, writes the source, or touches the network: it is the
//! one place the rest of the rebirth machinery asks "where?" and "who am I?".

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::error::LoomError;

// ── Mode ──────────────────────────────────────────────────────────────────────

/// How this process was started (spec §Modes). Resolved once at startup.
///
/// - `Dev`: `tauri dev` owns the binary. Source is the process cwd; reweave
///   builds but never swaps.
/// - `Packaged`: a built app. Source is `loomhome/source`; reweave builds,
///   swaps, relaunches.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Dev,
    Packaged,
}

pub fn mode() -> Mode {
    if tauri::is_dev() { Mode::Dev } else { Mode::Packaged }
}

/// The sha this binary was woven from — baked in by `build.rs`
/// (`git rev-parse HEAD` of the repo root, or `unknown` outside a repo).
pub fn genome_sha() -> &'static str {
    env!("LOOM_GENOME_SHA")
}

// ── Home ──────────────────────────────────────────────────────────────────────

/// The loomhome root and every path under it. Accessors are pure — they name
/// paths, they do not create them (except `from_app`, which makes the root).
pub struct Home {
    pub root: PathBuf,
}

impl Home {
    /// `<app_data_dir>/loom`, created if missing. Same directory the Phase 21
    /// sentinel already lives in.
    pub fn from_app(app: &tauri::AppHandle) -> Result<Home, LoomError> {
        use tauri::Manager;
        let root = app
            .path()
            .app_data_dir()
            .map_err(|e| LoomError::Git(e.to_string()))?
            .join("loom");
        std::fs::create_dir_all(&root).map_err(|e| LoomError::Git(e.to_string()))?;
        Ok(Home { root })
    }

    /// A home at an explicit root (tests, and the warden which is handed a root
    /// on argv rather than an AppHandle).
    pub fn at(root: PathBuf) -> Home {
        Home { root }
    }

    /// The genome: a full git work tree, cloned from the bundled genome.
    pub fn source(&self) -> PathBuf {
        self.root.join("source")
    }
    /// Threading manifest: tool paths + versions, threadedAt, threadedSha.
    pub fn threads_json(&self) -> PathBuf {
        self.root.join("threads.json")
    }
    /// `cargo vendor` output — every crate, offline.
    pub fn vendor(&self) -> PathBuf {
        self.root.join("vendor")
    }
    /// The one warm cargo target dir shared by validation and reweave.
    pub fn target(&self) -> PathBuf {
        self.root.join("target")
    }
    /// Validation worktrees.
    pub fn worktrees(&self) -> PathBuf {
        self.root.join("worktrees")
    }
    /// `generations/` — one subdirectory per woven sha.
    pub fn generations_dir(&self) -> PathBuf {
        self.root.join("generations")
    }
    /// The executable for a generation.
    pub fn generation_exe(&self, sha: &str) -> PathBuf {
        self.generations_dir().join(sha).join("loom")
    }
    /// `{ sha, wovenAt, sizeBytes, reason }` for a generation.
    pub fn generation_meta(&self, sha: &str) -> PathBuf {
        self.generations_dir().join(sha).join("meta.json")
    }
    /// The ledger: `{ current, previous, kept, keep }`.
    pub fn ledger_json(&self) -> PathBuf {
        self.root.join("generations.json")
    }
    /// State of the current/last reweave.
    pub fn reweave_json(&self) -> PathBuf {
        self.root.join("reweave.json")
    }
    /// The warden's job file.
    pub fn warden_json(&self) -> PathBuf {
        self.root.join("warden.json")
    }
    /// The Phase 21 sentinel (`kernel-boot.json`) — same file kernel.rs writes.
    pub fn sentinel_json(&self) -> PathBuf {
        self.root.join("kernel-boot.json")
    }
    /// The warden's recovery record.
    pub fn recovery_json(&self) -> PathBuf {
        self.root.join("recovery.json")
    }
    /// The bundled genome shipped inside the app: Tauri resource
    /// `genome/genome.bundle`. A resource path, not a loomhome path.
    pub fn genome_bundle_resource(&self, app: &tauri::AppHandle) -> Result<PathBuf, LoomError> {
        use tauri::Manager;
        let dir = app
            .path()
            .resource_dir()
            .map_err(|e| LoomError::NotFound(format!("resource dir: {e}")))?;
        Ok(dir.join("genome").join("genome.bundle"))
    }
}

// ── Seed ──────────────────────────────────────────────────────────────────────

/// How long a clone of the bundled genome may take. The bundle is local
/// (~20 MB); this is a wall against a wedged git, not a budget.
const SEED_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// The sha the bundle beside this path was written at, read from the
/// `genome.json` the bundling script leaves next to it.
///
/// Two independent readings of HEAD exist in a packaged LOOM: the sha baked
/// into the binary at compile time (`LOOM_GENOME_SHA`) and this one, written
/// when the bundle was packed. They come from the same build and should agree.
/// When they do not, THIS is the reading to follow: the bundle is the authority
/// on which commits actually exist to check out, and a sha it does not contain
/// cannot be checked out at all. Absent, unreadable, or not a sha → `None`, and
/// the caller keeps the baked one.
pub fn bundle_sha(bundle: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(bundle.parent()?.join("genome.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let s = v.get("sha")?.as_str()?.trim().to_string();
    (s.len() == 40 && s.chars().all(|c| c.is_ascii_hexdigit())).then_some(s)
}

/// Threading step 1 (spec §Threading): clone the bundled genome into
/// `source/` and check out the sha this binary was woven from, on a local
/// `main` so later commits land somewhere named. A no-op if `source/.git`
/// already exists — the ceremony is resumable, and the source is never
/// re-cloned over an existing work tree.
///
/// Every spawn is a fixed argv through `exec::run_checked` with
/// `allowed_root = home.root`; no shell, no network (the bundle is a file).
pub fn seed_source(home: &Home, bundle: &Path, sha: &str) -> Result<(), LoomError> {
    let source = home.source();
    if source.join(".git").exists() {
        return Ok(());
    }
    if !bundle.is_file() {
        return Err(LoomError::NotFound(
            "the genome bundle is missing — this LOOM was built without its history".into(),
        ));
    }
    std::fs::create_dir_all(&home.root).map_err(|e| LoomError::Git(e.to_string()))?;
    let bundle_s = bundle.to_string_lossy().into_owned();
    let source_s = source.to_string_lossy().into_owned();
    // argv[0] is the git the threads table found (recorded path first, then
    // the fixed candidate dirs, then PATH) — an absolute path, not a PATH
    // lookup at spawn time.
    let git = crate::threads::tool_path(home, "git").ok_or_else(|| {
        LoomError::NotFound("git is missing — install it with `xcode-select --install`".into())
    })?;
    let git = git.to_string_lossy().into_owned();

    let out = crate::exec::run_checked(
        &[&git, "clone", "--quiet", &bundle_s, &source_s],
        &home.root,
        &home.root,
        SEED_TIMEOUT,
    )?;
    if out.code != 0 {
        return Err(LoomError::Git(format!("seed: clone failed: {}", out.stderr)));
    }
    let out = crate::exec::run_checked(
        &[&git, "checkout", "--quiet", "--detach", sha],
        &source,
        &home.root,
        SEED_TIMEOUT,
    )?;
    if out.code != 0 {
        return Err(LoomError::Git(format!("seed: checkout {sha} failed: {}", out.stderr)));
    }
    let out = crate::exec::run_checked(
        &[&git, "checkout", "--quiet", "-B", "main"],
        &source,
        &home.root,
        SEED_TIMEOUT,
    )?;
    if out.code != 0 {
        return Err(LoomError::Git(format!("seed: branch main failed: {}", out.stderr)));
    }
    Ok(())
}

// ── Identity ──────────────────────────────────────────────────────────────────

/// What `kernel_identity` reports: which mode, which genome, which generation,
/// whether the loom is threaded, and where home is.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub mode: Mode,
    pub genome_sha: String,
    /// The genome's HEAD — `git rev-parse HEAD` of the repo a weave would
    /// build from (dev: the cwd; packaged: `loomhome/source`). `None` when
    /// there is no source yet, or git cannot answer.
    ///
    /// Round-3 review, Finding 1. Every surface that asked "is there anything
    /// new to weave?" compared `generation` with `genome_sha` — the sha the
    /// RUNNING BINARY was compiled from. Threading's register step sets
    /// `ledger.current = genome_sha()`, and every successful weave
    /// re-establishes it, so in the steady state those two are ALWAYS equal
    /// and the answer was always "nothing new". A self-edit moves this field
    /// and neither of the others, which is exactly the question being asked.
    pub genome_head: Option<String>,
    /// The ledger's `current` sha, if a ledger exists. `None` before the first
    /// reweave (and in dev, where no generation is ever woven).
    pub generation: Option<String>,
    pub threaded: bool,
    pub loomhome: String,
    /// Bytes on disk under loomhome (vendor + warm target run to several GB).
    /// A bounded walk — see `loomhome_bytes` — so the number is honest, never
    /// a hang.
    pub loomhome_bytes: u64,
    /// Whether THIS body can actually be swapped: packaged, on a platform the
    /// swap supports, and inside an app bundle we can find. The consent line
    /// asks before it promises "LOOM will close and return" — previously it
    /// guessed the platform from the webview's user-agent string, in an app
    /// that has always known the answer.
    pub can_swap: bool,
}

/// The most directory entries `loomhome_bytes` will visit. A warm cargo
/// target holds tens of thousands of files; this cap keeps `kernel_identity`
/// bounded even if something pathological grows under loomhome. Past the cap
/// the number under-reports — Settings says "uses" not "is exactly".
pub const LOOMHOME_WALK_CAP: usize = 200_000;

/// Sum the sizes of regular files under `root`, iteratively, skipping symlinks
/// (never followed — a link out of loomhome must not count or loop) and
/// stopping after `LOOMHOME_WALK_CAP` entries. A missing root is 0.
pub fn loomhome_bytes(root: &Path) -> u64 {
    walk_bytes(root, LOOMHOME_WALK_CAP)
}

fn walk_bytes(root: &Path, cap: usize) -> u64 {
    let mut total: u64 = 0;
    let mut seen: usize = 0;
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            seen += 1;
            if seen > cap {
                return total;
            }
            // symlink_metadata never follows the link (DirEntry::metadata
            // may, depending on the platform).
            let Ok(meta) = std::fs::symlink_metadata(entry.path()) else { continue };
            let ft = meta.file_type();
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                stack.push(entry.path());
            } else if ft.is_file() {
                total = total.saturating_add(meta.len());
            }
        }
    }
    total
}

/// The ledger's `current`, read minimally as JSON. The full `Ledger` type
/// lives in `generations.rs`; identity only needs one field and must never
/// fail because the ledger's shape moved — a torn or absent ledger is `None`.
pub fn read_generation(home: &Home) -> Option<String> {
    read_value(&home.ledger_json())?
        .get("current")?
        .as_str()
        .map(str::to_string)
}

/// `threads.json` exists and parses with `threaded: true`. Anything else —
/// absent, torn, or `false` — is not threaded.
pub fn read_threaded(home: &Home) -> bool {
    read_value(&home.threads_json())
        .and_then(|v| v.get("threaded")?.as_bool())
        .unwrap_or(false)
}

fn read_value(path: &Path) -> Option<serde_json::Value> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// `git rev-parse HEAD` of the repo a weave would build from — resolved
/// exactly the way `reweave::ctx_for` resolves it, so the sha Settings and the
/// consent line NAME is the sha a weave would actually target. Any failure
/// (no source cloned yet, no git, a torn work tree) is `None`, never an error:
/// identity must always answer.
pub fn genome_head(home: &Home) -> Option<String> {
    let root = crate::kernel::resolve_source_repo_at(mode(), None, Some(home)).ok()?;
    crate::kernel::head_sha(&root).ok()
}

pub fn identity(home: &Home) -> Identity {
    Identity {
        mode: mode(),
        genome_sha: genome_sha().to_string(),
        genome_head: genome_head(home),
        generation: read_generation(home),
        threaded: read_threaded(home),
        loomhome: home.root.to_string_lossy().into_owned(),
        loomhome_bytes: loomhome_bytes(&home.root),
        // Packaged, on a platform whose swap is implemented, and inside a
        // bundle we can locate. Any of those missing and the body stays put —
        // which the consent line must say before it promises otherwise.
        can_swap: mode() == Mode::Packaged && crate::platform::app_layout().is_ok(),
    }
}

/// `{ mode, genomeSha, generation, threaded, loomhome, loomhomeBytes }` —
/// read by the Settings organ and the Shuttle ("which generation is this").
#[tauri::command]
pub fn kernel_identity(app: tauri::AppHandle) -> Result<Identity, LoomError> {
    let home = Home::from_app(&app)?;
    Ok(identity(&home))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_are_under_root() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().to_path_buf();
        let h = Home::at(root.clone());
        let sha = "abc123";
        let all = [
            h.source(),
            h.threads_json(),
            h.vendor(),
            h.target(),
            h.worktrees(),
            h.generations_dir(),
            h.generation_exe(sha),
            h.generation_meta(sha),
            h.ledger_json(),
            h.reweave_json(),
            h.warden_json(),
            h.sentinel_json(),
            h.recovery_json(),
        ];
        for p in &all {
            assert!(p.starts_with(&root), "{} not under {}", p.display(), root.display());
            assert!(p != &root, "accessor returned the bare root");
        }
        assert_eq!(h.sentinel_json(), root.join("kernel-boot.json"));
        assert_eq!(h.threads_json(), root.join("threads.json"));
        assert_eq!(h.ledger_json(), root.join("generations.json"));
        assert_eq!(h.generation_exe(sha), root.join("generations").join(sha).join("loom"));
        assert_eq!(h.generation_meta(sha), root.join("generations").join(sha).join("meta.json"));
        assert!(h.source().join(".cargo").starts_with(&root));
    }

    /// Round-3 review, Finding 1. `genome_head` must MOVE when the genome's
    /// HEAD moves — that is the whole point of the field. `genome_sha` (the
    /// running binary's own sha) cannot move at all while the process lives,
    /// which is why gating on it made every weave after the first unreachable.
    #[test]
    fn genome_head_follows_the_genome_and_is_none_without_one() {
        let d = tempfile::tempdir().unwrap();
        let home = Home::at(d.path().to_path_buf());
        // No `source/` cloned yet: there is no head to name.
        assert!(
            crate::kernel::resolve_source_repo_at(Mode::Packaged, None, Some(&home)).is_err(),
            "a loomhome with no source has no repo to resolve"
        );

        // A real repo with two commits: HEAD names the second, and the sha the
        // binary was baked from is untouched by either.
        let repo = d.path().join("genome");
        std::fs::create_dir_all(&repo).unwrap();
        let run = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(&repo)
                .env("GIT_AUTHOR_NAME", "loom")
                .env("GIT_AUTHOR_EMAIL", "loom@example.com")
                .env("GIT_COMMITTER_NAME", "loom")
                .env("GIT_COMMITTER_EMAIL", "loom@example.com")
                .output()
                .unwrap();
            assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        };
        run(&["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("a.txt"), "one").unwrap();
        run(&["add", "."]);
        run(&["commit", "-qm", "one"]);
        let first = crate::kernel::head_sha(&repo).unwrap();
        std::fs::write(repo.join("a.txt"), "two").unwrap();
        run(&["add", "."]);
        run(&["commit", "-qm", "two"]);
        let second = crate::kernel::head_sha(&repo).unwrap();

        assert_ne!(first, second, "a self-edit moves HEAD");
        assert_ne!(second, genome_sha(), "and moves it away from the baked sha");
    }

    #[test]
    fn identity_serializes_camel_case() {
        let id = Identity {
            mode: Mode::Packaged,
            genome_sha: "deadbeef".into(),
            genome_head: Some("3f2a1c9".into()),
            generation: Some("deadbeef".into()),
            threaded: true,
            loomhome: "/tmp/loom".into(),
            loomhome_bytes: 1_234,
            can_swap: false,
        };
        let v = serde_json::to_value(&id).unwrap();
        assert_eq!(v["loomhomeBytes"], 1_234);
        assert!(v.get("loomhome_bytes").is_none(), "snake_case must not leak");
        assert_eq!(v.get("canSwap").and_then(|b| b.as_bool()), Some(false));
        assert_eq!(v["mode"], "packaged");
        assert_eq!(v["genomeSha"], "deadbeef");
        assert_eq!(v["generation"], "deadbeef");
        assert_eq!(v["threaded"], true);
        assert_eq!(v["loomhome"], "/tmp/loom");
        assert!(v.get("genome_sha").is_none(), "snake_case must not leak");
        // The genome's HEAD travels beside the running body's sha and is NOT
        // the same field — the whole of round-3 Finding 1 is that the two are
        // different questions.
        assert_eq!(v["genomeHead"], "3f2a1c9");
        assert!(v.get("genome_head").is_none(), "snake_case must not leak");
        assert_eq!(serde_json::to_value(Mode::Dev).unwrap(), "dev");
        // None serializes as null, not absent — the TS type is `string | null`.
        let none = Identity { generation: None, genome_head: None, ..id };
        let nv = serde_json::to_value(&none).unwrap();
        assert!(nv["generation"].is_null());
        assert!(nv["genomeHead"].is_null(), "no source yet reads as null, not absent");
    }

    #[test]
    fn generation_reads_ledger_current_minimally() {
        let d = tempfile::tempdir().unwrap();
        let h = Home::at(d.path().to_path_buf());
        assert_eq!(read_generation(&h), None, "no ledger → no generation");
        std::fs::write(h.ledger_json(), r#"{"current":"c0ffee","previous":null,"kept":[],"keep":3}"#).unwrap();
        assert_eq!(read_generation(&h).as_deref(), Some("c0ffee"));
        std::fs::write(h.ledger_json(), "not json").unwrap();
        assert_eq!(read_generation(&h), None, "a torn ledger is not a generation");
    }

    #[test]
    fn threaded_requires_the_flag_to_be_true() {
        let d = tempfile::tempdir().unwrap();
        let h = Home::at(d.path().to_path_buf());
        assert!(!read_threaded(&h), "no manifest → not threaded");
        std::fs::write(h.threads_json(), r#"{"threaded":false,"tools":[]}"#).unwrap();
        assert!(!read_threaded(&h));
        std::fs::write(h.threads_json(), r#"{"threaded":true,"tools":[]}"#).unwrap();
        assert!(read_threaded(&h));
        std::fs::write(h.threads_json(), "{").unwrap();
        assert!(!read_threaded(&h), "a torn manifest is not threaded");
    }

    #[test]
    fn genome_sha_is_baked_in() {
        let s = genome_sha();
        assert!(!s.is_empty());
        assert!(
            s == "unknown" || (s.len() == 40 && s.chars().all(|c| c.is_ascii_hexdigit())),
            "got {s}"
        );
    }

    // ── loomhome_bytes ───────────────────────────────────────────────────────

    #[test]
    fn loomhome_bytes_sums_regular_files_and_skips_symlinks() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().join("home");
        std::fs::create_dir_all(root.join("vendor").join("deep")).unwrap();
        std::fs::write(root.join("a.bin"), vec![0u8; 100]).unwrap();
        std::fs::write(root.join("vendor").join("b.bin"), vec![0u8; 250]).unwrap();
        std::fs::write(root.join("vendor").join("deep").join("c.bin"), vec![0u8; 50]).unwrap();
        // A symlink to a big file OUTSIDE the root must not be followed or counted.
        let outside = d.path().join("outside.bin");
        std::fs::write(&outside, vec![0u8; 10_000]).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, root.join("link.bin")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(d.path(), root.join("loop")).unwrap();
        assert_eq!(loomhome_bytes(&root), 400);
        let h = Home::at(root);
        assert_eq!(identity(&h).loomhome_bytes, 400);
    }

    #[test]
    fn loomhome_bytes_of_a_missing_root_is_zero() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(loomhome_bytes(&d.path().join("absent")), 0);
    }

    #[test]
    fn loomhome_bytes_walk_is_bounded() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().to_path_buf();
        for i in 0..20 {
            std::fs::write(root.join(format!("f{i}")), vec![0u8; 10]).unwrap();
        }
        // With a cap of 5 entries the walk stops early and under-reports —
        // honestly bounded, never unbounded.
        let capped = walk_bytes(&root, 5);
        assert!(capped <= 50, "capped walk counted {capped}");
        assert_eq!(walk_bytes(&root, 1_000), 200);
    }

    // ── seed_source ──────────────────────────────────────────────────────────

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
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    #[test]
    fn seed_clones_bundle_and_checks_out_sha() {
        let d = tempfile::tempdir().unwrap();
        // A real repo with two commits, bundled with --all.
        let repo = d.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&["init", "-q", "-b", "trunk"], &repo);
        std::fs::write(repo.join("a.txt"), "one").unwrap();
        git(&["add", "."], &repo);
        git(&["commit", "-q", "-m", "one"], &repo);
        let first = git(&["rev-parse", "HEAD"], &repo);
        std::fs::write(repo.join("a.txt"), "two").unwrap();
        git(&["commit", "-q", "-am", "two"], &repo);
        let second = git(&["rev-parse", "HEAD"], &repo);
        let bundle = d.path().join("genome.bundle");
        git(&["bundle", "create", bundle.to_str().unwrap(), "--all"], &repo);

        let root = d.path().join("home");
        std::fs::create_dir_all(&root).unwrap();
        let home = Home::at(root);

        // Seed at the FIRST sha (the binary's genome), not the bundle's tip.
        seed_source(&home, &bundle, &first).unwrap();
        assert!(home.source().join(".git").exists());
        assert_eq!(git(&["rev-parse", "HEAD"], &home.source()), first);
        assert_eq!(git(&["rev-parse", "--abbrev-ref", "HEAD"], &home.source()), "main");
        assert_eq!(std::fs::read_to_string(home.source().join("a.txt")).unwrap(), "one");
        assert_ne!(first, second);

        // Idempotent: a second seed at a different sha is a no-op.
        seed_source(&home, &bundle, &second).unwrap();
        assert_eq!(git(&["rev-parse", "HEAD"], &home.source()), first);
    }

    #[test]
    fn seed_without_a_bundle_is_not_found() {
        let d = tempfile::tempdir().unwrap();
        let home = Home::at(d.path().to_path_buf());
        let res = seed_source(&home, &d.path().join("absent.bundle"), "abc");
        match res {
            Err(LoomError::NotFound(m)) => {
                assert!(m.contains("genome bundle is missing"), "msg was {m}")
            }
            other => panic!("expected NotFound, got {other:?}"),
        }
        assert!(!home.source().exists(), "nothing is created when the bundle is absent");
    }

    #[test]
    fn bundle_sha_reads_the_manifest_and_refuses_junk() {
        let d = tempfile::tempdir().unwrap();
        let bundle = d.path().join("genome.bundle");
        std::fs::write(&bundle, b"not really a bundle").unwrap();

        // No manifest beside it — the caller keeps the baked sha.
        assert_eq!(bundle_sha(&bundle), None);

        let good = "a".repeat(40);
        std::fs::write(
            d.path().join("genome.json"),
            format!("{{\"sha\": \"{good}\", \"createdAt\": \"now\"}}"),
        )
        .unwrap();
        assert_eq!(bundle_sha(&bundle).as_deref(), Some(good.as_str()));

        // Anything that is not a 40-char hex sha is refused rather than
        // handed to `git checkout` — a short sha, a ref name, an injection.
        for junk in ["", "abc", "main", "../../etc", &"z".repeat(40)] {
            std::fs::write(
                d.path().join("genome.json"),
                format!("{{\"sha\": \"{junk}\"}}"),
            )
            .unwrap();
            assert_eq!(bundle_sha(&bundle), None, "must refuse {junk:?}");
        }

        // Unparseable manifest → None, never a panic.
        std::fs::write(d.path().join("genome.json"), "{ not json").unwrap();
        assert_eq!(bundle_sha(&bundle), None);
    }
}
