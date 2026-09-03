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
//! as `present`.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::error::LoomError;
use crate::loomhome::Home;

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

/// The first line of `<path> <version_args>`, trimmed; `present` when the
/// tool has no version flag; `None` if the probe fails (a found tool that
/// cannot answer is reported, not hidden — the drift check will flag it).
fn probe_version(path: &Path, spec: &ToolSpec) -> Option<String> {
    if spec.version_args.is_empty() {
        return Some("present".into());
    }
    let p = path.to_str()?;
    let mut argv: Vec<&str> = vec![p];
    argv.extend_from_slice(spec.version_args);
    let root = Path::new("/");
    let out = crate::exec::run_checked(&argv, root, root, VERSION_TIMEOUT).ok()?;
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
    let version = path.as_deref().and_then(|p| probe_version(p, spec));
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

pub fn write(home: &Home, t: &Threads) -> Result<(), LoomError> {
    write_json_atomic(&home.threads_json(), t)
}

/// A recorded tool's path if it still exists on disk; otherwise a fresh
/// discovery. This is what every later spawn (validation, reweave) asks for
/// argv[0], so a recorded path that vanished never becomes a silent PATH walk
/// without the status surface also reporting the drift.
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
    let steps = recorded.as_ref().map(|r| r.steps).unwrap_or_default();
    ThreadStatus {
        threaded: recorded.as_ref().map_or(false, |r| r.threaded),
        tools,
        missing,
        drifted,
        steps,
        needs_network: !steps.deps || !steps.vendor,
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
        };
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["needsNetwork"], true);
        assert!(v["steps"]["register"].is_boolean());
    }
}
