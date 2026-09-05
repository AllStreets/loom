//! threads.rs — tool discovery + the threading manifest (Phase 23 / Rebirth).
//!
//! PROTECTED (kernel.rs `PROTECTED_RUST`): this module decides which
//! executables LOOM will later spawn to weave itself. A self-edit here could
//! point `cargo` at anything.
//!
//! Spec §Threading. `thread_status` reports, per tool, where it is and which
//! version answered — searched in a FIXED order of candidate dirs, then PATH.
//! Missing tools carry the exact install line; LOOM does not install
//! toolchains, it says what is missing and stops. Once threaded, the manifest
//! (`threads.json`) records every path + version, and later status calls
//! report drift (a recorded path gone, or a version that changed) rather than
//! silently tolerating it.
//!
//! No shell is ever spawned: a version probe is `<absolute path> --version`
//! through `exec::run_checked`. `codesign` has no `--version`; it is recorded
//! as `present`. npm is the one exception to "an absolute path is enough":
//! it is a `#!/usr/bin/env node` shim, so every npm spawn — the probe and the
//! ceremony's own — carries a PATH pair leading with the recorded node's
//! directory (`npm_path_env`). cargo needs the same treatment for its own
//! reason: it resolves rustc by name, and native build scripts resolve cmake
//! by name (`whisper-rs-sys` through the `cmake` crate), so every cargo spawn
//! carries the recorded toolchain directories plus `CMAKE` (`cargo_with_path`).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use crate::error::LoomError;
use crate::exec::Slot;
use crate::loomhome::{Home, Mode};

// ── The tool table ────────────────────────────────────────────────────────────

/// One row of the spec's tool table. `candidates` are searched in order
/// before PATH; an entry may start with `~` (the owner's home) and may hold
/// one `*` segment (`~/.nvm/versions/node/*/bin`), resolved to the highest
/// semver directory. `version_args` empty = no probe, version `present`.
#[derive(Clone, Copy, Debug)]
pub struct ToolSpec {
    pub name: &'static str,
    pub required_for: &'static str,
    pub candidates: &'static [&'static str],
    pub version_args: &'static [&'static str],
    pub install: &'static str,
}

const RUSTUP_INSTALL: &str = "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh";
const XCODE_INSTALL: &str = "xcode-select --install";
const NODE_INSTALL: &str = "brew install node";

const GIT: ToolSpec = ToolSpec {
    name: "git",
    required_for: "everything",
    candidates: &["/usr/bin", "/opt/homebrew/bin", "/usr/local/bin"],
    version_args: &["--version"],
    install: XCODE_INSTALL,
};
const CARGO: ToolSpec = ToolSpec {
    name: "cargo",
    required_for: "core",
    candidates: &["~/.cargo/bin", "/opt/homebrew/bin", "/usr/local/bin"],
    version_args: &["--version"],
    install: RUSTUP_INSTALL,
};
const RUSTC: ToolSpec = ToolSpec {
    name: "rustc",
    required_for: "core",
    candidates: &["~/.cargo/bin", "/opt/homebrew/bin", "/usr/local/bin"],
    version_args: &["--version"],
    install: RUSTUP_INSTALL,
};
const NODE: ToolSpec = ToolSpec {
    name: "node",
    required_for: "assets, TS validation",
    candidates: &["~/.nvm/versions/node/*/bin", "/opt/homebrew/bin", "/usr/local/bin"],
    version_args: &["--version"],
    install: NODE_INSTALL,
};
const NPM: ToolSpec = ToolSpec {
    name: "npm",
    required_for: "assets, TS validation",
    candidates: &["~/.nvm/versions/node/*/bin", "/opt/homebrew/bin", "/usr/local/bin"],
    version_args: &["--version"],
    install: NODE_INSTALL,
};
const CMAKE: ToolSpec = ToolSpec {
    name: "cmake",
    required_for: "native deps (whisper.cpp)",
    candidates: &["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"],
    version_args: &["--version"],
    install: "brew install cmake",
};
const CLANG: ToolSpec = ToolSpec {
    name: "clang",
    required_for: "native deps (whisper.cpp)",
    candidates: &["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"],
    version_args: &["--version"],
    install: XCODE_INSTALL,
};
#[cfg(target_os = "macos")]
const CODESIGN: ToolSpec = ToolSpec {
    name: "codesign",
    required_for: "swap (macOS)",
    candidates: &["/usr/bin"],
    version_args: &[],
    install: XCODE_INSTALL,
};

/// The spec's table, in order. `codesign` only exists on macOS.
#[cfg(target_os = "macos")]
pub const TOOLS: &[ToolSpec] = &[GIT, CARGO, RUSTC, NODE, NPM, CMAKE, CLANG, CODESIGN];
#[cfg(not(target_os = "macos"))]
pub const TOOLS: &[ToolSpec] = &[GIT, CARGO, RUSTC, NODE, NPM, CMAKE, CLANG];

pub fn spec(name: &str) -> Option<&'static ToolSpec> {
    TOOLS.iter().find(|t| t.name == name)
}

// ── Discovery ─────────────────────────────────────────────────────────────────

/// A version probe is a local `--version`; anything slower is a hung tool.
const VERSION_TIMEOUT: Duration = Duration::from_secs(10);

/// What `thread_status` reports per tool and what `threads.json` records.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    pub name: String,
    pub path: Option<String>,
    pub version: Option<String>,
    pub required_for: String,
    pub install: String,
}

/// `(major, minor, patch)` from `v22.3.0` / `22.3.0` / `v22.3`. `None` if the
/// name is not a version — nvm keeps only versions there, but a stray file
/// must not win.
fn semver(name: &str) -> Option<(u64, u64, u64)> {
    let s = name.strip_prefix('v').unwrap_or(name);
    let mut parts = s.split('.').map(|p| p.parse::<u64>().ok());
    let major = parts.next()??;
    let minor = parts.next().unwrap_or(Some(0))?;
    let patch = parts.next().unwrap_or(Some(0))?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

/// Resolve one candidate entry: `~` → `home_dir`; a single `*` segment → the
/// highest-semver directory at that level. `None` if nothing resolves.
fn expand_candidate(entry: &str, home_dir: &Path) -> Option<PathBuf> {
    let expanded: PathBuf = if let Some(rest) = entry.strip_prefix("~/") {
        home_dir.join(rest)
    } else if entry == "~" {
        home_dir.to_path_buf()
    } else {
        PathBuf::from(entry)
    };
    let mut out = PathBuf::new();
    let mut components = expanded.components().peekable();
    while let Some(c) = components.next() {
        let seg = c.as_os_str();
        if seg == "*" {
            let best = std::fs::read_dir(&out)
                .ok()?
                .filter_map(|e| e.ok())
                .filter(|e| e.path().is_dir())
                .filter_map(|e| {
                    let n = e.file_name().to_string_lossy().into_owned();
                    semver(&n).map(|v| (v, n))
                })
                .max()?;
            out.push(best.1);
        } else {
            out.push(seg);
        }
    }
    Some(out)
}

/// Find the executable named `spec.name`: the first candidate dir holding it
/// wins, then the entries of `path_env` in order. Never spawns.
pub fn locate(spec: &ToolSpec, home_dir: &Path, path_env: &str) -> Option<PathBuf> {
    let candidates = spec.candidates.iter().filter_map(|c| expand_candidate(c, home_dir));
    let path_dirs = std::env::split_paths(path_env);
    for dir in candidates.chain(path_dirs) {
        let p = dir.join(spec.name);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// The PATH value every `npm` spawn carries: the directory of the RECORDED
/// node, then everything this process already had.
///
/// npm is a `#!/usr/bin/env node` shim — an absolute npm path still resolves
/// `node` through PATH. A Finder-launched macOS app inherits
/// `/usr/bin:/bin:/usr/sbin:/sbin`, which holds neither nvm nor homebrew, so
/// npm answered `env: node: No such file or directory` (exit 127) and the
/// packaged self-rebuild could not take its first step.
///
/// Both halves are LOOM's own — the parent of a path the tool table found,
/// and this process's PATH — so the pair keeps exec's fixed-env contract:
/// nothing here is composed from model output. `None` when the node path has
/// no directory to name.
pub fn npm_path_env(node: &Path) -> Option<String> {
    let dir = node.parent().filter(|d| !d.as_os_str().is_empty())?;
    let mut dirs: Vec<PathBuf> = vec![dir.to_path_buf()];
    dirs.extend(std::env::split_paths(&path_env()));
    std::env::join_paths(dirs).ok().map(|v| v.to_string_lossy().into_owned())
}

/// The PATH pair for `npm`, discovered alongside it; empty for every other
/// tool, which needs nothing but its absolute path.
fn probe_envs(spec: &ToolSpec, home_dir: &Path, path_env: &str) -> Vec<(String, String)> {
    if spec.name != "npm" {
        return Vec::new();
    }
    locate(&NODE, home_dir, path_env)
        .and_then(|node| npm_path_env(&node))
        .map(|v| vec![("PATH".to_string(), v)])
        .unwrap_or_default()
}

/// The first line of `<path> <version_args>`, trimmed; `present` when the
/// tool has no version flag; `None` if the probe fails (a found tool that
/// cannot answer is reported, not hidden — the drift check will flag it).
fn probe_version(path: &Path, spec: &ToolSpec, envs: &[(&str, &str)]) -> Option<String> {
    if spec.version_args.is_empty() {
        return Some("present".into());
    }
    let p = path.to_str()?;
    let mut argv: Vec<&str> = vec![p];
    argv.extend_from_slice(spec.version_args);
    let root = Path::new("/");
    let out = crate::exec::run_checked_env(&argv, root, root, VERSION_TIMEOUT, envs).ok()?;
    if out.code != 0 {
        return None;
    }
    let text = if out.stdout.trim().is_empty() { &out.stderr } else { &out.stdout };
    let line = text.lines().next()?.trim();
    if line.is_empty() { None } else { Some(line.to_string()) }
}

/// Discover one tool now: where it is (candidates, then PATH) and which
/// version answers. `home_dir` and `path_env` are passed in so tests can
/// build a whole machine in a tempdir.
pub fn discover(spec: &ToolSpec, home_dir: &Path, path_env: &str) -> Tool {
    let path = locate(spec, home_dir, path_env);
    let owned = probe_envs(spec, home_dir, path_env);
    let envs: Vec<(&str, &str)> = owned.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    let version = path.as_deref().and_then(|p| probe_version(p, spec, &envs));
    Tool {
        name: spec.name.to_string(),
        path: path.map(|p| p.to_string_lossy().into_owned()),
        version,
        required_for: spec.required_for.to_string(),
        install: spec.install.to_string(),
    }
}

fn owner_home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

fn path_env() -> String {
    std::env::var("PATH").unwrap_or_default()
}

/// Fresh discovery of a spec'd tool on this machine (no manifest consulted).
pub fn locate_now(name: &str) -> Option<PathBuf> {
    locate(spec(name)?, &owner_home(), &path_env())
}

// ── The sherpa cache ──────────────────────────────────────────────────────────

/// The name `thread_status` reports when the sherpa cache has gone.
pub const SHERPA_DRIFT: &str = "sherpa cache";

/// The key `threads.json` keeps the resolved cache path under.
const SHERPA_KEY: &str = "sherpaCache";

/// Where sherpa-rs keeps the prebuilt archive its build script downloads.
///
/// The spec says it lands in the target's OUT_DIR and stays; it does not. It
/// is a user cache — `~/Library/Caches/sherpa-rs/<triple>/<hash>/<dist>` on
/// macOS, `~/.cache/sherpa-rs` elsewhere — outside loomhome, uncounted by
/// `loomhome_bytes`, and purgeable by the OS under disk pressure. It also
/// arrives over HTTP at build time, so once the network is gone it cannot
/// arrive again.
pub fn sherpa_cache_root(home_dir: &Path) -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        home_dir.join("Library").join("Caches").join("sherpa-rs")
    }
    #[cfg(not(target_os = "macos"))]
    {
        home_dir.join(".cache").join("sherpa-rs")
    }
}

/// The deepest single-child directory under the cache root — the extracted
/// distribution itself when one target built here, the root when several
/// did. `None` when nothing was ever downloaded, or when the root is empty.
/// Threading records what this resolves to; `thread_status` later reports
/// that exact path as drift when it is gone, so an offline weave fails early
/// and honestly instead of opaquely, minutes in.
pub fn resolve_sherpa_cache(home_dir: &Path) -> Option<PathBuf> {
    let root = sherpa_cache_root(home_dir);
    if !root.is_dir() {
        return None;
    }
    let mut here = root.clone();
    loop {
        let mut children = std::fs::read_dir(&here).ok()?.filter_map(|e| e.ok());
        let Some(first) = children.next() else {
            // An empty root is a cache that was purged, not one that is here.
            return if here == root { None } else { Some(here) };
        };
        if children.next().is_some() || !first.path().is_dir() {
            return Some(here);
        }
        here = first.path();
    }
}

/// The cache as it stands on this machine, for the owner running LOOM.
fn sherpa_cache_now() -> Option<String> {
    resolve_sherpa_cache(&owner_home()).map(|p| p.to_string_lossy().into_owned())
}

/// Has a recorded cache gone? A path that is no longer a directory, or one
/// that is now empty, cannot serve an offline build.
fn sherpa_gone(recorded: &str) -> bool {
    let p = Path::new(recorded);
    if !p.is_dir() {
        return true;
    }
    std::fs::read_dir(p).map(|mut d| d.next().is_none()).unwrap_or(true)
}

// ── The manifest ──────────────────────────────────────────────────────────────

/// Which ceremony steps have completed. Each step checks its own marker, so
/// an interrupted threading resumes where it stopped.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSteps {
    pub seed: bool,
    pub deps: bool,
    pub vendor: bool,
    pub warm: bool,
    pub register: bool,
}

/// `threads.json`: `threaded` is true only when every step succeeded.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Threads {
    pub threaded: bool,
    pub threaded_at: Option<String>,
    pub threaded_sha: Option<String>,
    pub tools: Vec<Tool>,
    pub steps: ThreadSteps,
}

/// Write `v` as pretty JSON to `path` atomically: serialize, write a sibling
/// temp file, fsync, rename over. A crash mid-write leaves either the old
/// file or the new one — never a torn one. Used for every JSON in loomhome.
pub fn write_json_atomic(path: &Path, v: &impl Serialize) -> Result<(), LoomError> {
    let raw = serde_json::to_string_pretty(v).map_err(|e| LoomError::Parse(e.to_string()))?;
    let parent = path
        .parent()
        .ok_or_else(|| LoomError::Parse(format!("no parent dir for {}", path.display())))?;
    std::fs::create_dir_all(parent).map_err(|e| LoomError::Git(e.to_string()))?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "json".into());
    let tmp = parent.join(format!(".{name}.{}.tmp", std::process::id()));
    let result = (|| -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        std::io::Write::write_all(&mut f, raw.as_bytes())?;
        f.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result.map_err(|e| LoomError::Git(format!("write {}: {e}", path.display())))
}

/// The manifest, or `None` if absent or torn.
pub fn read(home: &Home) -> Option<Threads> {
    let raw = std::fs::read_to_string(home.threads_json()).ok()?;
    serde_json::from_str(&raw).ok()
}

/// The sherpa cache path recorded at threading, if any.
///
/// It sits beside the manifest rather than inside `Threads` because it does
/// not describe a tool LOOM found and can find again: it is a cache LOOM
/// cannot rebuild once the network is gone, recorded once and thereafter only
/// checked. `write` carries whatever is on disk forward, so no later step of
/// the ceremony can drop it.
pub fn read_sherpa(home: &Home) -> Option<String> {
    let raw = std::fs::read_to_string(home.threads_json()).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v.get(SHERPA_KEY)?.as_str().map(|s| s.to_string())
}

pub fn write(home: &Home, t: &Threads) -> Result<(), LoomError> {
    let kept = read_sherpa(home);
    write_sherpa(home, t, kept)
}

/// Write the manifest and the sherpa cache path together.
pub fn write_sherpa(home: &Home, t: &Threads, sherpa: Option<String>) -> Result<(), LoomError> {
    let mut v = serde_json::to_value(t).map_err(|e| LoomError::Parse(e.to_string()))?;
    if let (Some(obj), Some(p)) = (v.as_object_mut(), sherpa) {
        obj.insert(SHERPA_KEY.to_string(), serde_json::Value::String(p));
    }
    write_json_atomic(&home.threads_json(), &v)
}

/// Was a sherpa cache recorded at threading, and has it since gone?
///
/// The archive arrives over HTTP at build time and cannot arrive again once
/// the network is gone, so its absence is not a warning — it is the reason a
/// weave will fail, and `reweave::check_start` refuses on it. A LOOM that
/// never recorded one is not blocked: `false` is the honest answer to "was
/// something here and is it gone".
pub fn sherpa_missing(home: &Home) -> bool {
    read_sherpa(home).as_deref().map_or(false, sherpa_gone)
}

/// A recorded tool's path if it still exists on disk; otherwise a fresh
/// discovery. This is what every later spawn (validation, reweave) asks for
/// argv[0].
///
/// The fallback deliberately swaps toolchains: when the recorded node or
/// cargo is gone (an nvm bump moves node's whole directory), the weave runs
/// against whatever the search finds NOW, which may not be what
/// `threads.json` recorded. Round-2 review, Finding 8 — considered and kept,
/// because refusing would strand the owner: re-threading does not re-record
/// the tool table, so there would be no remedy to offer. It is stated rather
/// than hidden — `status_with` reports the tool as drifted and the Settings
/// row says a weave uses the one found now, not the one recorded.
pub fn tool_path(home: &Home, name: &str) -> Option<PathBuf> {
    if let Some(t) = read(home) {
        if let Some(p) = t.tools.iter().find(|t| t.name == name).and_then(|t| t.path.as_deref()) {
            let p = PathBuf::from(p);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    locate_now(name)
}

// ── Status ────────────────────────────────────────────────────────────────────

/// What the threading card reads. `missing` = not found now; `drifted` = a
/// recorded tool whose path is gone or whose version changed; `needs_network`
/// = deps or vendor have not completed (the only steps that touch the net).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ThreadStatus {
    pub threaded: bool,
    pub tools: Vec<Tool>,
    pub missing: Vec<String>,
    pub drifted: Vec<String>,
    pub steps: ThreadSteps,
    pub needs_network: bool,
    /// Where threading found the sherpa prebuilt archive. When it is gone it
    /// also appears in `drifted` as `sherpa cache`: no weave can fetch it
    /// again offline, and the owner should hear that before the weave, not
    /// minutes into one.
    pub sherpa_cache: Option<String>,
}

/// Discover every spec now and compare against the manifest. `specs`,
/// `home_dir` and `path_env` are parameters so a test can stage a machine.
pub fn status_with(home: &Home, specs: &[ToolSpec], home_dir: &Path, path_env: &str) -> ThreadStatus {
    let recorded = read(home);
    let tools: Vec<Tool> = specs.iter().map(|s| discover(s, home_dir, path_env)).collect();
    let missing: Vec<String> = tools
        .iter()
        .filter(|t| t.path.is_none())
        .map(|t| t.name.clone())
        .collect();
    let mut drifted = Vec::new();
    if let Some(r) = &recorded {
        for rec in &r.tools {
            let Some(rec_path) = rec.path.as_deref() else { continue };
            let gone = !Path::new(rec_path).is_file();
            let now = tools.iter().find(|t| t.name == rec.name);
            let version_changed = now.map_or(true, |t| t.version != rec.version);
            if gone || version_changed {
                drifted.push(rec.name.clone());
            }
        }
    }
    let sherpa = read_sherpa(home);
    if sherpa_missing(home) {
        drifted.push(SHERPA_DRIFT.to_string());
    }
    let steps = recorded.as_ref().map(|r| r.steps).unwrap_or_default();
    ThreadStatus {
        threaded: recorded.as_ref().map_or(false, |r| r.threaded),
        tools,
        missing,
        drifted,
        steps,
        needs_network: !steps.deps || !steps.vendor,
        sherpa_cache: sherpa,
    }
}

pub fn status(home: &Home) -> ThreadStatus {
    status_with(home, TOOLS, &owner_home(), &path_env())
}

/// `{ threaded, tools, missing, drifted, steps, needsNetwork }` — discovers
/// now, compares with `threads.json`. Never spawns a shell.
#[tauri::command]
pub fn thread_status(app: tauri::AppHandle) -> Result<ThreadStatus, LoomError> {
    let home = Home::from_app(&app)?;
    Ok(status(&home))
}

// ── The ceremony ──────────────────────────────────────────────────────────────
//
// Spec §Threading: seed · deps · vendor · warm · register · stamp. Runs as one
// background job in the global `exec::JOB` slot (shared with reweave, so the
// two can never overlap). Every step first reads its own marker in
// `threads.json` and skips if already true — an interrupted ceremony resumes
// where it stopped. `threaded` turns true only at stamp.
//
// Every spawn is a fixed argv through `exec` with `allowed_root = home.root`;
// argv[0] is the absolute tool path the threads table recorded. deps and
// vendor are the only steps in all of LOOM allowed to touch the network,
// and the failure line says so.

/// The `loom-thread` event payload. `step` is one of seed · deps · vendor ·
/// warm · register · stamp · done · failed; `tail` is the last few lines of
/// the running tool's output (cargo's "Compiling x/y").
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ThreadEvent {
    pub step: String,
    pub detail: String,
    pub tail: Vec<String>,
}

pub const THREAD_EVENT: &str = "loom-thread";

/// The one honest line about the network (spec §Threading, step 2).
pub const NEEDS_NETWORK: &str = "threading needs the network once — after that LOOM weaves offline.";

/// What a cancelled ceremony says. The step that was running stays unmarked,
/// so the next `thread_loom` resumes from it.
pub const CANCELLED: &str = "threading was cancelled — run it again to continue.";

/// What `thread_cancel` says when threading is not the job in flight.
pub const NOTHING_TO_CANCEL: &str = "nothing to cancel — the loom isn't being threaded";

const DEPS_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const VENDOR_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const ASSETS_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const CORE_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// How many lines of the running tool's output ride on a progress event.
const TAIL_LINES: usize = 3;
/// How often the warm step re-emits its tail.
const TAIL_EVERY: Duration = Duration::from_secs(2);

/// npm's own words for "no network".
const OFFLINE_MARKS: &[&str] = &["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"];

/// The tool named `name`, or the install line for it — the ceremony does
/// not install toolchains, it says what is missing and stops.
fn need_tool(tools: &dyn Fn(&str) -> Option<PathBuf>, name: &str) -> Result<String, LoomError> {
    match tools(name) {
        Some(p) => Ok(p.to_string_lossy().into_owned()),
        None => {
            let install = spec(name).map(|s| s.install).unwrap_or("");
            Err(LoomError::NotFound(format!("{name} is missing — install it with `{install}`")))
        }
    }
}

/// npm's absolute path plus the PATH value that lets its shebang find node.
/// A machine with npm but no node cannot run npm at all, so it stops here
/// with node's own install line rather than at a shim's exit 127.
///
/// Public because the ceremony is not the only caller: `reweave`'s assets
/// stage runs the same `npm run build` on the same machine and needs the same
/// pair. Round 1 fixed only the ceremony and said it had fixed both.
pub fn npm_with_node(tools: &dyn Fn(&str) -> Option<PathBuf>) -> Result<(String, String), LoomError> {
    let npm = need_tool(tools, "npm")?;
    let node = need_tool(tools, "node")?;
    let path = npm_path_env(Path::new(&node))
        .ok_or_else(|| LoomError::NotFound(format!("node has no directory to lead PATH: {node}")))?;
    Ok((npm, path))
}

/// The tools whose RECORDED directories lead every cargo spawn's PATH, in
/// this order. cargo and rustc because cargo finds its own toolchain by name;
/// cmake and clang because native build scripts do.
const CARGO_PATH_TOOLS: &[&str] = &["cargo", "rustc", "cmake", "clang"];

/// The PATH value every `cargo` spawn carries: the directories of the tools
/// the table RECORDED, then everything this process already had.
///
/// The same lesson npm taught, on the other half of the toolchain. An
/// absolute cargo path is not enough: `whisper-rs-sys`'s build script drives
/// the `cmake` crate, which on unix resolves the literal `"cmake"` through
/// PATH — there is no absolute-path escape hatch. A Finder-launched macOS app
/// inherits `/usr/bin:/bin:/usr/sbin:/sbin`, which holds neither homebrew nor
/// rustup: cmake, cargo, rustc, node and npm are all absent there, while cc,
/// clang and codesign are present. So the warm step — the long one, spent
/// after `npm ci` and `cargo vendor` have used the owner's single network
/// trip — died with cmake's "command not found" surfaced as a bare cargo exit
/// code, and `threaded` never turned true.
///
/// Every entry is LOOM's own: the parent of a path the tool table found, or a
/// directory this process already had. Nothing is composed from model output,
/// so the pair keeps exec's fixed-env contract. `None` only when the joined
/// value cannot be built at all.
pub fn cargo_path_env(tools: &dyn Fn(&str) -> Option<PathBuf>) -> Option<String> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    for name in CARGO_PATH_TOOLS {
        let Some(dir) = tools(name)
            .and_then(|p| p.parent().map(Path::to_path_buf))
            .filter(|d| !d.as_os_str().is_empty())
        else {
            continue;
        };
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    dirs.extend(std::env::split_paths(&path_env()));
    std::env::join_paths(dirs).ok().map(|v| v.to_string_lossy().into_owned())
}

/// cargo's absolute path plus the env pairs every cargo spawn needs: the
/// PATH the toolchain lives on, and — when the table recorded one — `CMAKE`
/// naming the exact cmake binary. The `cmake` crate honours `CMAKE` before it
/// searches, which is stronger than a PATH hit.
///
/// cmake is optional here on purpose: a machine without it can still build
/// everything that does not need a native dep, and a missing cmake already
/// has its own row and its own install line in the tool table.
#[derive(Debug, Clone)]
pub struct CargoSpawn {
    pub cargo: String,
    pub envs: Vec<(String, String)>,
}

/// The pair for `cargo`, from the recorded table. Public because the ceremony
/// is not the only caller: `reweave`'s core stage compiles the same crate on
/// the same machine and needs the same env. Round 1 fixed only npm.
pub fn cargo_with_path(tools: &dyn Fn(&str) -> Option<PathBuf>) -> Result<CargoSpawn, LoomError> {
    let cargo = need_tool(tools, "cargo")?;
    let path = cargo_path_env(tools)
        .ok_or_else(|| LoomError::NotFound("cargo's PATH could not be composed".to_string()))?;
    let mut envs = vec![("PATH".to_string(), path)];
    if let Some(cmake) = tools("cmake") {
        envs.push(("CMAKE".to_string(), cmake.to_string_lossy().into_owned()));
    }
    Ok(CargoSpawn { cargo, envs })
}

/// Every step of the ceremony runs through the slot-registering streamed
/// runner. A spawn `thread_cancel` cannot reach is a stop button that does
/// not stop — and `npm ci` and `cargo vendor` are the only two steps in the
/// whole product that talk to the internet. Returns the tool's exit plus the
/// last lines it printed, which the caller emits as the step's progress.
#[allow(clippy::too_many_arguments)]
fn run_step(
    slot: &Slot,
    step: &str,
    detail: &str,
    argv: &[&str],
    cwd: &Path,
    root: &Path,
    timeout: Duration,
    envs: &[(&str, &str)],
    emit: &mut dyn FnMut(&str, &str, &[String]),
) -> Result<(crate::exec::ExecOut, Vec<String>), LoomError> {
    let mut tail: Vec<String> = Vec::new();
    let mut last: Option<Instant> = None;
    let out = crate::exec::run_job_stream(slot, argv, cwd, root, timeout, envs, &mut |line| {
        if line.trim().is_empty() {
            return;
        }
        if tail.len() == TAIL_LINES {
            tail.remove(0);
        }
        tail.push(line.to_string());
        if last.map_or(true, |t: Instant| t.elapsed() >= TAIL_EVERY) {
            emit(step, detail, &tail);
            last = Some(Instant::now());
        }
    })?;
    Ok((out, tail))
}

/// Between every step. A cancel that lands while a tool runs kills the tool;
/// a cancel that lands between them must still stop the ceremony instead of
/// letting the next step start.
fn cancel_check(slot: &Slot) -> Result<(), Failed> {
    if slot.cancelled() {
        return Err(LoomError::Parse(CANCELLED.into()).into());
    }
    Ok(())
}

fn tail_of(text: &str) -> Vec<String> {
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    let skip = lines.len().saturating_sub(TAIL_LINES);
    lines[skip..].iter().map(|l| l.to_string()).collect()
}

/// Where the ceremony works, per mode (spec §Modes).
///
/// Dev is the checkout LOOM is running from — `resolve_source_repo_at`
/// canonicalizes it and asserts it is a git work dir. Packaged is
/// `loomhome/source`, named rather than resolved: on the first threading it
/// does not exist yet — seed is the step that creates it — and a resolution
/// that canonicalizes would refuse the ceremony before it could start.
///
/// `loomhome/source` in dev is nobody's: seed never writes it, so binding it
/// for both modes made every dev threading die in `checked_cwd` and left
/// `threaded` false forever — and with it every reweave the spec calls "how
/// CI and the owner prove it".
pub fn ceremony_source(home: &Home, mode: Mode) -> Result<PathBuf, LoomError> {
    match mode {
        Mode::Packaged => Ok(home.source()),
        Mode::Dev => crate::kernel::resolve_source_repo_at(mode, None, Some(home)),
    }
}

/// The allowed root for every spawn in the ceremony. Packaged: loomhome,
/// which contains the source and the vendor and target dirs. Dev: the
/// checkout itself — it lives wherever the owner keeps it, and a root that
/// does not contain the cwd refuses every spawn.
fn ceremony_root(home: &Home, mode: Mode, source: &Path) -> PathBuf {
    match mode {
        Mode::Packaged => home.root.clone(),
        Mode::Dev => source.to_path_buf(),
    }
}

/// The vendored-source replacement written after `cargo vendor`. PROTECTED
/// in the genome (kernel.rs) — a self-edit here could point cargo anywhere.
fn cargo_config(vendor: &Path) -> String {
    format!(
        "[source.crates-io]\nreplace-with = \"vendored\"\n[source.vendored]\ndirectory = \"{}\"\n[net]\noffline = true\n",
        vendor.display()
    )
}

/// The ceremony, factored so a test can stage fake tools in a tempdir.
///
/// - `source` is the genome to work in: the checkout in dev, `loomhome/source`
///   in packaged mode (`ceremony_source`).
/// - `slot` is the job slot this ceremony holds (`exec::JOB` in the app): every
///   spawn registers its pid there, so `thread_cancel` reaches all of them.
/// - `tools(name)` resolves a tool to its absolute path (`tool_path` in the
///   app; a closure over fakes in tests).
/// - `exe` is the running executable, shelved as generation 0 at register.
/// - `bundle` is the genome bundle for seed (`None` in dev, where source is
///   the cwd and seed is skipped).
/// - `emit(step, detail, tail)` is called for every progress event, ending
///   with `done` or `failed`.
///
/// Returns the failure so the caller can also surface it; the `failed`
/// event has already been emitted by then.
#[allow(clippy::too_many_arguments)]
pub fn run_ceremony(
    home: &Home,
    mode: Mode,
    source: &Path,
    slot: &Slot,
    tools: &dyn Fn(&str) -> Option<PathBuf>,
    exe: &Path,
    bundle: Option<&Path>,
    emit: &mut dyn FnMut(&str, &str, &[String]),
) -> Result<(), LoomError> {
    let mut t = read(home).unwrap_or(Threads {
        threaded: false,
        threaded_at: None,
        threaded_sha: None,
        tools: vec![],
        steps: ThreadSteps::default(),
    });
    match ceremony_steps(home, mode, source, slot, tools, exe, bundle, emit, &mut t) {
        Ok(()) => {
            emit("done", "the loom is threaded — it weaves offline from here.", &[]);
            Ok(())
        }
        Err(Failed { err, tail }) => {
            let detail = match &err {
                LoomError::Parse(m) => m.clone(),
                LoomError::Timeout => "a step ran out of time — run threading again to continue.".to_string(),
                other => other.to_string(),
            };
            emit("failed", &detail, &tail);
            Err(err)
        }
    }
}

/// A step's failure plus the last lines of the tool that failed, so the
/// `failed` event carries evidence (npm's own ENOTFOUND under the honest line).
struct Failed {
    err: LoomError,
    tail: Vec<String>,
}

impl From<LoomError> for Failed {
    fn from(err: LoomError) -> Failed {
        Failed { err, tail: vec![] }
    }
}

/// An `npm`/`cargo` exit ≠ 0: the honest network line when the stderr says
/// the network was the reason, otherwise the tool's own last words.
fn step_failed(what: &str, out: &crate::exec::ExecOut) -> Failed {
    let text = if out.stderr.trim().is_empty() { &out.stdout } else { &out.stderr };
    let tail = tail_of(text);
    if OFFLINE_MARKS.iter().any(|m| out.stderr.contains(m)) {
        return Failed { err: LoomError::Parse(NEEDS_NETWORK.into()), tail };
    }
    Failed { err: LoomError::Parse(format!("{what} failed (exit {})", out.code)), tail }
}

#[allow(clippy::too_many_arguments)]
fn ceremony_steps(
    home: &Home,
    mode: Mode,
    source: &Path,
    slot: &Slot,
    tools: &dyn Fn(&str) -> Option<PathBuf>,
    exe: &Path,
    bundle: Option<&Path>,
    emit: &mut dyn FnMut(&str, &str, &[String]),
    t: &mut Threads,
) -> Result<(), Failed> {
    let root = ceremony_root(home, mode, source);
    let source = source.to_path_buf();
    let core = source.join("src-tauri");
    let sha = crate::loomhome::genome_sha();
    let none: &[String] = &[];

    // 1 · seed
    if t.steps.seed {
        emit("seed", "already seeded", none);
    } else {
        match mode {
            Mode::Dev => emit("seed", "dev mode — the source is this checkout", none),
            Mode::Packaged => {
                emit("seed", "cloning the bundled genome into source/", none);
                let bundle = bundle.ok_or_else(|| {
                    Failed::from(LoomError::NotFound(
                        "the genome bundle is missing — this LOOM was built without its history".into(),
                    ))
                })?;
                // Follow the bundle's own sha when it disagrees with the one
                // baked into this binary — the bundle is the authority on
                // which commits exist to check out. They agree in a healthy
                // build; a disagreement is worth saying out loud.
                let seed_sha = crate::loomhome::bundle_sha(bundle).unwrap_or_else(|| sha.to_string());
                if seed_sha != sha {
                    emit(
                        "seed",
                        "the bundle and the binary name different shas — following the bundle",
                        none,
                    );
                }
                crate::loomhome::seed_source(home, bundle, &seed_sha)?;
            }
        }
        t.steps.seed = true;
        write(home, t)?;
    }
    cancel_check(slot)?;

    // 2 · deps (network, once)
    if t.steps.deps {
        emit("deps", "dependencies already installed", none);
    } else {
        emit("deps", "npm ci — this is the step that needs the network", none);
        let (npm, node_path) = npm_with_node(tools)?;
        let (out, _) = run_step(
            slot,
            "deps",
            "npm ci",
            &[&npm, "ci", "--no-audit", "--no-fund"],
            &source,
            &root,
            DEPS_TIMEOUT,
            &[("PATH", &node_path)],
            emit,
        )?;
        if out.code != 0 {
            cancel_check(slot)?;
            return Err(step_failed("npm ci", &out));
        }
        t.steps.deps = true;
        write(home, t)?;
    }
    cancel_check(slot)?;

    // 3 · vendor (network, once)
    if t.steps.vendor {
        emit("vendor", "crates already vendored", none);
    } else {
        emit("vendor", "cargo vendor — every crate, kept locally", none);
        // cargo resolves its own toolchain by NAME: even vendoring asks rustc
        // for the target spec. The pair that lets the warm step find cmake is
        // what lets this step find rustc at all.
        let spawn = cargo_with_path(tools)?;
        let vendor_dir = home.vendor().to_string_lossy().into_owned();
        let envs: Vec<(&str, &str)> =
            spawn.envs.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        let (out, _) = run_step(
            slot,
            "vendor",
            "vendoring the crates",
            &[&spawn.cargo, "vendor", "--versioned-dirs", &vendor_dir],
            &core,
            &root,
            VENDOR_TIMEOUT,
            &envs,
            emit,
        )?;
        if out.code != 0 {
            cancel_check(slot)?;
            return Err(step_failed("cargo vendor", &out));
        }
        let cfg = source.join(".cargo").join("config.toml");
        std::fs::create_dir_all(cfg.parent().unwrap()).map_err(|e| LoomError::Git(e.to_string()))?;
        std::fs::write(&cfg, cargo_config(&home.vendor()))
            .map_err(|e| LoomError::Git(format!("write {}: {e}", cfg.display())))?;
        // Say what was left behind. In dev this file lands in the owner's own
        // checkout, where every later `cargo` — LOOM's and theirs — reads it
        // and builds from the vendored crates with the network switched off.
        // Round-2 review, Finding 6: an untracked file that silently changes
        // how a checkout builds must be announced, not discovered.
        emit(
            "vendor",
            &format!(
                "wrote {} — cargo in this checkout now builds from the vendored crates, offline",
                cfg.display()
            ),
            none,
        );
        t.steps.vendor = true;
        write(home, t)?;
    }
    cancel_check(slot)?;

    // 4 · warm (the long one)
    if t.steps.warm {
        emit("warm", "the build is already warm", none);
    } else {
        emit("warm", "building the assets", none);
        let (npm, node_path) = npm_with_node(tools)?;
        let (out, _) = run_step(
            slot,
            "warm",
            "building the assets",
            &[&npm, "run", "build"],
            &source,
            &root,
            ASSETS_TIMEOUT,
            &[("PATH", &node_path)],
            emit,
        )?;
        if out.code != 0 {
            cancel_check(slot)?;
            return Err(step_failed("npm run build", &out));
        }
        cancel_check(slot)?;
        emit("warm", "compiling the core — native deps compile once", none);
        // The long step, and the one that compiles the native deps: cmake has
        // to be findable or `whisper-rs-sys` fails minutes in, after the
        // owner's single network trip has already been spent.
        let spawn = cargo_with_path(tools)?;
        let target = home.target().to_string_lossy().into_owned();
        let mut envs: Vec<(&str, &str)> =
            vec![("CARGO_TARGET_DIR", &target), ("CARGO_NET_OFFLINE", "true")];
        envs.extend(spawn.envs.iter().map(|(k, v)| (k.as_str(), v.as_str())));
        let (out, tail) = run_step(
            slot,
            "warm",
            "compiling the core",
            &[&spawn.cargo, "build", "--release", "--offline"],
            &core,
            &root,
            CORE_TIMEOUT,
            &envs,
            emit,
        )?;
        if out.code != 0 {
            cancel_check(slot)?;
            return Err(step_failed("cargo build", &out));
        }
        emit("warm", "the core is built", &tail);
        // The sherpa archive came down over HTTP during this build and will
        // not come down again offline. Record where it landed, so status can
        // report its absence before a weave discovers it the hard way.
        t.steps.warm = true;
        write_sherpa(home, t, sherpa_cache_now())?;
    }
    cancel_check(slot)?;

    // 5 · register — the running body becomes generation 0
    if t.steps.register {
        emit("register", "generation 0 already shelved", none);
    } else {
        emit("register", "shelving this body as generation 0", none);
        crate::generations::record(home, sha, exe, "threaded")?;
        let mut ledger = crate::generations::read(home);
        ledger.current = Some(sha.to_string());
        ledger.previous = None;
        ledger.confirmed = true;
        crate::generations::write(home, &ledger)?;
        t.steps.register = true;
        write(home, t)?;
    }
    cancel_check(slot)?;

    // 6 · stamp — threaded only now
    emit("stamp", "writing threads.json", none);
    t.threaded = true;
    t.threaded_at = Some(crate::generations::now_rfc3339());
    t.threaded_sha = Some(sha.to_string());
    write(home, t)?;
    Ok(())
}

/// Is the job in flight THREADING's, and which tenancy of the slot is it?
/// `exec::JOB` says a job holds the slot, not whose it is; `thread_cancel`
/// must never reach a weave. Zero means no ceremony is running.
///
/// It holds the token rather than a bare flag because reading the flag and
/// killing are two steps: between them the ceremony can end and a weave can
/// claim the slot. The token the ceremony was given is what `Slot::kill`
/// checks, so a late stop button reaches nothing.
static ACTIVE: AtomicU64 = AtomicU64::new(0);

/// Raises the flag for as long as it lives and lowers it on drop — an
/// unwinding job thread leaves nothing standing.
struct Active;

impl Active {
    fn take(token: crate::exec::JobToken) -> Active {
        ACTIVE.store(token, Ordering::SeqCst);
        Active
    }
}

impl Drop for Active {
    fn drop(&mut self) {
        ACTIVE.store(0, Ordering::SeqCst);
    }
}

/// Start the ceremony as a background job. Refuses if threading or reweave
/// is already in flight (they share `exec::JOB`). Progress arrives as
/// `loom-thread` events; the command itself returns at once.
#[tauri::command]
pub fn thread_loom(app: tauri::AppHandle) -> Result<(), LoomError> {
    use tauri::Emitter;
    let home = Home::from_app(&app)?;
    // The slot is held by an RAII guard from here on: every early return
    // below, and a panic in the job thread, releases it.
    let Some(slot) = crate::exec::SlotGuard::take(&crate::exec::JOB) else {
        return Err(LoomError::Parse("threading already in flight".into()));
    };
    // Record the machine's tools (paths + versions) before the first step,
    // so drift has a baseline and every spawn below uses a recorded path.
    if read(&home).is_none() {
        let discovered = status(&home).tools;
        let fresh = Threads {
            threaded: false,
            threaded_at: None,
            threaded_sha: None,
            tools: discovered,
            steps: ThreadSteps::default(),
        };
        write(&home, &fresh)?;
    }
    let mode = crate::loomhome::mode();
    let bundle = match mode {
        Mode::Packaged => home.genome_bundle_resource(&app).ok(),
        Mode::Dev => None,
    };
    let started = (|| {
        let source = ceremony_source(&home, mode)?;
        let exe = std::env::current_exe()
            .map_err(|e| LoomError::NotFound(format!("current exe: {e}")))?;
        Ok::<(PathBuf, PathBuf), LoomError>((source, exe))
    })();
    let (source, exe) = started?;
    std::thread::spawn(move || {
        // Both are RAII: this thread ending — by return or by panic — lowers
        // the flag first and frees the slot second, so there is never a
        // moment where a reweave holds the slot while threading still claims
        // the right to cancel it.
        let held = slot;
        let _active = Active::take(held.token());
        let tools = |name: &str| tool_path(&home, name);
        let mut emit = |step: &str, detail: &str, tail: &[String]| {
            let _ = app.emit(
                THREAD_EVENT,
                ThreadEvent { step: step.into(), detail: detail.into(), tail: tail.to_vec() },
            );
        };
        let _ = run_ceremony(
            &home,
            mode,
            &source,
            held.slot(),
            &tools,
            &exe,
            bundle.as_deref(),
            &mut emit,
        );
    });
    Ok(())
}

/// Stop a running ceremony: group-kills the current tool. The step that was
/// running stays unmarked, so the next `thread_loom` resumes from it.
///
/// Refused unless threading is the job in flight. The slot is shared with
/// reweave, and a weave past its cancellable stages is not threading's to
/// kill — the spec's point of return belongs to the reweave card.
///
/// The kill carries the ceremony's own token: reading the flag and killing
/// are two steps, and between them the ceremony can end and a weave can take
/// the slot. `Slot::kill` refuses any token but the one it currently holds,
/// so a stop button pressed a moment too late reaches nothing at all.
#[tauri::command]
pub fn thread_cancel() -> Result<(), LoomError> {
    let token = ACTIVE.load(Ordering::SeqCst);
    if token == 0 {
        return Err(LoomError::Parse(NOTHING_TO_CANCEL.into()));
    }
    crate::exec::JOB.kill(token);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// A fake executable: a shell script with a shebang that prints `line`.
    /// LOOM never spawns a shell; the kernel runs the shebang interpreter.
    #[cfg(unix)]
    fn fake_exe(dir: &Path, name: &str, line: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(dir).unwrap();
        let p = dir.join(name);
        std::fs::write(&p, format!("#!/bin/sh\necho \"{line}\"\n")).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    /// A fake executable with a body of its own (the shebang interpreter
    /// runs it; LOOM never spawns a shell itself).
    #[cfg(unix)]
    fn fake_script(dir: &Path, name: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(dir).unwrap();
        let p = dir.join(name);
        std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    fn spec_for(name: &str) -> &'static ToolSpec {
        TOOLS.iter().find(|t| t.name == name).expect("spec exists")
    }

    fn leak(s: String) -> &'static str {
        Box::leak(s.into_boxed_str())
    }

    #[cfg(unix)]
    #[test]
    fn discover_prefers_candidate_dirs_over_path() {
        let d = tempfile::tempdir().unwrap();
        let cand_dir = d.path().join("cand");
        let path_dir = d.path().join("onpath");
        fake_exe(&cand_dir, "cargo", "cargo 1.0.0-fake");
        fake_exe(&path_dir, "cargo", "cargo 9.9.9-path");
        let spec = ToolSpec {
            name: "cargo",
            required_for: "core",
            candidates: Box::leak(vec![leak(cand_dir.to_string_lossy().into_owned())].into_boxed_slice()),
            version_args: &["--version"],
            install: "curl … | sh",
        };
        let tool = discover(&spec, d.path(), path_dir.to_str().unwrap());
        assert_eq!(tool.name, "cargo");
        assert_eq!(tool.path.as_deref(), Some(cand_dir.join("cargo").to_str().unwrap()));
        assert_eq!(tool.version.as_deref(), Some("cargo 1.0.0-fake"));
        assert_eq!(tool.required_for, "core");

        // With no candidate hit, PATH is walked.
        let spec_no_cand = ToolSpec { candidates: &[], ..spec };
        let tool = discover(&spec_no_cand, d.path(), path_dir.to_str().unwrap());
        assert_eq!(tool.path.as_deref(), Some(path_dir.join("cargo").to_str().unwrap()));
        assert_eq!(tool.version.as_deref(), Some("cargo 9.9.9-path"));
    }

    #[test]
    fn discover_reports_missing_with_install_line() {
        let d = tempfile::tempdir().unwrap();
        let spec = ToolSpec {
            name: "cmake",
            required_for: "native deps",
            candidates: &[],
            version_args: &["--version"],
            install: "brew install cmake",
        };
        let empty_path = d.path().join("nothing-here");
        let tool = discover(&spec, d.path(), empty_path.to_str().unwrap());
        assert_eq!(tool.path, None);
        assert_eq!(tool.version, None);
        assert_eq!(tool.install, "brew install cmake");
        assert_eq!(tool.required_for, "native deps");
    }

    #[cfg(unix)]
    #[test]
    fn nvm_highest_version_wins() {
        let d = tempfile::tempdir().unwrap();
        let home = d.path().join("home");
        let nvm = home.join(".nvm").join("versions").join("node");
        fake_exe(&nvm.join("v20.1.0").join("bin"), "node", "v20.1.0");
        fake_exe(&nvm.join("v22.3.0").join("bin"), "node", "v22.3.0");
        fake_exe(&nvm.join("v9.0.0").join("bin"), "node", "v9.0.0"); // lexically last, semver lowest
        std::fs::create_dir_all(nvm.join("junk")).unwrap(); // not a version
        let tool = discover(spec_for("node"), &home, "");
        assert_eq!(
            tool.path.as_deref(),
            Some(nvm.join("v22.3.0").join("bin").join("node").to_str().unwrap())
        );
        assert_eq!(tool.version.as_deref(), Some("v22.3.0"));
    }

    #[test]
    fn npm_path_env_puts_the_recorded_node_first() {
        let v = npm_path_env(Path::new("/opt/loom/node/v22.3.0/bin/node")).unwrap();
        let mut entries = std::env::split_paths(&v);
        assert_eq!(
            entries.next().unwrap(),
            PathBuf::from("/opt/loom/node/v22.3.0/bin"),
            "the recorded node's own directory leads: {v}"
        );
        // Nothing the process already had is dropped — the pair prepends.
        let rest: Vec<PathBuf> = entries.collect();
        for dir in std::env::split_paths(&std::env::var("PATH").unwrap_or_default()) {
            assert!(rest.contains(&dir), "{} was dropped from PATH", dir.display());
        }
        assert_eq!(npm_path_env(Path::new("node")), None, "a bare name has no directory");
    }

    /// npm is a `#!/usr/bin/env node` shim: an absolute npm path is not
    /// enough, node has to be ON PATH. A Finder-launched app's PATH is
    /// `/usr/bin:/bin:/usr/sbin:/sbin`, which has neither nvm nor homebrew,
    /// so the probe answered `env: node: No such file or directory` and the
    /// table showed npm with a valid path and no version.
    #[cfg(unix)]
    #[test]
    fn npm_version_probe_carries_the_recorded_node() {
        let d = tempfile::tempdir().unwrap();
        let home = d.path().join("home");
        let bin = home.join(".nvm").join("versions").join("node").join("v22.3.0").join("bin");
        fake_exe(&bin, "node", "v22.3.0");
        fake_script(&bin, "npm", "command -v node");
        let tool = discover(spec_for("npm"), &home, "");
        assert_eq!(tool.path.as_deref(), Some(bin.join("npm").to_str().unwrap()));
        assert_eq!(
            tool.version.as_deref(),
            Some(bin.join("node").to_str().unwrap()),
            "the probe must see the RECORDED node, not whatever PATH the app inherited"
        );
    }

    /// Round-3 review, Finding 1. Round 1 taught npm to carry a PATH and
    /// wrote down why; cargo was left with none. `whisper-rs-sys`'s build
    /// script drives the `cmake` crate, which resolves the literal `"cmake"`
    /// through PATH — there is no absolute-path escape on unix. A
    /// Finder-launched app inherits `/usr/bin:/bin:/usr/sbin:/sbin`, which
    /// holds no cmake, no cargo and no rustc: the warm step died minutes in,
    /// after the owner's single network trip, with cmake's "command not
    /// found" surfaced as a bare cargo exit code.
    #[test]
    fn cargo_path_env_leads_with_the_recorded_tool_dirs() {
        let tools = |name: &str| match name {
            "cargo" => Some(PathBuf::from("/opt/loom/.cargo/bin/cargo")),
            "rustc" => Some(PathBuf::from("/opt/loom/.cargo/bin/rustc")),
            "cmake" => Some(PathBuf::from("/opt/homebrew/bin/cmake")),
            "clang" => Some(PathBuf::from("/usr/bin/clang")),
            _ => None,
        };
        let v = cargo_path_env(&tools).unwrap();
        let entries: Vec<PathBuf> = std::env::split_paths(&v).collect();
        // Every recorded directory leads, in table order, deduplicated.
        assert_eq!(
            &entries[..3],
            &[
                PathBuf::from("/opt/loom/.cargo/bin"),
                PathBuf::from("/opt/homebrew/bin"),
                PathBuf::from("/usr/bin"),
            ],
            "the recorded tool directories lead: {v}"
        );
        // Nothing the process already had is dropped — the pair prepends.
        for dir in std::env::split_paths(&std::env::var("PATH").unwrap_or_default()) {
            assert!(entries.contains(&dir), "{} was dropped from PATH", dir.display());
        }
        // A machine with none of them recorded still gets its own PATH.
        let none = |_: &str| None;
        assert!(cargo_path_env(&none).is_some(), "an empty table still composes a PATH");
    }

    /// The cmake crate honours `CMAKE` directly, which beats a PATH search:
    /// the pair names the exact binary the tool table recorded.
    #[test]
    fn cargo_with_path_names_the_recorded_cmake() {
        let tools = |name: &str| match name {
            "cargo" => Some(PathBuf::from("/opt/loom/.cargo/bin/cargo")),
            "cmake" => Some(PathBuf::from("/opt/homebrew/bin/cmake")),
            _ => None,
        };
        let spawn = cargo_with_path(&tools).unwrap();
        assert_eq!(spawn.cargo, "/opt/loom/.cargo/bin/cargo");
        let cmake = spawn.envs.iter().find(|(k, _)| k == "CMAKE").expect("CMAKE is passed");
        assert_eq!(cmake.1, "/opt/homebrew/bin/cmake");
        assert!(spawn.envs.iter().any(|(k, _)| k == "PATH"), "and the PATH pair rides with it");

        // No cmake recorded: no CMAKE pair invented, and cargo still spawns.
        let thin = |name: &str| (name == "cargo").then(|| PathBuf::from("/opt/loom/.cargo/bin/cargo"));
        let spawn = cargo_with_path(&thin).unwrap();
        assert!(spawn.envs.iter().all(|(k, _)| k != "CMAKE"), "nothing is invented");

        // No cargo at all: the install line, not a spawn.
        let empty = |_: &str| None;
        let err = cargo_with_path(&empty).unwrap_err().to_string();
        assert!(err.contains("cargo is missing"), "got {err}");
    }

    #[cfg(unix)]
    #[test]
    fn drift_detects_moved_tool() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().join("loom");
        std::fs::create_dir_all(&root).unwrap();
        let home = crate::loomhome::Home::at(root);
        let bin = d.path().join("bin");
        let git = fake_exe(&bin, "git", "git version 2.0.0-fake");
        let cargo = fake_exe(&bin, "cargo", "cargo 1.0.0-fake");

        // Recorded manifest: git at `bin`, cargo at `bin`, both with versions.
        let recorded = Threads {
            threaded: true,
            threaded_at: Some("2026-09-02T00:00:00Z".into()),
            threaded_sha: Some("deadbeef".into()),
            tools: vec![
                Tool {
                    name: "git".into(),
                    path: Some(git.to_string_lossy().into_owned()),
                    version: Some("git version 2.0.0-fake".into()),
                    required_for: "everything".into(),
                    install: "xcode-select --install".into(),
                },
                Tool {
                    name: "cargo".into(),
                    path: Some(cargo.to_string_lossy().into_owned()),
                    version: Some("cargo 1.0.0-fake".into()),
                    required_for: "core".into(),
                    install: "rustup".into(),
                },
            ],
            steps: ThreadSteps { seed: true, deps: true, vendor: true, warm: true, register: true },
        };
        write(&home, &recorded).unwrap();
        assert_eq!(read(&home).unwrap().tools.len(), 2);

        let specs = [
            ToolSpec {
                name: "git",
                required_for: "everything",
                candidates: &[],
                version_args: &["--version"],
                install: "xcode-select --install",
            },
            ToolSpec {
                name: "cargo",
                required_for: "core",
                candidates: &[],
                version_args: &["--version"],
                install: "rustup",
            },
        ];
        let path_env = bin.to_str().unwrap();

        // Nothing moved: no drift, nothing missing, no network needed.
        let s = status_with(&home, &specs, d.path(), path_env);
        assert!(s.threaded);
        assert!(s.drifted.is_empty(), "drifted = {:?}", s.drifted);
        assert!(s.missing.is_empty());
        assert!(!s.needs_network);
        assert!(s.steps.warm);

        // git moves away: still discoverable? No — it's gone from PATH too.
        std::fs::remove_file(&git).unwrap();
        let s = status_with(&home, &specs, d.path(), path_env);
        assert_eq!(s.drifted, vec!["git".to_string()]);
        assert_eq!(s.missing, vec!["git".to_string()]);

        // cargo stays in place but its version changes: drift, not missing.
        fake_exe(&bin, "cargo", "cargo 2.0.0-fake");
        let s = status_with(&home, &specs, d.path(), path_env);
        assert!(s.drifted.contains(&"cargo".to_string()), "drifted = {:?}", s.drifted);
        assert!(!s.missing.contains(&"cargo".to_string()));

        // tool_path: recorded path wins while it exists; otherwise fresh discovery.
        assert_eq!(tool_path(&home, "cargo"), Some(cargo.clone()));
        assert!(tool_path(&home, "git").map_or(true, |p| p != git));
    }

    /// CANCEL on the threading card must not reach a weave: `exec::JOB` says
    /// a job holds the slot, not whose it is, and a reweave past its
    /// cancellable stages is nobody's to kill.
    #[test]
    fn cancel_is_refused_unless_threading_owns_the_job() {
        match thread_cancel().unwrap_err() {
            LoomError::Parse(m) => assert_eq!(m, NOTHING_TO_CANCEL),
            e => panic!("expected the honest refusal, got {e:?}"),
        }
        // While the ceremony runs the flag names its tenancy of the slot; it
        // lowers on drop, so a job thread that panics leaves nothing
        // cancellable behind — and a cancel issued after it can carry no
        // token the slot will honour.
        {
            let _active = Active::take(11);
            assert_eq!(ACTIVE.load(Ordering::SeqCst), 11);
        }
        assert_eq!(ACTIVE.load(Ordering::SeqCst), 0);
        assert!(thread_cancel().is_err(), "refused again once the ceremony ended");
    }

    #[test]
    fn the_sherpa_cache_resolves_to_the_deepest_single_child() {
        let d = tempfile::tempdir().unwrap();
        let home_dir = d.path();
        // Nothing downloaded yet.
        assert_eq!(resolve_sherpa_cache(home_dir), None);

        let root = sherpa_cache_root(home_dir);
        std::fs::create_dir_all(&root).unwrap();
        assert_eq!(resolve_sherpa_cache(home_dir), None, "an empty root is a purged cache");

        // One target, one hash, one distribution: the deepest one wins.
        let dist = root.join("aarch64-apple-darwin").join("e3f3596b").join("sherpa-onnx-v1.12.9");
        std::fs::create_dir_all(&dist).unwrap();
        std::fs::write(dist.join("lib.a"), b"x").unwrap();
        assert_eq!(resolve_sherpa_cache(home_dir).as_deref(), Some(dist.as_path()));

        // Two targets: the walk stops where the tree forks.
        std::fs::create_dir_all(root.join("x86_64-apple-darwin")).unwrap();
        assert_eq!(resolve_sherpa_cache(home_dir).as_deref(), Some(root.as_path()));
    }

    /// The archive comes down over HTTP once and never again offline. A
    /// recorded path that has gone is drift, said before the weave rather
    /// than discovered minutes into one.
    #[test]
    fn a_vanished_sherpa_cache_is_reported_as_drift() {
        let d = tempfile::tempdir().unwrap();
        let home = crate::loomhome::Home::at(d.path().join("loom"));
        let cache = d.path().join("cache");
        std::fs::create_dir_all(&cache).unwrap();
        std::fs::write(cache.join("lib.a"), b"x").unwrap();

        let t = Threads {
            threaded: true,
            threaded_at: None,
            threaded_sha: None,
            tools: vec![],
            steps: ThreadSteps { seed: true, deps: true, vendor: true, warm: true, register: true },
        };
        write_sherpa(&home, &t, Some(cache.to_string_lossy().into_owned())).unwrap();
        assert_eq!(read_sherpa(&home).as_deref(), Some(cache.to_str().unwrap()));

        let s = status_with(&home, &[], d.path(), "");
        assert_eq!(s.sherpa_cache.as_deref(), Some(cache.to_str().unwrap()));
        assert!(s.drifted.is_empty(), "the cache is there: {:?}", s.drifted);

        // A later step of the ceremony must not drop the record.
        write(&home, &t).unwrap();
        assert_eq!(read_sherpa(&home).as_deref(), Some(cache.to_str().unwrap()));

        // macOS purges it under disk pressure; loomhome_bytes never counted it.
        std::fs::remove_dir_all(&cache).unwrap();
        let s = status_with(&home, &[], d.path(), "");
        assert_eq!(s.drifted, vec![SHERPA_DRIFT.to_string()]);
        assert_eq!(s.sherpa_cache.as_deref(), Some(cache.to_str().unwrap()), "status still names it");

        // An emptied directory is just as useless as a missing one.
        std::fs::create_dir_all(&cache).unwrap();
        assert!(status_with(&home, &[], d.path(), "").drifted.contains(&SHERPA_DRIFT.to_string()));
    }

    #[test]
    fn write_json_atomic_leaves_no_temp_file() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("nested").join("threads.json");
        write_json_atomic(&path, &serde_json::json!({ "threaded": false })).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"threaded\": false"));
        let names: Vec<String> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["threads.json".to_string()], "only the final file remains");
        // Overwrite is also atomic and leaves the directory clean.
        write_json_atomic(&path, &serde_json::json!({ "threaded": true })).unwrap();
        let names: Vec<String> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["threads.json".to_string()]);
        assert!(std::fs::read_to_string(&path).unwrap().contains("true"));
    }

    #[test]
    fn manifest_round_trips_camel_case() {
        let d = tempfile::tempdir().unwrap();
        let home = crate::loomhome::Home::at(d.path().to_path_buf());
        assert!(read(&home).is_none(), "no manifest yet");
        let t = Threads {
            threaded: false,
            threaded_at: None,
            threaded_sha: None,
            tools: vec![],
            steps: ThreadSteps { seed: true, ..ThreadSteps::default() },
        };
        write(&home, &t).unwrap();
        let raw = std::fs::read_to_string(home.threads_json()).unwrap();
        assert!(raw.contains("\"threadedAt\""), "camelCase on disk: {raw}");
        assert!(!raw.contains("threaded_at"));
        let back = read(&home).unwrap();
        assert!(back.steps.seed && !back.steps.deps);
        assert!(!crate::loomhome::read_threaded(&home));
        // A torn manifest reads as None.
        std::fs::write(home.threads_json(), "{").unwrap();
        assert!(read(&home).is_none());
    }

    #[test]
    fn tools_table_matches_the_spec() {
        let names: Vec<&str> = TOOLS.iter().map(|t| t.name).collect();
        for n in ["git", "cargo", "rustc", "node", "npm", "cmake", "clang"] {
            assert!(names.contains(&n), "{n} missing from TOOLS");
        }
        assert_eq!(names.contains(&"codesign"), cfg!(target_os = "macos"));
        for t in TOOLS {
            assert!(!t.install.is_empty(), "{} needs an install line", t.name);
            assert!(!t.required_for.is_empty());
            if t.name == "codesign" {
                assert!(t.version_args.is_empty(), "codesign has no --version");
            } else {
                assert_eq!(t.version_args, &["--version"]);
            }
        }
        // ThreadStatus serializes camelCase for the TS side.
        let s = ThreadStatus {
            threaded: false,
            tools: vec![],
            missing: vec!["cmake".into()],
            drifted: vec![],
            steps: ThreadSteps::default(),
            needs_network: true,
            sherpa_cache: None,
        };
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["needsNetwork"], true);
        assert!(v["steps"]["register"].is_boolean());
    }

    // ── The ceremony ──────────────────────────────────────────────────────────

    /// A staged machine: a loomhome with `source/src-tauri`, fake `npm` and
    /// `cargo` that append their argv to `log` and touch a marker per
    /// subcommand, and a small file standing in for the running executable.
    #[cfg(unix)]
    struct Stage {
        _dir: tempfile::TempDir,
        home: Home,
        /// This ceremony's own job slot. The app runs in `exec::JOB`; a test
        /// that shared it could group-kill another test's tools.
        slot: &'static Slot,
        /// The token naming this ceremony's tenancy of the slot: `kill` takes
        /// it, so a stale cancel cannot land on a job that is not this one.
        token: crate::exec::JobToken,
        /// The dev checkout — where the owner keeps it, NOT under loomhome.
        /// `loomhome/source` is seed's work, and seed runs in packaged mode
        /// only; a fixture that pre-creates it hides that dev has no source.
        source: PathBuf,
        log: PathBuf,
        markers: PathBuf,
        npm: PathBuf,
        node: PathBuf,
        cargo: PathBuf,
        /// Deliberately NOT in `bin`: the only way a spawn can reach it is
        /// the PATH the cargo pair injects.
        cmake: PathBuf,
        exe: PathBuf,
    }

    #[cfg(unix)]
    fn fake_tool(dir: &Path, name: &str, log: &Path, markers: &Path, extra: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(dir).unwrap();
        let p = dir.join(name);
        let script = format!(
            "#!/bin/sh\necho \"{name} $*\" >> \"{log}\"\ntouch \"{markers}/{name}-$1\"\n{extra}\nexit 0\n",
            log = log.display(),
            markers = markers.display(),
        );
        std::fs::write(&p, script).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    #[cfg(unix)]
    fn stage(npm_extra: &str, cargo_extra: &str) -> Stage {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("loom");
        let home = Home::at(root.clone());
        let slot: &'static Slot = Box::leak(Box::new(Slot::new()));
        let token = slot.try_take().expect("the ceremony holds its slot, as thread_loom does");
        std::fs::create_dir_all(&root).unwrap();
        let source = dir.path().join("checkout");
        std::fs::create_dir_all(source.join("src-tauri")).unwrap();
        let log = dir.path().join("calls.log");
        let markers = dir.path().join("markers");
        std::fs::create_dir_all(&markers).unwrap();
        let bin = dir.path().join("bin");
        let npm = fake_tool(&bin, "npm", &log, &markers, npm_extra);
        let node = fake_exe(&bin, "node", "v22.3.0");
        let cargo = fake_tool(&bin, "cargo", &log, &markers, cargo_extra);
        let cmake = fake_exe(&dir.path().join("cmake-bin"), "cmake", "cmake version 3.30.0-fake");
        let exe = dir.path().join("loom-body");
        std::fs::write(&exe, b"#!/bin/sh\nexit 0\n").unwrap();
        Stage { _dir: dir, home, slot, token, source, log, markers, npm, node, cargo, cmake, exe }
    }

    #[cfg(unix)]
    impl Stage {
        fn tools(&self) -> impl Fn(&str) -> Option<PathBuf> + '_ {
            move |name: &str| match name {
                "npm" => Some(self.npm.clone()),
                "node" => Some(self.node.clone()),
                "cargo" => Some(self.cargo.clone()),
                "cmake" => Some(self.cmake.clone()),
                _ => None,
            }
        }
        fn log(&self) -> String {
            std::fs::read_to_string(&self.log).unwrap_or_default()
        }
        fn run(&self) -> (Result<(), LoomError>, Vec<(String, String, Vec<String>)>) {
            let mut events: Vec<(String, String, Vec<String>)> = Vec::new();
            let tools = self.tools();
            let res = run_ceremony(
                &self.home,
                Mode::Dev,
                &self.source,
                self.slot,
                &tools,
                &self.exe,
                None,
                &mut |step, detail, tail| events.push((step.to_string(), detail.to_string(), tail.to_vec())),
            );
            (res, events)
        }
    }

    fn step_order(events: &[(String, String, Vec<String>)]) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for (s, _, _) in events {
            if out.last() != Some(s) {
                out.push(s.clone());
            }
        }
        out
    }

    /// The `cargo build` fake prints a few "Compiling" lines and records the
    /// envs the ceremony must set.
    const CARGO_BUILD_FAKE: &str = r#"if [ "$1" = build ]; then
  echo "target=$CARGO_TARGET_DIR offline=$CARGO_NET_OFFLINE" >> "$(dirname "$0")/../calls.log"
  echo "Compiling a"; echo "Compiling b"; echo "Compiling c"; echo "Compiling d"
fi"#;

    #[cfg(unix)]
    #[test]
    fn ceremony_runs_every_step_in_order_and_stamps() {
        let st = stage("", CARGO_BUILD_FAKE);
        let (res, events) = st.run();
        assert!(res.is_ok(), "ceremony failed: {res:?}\nevents: {events:?}");
        assert_eq!(
            step_order(&events),
            vec!["seed", "deps", "vendor", "warm", "register", "stamp", "done"]
        );

        // The tools were called in the spec's order with the spec's argv.
        let log = st.log();
        let calls: Vec<&str> = log.lines().collect();
        let vendor_dir = st.home.vendor().to_string_lossy().into_owned();
        assert_eq!(calls[0], "npm ci --no-audit --no-fund");
        assert_eq!(calls[1], format!("cargo vendor --versioned-dirs {vendor_dir}"));
        assert_eq!(calls[2], "npm run build");
        assert_eq!(calls[3], "cargo build --release --offline");
        assert_eq!(
            calls[4],
            format!("target={} offline=true", st.home.target().display()),
            "cargo build runs with the shared target and offline"
        );
        assert_eq!(calls.len(), 5, "no extra spawns: {calls:?}");
        assert!(st.markers.join("npm-ci").exists());
        assert!(st.markers.join("cargo-build").exists());

        // The warm step streamed cargo's tail (last 3 lines).
        let warm_tail = events
            .iter()
            .filter(|(s, _, _)| s == "warm")
            .map(|(_, _, t)| t.clone())
            .find(|t| t.len() == 3)
            .expect("a warm event carries a 3-line tail");
        assert_eq!(warm_tail, vec!["Compiling b", "Compiling c", "Compiling d"]);

        // The warm build is where the sherpa archive lands; the manifest
        // records where, so a later status can miss it.
        assert_eq!(
            read_sherpa(&st.home),
            resolve_sherpa_cache(&owner_home()).map(|p| p.to_string_lossy().into_owned()),
            "the warm step records the cache this machine has"
        );

        // Dev works in the checkout; loomhome/source is seed's, and seed
        // does not run in dev. Nothing may have created it.
        assert!(
            !st.home.source().exists(),
            "dev threading must never look for a source under loomhome"
        );

        // Stamped: every marker, threaded, sha + time recorded.
        let t = read(&st.home).unwrap();
        assert!(t.threaded);
        assert_eq!(t.steps, ThreadSteps { seed: true, deps: true, vendor: true, warm: true, register: true });
        assert_eq!(t.threaded_sha.as_deref(), Some(crate::loomhome::genome_sha()));
        assert!(t.threaded_at.as_deref().map_or(false, |s| s.ends_with('Z')));

        // Registered: generation 0 shelved, ledger current + confirmed.
        let sha = crate::loomhome::genome_sha();
        assert!(st.home.generation_exe(sha).is_file());
        let ledger = crate::generations::read(&st.home);
        assert_eq!(ledger.current.as_deref(), Some(sha));
        assert_eq!(ledger.previous, None);
        assert_eq!(ledger.kept, vec![sha.to_string()]);
        assert!(ledger.confirmed);
        let meta: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(st.home.generation_meta(sha)).unwrap()).unwrap();
        assert_eq!(meta["reason"], "threaded");
    }

    /// The cargo fake reports what the injected PATH resolves `cmake` to and
    /// what `CMAKE` names — the two things the cmake crate consults.
    const CARGO_CMAKE_FAKE: &str = r#"if [ "$1" = build ]; then
  echo "cmake_on_path=$(command -v cmake)" >> "$(dirname "$0")/../calls.log"
  echo "CMAKE=$CMAKE" >> "$(dirname "$0")/../calls.log"
fi"#;

    /// Round-3 review, Finding 1, end to end. The warm step is the long one,
    /// spent AFTER `npm ci` and `cargo vendor` have used the owner's single
    /// network trip. With no PATH pair, `whisper-rs-sys`'s build script asked
    /// the cmake crate for the literal `"cmake"`, PATH held none, and the
    /// ceremony died with a bare cargo exit code — `threaded` never turned
    /// true, so nothing else in Phase 23 unlocked.
    #[cfg(unix)]
    #[test]
    fn the_warm_step_lets_cargo_find_the_recorded_cmake() {
        let st = stage("", CARGO_CMAKE_FAKE);
        let (res, events) = st.run();
        assert!(res.is_ok(), "ceremony failed: {res:?}\nevents: {events:?}");
        let log = st.log();
        // Resolved through the injected PATH, not through whatever a
        // Finder-launched app inherited: the fake cmake is outside `bin`.
        assert!(
            log.contains(&format!("cmake_on_path={}", st.cmake.display())),
            "the recorded cmake must be the one PATH resolves; log:\n{log}"
        );
        // And named outright, which the cmake crate honours before searching.
        assert!(
            log.contains(&format!("CMAKE={}", st.cmake.display())),
            "the recorded cmake must be named in CMAKE; log:\n{log}"
        );
    }

    #[test]
    fn the_source_and_the_root_are_resolved_per_mode() {
        let d = tempfile::tempdir().unwrap();
        let home = Home::at(d.path().join("loom"));
        // Packaged names loomhome/source without asking whether it exists —
        // on the first threading it does not, seed is what creates it.
        assert!(!home.source().exists());
        assert_eq!(ceremony_source(&home, Mode::Packaged).unwrap(), home.source());
        // Packaged spawns are contained by loomhome, which holds the source.
        assert_eq!(ceremony_root(&home, Mode::Packaged, &home.source()), home.root);
        // Dev's checkout lives wherever the owner keeps it, so the allowed
        // root is the checkout — loomhome would refuse every spawn.
        let checkout = d.path().join("checkout");
        assert_eq!(ceremony_root(&home, Mode::Dev, &checkout), checkout);
    }

    #[cfg(unix)]
    #[test]
    fn ceremony_resumes_after_deps_already_done() {
        let st = stage("", CARGO_BUILD_FAKE);
        write(
            &st.home,
            &Threads {
                threaded: false,
                threaded_at: None,
                threaded_sha: None,
                tools: vec![],
                steps: ThreadSteps { seed: true, deps: true, ..ThreadSteps::default() },
            },
        )
        .unwrap();
        let (res, events) = st.run();
        assert!(res.is_ok(), "ceremony failed: {res:?}");
        let log = st.log();
        assert!(!log.contains("npm ci"), "npm ci must not run again: {log}");
        assert!(!st.markers.join("npm-ci").exists());
        assert!(log.contains("cargo vendor"), "vendor still runs: {log}");
        assert!(log.contains("npm run build"), "warm still runs: {log}");
        // Skipped steps still announce themselves, so the card shows the whole ceremony.
        let order = step_order(&events);
        assert_eq!(order, vec!["seed", "deps", "vendor", "warm", "register", "stamp", "done"]);
        let deps = events.iter().find(|(s, _, _)| s == "deps").unwrap();
        assert!(deps.1.contains("already"), "skip detail says so: {:?}", deps.1);
        assert!(read(&st.home).unwrap().threaded);
    }

    #[cfg(unix)]
    #[test]
    fn offline_deps_failure_uses_the_honest_line() {
        let st = stage(
            r#"if [ "$1" = ci ]; then echo "npm ERR! code ENOTFOUND" 1>&2; echo "npm ERR! request to https://registry.npmjs.org/x failed" 1>&2; exit 1; fi"#,
            CARGO_BUILD_FAKE,
        );
        let (res, events) = st.run();
        assert!(res.is_err(), "offline deps must fail");
        let last = events.last().unwrap();
        assert_eq!(last.0, "failed");
        assert_eq!(last.1, "threading needs the network once — after that LOOM weaves offline.");
        assert!(last.2.iter().any(|l| l.contains("ENOTFOUND")), "tail carries npm's own words: {:?}", last.2);
        let t = read(&st.home).unwrap();
        assert!(!t.threaded);
        assert!(t.steps.seed, "seed (dev: skip) was recorded before deps failed");
        assert!(!t.steps.deps);
        assert!(!st.log().contains("cargo"), "nothing after the failed step runs");
    }

    #[cfg(unix)]
    #[test]
    fn vendor_writes_offline_config() {
        let st = stage("", CARGO_BUILD_FAKE);
        let (res, _) = st.run();
        assert!(res.is_ok(), "{res:?}");
        let cfg = std::fs::read_to_string(st.source.join(".cargo").join("config.toml")).unwrap();
        let expected = format!(
            "[source.crates-io]\nreplace-with = \"vendored\"\n[source.vendored]\ndirectory = \"{}\"\n[net]\noffline = true\n",
            st.home.vendor().display()
        );
        assert_eq!(cfg, expected);
        assert!(st.markers.join("cargo-vendor").exists());
    }

    /// Round-2 review, Finding 6. In dev the ceremony writes
    /// `.cargo/config.toml` into the OWNER'S OWN CHECKOUT, where every later
    /// cargo command — LOOM's and the owner's — reads it and builds from the
    /// vendored crates with `[net] offline = true`. A file that changes how a
    /// checkout builds must be announced, not discovered.
    #[cfg(unix)]
    #[test]
    fn the_vendor_step_says_what_it_left_in_the_checkout() {
        let st = stage("", CARGO_BUILD_FAKE);
        let (res, events) = st.run();
        assert!(res.is_ok(), "{res:?}");
        let cfg = st.source.join(".cargo").join("config.toml");
        let said = events
            .iter()
            .filter(|(step, _, _)| step == "vendor")
            .any(|(_, detail, _)| {
                detail.contains(&cfg.display().to_string())
                    && detail.contains("vendored")
                    && detail.contains("offline")
            });
        assert!(
            said,
            "the vendor step must name the file it wrote and what it does, saw {:?}",
            events.iter().filter(|(s, _, _)| s == "vendor").collect::<Vec<_>>()
        );
    }

    /// …and the same file must not linger as an untracked surprise in the
    /// genome. Round-2 review, Finding 6.
    #[test]
    fn the_ceremonys_cargo_config_is_gitignored() {
        let ignore = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join(".gitignore"),
        )
        .expect("the genome has a .gitignore");
        assert!(
            ignore.lines().any(|l| l.trim() == ".cargo/config.toml"),
            "a dev ceremony writes .cargo/config.toml into the checkout — it must be ignored, not committed by accident"
        );
    }

    /// Both npm spawns in the ceremony — deps and the warm assets build —
    /// carry the pair, or the packaged self-rebuild dies at `npm ci`.
    #[cfg(unix)]
    #[test]
    fn every_npm_spawn_carries_the_recorded_node_on_path() {
        let st = stage(
            r#"echo "npm-saw=${PATH%%:*}" >> "$(dirname "$0")/../calls.log""#,
            CARGO_BUILD_FAKE,
        );
        let (res, _) = st.run();
        assert!(res.is_ok(), "{res:?}");
        let bin = st.node.parent().unwrap().to_string_lossy().into_owned();
        let log = st.log();
        let saw: Vec<&str> = log.lines().filter(|l| l.starts_with("npm-saw=")).collect();
        let want = format!("npm-saw={bin}");
        assert_eq!(
            saw,
            vec![want.as_str(), want.as_str()],
            "npm ci and npm run build both lead PATH with the recorded node's directory"
        );
    }

    /// node is what makes npm runnable, so a machine without it stops at the
    /// same wall as a machine without npm — with node's own install line.
    #[cfg(unix)]
    #[test]
    fn npm_without_node_stops_with_nodes_install_line() {
        let st = stage("", CARGO_BUILD_FAKE);
        let mut events: Vec<(String, String, Vec<String>)> = Vec::new();
        let npm_only = |name: &str| if name == "npm" { Some(st.npm.clone()) } else { None };
        let res = run_ceremony(
            &st.home,
            Mode::Dev,
            &st.source,
            st.slot,
            &npm_only,
            &st.exe,
            None,
            &mut |s, d, t| events.push((s.into(), d.into(), t.to_vec())),
        );
        assert!(res.is_err());
        let last = events.last().unwrap();
        assert_eq!(last.0, "failed");
        assert!(last.1.contains("node is missing"), "{:?}", last.1);
        assert!(last.1.contains("brew install node"), "{:?}", last.1);
        assert!(st.log().is_empty(), "nothing spawned");
    }

    /// `npm ci` is the longest step that reaches the internet. CANCEL during
    /// it has to take the process down — with `run_checked_env` no pid was
    /// ever registered, so the stop button stopped nothing and LOOM kept
    /// talking to the registry.
    #[cfg(unix)]
    #[test]
    fn cancel_during_npm_ci_kills_it_and_stops_the_ceremony() {
        let st = stage(r#"if [ "$1" = ci ]; then sleep 30; fi"#, CARGO_BUILD_FAKE);
        let slot = st.slot;
        let home = Home::at(st.home.root.clone());
        let source = st.source.clone();
        let exe = st.exe.clone();
        let npm = st.npm.clone();
        let node = st.node.clone();
        let cargo = st.cargo.clone();
        let job = std::thread::spawn(move || {
            let tools = move |name: &str| match name {
                "npm" => Some(npm.clone()),
                "node" => Some(node.clone()),
                "cargo" => Some(cargo.clone()),
                _ => None,
            };
            run_ceremony(&home, Mode::Dev, &source, slot, &tools, &exe, None, &mut |_, _, _| {})
        });

        let start = Instant::now();
        while slot.pid().is_none() && start.elapsed() < Duration::from_secs(10) {
            std::thread::sleep(Duration::from_millis(20));
        }
        let pid = slot.pid().expect("npm ci registers its pid — otherwise CANCEL reaches nothing");
        slot.kill(st.token);
        let res = job.join().unwrap();

        assert!(start.elapsed() < Duration::from_secs(20), "the kill lands promptly");
        match res {
            Err(LoomError::Parse(m)) => assert_eq!(m, CANCELLED),
            other => panic!("expected the cancelled line, got {other:?}"),
        }
        std::thread::sleep(Duration::from_millis(250));
        assert!(
            unsafe { libc::kill(pid as i32, 0) } != 0,
            "the npm tree must be dead after CANCEL"
        );
        let log = st.log();
        assert!(!log.contains("cargo vendor"), "nothing after the cancelled step runs: {log}");
        assert!(!read(&st.home).unwrap().steps.deps, "the cancelled step stays unmarked");
    }

    /// A cancel that lands between two steps stops the ceremony too — the
    /// warm build was the only place the mark was ever read.
    #[cfg(unix)]
    #[test]
    fn a_cancel_between_steps_stops_before_the_next_one() {
        let st = stage("", CARGO_BUILD_FAKE);
        st.slot.kill(st.token); // marks cancelled; no child is running
        let (res, events) = st.run();
        match res {
            Err(LoomError::Parse(m)) => assert_eq!(m, CANCELLED),
            other => panic!("expected the cancelled line, got {other:?}"),
        }
        assert_eq!(events.last().unwrap().0, "failed");
        assert!(st.log().is_empty(), "no tool was spawned: {:?}", st.log());
        assert!(!read(&st.home).unwrap().threaded);
    }

    #[cfg(unix)]
    #[test]
    fn missing_tool_stops_with_its_install_line() {
        let st = stage("", CARGO_BUILD_FAKE);
        let mut events: Vec<(String, String, Vec<String>)> = Vec::new();
        let none = |_: &str| None::<PathBuf>;
        let res = run_ceremony(
            &st.home,
            Mode::Dev,
            &st.source,
            st.slot,
            &none,
            &st.exe,
            None,
            &mut |s, d, t| events.push((s.into(), d.into(), t.to_vec())),
        );
        assert!(res.is_err());
        let last = events.last().unwrap();
        assert_eq!(last.0, "failed");
        assert!(last.1.contains("npm is missing"), "{:?}", last.1);
        assert!(last.1.contains("brew install node"), "{:?}", last.1);
        assert!(st.log().is_empty(), "nothing spawned");
    }

    // ── SKIP-GUARDED real-tool ceremony (#[ignore]) ──────────────────────────
    //
    // Everything above this line drives shell-script fakes: it proves the
    // ceremony's ORDER, ARGV and ENV, and nothing about whether real tools
    // accept them. This section drives the REAL git, node, npm and cargo the
    // tool table finds, over a real `git bundle`, and asserts the ceremony's
    // effects ON DISK.
    //
    // The genome under test is a throwaway fixture, NOT the LOOM repo: a real
    // ceremony over LOOM's own tree is `npm ci` plus a cold release build of
    // whisper/sherpa — tens of minutes and gigabytes. The fixture is the same
    // SHAPE (a `package.json` with a dependency and a `build` script; a
    // `src-tauri/` crate with one crates.io dependency, whose binary is named
    // `loom`) so all six steps do real work in seconds.
    //
    // Network: `cargo vendor` reaches crates.io unless `cfg-if 1.0.0` is
    // already in the owner's cargo registry cache. That is exactly the spec's
    // stated residual — "threading needs the network once" — and it is why
    // these tests are `#[ignore]`d and never run in CI.

    /// The tools the real ceremony needs present before it can prove anything.
    #[cfg(unix)]
    const REAL_TOOLS: &[&str] = &["git", "node", "npm", "cargo", "rustc"];

    /// `Some(closure)` when every tool in `REAL_TOOLS` is on this machine;
    /// `None` (after printing why) when one is missing — the house pattern
    /// from `kernel::real_cargo_catches_type_errors`.
    #[cfg(unix)]
    fn real_tools(test: &str) -> Option<impl Fn(&str) -> Option<PathBuf>> {
        for name in REAL_TOOLS {
            match locate_now(name) {
                Some(p) => eprintln!("  {name}: {}", p.display()),
                None => {
                    eprintln!("SKIP {test}: {name} is not on this machine");
                    return None;
                }
            }
        }
        Some(|name: &str| locate_now(name))
    }

    /// `package.json`: one `file:` dependency (so `npm ci` really has
    /// something to install, with no registry) and a `build` script that
    /// writes `dist/`, standing in for tsc + vite.
    #[cfg(unix)]
    const FIXTURE_PACKAGE_JSON: &str = r#"{
  "name": "loom-thread-fixture",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "build": "node -e \"const f=require('fs');f.mkdirSync('dist',{recursive:true});f.writeFileSync('dist/index.html','threaded')\""
  },
  "dependencies": { "loom-fixture-dep": "file:dep" }
}
"#;

    /// The lockfile `npm ci` refuses to run without. Committed verbatim (it
    /// is what `npm install --package-lock-only` writes for the manifest
    /// above) so building the fixture needs no npm of its own.
    #[cfg(unix)]
    const FIXTURE_PACKAGE_LOCK: &str = r#"{
  "name": "loom-thread-fixture",
  "version": "0.0.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "loom-thread-fixture",
      "version": "0.0.0",
      "dependencies": { "loom-fixture-dep": "file:dep" }
    },
    "dep": { "name": "loom-fixture-dep", "version": "1.0.0" },
    "node_modules/loom-fixture-dep": { "resolved": "dep", "link": true }
  }
}
"#;

    /// The crate: one pinned crates.io dependency, so `cargo vendor` has a
    /// crate to vendor and the offline build has one to resolve from
    /// `vendor/`. The binary is named `loom` because `reweave`'s stage step
    /// looks for `target/release/loom` by that name.
    #[cfg(unix)]
    const FIXTURE_CARGO_TOML: &str = r#"[package]
name = "loom_thread_fixture"
version = "0.0.0"
edition = "2021"

[[bin]]
name = "loom"
path = "src/main.rs"

[dependencies]
cfg-if = "=1.0.0"

[workspace]
"#;

    #[cfg(unix)]
    const FIXTURE_MAIN_RS: &str = r#"fn main() {
    cfg_if::cfg_if! { if #[cfg(unix)] { println!("threaded"); } else { println!("threaded"); } }
}
"#;

    /// A throwaway genome, bundled, plus the loomhome the ceremony threads.
    #[cfg(unix)]
    struct RealGenome {
        _dir: tempfile::TempDir,
        home: Home,
        /// `<dir>/genome/genome.bundle`, with `genome.json` beside it.
        bundle: PathBuf,
        /// The sha the bundle records — what seed must check `source/` out at.
        sha: String,
        slot: &'static Slot,
        _token: crate::exec::JobToken,
    }

    #[cfg(unix)]
    fn write_file(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    /// A fixed-argv git, run for its exit code. Test setup only — the
    /// ceremony's own spawns all go through `exec`.
    #[cfg(unix)]
    fn git_ok(git: &Path, cwd: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new(git)
            .args(args)
            .current_dir(cwd)
            .output()
            .unwrap_or_else(|e| panic!("git {args:?}: {e}"));
        assert!(
            out.status.success(),
            "git {args:?} failed: {}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// Build the fixture genome, commit it, `git bundle create … --all`, and
    /// write the `genome.json` the ceremony's seed step reads the sha from.
    #[cfg(unix)]
    fn real_genome() -> RealGenome {
        let git = locate_now("git").expect("guarded by real_tools");
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().canonicalize().unwrap();
        let repo = base.join("genome-src");

        write_file(&repo.join("package.json"), FIXTURE_PACKAGE_JSON);
        write_file(&repo.join("package-lock.json"), FIXTURE_PACKAGE_LOCK);
        write_file(&repo.join("dep/package.json"), "{ \"name\": \"loom-fixture-dep\", \"version\": \"1.0.0\", \"main\": \"index.js\" }\n");
        write_file(&repo.join("dep/index.js"), "module.exports = 1;\n");
        write_file(&repo.join("src-tauri/Cargo.toml"), FIXTURE_CARGO_TOML);
        write_file(&repo.join("src-tauri/src/main.rs"), FIXTURE_MAIN_RS);
        write_file(&repo.join(".gitignore"), "node_modules/\ndist/\ntarget/\n.cargo/config.toml\n");

        git_ok(&git, &repo, &["init", "--quiet", "-b", "main"]);
        git_ok(&git, &repo, &["add", "-A"]);
        git_ok(
            &git,
            &repo,
            &[
                "-c",
                "user.email=fixture@loom.test",
                "-c",
                "user.name=LOOM fixture",
                "commit",
                "--quiet",
                "-m",
                "the fixture genome",
            ],
        );
        let sha = git_ok(&git, &repo, &["rev-parse", "HEAD"]);
        assert_eq!(sha.len(), 40, "a real sha: {sha}");

        let bundle = base.join("genome").join("genome.bundle");
        std::fs::create_dir_all(bundle.parent().unwrap()).unwrap();
        git_ok(&git, &repo, &["bundle", "create", bundle.to_str().unwrap(), "--all"]);
        write_file(
            &bundle.parent().unwrap().join("genome.json"),
            &format!("{{ \"sha\": \"{sha}\" }}\n"),
        );
        assert_eq!(crate::loomhome::bundle_sha(&bundle).as_deref(), Some(sha.as_str()));

        let root = base.join("loomhome");
        std::fs::create_dir_all(&root).unwrap();
        let home = Home::at(root);
        let slot: &'static Slot = Box::leak(Box::new(Slot::new()));
        let token = slot.try_take().expect("the ceremony holds its slot, as thread_loom does");
        RealGenome { _dir: dir, home, bundle, sha, slot, _token: token }
    }

    /// Run the ceremony over the fixture with the real tools, collecting
    /// every progress event.
    #[cfg(unix)]
    fn run_real(
        g: &RealGenome,
        tools: &dyn Fn(&str) -> Option<PathBuf>,
    ) -> (Result<(), LoomError>, Vec<(String, String, Vec<String>)>) {
        let mut events: Vec<(String, String, Vec<String>)> = Vec::new();
        // Generation 0 is the body that ran the ceremony. Here that is the
        // one the ceremony itself just built — `register` reads the path at
        // call time, after `warm`, so the shelved bytes are a real product.
        let exe = g.home.target().join("release").join("loom");
        let res = run_ceremony(
            &g.home,
            Mode::Packaged,
            &g.home.source(),
            g.slot,
            tools,
            &exe,
            Some(&g.bundle),
            &mut |s, d, t| {
                eprintln!("    [{s}] {d}");
                events.push((s.to_string(), d.to_string(), t.to_vec()));
            },
        );
        (res, events)
    }

    /// The whole ceremony, against real git + npm + cargo, asserted by what
    /// it leaves on disk — and then run a SECOND time to prove resumption
    /// skips completed steps instead of redoing them.
    ///
    /// This is the test that closes the round-3 gap: "threading has never run
    /// against real git, npm and cargo."
    ///
    /// Run it with:
    ///   cd src-tauri && cargo test real_ceremony_threads_a_real_genome -- --ignored --nocapture
    #[cfg(unix)]
    #[test]
    #[ignore = "spawns real git/npm/cargo and may reach crates.io once — run manually with --ignored"]
    fn real_ceremony_threads_a_real_genome_and_resumes() {
        let Some(tools) = real_tools("real_ceremony_threads_a_real_genome_and_resumes") else {
            return;
        };
        let g = real_genome();
        let started = Instant::now();
        let (res, events) = run_real(&g, &tools);
        eprintln!("  first ceremony: {:?}", started.elapsed());
        assert!(res.is_ok(), "the ceremony failed: {res:?}");
        assert_eq!(
            step_order(&events),
            vec!["seed", "deps", "vendor", "warm", "register", "stamp", "done"]
        );

        let source = g.home.source();
        let git = locate_now("git").unwrap();

        // 1 · seed — a real clone of a real bundle, checked out at the sha
        // the bundle itself records, on a local `main`.
        assert!(source.join(".git").is_dir(), "source/ is a git work tree");
        assert_eq!(git_ok(&git, &source, &["rev-parse", "HEAD"]), g.sha, "seed checked out the bundle's sha");
        assert_eq!(git_ok(&git, &source, &["rev-parse", "--abbrev-ref", "HEAD"]), "main");
        assert!(source.join("src-tauri/src/main.rs").is_file(), "the genome's files came across");

        // 2 · deps — a real `npm ci` really installed.
        assert!(
            source.join("node_modules").join("loom-fixture-dep").exists(),
            "npm ci installed the dependency into source/node_modules"
        );

        // 3 · vendor — a real `cargo vendor` really populated vendor/, and
        // the config that makes the checkout build offline was written.
        let vendored = g.home.vendor().join("cfg-if-1.0.0").join("Cargo.toml");
        assert!(vendored.is_file(), "cargo vendor populated {}", g.home.vendor().display());
        let cfg = std::fs::read_to_string(source.join(".cargo").join("config.toml"))
            .expect("the ceremony wrote source/.cargo/config.toml");
        assert!(cfg.contains(&g.home.vendor().display().to_string()), "the config names the vendor dir: {cfg}");
        assert!(cfg.contains("replace-with = \"vendored\""), "{cfg}");
        assert!(cfg.contains("offline = true"), "{cfg}");

        // 4 · warm — real assets, and a real offline release build. That the
        // build SUCCEEDED with `--offline` is the proof that steps 3 and 4
        // fit together: cargo resolved cfg-if from vendor/, not the network.
        assert!(source.join("dist").join("index.html").is_file(), "npm run build wrote dist/");
        let built = g.home.target().join("release").join("loom");
        assert!(built.is_file(), "cargo build --release --offline produced {}", built.display());
        let built_bytes = std::fs::read(&built).unwrap();
        assert!(built_bytes.len() > 1024, "a real executable, not a stub");

        // 5 · register — generation 0 is that body, and the ledger says so.
        //
        // Found by running this test: `register` shelves under the sha baked
        // into the BINARY (`genome_sha()`), while `seed` checks the source out
        // at the sha the BUNDLE names. They agree in a healthy build; here
        // they deliberately do not, and the divergence is visible below —
        // `source/` HEAD is the fixture's sha, the ledger names the running
        // binary's. Recorded, not fixed: which of the two `register` should
        // follow is a design call, not a test's to make.
        let shelved = g.home.generation_exe(crate::loomhome::genome_sha());
        assert!(shelved.is_file(), "generation 0 shelved at {}", shelved.display());
        assert!(
            std::fs::read(&shelved).unwrap() == built_bytes,
            "the shelved body IS the built body — register copies, it does not re-sign"
        );
        let ledger = crate::generations::read(&g.home);
        assert_eq!(ledger.current.as_deref(), Some(crate::loomhome::genome_sha()));
        assert_eq!(ledger.previous, None);
        assert!(ledger.confirmed);
        assert!(g.home.generation_meta(crate::loomhome::genome_sha()).is_file(), "meta.json written");

        // 6 · stamp — threaded, only now.
        let t = read(&g.home).expect("threads.json");
        assert!(t.threaded, "threaded");
        assert_eq!(t.threaded_sha.as_deref(), Some(crate::loomhome::genome_sha()));
        assert!(t.threaded_at.is_some());
        assert!(t.steps.seed && t.steps.deps && t.steps.vendor && t.steps.warm && t.steps.register);

        // ── Resumption, for real ────────────────────────────────────────────
        //
        // Delete the assets the warm step produced. A second ceremony that
        // re-ran warm would put them back; a resuming one must not — and must
        // say so, per step, rather than silently redoing minutes of work.
        std::fs::remove_dir_all(source.join("dist")).unwrap();
        let built_before = std::fs::metadata(&built).unwrap().modified().unwrap();
        let node_modules_before = std::fs::metadata(source.join("node_modules")).unwrap().modified().unwrap();

        let again = Instant::now();
        let (res2, events2) = run_real(&g, &tools);
        let resume_took = again.elapsed();
        eprintln!("  second ceremony (resumed): {resume_took:?}");
        assert!(res2.is_ok(), "the resumed ceremony failed: {res2:?}");
        assert_eq!(
            step_order(&events2),
            vec!["seed", "deps", "vendor", "warm", "register", "stamp", "done"],
            "every step still reports; the completed ones report as already done"
        );

        let said = |step: &str| -> String {
            events2.iter().find(|(s, _, _)| s == step).map(|(_, d, _)| d.clone()).unwrap_or_default()
        };
        assert_eq!(said("seed"), "already seeded");
        assert_eq!(said("deps"), "dependencies already installed");
        assert_eq!(said("vendor"), "crates already vendored");
        assert_eq!(said("warm"), "the build is already warm");
        assert_eq!(said("register"), "generation 0 already shelved");

        assert!(
            !source.join("dist").exists(),
            "the warm step was SKIPPED, not redone — dist/ did not come back"
        );
        assert_eq!(
            std::fs::metadata(&built).unwrap().modified().unwrap(),
            built_before,
            "the release binary was not rebuilt"
        );
        assert_eq!(
            std::fs::metadata(source.join("node_modules")).unwrap().modified().unwrap(),
            node_modules_before,
            "npm ci did not run again"
        );
        assert!(read(&g.home).unwrap().threaded, "still threaded after the resumed run");
    }

    /// The reweave's build stages — `assets` and `core` — against the same
    /// real toolchain and the same fixture, on the loomhome a real ceremony
    /// just threaded. Dev mode on purpose: stages 1–3 run, and the job stops
    /// at `done` before `swap` and `relaunch`, which replace a running
    /// application and must never be exercised by a test.
    ///
    /// Run it with:
    ///   cd src-tauri && cargo test real_reweave_builds_and_shelves -- --ignored --nocapture
    #[cfg(unix)]
    #[test]
    #[ignore = "spawns real npm/cargo on a threaded fixture — run manually with --ignored"]
    fn real_reweave_builds_and_shelves_a_real_binary() {
        let Some(tools) = real_tools("real_reweave_builds_and_shelves_a_real_binary") else {
            return;
        };
        let g = real_genome();
        let (res, _) = run_real(&g, &tools);
        assert!(res.is_ok(), "the fixture must thread before it can reweave: {res:?}");

        let source = g.home.source();
        let git = locate_now("git").unwrap();
        // A new commit, so the reweave has a genome that differs from the
        // body — and so the target sha is one the ledger has never seen.
        std::fs::write(
            source.join("src-tauri/src/main.rs"),
            "fn main() {\n    cfg_if::cfg_if! { if #[cfg(unix)] { println!(\"rewoven\"); } else { println!(\"rewoven\"); } }\n}\n",
        )
        .unwrap();
        git_ok(&git, &source, &["add", "-A"]);
        git_ok(
            &git,
            &source,
            &["-c", "user.email=fixture@loom.test", "-c", "user.name=LOOM fixture", "commit", "--quiet", "-m", "a core change"],
        );
        let new_sha = git_ok(&git, &source, &["rev-parse", "HEAD"]);
        assert_ne!(new_sha, g.sha);

        // The build stages want the slot free — the ceremony's tenancy is
        // done, and `ExecRunner` takes the global JOB slot for itself.
        let ctx = crate::reweave::Ctx {
            home: &g.home,
            mode: Mode::Dev,
            os: std::env::consts::OS,
            source: source.clone(),
            layout: None,
            tools: &tools,
            old_pid: std::process::id(),
        };
        let mut runner = crate::reweave::ExecRunner;
        let mut seen: Vec<String> = Vec::new();
        let started = Instant::now();
        let fin = crate::reweave::run_job(
            &ctx,
            crate::reweave::Kind::Weave,
            &mut runner,
            &mut |s| {
                if seen.last() != Some(&s.stage) {
                    eprintln!("    [{}] {}", s.stage, s.outcome.as_deref().unwrap_or(""));
                    seen.push(s.stage.clone());
                }
            },
        );
        eprintln!("  reweave: {:?}", started.elapsed());
        let fin = fin.expect("the reweave's build stages must succeed on real tools");
        assert_eq!(fin, crate::reweave::Finish::Built, "dev stops after stage — no swap, no relaunch");
        assert_eq!(seen, vec!["assets", "core", "stage", "done"]);

        // assets · a real `npm run build` product.
        assert!(source.join("dist").join("index.html").is_file(), "the assets stage rebuilt dist/");
        // core · a real offline `cargo build --release` product.
        let built = g.home.target().join("release").join("loom");
        assert!(built.is_file(), "the core stage produced {}", built.display());
        // stage · shelved under the NEW sha, byte-for-byte the thing built.
        let shelved = g.home.generation_exe(&new_sha);
        assert!(shelved.is_file(), "the new generation is shelved at {}", shelved.display());
        assert!(g.home.generation_meta(&new_sha).is_file(), "meta.json for the new generation");
        // Found by running this test: on macOS the stage step ad-hoc signs the
        // SHELVED copy, so it is deliberately NOT byte-identical to
        // `target/release/loom`. That the signature verifies is the stronger
        // claim, and the one the swap depends on — an unsigned body will not
        // launch. On other unixes the copy is a plain copy.
        if std::env::consts::OS == "macos" {
            let codesign = locate_now("codesign").expect("macOS has codesign");
            let verify = std::process::Command::new(&codesign)
                .args(["--verify", "--strict", shelved.to_str().unwrap()])
                .output()
                .unwrap();
            assert!(
                verify.status.success(),
                "the stage step's ad-hoc signature must verify: {}",
                String::from_utf8_lossy(&verify.stderr)
            );
            assert!(
                std::fs::read(&shelved).unwrap().len() >= std::fs::read(&built).unwrap().len(),
                "signing appends a load command; the shelved body is not smaller than the built one"
            );
        } else {
            assert!(std::fs::read(&shelved).unwrap() == std::fs::read(&built).unwrap());
        }
        // And the running generation is untouched: no swap happened.
        let ledger = crate::generations::read(&g.home);
        assert_eq!(
            ledger.current.as_deref(),
            Some(crate::loomhome::genome_sha()),
            "dev never swaps — the ledger still names the body that ran"
        );
    }
}
