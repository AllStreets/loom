# LOOM Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up LOOM's foundation — a Tauri desktop app whose Rust core manages the local Ollama model fleet and provides a git-backed Timeline — the substrate every later subsystem (Organ Host, the Loom, Companion, orb) builds on.

**Architecture:** A Tauri v2 app: a thin **Rust core** exposes commands to a **React+Vite+TypeScript** web UI. The Rust core owns everything native — talking to local Ollama (list/chat/pull/pin the 3-model fleet with timeouts + retry + fallback) and running git operations (the Timeline: commit, log, rollback, last-good). The web UI has thin typed wrappers (`invoke`) and a minimal Status surface proving the fleet and Timeline work end-to-end. Fully offline; no cloud, no telemetry.

**Tech Stack:** Tauri v2 (Rust), React 19 + Vite + TypeScript, `reqwest` (Ollama HTTP), `git2` (libgit2), `tokio`, `serde`; Vitest (frontend tests), Rust `cargo test` + `tempfile` (core tests).

## Global Constraints

- Fully offline. Models run only via local Ollama at `http://localhost:11434`. No cloud calls, no telemetry, ever.
- Tauri **v2**. Kernel UI is React + Vite + TypeScript. (Organs will be no-build modules in a later plan — not this one.)
- **git is the Timeline** — all versioning is git via `git2`; no timestamped backup folders.
- Model fleet (exact Ollama tags): builder `qwen3-coder:30b-a3b-q4_K_M`, companion `gpt-oss:20b`, rewriter `qwen3:1.7b`. Pin resident with `keep_alive: -1`.
- Every model call has a timeout, bounded retry, and a fallback model (builder→rewriter, companion→rewriter). A slow/absent model degrades gracefully; it never hangs the UI.
- UI base color is navy `#060b18` (not black). No emojis in any UI copy — words and icons only.
- DRY, YAGNI, TDD, frequent commits.

---

## File Structure

```
LOOM/
├─ package.json                     # web UI + scripts (dev, build, test, check)
├─ vite.config.ts
├─ vitest.config.ts
├─ index.html
├─ src/                             # React kernel (web UI)
│  ├─ main.tsx                      # React entry
│  ├─ App.tsx                       # boot shell → Status surface
│  ├─ styles/tokens.css             # design tokens (navy base, state colors)
│  ├─ lib/core.ts                   # typed wrappers over Tauri invoke (fleet + timeline)
│  ├─ lib/core.test.ts              # vitest: core wrappers with mocked invoke
│  └─ components/StatusPanel.tsx    # minimal fleet + timeline status surface
├─ src-tauri/
│  ├─ Cargo.toml
│  ├─ tauri.conf.json
│  └─ src/
│     ├─ main.rs                    # Tauri entry, command registration
│     ├─ ollama.rs                  # Ollama HTTP client (tags, chat, pull)
│     ├─ fleet.rs                   # fleet config + manager (ensure/pin/health/call w/ retry+fallback)
│     ├─ timeline.rs               # git-backed Timeline (init/commit/log/rollback/last_good)
│     └─ error.rs                   # shared error type → serializable to the UI
├─ .github/workflows/check.yml      # cargo test + vitest gate
└─ docs/superpowers/…               # spec + this plan (already committed)
```

Responsibilities: `ollama.rs` = raw HTTP only. `fleet.rs` = policy (which model per role, pin, retry, fallback). `timeline.rs` = all git. `core.ts` = the single typed boundary the UI uses. Files that change together live together; each file has one job.

---

### Task 1: Scaffold the Tauri v2 + React + Vite + TS app

**Files:**
- Create: whole skeleton via scaffolder, then trim to the structure above.
- Create: `vitest.config.ts`, `src/lib/smoke.test.ts`

**Interfaces:**
- Produces: a running `npm run tauri dev` app window; `npm test` (vitest) and `cargo test` both runnable.

- [ ] **Step 1: Verify prerequisites**

Run:
```bash
node --version   # expect v20+
rustc --version  # expect 1.77+
ollama --version # expect present
```
Expected: all three print versions. If Rust is missing: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`. If Tauri system deps are missing on macOS, install Xcode CLT: `xcode-select --install`.

- [ ] **Step 2: Scaffold into the existing LOOM folder**

The LOOM folder already exists (git repo + docs). Scaffold into a temp dir and merge so we keep `docs/` and git history:
```bash
cd /Users/connorevans/Downloads
npm create tauri-app@latest loom-scaffold -- --template react-ts --manager npm --yes
rsync -a --exclude='.git' loom-scaffold/ LOOM/
rm -rf loom-scaffold
cd LOOM && npm install
```
Expected: `LOOM/src-tauri/`, `LOOM/src/`, `LOOM/package.json` now exist alongside `docs/`.

- [ ] **Step 3: Confirm the app boots**

Run: `npm run tauri dev`
Expected: a native window opens showing the default Tauri+React page. Close it (Ctrl-C).

- [ ] **Step 4: Add Vitest**

Run: `npm i -D vitest @testing-library/react @testing-library/jest-dom jsdom`

Create `vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { environment: "jsdom", globals: true, setupFiles: [] },
});
```

Add to `package.json` "scripts": `"test": "vitest run"`, `"check": "vitest run && (cd src-tauri && cargo test)"`.

- [ ] **Step 5: Write a smoke test**

Create `src/lib/smoke.test.ts`:
```ts
import { describe, it, expect } from "vitest";
describe("smoke", () => {
  it("runs the test harness", () => { expect(1 + 1).toBe(2); });
});
```

- [ ] **Step 6: Run tests to verify the harness works**

Run: `npm test`
Expected: PASS (1 test).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold Tauri v2 + React/Vite/TS skeleton with vitest"
```

---

### Task 2: Design tokens + boot shell

**Files:**
- Create: `src/styles/tokens.css`
- Modify: `src/main.tsx` (import tokens), `src/App.tsx` (boot shell)
- Test: `src/App.test.tsx`

**Interfaces:**
- Produces: `App` renders a boot shell with `data-testid="loom-shell"` on navy `#060b18`. CSS vars `--bg`, `--panel`, `--t1/2/3`, `--accent`, `--go`, `--warn`, `--danger`, and state colors `--state-listen/think/speak`.

- [ ] **Step 1: Write the failing test**

Create `src/App.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import App from "./App";

describe("App boot shell", () => {
  it("renders the LOOM shell", () => {
    render(<App />);
    expect(screen.getByTestId("loom-shell")).toBeTruthy();
    expect(screen.getByText(/LOOM/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/App.test.tsx`
Expected: FAIL (App has no `loom-shell` testid yet).

- [ ] **Step 3: Create the design tokens**

Create `src/styles/tokens.css`:
```css
:root{
  --bg:#060b18; --panel:#0b1striped; /* replaced below */
}
:root{
  --bg:#060b18;
  --panel:#0d1424;
  --panel-2:#111a2e;
  --line:rgba(255,255,255,.06);
  --t1:#e8edf7; --t2:#9fb0cc; --t3:#5f6f8c;
  --accent:#f59e0b;
  --go:#4ade80; --warn:#fbbf24; --danger:#f87171;
  --state-listen:#0a84ff; --state-think:#f59e0b; --state-speak:#10b981;
  --f-sans:ui-sans-serif,system-ui,-apple-system,sans-serif;
  --f-mono:ui-monospace,SFMono-Regular,Menlo,monospace;
}
html,body,#root{height:100%;margin:0}
body{background:var(--bg);color:var(--t1);font-family:var(--f-sans)}
```
(Delete the erroneous first `:root` block; keep only the full one.)

- [ ] **Step 4: Write the shell**

Replace `src/App.tsx`:
```tsx
import "./styles/tokens.css";

export default function App() {
  return (
    <main data-testid="loom-shell" style={{ minHeight: "100vh", padding: 24 }}>
      <header style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <b style={{ letterSpacing: ".4em", fontSize: 20 }}>LOOM</b>
        <small style={{ color: "var(--t3)", fontFamily: "var(--f-mono)" }}>
          sovereign console
        </small>
      </header>
    </main>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/App.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: design tokens (navy base) + boot shell"
```

---

### Task 3: Rust — Ollama HTTP client

**Files:**
- Create: `src-tauri/src/ollama.rs`, `src-tauri/src/error.rs`
- Modify: `src-tauri/Cargo.toml` (deps), `src-tauri/src/main.rs` (`mod ollama; mod error;`)

**Interfaces:**
- Produces:
  - `pub struct Ollama { base: String }` with `Ollama::new(base: &str)`
  - `pub async fn tags(&self) -> Result<Vec<String>, LoomError>` — installed model names
  - `pub async fn chat(&self, model:&str, messages: Vec<Msg>, keep_alive: i64, timeout_ms: u64) -> Result<String, LoomError>`
  - `pub struct Msg { pub role: String, pub content: String }` (serde)
  - `pub fn parse_tags(json:&str) -> Result<Vec<String>, LoomError>` (pure, testable)
- `LoomError` in `error.rs`: `pub enum LoomError { Http(String), Timeout, Parse(String), Git(String), NotFound(String) }`, `impl std::fmt::Display`, `impl serde::Serialize` (as `{ "kind": "...", "message": "..." }`).

- [ ] **Step 1: Add dependencies**

In `src-tauri/Cargo.toml` under `[dependencies]`:
```toml
reqwest = { version = "0.12", features = ["json"] }
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
git2 = "0.19"
```
Under a new `[dev-dependencies]`:
```toml
tempfile = "3"
```

- [ ] **Step 2: Create the error type**

Create `src-tauri/src/error.rs`:
```rust
use serde::{Serialize, Serializer, ser::SerializeStruct};

#[derive(Debug)]
pub enum LoomError { Http(String), Timeout, Parse(String), Git(String), NotFound(String) }

impl std::fmt::Display for LoomError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LoomError::Http(m) => write!(f, "http: {m}"),
            LoomError::Timeout => write!(f, "timeout"),
            LoomError::Parse(m) => write!(f, "parse: {m}"),
            LoomError::Git(m) => write!(f, "git: {m}"),
            LoomError::NotFound(m) => write!(f, "not found: {m}"),
        }
    }
}
impl std::error::Error for LoomError {}

impl Serialize for LoomError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let kind = match self {
            LoomError::Http(_) => "http", LoomError::Timeout => "timeout",
            LoomError::Parse(_) => "parse", LoomError::Git(_) => "git",
            LoomError::NotFound(_) => "not_found",
        };
        let mut st = s.serialize_struct("LoomError", 2)?;
        st.serialize_field("kind", kind)?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}
```

- [ ] **Step 3: Write the failing test for `parse_tags`**

Create `src-tauri/src/ollama.rs` with only the test + a stub:
```rust
use crate::error::LoomError;

pub fn parse_tags(_json: &str) -> Result<Vec<String>, LoomError> { unimplemented!() }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_model_names() {
        let json = r#"{"models":[{"name":"gpt-oss:20b"},{"name":"qwen3:1.7b"}]}"#;
        let got = parse_tags(json).unwrap();
        assert_eq!(got, vec!["gpt-oss:20b".to_string(), "qwen3:1.7b".to_string()]);
    }
    #[test]
    fn empty_on_no_models() {
        assert_eq!(parse_tags(r#"{"models":[]}"#).unwrap(), Vec::<String>::new());
    }
}
```
Add `mod ollama; mod error;` to `src-tauri/src/main.rs` (top).

- [ ] **Step 4: Run test to verify it fails**

Run: `cd src-tauri && cargo test parse_tags`
Expected: FAIL (panics on `unimplemented!()`).

- [ ] **Step 5: Implement the Ollama client**

Replace the stub in `src-tauri/src/ollama.rs` (keep the `#[cfg(test)]` block):
```rust
use crate::error::LoomError;
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Serialize, Deserialize, Clone)]
pub struct Msg { pub role: String, pub content: String }

pub struct Ollama { base: String }

impl Ollama {
    pub fn new(base: &str) -> Self { Self { base: base.trim_end_matches('/').to_string() } }

    pub async fn tags(&self) -> Result<Vec<String>, LoomError> {
        let url = format!("{}/api/tags", self.base);
        let res = reqwest::get(&url).await.map_err(|e| LoomError::Http(e.to_string()))?;
        let text = res.text().await.map_err(|e| LoomError::Http(e.to_string()))?;
        parse_tags(&text)
    }

    pub async fn chat(&self, model: &str, messages: Vec<Msg>, keep_alive: i64, timeout_ms: u64)
        -> Result<String, LoomError> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(timeout_ms))
            .build().map_err(|e| LoomError::Http(e.to_string()))?;
        let body = serde_json::json!({
            "model": model, "messages": messages, "stream": false,
            "keep_alive": keep_alive,
        });
        let res = client.post(format!("{}/api/chat", self.base)).json(&body).send().await
            .map_err(|e| if e.is_timeout() { LoomError::Timeout } else { LoomError::Http(e.to_string()) })?;
        if res.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(LoomError::NotFound(model.to_string()));
        }
        let text = res.text().await.map_err(|e| LoomError::Http(e.to_string()))?;
        let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| LoomError::Parse(e.to_string()))?;
        Ok(v.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_str()).unwrap_or("").to_string())
    }
}

pub fn parse_tags(json: &str) -> Result<Vec<String>, LoomError> {
    let v: serde_json::Value = serde_json::from_str(json).map_err(|e| LoomError::Parse(e.to_string()))?;
    let models = v.get("models").and_then(|m| m.as_array())
        .ok_or_else(|| LoomError::Parse("no models[]".into()))?;
    Ok(models.iter().filter_map(|m| m.get("name").and_then(|n| n.as_str()).map(String::from)).collect())
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd src-tauri && cargo test`
Expected: PASS (both `parse_tags` tests).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(core): Ollama HTTP client (tags, chat) + serializable error"
```

---

### Task 4: Rust — Fleet manager (roles, pin, health, retry, fallback)

**Files:**
- Create: `src-tauri/src/fleet.rs`
- Modify: `src-tauri/src/main.rs` (`mod fleet;` + register commands)

**Interfaces:**
- Produces:
  - `pub struct FleetConfig { pub builder:String, pub companion:String, pub rewriter:String }` with `Default` = the three exact tags.
  - `pub fn role_model(cfg:&FleetConfig, role:&str) -> Option<String>` (pure)
  - `pub fn fallback_for(cfg:&FleetConfig, role:&str) -> String` (pure: builder→rewriter, companion→rewriter, rewriter→rewriter)
  - `pub fn health(installed:&[String], cfg:&FleetConfig) -> Vec<(String,String,bool)>` (pure: (role, tag, present))
  - Tauri commands: `fleet_status() -> Result<Vec<RoleStatus>, LoomError>`, `fleet_chat(role:String, messages:Vec<Msg>) -> Result<String, LoomError>` (uses timeout+one retry, then falls back to `fallback_for`).
  - `pub struct RoleStatus { pub role:String, pub model:String, pub present:bool }` (serde)

- [ ] **Step 1: Write failing tests for the pure fleet logic**

Create `src-tauri/src/fleet.rs`:
```rust
use crate::error::LoomError;
use crate::ollama::{Msg, Ollama};
use serde::Serialize;

pub struct FleetConfig { pub builder: String, pub companion: String, pub rewriter: String }
impl Default for FleetConfig {
    fn default() -> Self {
        Self {
            builder: "qwen3-coder:30b-a3b-q4_K_M".into(),
            companion: "gpt-oss:20b".into(),
            rewriter: "qwen3:1.7b".into(),
        }
    }
}
pub fn role_model(_c: &FleetConfig, _r: &str) -> Option<String> { unimplemented!() }
pub fn fallback_for(_c: &FleetConfig, _r: &str) -> String { unimplemented!() }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn maps_roles_to_models() {
        let c = FleetConfig::default();
        assert_eq!(role_model(&c, "builder").unwrap(), "qwen3-coder:30b-a3b-q4_K_M");
        assert_eq!(role_model(&c, "companion").unwrap(), "gpt-oss:20b");
        assert_eq!(role_model(&c, "rewriter").unwrap(), "qwen3:1.7b");
        assert!(role_model(&c, "bogus").is_none());
    }
    #[test]
    fn falls_back_to_rewriter() {
        let c = FleetConfig::default();
        assert_eq!(fallback_for(&c, "builder"), "qwen3:1.7b");
        assert_eq!(fallback_for(&c, "companion"), "qwen3:1.7b");
    }
    #[test]
    fn health_flags_present_models() {
        let c = FleetConfig::default();
        let installed = vec!["gpt-oss:20b".to_string()];
        let h = health(&installed, &c);
        let companion = h.iter().find(|(r,_,_)| r=="companion").unwrap();
        let builder = h.iter().find(|(r,_,_)| r=="builder").unwrap();
        assert!(companion.2);   // present
        assert!(!builder.2);    // absent
    }
}
```
Add `mod fleet;` to `main.rs`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test fleet`
Expected: FAIL (unimplemented + `health` undefined).

- [ ] **Step 3: Implement the pure logic + manager + commands**

Append/replace in `src-tauri/src/fleet.rs` (keep the tests):
```rust
pub fn role_model(c: &FleetConfig, r: &str) -> Option<String> {
    match r {
        "builder" => Some(c.builder.clone()),
        "companion" => Some(c.companion.clone()),
        "rewriter" => Some(c.rewriter.clone()),
        _ => None,
    }
}
pub fn fallback_for(c: &FleetConfig, _r: &str) -> String { c.rewriter.clone() }

pub fn health(installed: &[String], c: &FleetConfig) -> Vec<(String, String, bool)> {
    ["builder", "companion", "rewriter"].iter().map(|role| {
        let m = role_model(c, role).unwrap();
        let present = installed.iter().any(|i| i == &m);
        (role.to_string(), m, present)
    }).collect()
}

#[derive(Serialize)]
pub struct RoleStatus { pub role: String, pub model: String, pub present: bool }

const OLLAMA: &str = "http://localhost:11434";
const KEEP_ALIVE: i64 = -1;         // pin resident
const TIMEOUT_MS: u64 = 90_000;

#[tauri::command]
pub async fn fleet_status() -> Result<Vec<RoleStatus>, LoomError> {
    let cfg = FleetConfig::default();
    let installed = Ollama::new(OLLAMA).tags().await.unwrap_or_default();
    Ok(health(&installed, &cfg).into_iter()
        .map(|(role, model, present)| RoleStatus { role, model, present }).collect())
}

#[tauri::command]
pub async fn fleet_chat(role: String, messages: Vec<Msg>) -> Result<String, LoomError> {
    let cfg = FleetConfig::default();
    let primary = role_model(&cfg, &role).ok_or(LoomError::NotFound(role.clone()))?;
    let o = Ollama::new(OLLAMA);
    // one retry on primary, then fall back
    for attempt in 0..2 {
        match o.chat(&primary, messages.clone(), KEEP_ALIVE, TIMEOUT_MS).await {
            Ok(s) => return Ok(s),
            Err(LoomError::NotFound(_)) => break,               // pulling won't help this call; fall back
            Err(_) if attempt == 0 => continue,                  // transient: retry once
            Err(_) => break,
        }
    }
    let fb = fallback_for(&cfg, &role);
    o.chat(&fb, messages, KEEP_ALIVE, TIMEOUT_MS).await
}
```

- [ ] **Step 4: Register the commands**

In `src-tauri/src/main.rs`, add to the `tauri::Builder` `.invoke_handler(tauri::generate_handler![ ... ])` list: `fleet::fleet_status, fleet::fleet_chat`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src-tauri && cargo test fleet`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): fleet manager — roles, health, retry+fallback chat"
```

---

### Task 5: Rust — Timeline (git-backed history)

**Files:**
- Create: `src-tauri/src/timeline.rs`
- Modify: `src-tauri/src/main.rs` (`mod timeline;` + register commands)

**Interfaces:**
- Produces (all operate on a repo at a given path, using `git2`):
  - `pub fn ensure_repo(path:&std::path::Path) -> Result<(), LoomError>` — init if absent
  - `pub fn commit_all(path:&std::path::Path, message:&str) -> Result<String, LoomError>` — stage all, commit, return short sha (no-op returns `"nochange"`)
  - `pub fn log(path:&std::path::Path, limit:usize) -> Result<Vec<Commit>, LoomError>`
  - `pub fn rollback(path:&std::path::Path, sha:&str) -> Result<(), LoomError>` — hard reset working tree to sha
  - `pub fn last_good(path:&std::path::Path) -> Result<String, LoomError>` — sha of HEAD (v1: last commit; later: last commit tagged good)
  - `pub struct Commit { pub sha:String, pub message:String }` (serde)
  - Tauri commands wrapping these against the app data dir.

- [ ] **Step 1: Write the failing test**

Create `src-tauri/src/timeline.rs`:
```rust
use crate::error::LoomError;
use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
pub struct Commit { pub sha: String, pub message: String }

pub fn ensure_repo(_p: &Path) -> Result<(), LoomError> { unimplemented!() }
pub fn commit_all(_p: &Path, _m: &str) -> Result<String, LoomError> { unimplemented!() }
pub fn log(_p: &Path, _n: usize) -> Result<Vec<Commit>, LoomError> { unimplemented!() }
pub fn rollback(_p: &Path, _sha: &str) -> Result<(), LoomError> { unimplemented!() }
pub fn last_good(_p: &Path) -> Result<String, LoomError> { unimplemented!() }

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn commit_rollback_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        ensure_repo(p).unwrap();

        fs::write(p.join("organ.js"), "v1").unwrap();
        let sha1 = commit_all(p, "add organ v1").unwrap();
        assert_ne!(sha1, "nochange");

        fs::write(p.join("organ.js"), "v2-broken").unwrap();
        let sha2 = commit_all(p, "organ v2").unwrap();
        assert_eq!(log(p, 10).unwrap().len(), 2);

        // roll back to v1
        rollback(p, &sha1).unwrap();
        assert_eq!(fs::read_to_string(p.join("organ.js")).unwrap(), "v1");
        // last_good tracks HEAD after reset
        assert!(last_good(p).unwrap().starts_with(&sha1[..7]) || last_good(p).unwrap() == sha1);
        let _ = sha2;
    }

    #[test]
    fn nochange_when_nothing_staged() {
        let dir = tempfile::tempdir().unwrap();
        ensure_repo(dir.path()).unwrap();
        fs::write(dir.path().join("a"), "x").unwrap();
        commit_all(dir.path(), "first").unwrap();
        assert_eq!(commit_all(dir.path(), "again").unwrap(), "nochange");
    }
}
```
Add `mod timeline;` to `main.rs`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test timeline`
Expected: FAIL (unimplemented).

- [ ] **Step 3: Implement with git2**

Replace the stubs in `src-tauri/src/timeline.rs` (keep tests):
```rust
use git2::{Repository, Signature, ResetType};

fn sig() -> Result<Signature<'static>, LoomError> {
    Signature::now("LOOM", "loom@localhost").map_err(|e| LoomError::Git(e.to_string()))
}

pub fn ensure_repo(p: &Path) -> Result<(), LoomError> {
    if Repository::open(p).is_ok() { return Ok(()); }
    Repository::init(p).map_err(|e| LoomError::Git(e.to_string()))?;
    Ok(())
}

pub fn commit_all(p: &Path, message: &str) -> Result<String, LoomError> {
    let repo = Repository::open(p).map_err(|e| LoomError::Git(e.to_string()))?;
    let mut index = repo.index().map_err(|e| LoomError::Git(e.to_string()))?;
    index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
        .map_err(|e| LoomError::Git(e.to_string()))?;
    index.write().map_err(|e| LoomError::Git(e.to_string()))?;
    let tree_id = index.write_tree().map_err(|e| LoomError::Git(e.to_string()))?;
    let tree = repo.find_tree(tree_id).map_err(|e| LoomError::Git(e.to_string()))?;
    let sig = sig()?;
    let parent = repo.head().ok().and_then(|h| h.target()).and_then(|oid| repo.find_commit(oid).ok());
    if let Some(ref pc) = parent {
        if pc.tree_id() == tree_id { return Ok("nochange".into()); } // nothing changed
    }
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    let oid = repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
        .map_err(|e| LoomError::Git(e.to_string()))?;
    Ok(oid.to_string())
}

pub fn log(p: &Path, limit: usize) -> Result<Vec<Commit>, LoomError> {
    let repo = Repository::open(p).map_err(|e| LoomError::Git(e.to_string()))?;
    let mut walk = repo.revwalk().map_err(|e| LoomError::Git(e.to_string()))?;
    if walk.push_head().is_err() { return Ok(vec![]); }
    let mut out = vec![];
    for oid in walk.take(limit) {
        let oid = oid.map_err(|e| LoomError::Git(e.to_string()))?;
        let c = repo.find_commit(oid).map_err(|e| LoomError::Git(e.to_string()))?;
        out.push(Commit { sha: oid.to_string(), message: c.summary().unwrap_or("").to_string() });
    }
    Ok(out)
}

pub fn rollback(p: &Path, sha: &str) -> Result<(), LoomError> {
    let repo = Repository::open(p).map_err(|e| LoomError::Git(e.to_string()))?;
    let oid = git2::Oid::from_str(sha).map_err(|e| LoomError::Git(e.to_string()))?;
    let obj = repo.find_object(oid, None).map_err(|e| LoomError::Git(e.to_string()))?;
    repo.reset(&obj, ResetType::Hard, None).map_err(|e| LoomError::Git(e.to_string()))?;
    Ok(())
}

pub fn last_good(p: &Path) -> Result<String, LoomError> {
    let repo = Repository::open(p).map_err(|e| LoomError::Git(e.to_string()))?;
    let head = repo.head().map_err(|e| LoomError::Git(e.to_string()))?;
    head.target().map(|o| o.to_string()).ok_or(LoomError::Git("no HEAD".into()))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src-tauri && cargo test timeline`
Expected: PASS (2 tests).

- [ ] **Step 5: Add Tauri commands over the app data dir**

Append to `src-tauri/src/timeline.rs`:
```rust
fn loom_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, LoomError> {
    let dir = tauri::Manager::path(app).app_data_dir()
        .map_err(|e| LoomError::Git(e.to_string()))?.join("loom");
    std::fs::create_dir_all(&dir).map_err(|e| LoomError::Git(e.to_string()))?;
    Ok(dir)
}

#[tauri::command]
pub fn timeline_init(app: tauri::AppHandle) -> Result<(), LoomError> { ensure_repo(&loom_dir(&app)?) }

#[tauri::command]
pub fn timeline_commit(app: tauri::AppHandle, message: String) -> Result<String, LoomError> {
    commit_all(&loom_dir(&app)?, &message)
}

#[tauri::command]
pub fn timeline_log(app: tauri::AppHandle, limit: usize) -> Result<Vec<Commit>, LoomError> {
    log(&loom_dir(&app)?, limit)
}

#[tauri::command]
pub fn timeline_rollback(app: tauri::AppHandle, sha: String) -> Result<(), LoomError> {
    rollback(&loom_dir(&app)?, &sha)
}
```
Register in `main.rs` handler list: `timeline::timeline_init, timeline::timeline_commit, timeline::timeline_log, timeline::timeline_rollback`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): git-backed Timeline (commit/log/rollback/last_good) + commands"
```

---

### Task 6: Frontend core wrappers + Status surface

**Files:**
- Create: `src/lib/core.ts`, `src/lib/core.test.ts`, `src/components/StatusPanel.tsx`
- Modify: `src/App.tsx` (mount StatusPanel)

**Interfaces:**
- Consumes: Tauri commands `fleet_status`, `fleet_chat`, `timeline_init`, `timeline_commit`, `timeline_log`, `timeline_rollback`.
- Produces:
  - `core.ts`: `fleetStatus(): Promise<RoleStatus[]>`, `fleetChat(role:string, messages:Msg[]): Promise<string>`, `timeline{Init,Commit,Log,Rollback}`; types `RoleStatus`, `Msg`, `Commit`.
  - `StatusPanel` React component showing each role (model + present dot) and the latest Timeline commits.

- [ ] **Step 1: Write the failing test (mock invoke)**

Create `src/lib/core.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { fleetStatus, fleetChat } from "./core";

beforeEach(() => invoke.mockReset());

describe("core wrappers", () => {
  it("fleetStatus calls the right command and returns typed rows", async () => {
    invoke.mockResolvedValue([{ role: "companion", model: "gpt-oss:20b", present: true }]);
    const rows = await fleetStatus();
    expect(invoke).toHaveBeenCalledWith("fleet_status");
    expect(rows[0].role).toBe("companion");
  });
  it("fleetChat passes role and messages", async () => {
    invoke.mockResolvedValue("hi");
    const out = await fleetChat("companion", [{ role: "user", content: "hey" }]);
    expect(invoke).toHaveBeenCalledWith("fleet_chat", { role: "companion", messages: [{ role: "user", content: "hey" }] });
    expect(out).toBe("hi");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/core.test.ts`
Expected: FAIL (`./core` has no exports yet).

- [ ] **Step 3: Implement core.ts**

Create `src/lib/core.ts`:
```ts
import { invoke } from "@tauri-apps/api/core";

export type RoleStatus = { role: string; model: string; present: boolean };
export type Msg = { role: "system" | "user" | "assistant"; content: string };
export type Commit = { sha: string; message: string };

export const fleetStatus = () => invoke<RoleStatus[]>("fleet_status");
export const fleetChat = (role: string, messages: Msg[]) =>
  invoke<string>("fleet_chat", { role, messages });

export const timelineInit = () => invoke<void>("timeline_init");
export const timelineCommit = (message: string) => invoke<string>("timeline_commit", { message });
export const timelineLog = (limit = 20) => invoke<Commit[]>("timeline_log", { limit });
export const timelineRollback = (sha: string) => invoke<void>("timeline_rollback", { sha });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/core.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Build the Status surface**

Create `src/components/StatusPanel.tsx`:
```tsx
import { useEffect, useState } from "react";
import { fleetStatus, timelineInit, timelineLog, type RoleStatus, type Commit } from "../lib/core";

export default function StatusPanel() {
  const [roles, setRoles] = useState<RoleStatus[]>([]);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        await timelineInit();
        setRoles(await fleetStatus());
        setCommits(await timelineLog(5));
      } catch (e) { setErr(String(e)); }
    })();
  }, []);

  return (
    <section style={{ marginTop: 20, maxWidth: 640 }}>
      <div style={{ fontFamily: "var(--f-mono)", color: "var(--t3)", fontSize: 12, textTransform: "uppercase", letterSpacing: ".08em" }}>Fleet</div>
      {roles.map((r) => (
        <div key={r.role} style={{ display: "flex", gap: 10, alignItems: "center", padding: "6px 0" }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: r.present ? "var(--go)" : "var(--danger)" }} />
          <b style={{ minWidth: 92 }}>{r.role}</b>
          <span style={{ fontFamily: "var(--f-mono)", color: "var(--t2)", fontSize: 13 }}>{r.model}</span>
        </div>
      ))}
      <div style={{ fontFamily: "var(--f-mono)", color: "var(--t3)", fontSize: 12, textTransform: "uppercase", letterSpacing: ".08em", marginTop: 16 }}>Timeline</div>
      {commits.length === 0 && <div style={{ color: "var(--t3)" }}>No commits yet.</div>}
      {commits.map((c) => (
        <div key={c.sha} style={{ fontSize: 13, padding: "3px 0" }}>
          <span style={{ fontFamily: "var(--f-mono)", color: "var(--t3)" }}>{c.sha.slice(0, 7)}</span>{" "}
          <span style={{ color: "var(--t1)" }}>{c.message}</span>
        </div>
      ))}
      {err && <div style={{ color: "var(--danger)", marginTop: 10 }}>{err}</div>}
    </section>
  );
}
```

Modify `src/App.tsx` to render it inside the shell:
```tsx
import "./styles/tokens.css";
import StatusPanel from "./components/StatusPanel";

export default function App() {
  return (
    <main data-testid="loom-shell" style={{ minHeight: "100vh", padding: 24 }}>
      <header style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <b style={{ letterSpacing: ".4em", fontSize: 20 }}>LOOM</b>
        <small style={{ color: "var(--t3)", fontFamily: "var(--f-mono)" }}>sovereign console</small>
      </header>
      <StatusPanel />
    </main>
  );
}
```

- [ ] **Step 6: Manual end-to-end check**

Run: `npm run tauri dev` (with Ollama running)
Expected: the window shows three fleet roles (green dot for any model you have installed, red for missing) and an empty-or-populated Timeline. No crash.

- [ ] **Step 7: Run the full check + commit**

Run: `npm run check`
Expected: vitest PASS + cargo test PASS.
```bash
git add -A
git commit -m "feat: core wrappers + fleet/timeline status surface"
```

---

### Task 7: CI gate

**Files:**
- Create: `.github/workflows/check.yml`

**Interfaces:**
- Produces: CI that runs `cargo test` + `vitest run` on push (the harness the later Loom self-test plugs into).

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/check.yml`:
```yaml
name: check
on: [push, pull_request]
jobs:
  test:
    runs-on: macos-14
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - uses: dtolnay/rust-toolchain@stable
      - run: npm ci
      - run: npm test
      - run: cd src-tauri && cargo test
```

- [ ] **Step 2: Verify locally**

Run: `npm ci && npm test && (cd src-tauri && cargo test)`
Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "ci: cargo test + vitest gate"
```

---

## Self-Review

**Spec coverage (foundation subset):**
- Tauri v2 + React+Vite+TS kernel → Task 1. ✓
- Rust core Ollama bridge + fleet manager (resident, keep_alive -1, timeout/retry/fallback) → Tasks 3–4. ✓
- git-backed Timeline (commit/log/rollback/last_good) → Task 5. ✓
- Navy `#060b18` tokens, no emojis → Task 2 + copy throughout. ✓
- Self-test harness in CI (harness now; Loom self-test lands with the Loom plan) → Task 7. ✓
- Deferred to later plans (correctly out of scope here): Organ Host + sandboxed smoke-test, the Loom port, Prompt Compiler, Companion, voice (whisper/piper), the orb/UI. Noted in spec §12; each gets its own plan.

**Placeholder scan:** No TBD/TODO; every code step shows real code; every test step shows the assertion and the run command with expected result.

**Type consistency:** `Msg{role,content}`, `RoleStatus{role,model,present}`, `Commit{sha,message}` are defined once in Rust and mirrored once in `core.ts`; command names (`fleet_status`, `fleet_chat`, `timeline_*`) match between Rust `#[tauri::command]` fns, the `main.rs` handler registration, and the `core.ts` `invoke` calls. `fallback_for`/`role_model`/`health` names are used consistently across Task 4 and its tests.

**Note on scope:** This plan delivers a runnable, tested foundation (fleet + Timeline visible in a real window). It intentionally stops before the Organ Host and the Loom so it stays a right-sized, reviewable milestone. The next plan (`2026-08-XX-loom-organ-host-and-loom.md`) adds the Organ Host with Worker-sandboxed validation and ports/hardens Forge into the Loom, with its self-test wired into this CI.
