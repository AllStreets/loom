# LOOM Engine (Phase 2: The Loom + Organ Host) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give LOOM its heart — a self-building engine (the Loom) that turns a plain-language request into a validated, git-committed, permission-gated **organ**, plus the Organ Host that runs organs safely. This is EMBER's Forge **upgraded**, not ported.

**Architecture:** The Rust core gains chat options (num_ctx/temperature), a smarter builder fallback (best installed coder), and an organ store (files under the Timeline repo, committed via git on every write, with kernel-only permission grants). The TS kernel gains the pure edit engine (extract/edit-blocks/append — EMBER's proven logic, fully unit-tested), deterministic-first planning, a **sandboxed-iframe validation gate** (syntax + render smoke-test + model-authored tests, kill-on-timeout), an Organ Host with per-organ error boundaries and a permission-gated injected `loom` API, and a Loom console UI with a single-build queue and structured build log. A real-model self-test suite runs locally via `npm run selftest`; deterministic pipeline tests run in CI.

**Tech Stack:** Rust (`git2`, `reqwest`, `serde`), React 19 + TS + Vite, vitest + @testing-library/react, sandboxed `<iframe>` for organ validation, Ollama (builder role).

## Global Constraints

- Fully offline. Models only via local Ollama at `http://localhost:11434`. No cloud, no telemetry.
- Organs live in the **Timeline repo** (app data dir `loom/organs/<id>/`) — every write is a git commit. No backup folders.
- Organ id charset: `^[a-z0-9-]{1,32}$`. Organ files whitelist: exactly `manifest.json`, `organ.js`, `test.js`. Reject anything else (path traversal defense).
- Permission catalog (v1, exact strings): `storage`, `model`, `notify`. Manifest `permissions` must be a subset. Grants are kernel-only (`.granted` file written only by the `organ_grant` command; the model can never write it).
- An organ NEVER runs (host or sandbox result trusted) until the user approves its permissions. Auto-apply of a green build is safe because unapproved organs are inert.
- Validation gate order: manifest guard → sandbox (syntax via import, render smoke-test, model-authored tests) → only then write to disk. Nothing un-green ever touches disk.
- Sandbox: `<iframe sandbox="allow-scripts">`, srcdoc harness, postMessage protocol, **5000ms** timeout kill.
- One build at a time (queue rejects concurrent builds).
- Builder fallback chain: configured builder → **best installed coder model** (name contains "coder", largest parameter count) → rewriter.
- UI: navy `#060b18` tokens; no emojis in UI copy — words and icons only.
- DRY, YAGNI, TDD, frequent commits.

---

## File Structure

```
src-tauri/src/
├─ ollama.rs          # MODIFY: chat() gains ChatOpts (num_ctx, temperature)
├─ fleet.rs           # MODIFY: fleet_chat opts param; best_coder(); smarter fallback_for
├─ organs.rs          # CREATE: organ store (list/read/write/grant/delete) + timeline commit
└─ lib.rs             # MODIFY: mod organs; register commands
src/lib/
├─ core.ts            # MODIFY: fleetChat opts; organ command wrappers
├─ loom/edits.ts      # CREATE: extractCode/scrubFences/applyBlock/applyEditBlocks/spliceEntries (pure)
├─ loom/prompts.ts    # CREATE: ctxFor, ORGAN_CONTRACT doc, system prompts (single source)
├─ loom/plan.ts       # CREATE: deterministic new-organ plan; parseSteps for edits (pure)
├─ loom/validate.ts   # CREATE: manifestGuard + gate() orchestration (pure verdict logic)
├─ loom/sandbox.ts    # CREATE: iframe harness builder + runner (srcdoc, postMessage, timeout)
├─ loom/build.ts      # CREATE: build orchestrator — queue, state machine, log, apply
├─ organs/api.ts      # CREATE: makeLoomApi(organId, granted) — permission-gated injected API
└─ organs/host.tsx    # CREATE: OrganHost — load, error boundary, PermissionCard
src/components/
└─ LoomConsole.tsx    # CREATE: build surface — request input, live log, verdicts, rollback
src/selftest/
└─ loom.selftest.test.ts  # CREATE: real-model harness, env-gated (SELFTEST=1)
```

Responsibilities: `edits.ts` pure text ops only; `sandbox.ts` owns the iframe; `build.ts` owns orchestration/state; `organs.rs` owns disk+git; `api.ts` is the only capability the organ ever sees.

---

### Task 1: Rust chat options + smart builder fallback (+ TS wrapper)

**Files:**
- Modify: `src-tauri/src/ollama.rs`, `src-tauri/src/fleet.rs`, `src/lib/core.ts`, `src/lib/core.test.ts`

**Interfaces:**
- Consumes: existing `Ollama::chat`, `FleetConfig`, `fallback_for`, `fleetChat`.
- Produces:
  - Rust `pub struct ChatOpts { pub num_ctx: Option<u64>, pub temperature: Option<f32> }` (serde Deserialize+Default+Clone).
  - `Ollama::chat(&self, model, messages, keep_alive, timeout_ms, opts: &ChatOpts)`.
  - `fleet_chat(role: String, messages: Vec<Msg>, opts: Option<ChatOpts>)` Tauri command.
  - `pub fn best_coder(installed: &[String]) -> Option<String>` (pure) — models whose name contains `coder`, ranked by the largest number directly preceding `b` in the tag (e.g. `30b` → 30.0, `7b` → 7.0; no number → 0.0).
  - `pub fn fallback_for(cfg: &FleetConfig, role: &str, installed: &[String]) -> String` — builder → `best_coder` else rewriter; other roles → rewriter.
  - TS: `fleetChat(role, messages, opts?: { numCtx?: number; temperature?: number })` sending snake_case keys.

- [ ] **Step 1: Write the failing Rust tests**

In `src-tauri/src/fleet.rs` tests module, add:

```rust
#[test]
fn best_coder_prefers_largest_coder() {
    let installed = vec![
        "llama3.1:8b".to_string(),
        "qwen2.5-coder:7b".to_string(),
        "qwen3-coder:30b-a3b-q4_K_M".to_string(),
    ];
    assert_eq!(best_coder(&installed).unwrap(), "qwen3-coder:30b-a3b-q4_K_M");
    assert_eq!(best_coder(&["llama3.1:8b".to_string()]), None);
}

#[test]
fn builder_falls_back_to_installed_coder_then_rewriter() {
    let c = FleetConfig::default();
    let with_coder = vec!["qwen2.5-coder:7b".to_string()];
    assert_eq!(fallback_for(&c, "builder", &with_coder), "qwen2.5-coder:7b");
    let none: Vec<String> = vec![];
    assert_eq!(fallback_for(&c, "builder", &none), "qwen3:1.7b");
    assert_eq!(fallback_for(&c, "companion", &with_coder), "qwen3:1.7b");
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test fleet`
Expected: FAIL (`best_coder` undefined; `fallback_for` arity mismatch).

- [ ] **Step 3: Implement**

In `src-tauri/src/ollama.rs` add and thread through:

```rust
#[derive(serde::Deserialize, Default, Clone)]
pub struct ChatOpts { pub num_ctx: Option<u64>, pub temperature: Option<f32> }
```

Change `chat` signature to `pub async fn chat(&self, model: &str, messages: Vec<Msg>, keep_alive: i64, timeout_ms: u64, opts: &ChatOpts)` and build options as:

```rust
let mut options = serde_json::Map::new();
options.insert("temperature".into(), serde_json::json!(opts.temperature.unwrap_or(0.6)));
if let Some(n) = opts.num_ctx { options.insert("num_ctx".into(), serde_json::json!(n)); }
let body = serde_json::json!({
    "model": model, "messages": messages, "stream": false,
    "keep_alive": keep_alive, "options": options,
});
```

In `src-tauri/src/fleet.rs`:

```rust
pub fn best_coder(installed: &[String]) -> Option<String> {
    fn params(tag: &str) -> f32 {
        let lower = tag.to_lowercase();
        let bytes = lower.as_bytes();
        let mut best = 0.0f32;
        for (i, _) in lower.match_indices('b') {
            let mut j = i;
            while j > 0 && (bytes[j - 1].is_ascii_digit() || bytes[j - 1] == b'.') { j -= 1; }
            if j < i {
                if let Ok(v) = lower[j..i].parse::<f32>() { if v > best { best = v; } }
            }
        }
        best
    }
    installed.iter()
        .filter(|m| m.to_lowercase().contains("coder"))
        .max_by(|a, b| params(a).partial_cmp(&params(b)).unwrap_or(std::cmp::Ordering::Equal))
        .cloned()
}

pub fn fallback_for(c: &FleetConfig, role: &str, installed: &[String]) -> String {
    if role == "builder" {
        if let Some(m) = best_coder(installed) { return m; }
    }
    c.rewriter.clone()
}
```

Update `fleet_chat` to `pub async fn fleet_chat(role: String, messages: Vec<Msg>, opts: Option<ChatOpts>) -> Result<String, LoomError>`: use `let opts = opts.unwrap_or_default();`, pass `&opts` to every `o.chat(...)` call, and compute the fallback with the installed list: `let installed = o.tags().await.unwrap_or_default(); let fb = fallback_for(&cfg, &role, &installed);`. Update the old `falls_back_to_rewriter` test to the new arity (empty installed list).

- [ ] **Step 4: Run Rust tests to verify they pass**

Run: `cd src-tauri && cargo test`
Expected: PASS (all fleet + ollama + timeline tests; compiles clean).

- [ ] **Step 5: Update the TS wrapper + test**

In `src/lib/core.ts`:

```ts
export type ChatOpts = { numCtx?: number; temperature?: number };
export const fleetChat = (role: string, messages: Msg[], opts?: ChatOpts) =>
  invoke<string>("fleet_chat", {
    role, messages,
    opts: opts ? { num_ctx: opts.numCtx ?? null, temperature: opts.temperature ?? null } : null,
  });
```

In `src/lib/core.test.ts` update the `fleetChat` expectation:

```ts
it("fleetChat passes role, messages and snake_case opts", async () => {
  invoke.mockResolvedValue("hi");
  const out = await fleetChat("builder", [{ role: "user", content: "hey" }], { numCtx: 8192, temperature: 0.2 });
  expect(invoke).toHaveBeenCalledWith("fleet_chat", {
    role: "builder",
    messages: [{ role: "user", content: "hey" }],
    opts: { num_ctx: 8192, temperature: 0.2 },
  });
  expect(out).toBe("hi");
});
```

- [ ] **Step 6: Run the full check**

Run: `npm run check`
Expected: vitest PASS + cargo PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(core): chat options (num_ctx/temperature) + best-installed-coder builder fallback"
```

---

### Task 2: Rust organ store (files + git commit + kernel-only grants)

**Files:**
- Create: `src-tauri/src/organs.rs`
- Modify: `src-tauri/src/lib.rs` (`mod organs;` + register commands)

**Interfaces:**
- Consumes: `timeline::{ensure_repo, commit_all}`, `LoomError`.
- Produces (pure fns on a root path + Tauri commands over the app data dir):
  - `pub struct OrganFile { pub name: String, pub content: String }` (serde both ways)
  - `pub struct OrganEntry { pub id: String, pub manifest: String, pub granted: Option<String> }` (Serialize)
  - `pub fn valid_id(id: &str) -> bool` — `^[a-z0-9-]{1,32}$`
  - `pub fn write_organ(root: &Path, id: &str, files: &[OrganFile]) -> Result<(), LoomError>` — rejects invalid id, rejects any file name not in `{manifest.json, organ.js, test.js}`, writes under `root/organs/<id>/`
  - `pub fn list_organs(root: &Path) -> Result<Vec<OrganEntry>, LoomError>` — reads each organ dir's manifest.json + optional `.granted`
  - `pub fn read_organ_file(root: &Path, id: &str, name: &str) -> Result<String, LoomError>`
  - `pub fn grant(root: &Path, id: &str, granted_json: &str) -> Result<(), LoomError>` — writes `.granted`
  - `pub fn delete_organ(root: &Path, id: &str) -> Result<(), LoomError>`
  - Tauri commands (each ends with `timeline::commit_all(&dir, msg)` where dir is the timeline repo root): `organ_write(id, files, message)` → returns commit sha, `organ_list()`, `organ_read(id, name)`, `organ_grant(id, granted_json)`, `organ_delete(id)`.

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/organs.rs` with stubs (`unimplemented!()`) for the pure fns and this tests module:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::timeline;

    #[test]
    fn id_validation() {
        assert!(valid_id("run-tracker"));
        assert!(valid_id("a1"));
        assert!(!valid_id("Run"));           // uppercase
        assert!(!valid_id("../evil"));       // traversal
        assert!(!valid_id(""));
        assert!(!valid_id(&"x".repeat(33))); // too long
    }

    #[test]
    fn write_list_read_grant_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        timeline::ensure_repo(root).unwrap();
        let files = vec![
            OrganFile { name: "manifest.json".into(), content: r#"{"id":"runs","permissions":["storage"]}"#.into() },
            OrganFile { name: "organ.js".into(), content: "export default {}".into() },
            OrganFile { name: "test.js".into(), content: "export const tests = []".into() },
        ];
        write_organ(root, "runs", &files).unwrap();
        let sha = timeline::commit_all(root, "organ: runs").unwrap();
        assert_ne!(sha, "nochange");

        let listed = list_organs(root).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "runs");
        assert!(listed[0].manifest.contains("storage"));
        assert!(listed[0].granted.is_none());

        grant(root, "runs", r#"["storage"]"#).unwrap();
        assert_eq!(list_organs(root).unwrap()[0].granted.as_deref(), Some(r#"["storage"]"#));

        assert_eq!(read_organ_file(root, "runs", "organ.js").unwrap(), "export default {}");
        delete_organ(root, "runs").unwrap();
        assert!(list_organs(root).unwrap().is_empty());
    }

    #[test]
    fn rejects_bad_ids_and_filenames() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        timeline::ensure_repo(root).unwrap();
        let evil_name = vec![OrganFile { name: "../../escape.js".into(), content: "x".into() }];
        assert!(write_organ(root, "ok-id", &evil_name).is_err());
        let ok_files = vec![OrganFile { name: "organ.js".into(), content: "x".into() }];
        assert!(write_organ(root, "../evil", &ok_files).is_err());
        assert!(read_organ_file(root, "ok-id", ".granted").is_err()); // .granted not readable as organ file
    }
}
```

Add `mod organs;` to `src-tauri/src/lib.rs`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test organs`
Expected: FAIL (unimplemented).

- [ ] **Step 3: Implement**

```rust
use crate::error::LoomError;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Serialize, Deserialize, Clone)]
pub struct OrganFile { pub name: String, pub content: String }

#[derive(Serialize)]
pub struct OrganEntry { pub id: String, pub manifest: String, pub granted: Option<String> }

const ALLOWED: [&str; 3] = ["manifest.json", "organ.js", "test.js"];

pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 32
        && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn organ_dir(root: &Path, id: &str) -> Result<std::path::PathBuf, LoomError> {
    if !valid_id(id) { return Err(LoomError::Parse(format!("invalid organ id: {id}"))); }
    Ok(root.join("organs").join(id))
}

pub fn write_organ(root: &Path, id: &str, files: &[OrganFile]) -> Result<(), LoomError> {
    let dir = organ_dir(root, id)?;
    for f in files {
        if !ALLOWED.contains(&f.name.as_str()) {
            return Err(LoomError::Parse(format!("file not allowed: {}", f.name)));
        }
    }
    std::fs::create_dir_all(&dir).map_err(|e| LoomError::Git(e.to_string()))?;
    for f in files {
        std::fs::write(dir.join(&f.name), &f.content).map_err(|e| LoomError::Git(e.to_string()))?;
    }
    Ok(())
}

pub fn list_organs(root: &Path) -> Result<Vec<OrganEntry>, LoomError> {
    let organs = root.join("organs");
    let mut out = vec![];
    if !organs.exists() { return Ok(out); }
    let rd = std::fs::read_dir(&organs).map_err(|e| LoomError::Git(e.to_string()))?;
    for entry in rd.flatten() {
        let id = entry.file_name().to_string_lossy().to_string();
        if !valid_id(&id) { continue; }
        let manifest = match std::fs::read_to_string(entry.path().join("manifest.json")) {
            Ok(m) => m, Err(_) => continue,
        };
        let granted = std::fs::read_to_string(entry.path().join(".granted")).ok();
        out.push(OrganEntry { id, manifest, granted });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

pub fn read_organ_file(root: &Path, id: &str, name: &str) -> Result<String, LoomError> {
    if !ALLOWED.contains(&name) { return Err(LoomError::Parse(format!("file not allowed: {name}"))); }
    let dir = organ_dir(root, id)?;
    std::fs::read_to_string(dir.join(name)).map_err(|e| LoomError::NotFound(format!("{id}/{name}: {e}")))
}

pub fn grant(root: &Path, id: &str, granted_json: &str) -> Result<(), LoomError> {
    let dir = organ_dir(root, id)?;
    if !dir.exists() { return Err(LoomError::NotFound(id.into())); }
    std::fs::write(dir.join(".granted"), granted_json).map_err(|e| LoomError::Git(e.to_string()))
}

pub fn delete_organ(root: &Path, id: &str) -> Result<(), LoomError> {
    let dir = organ_dir(root, id)?;
    if dir.exists() { std::fs::remove_dir_all(&dir).map_err(|e| LoomError::Git(e.to_string()))?; }
    Ok(())
}
```

Then the Tauri commands (same file). Reuse the app-data-dir helper pattern from `timeline.rs` — extract it once: in `timeline.rs` make `pub(crate) fn loom_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, LoomError>` (change visibility from private) and import it here:

```rust
use crate::timeline::{self, loom_dir};

#[tauri::command]
pub fn organ_write(app: tauri::AppHandle, id: String, files: Vec<OrganFile>, message: String)
    -> Result<String, LoomError> {
    let root = loom_dir(&app)?;
    timeline::ensure_repo(&root)?;
    write_organ(&root, &id, &files)?;
    timeline::commit_all(&root, &message)
}

#[tauri::command]
pub fn organ_list(app: tauri::AppHandle) -> Result<Vec<OrganEntry>, LoomError> {
    list_organs(&loom_dir(&app)?)
}

#[tauri::command]
pub fn organ_read(app: tauri::AppHandle, id: String, name: String) -> Result<String, LoomError> {
    read_organ_file(&loom_dir(&app)?, &id, &name)
}

#[tauri::command]
pub fn organ_grant(app: tauri::AppHandle, id: String, granted_json: String) -> Result<String, LoomError> {
    let root = loom_dir(&app)?;
    grant(&root, &id, &granted_json)?;
    timeline::commit_all(&root, &format!("grant: {id}"))
}

#[tauri::command]
pub fn organ_delete(app: tauri::AppHandle, id: String) -> Result<String, LoomError> {
    let root = loom_dir(&app)?;
    delete_organ(&root, &id)?;
    timeline::commit_all(&root, &format!("delete organ: {id}"))
}
```

Register all five in `lib.rs` `generate_handler!`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test`
Expected: PASS (all crate tests).

- [ ] **Step 5: Add TS wrappers + test**

In `src/lib/core.ts`:

```ts
export type OrganFile = { name: string; content: string };
export type OrganEntry = { id: string; manifest: string; granted: string | null };

export const organWrite = (id: string, files: OrganFile[], message: string) =>
  invoke<string>("organ_write", { id, files, message });
export const organList = () => invoke<OrganEntry[]>("organ_list");
export const organRead = (id: string, name: string) => invoke<string>("organ_read", { id, name });
export const organGrant = (id: string, grantedJson: string) =>
  invoke<string>("organ_grant", { id, grantedJson });
export const organDelete = (id: string) => invoke<string>("organ_delete", { id });
```

Add to `src/lib/core.test.ts`:

```ts
it("organWrite passes id, files and message", async () => {
  invoke.mockResolvedValue("abc123");
  const files = [{ name: "organ.js", content: "export default {}" }];
  const sha = await organWrite("runs", files, "organ: runs");
  expect(invoke).toHaveBeenCalledWith("organ_write", { id: "runs", files, message: "organ: runs" });
  expect(sha).toBe("abc123");
});
```

- [ ] **Step 6: Run the full check + commit**

Run: `npm run check` → all PASS.

```bash
git add -A
git commit -m "feat(core): organ store — whitelisted files, git commits, kernel-only grants"
```

---

### Task 3: Pure edit engine (`edits.ts`) — EMBER's proven logic, upgraded to TS

**Files:**
- Create: `src/lib/loom/edits.ts`
- Test: `src/lib/loom/edits.test.ts`

**Interfaces:**
- Produces (all pure):
  - `extractCode(s: string): string` — strips fences even when the closing fence is truncated (the bug that corrupted EMBER's kb.js); handles inner fences; never returns a string starting/ending with a fence.
  - `scrubFences(s: string): string` — last-resort guard.
  - `applyBlock(text: string, search: string, replace: string): string | null` — exact match, then whitespace-tolerant line match; empty search = append.
  - `applyEditBlocks(base: string, raw: string): string | null` — parses `<<<<<<< SEARCH / ======= / >>>>>>> REPLACE` blocks; `null` when no blocks; throws when a SEARCH doesn't match.
  - `spliceEntries(base: string, varName: string, raw: string): string` — cleans a model snippet (prose, fences, `const X = [` wrapping, missing trailing comma), validates it as array elements via `new Function`, splices after `const <varName> = [`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/loom/edits.test.ts` (these are EMBER's battle-tested cases, ported):

```ts
import { describe, it, expect } from "vitest";
import { extractCode, scrubFences, applyBlock, applyEditBlocks, spliceEntries } from "./edits";

describe("extractCode", () => {
  it("strips a clean fenced block", () => {
    expect(extractCode("```javascript\nconst a = 1;\n```")).toBe("const a = 1;");
  });
  it("strips a TRUNCATED closing fence (the kb.js corruption bug)", () => {
    expect(extractCode("```javascript\nconst a = 1;")).toBe("const a = 1;");
  });
  it("extracts an inner fenced block from prose", () => {
    expect(extractCode("Here you go:\n```js\nconst a = 1;\n```\nDone.")).toBe("const a = 1;");
  });
  it("passes through unfenced code", () => {
    expect(extractCode("const a = 1;")).toBe("const a = 1;");
  });
});

describe("applyEditBlocks", () => {
  const file = "function greet(name) {\n  const msg = \"hi \" + name;\n  return msg;\n}\n";
  it("applies an exact-match replace", () => {
    const raw = "<<<<<<< SEARCH\n  const msg = \"hi \" + name;\n=======\n  const msg = \"hello \" + name;\n>>>>>>> REPLACE";
    expect(applyEditBlocks(file, raw)).toContain("hello ");
  });
  it("tolerates whitespace drift in SEARCH", () => {
    const raw = "<<<<<<< SEARCH\nconst msg = \"hi \" + name;\n=======\n  const msg = \"hey \" + name;\n>>>>>>> REPLACE";
    expect(applyEditBlocks(file, raw)).toContain("hey ");
  });
  it("adds lines by repeating an anchor line", () => {
    const raw = "<<<<<<< SEARCH\n  return msg;\n=======\n  console.log(msg);\n  return msg;\n>>>>>>> REPLACE";
    const out = applyEditBlocks(file, raw)!;
    expect(out).toContain("console.log(msg);");
    expect(out).toContain("return msg;");
  });
  it("throws when SEARCH does not match", () => {
    const raw = "<<<<<<< SEARCH\nnot in file\n=======\nx\n>>>>>>> REPLACE";
    expect(() => applyEditBlocks(file, raw)).toThrow();
  });
  it("returns null when there are no blocks", () => {
    expect(applyEditBlocks(file, "here is the whole file...")).toBeNull();
  });
  it("applies two blocks in sequence and stays valid JS", () => {
    const raw =
      "<<<<<<< SEARCH\n  const msg = \"hi \" + name;\n=======\n  const msg = \"hello \" + name;\n>>>>>>> REPLACE\n\n" +
      "<<<<<<< SEARCH\nfunction greet(name) {\n=======\n// greet a user\nfunction greet(name) {\n>>>>>>> REPLACE";
    const out = applyEditBlocks(file, raw)!;
    expect(() => new Function(out)).not.toThrow();
    expect(out).toContain("// greet a user");
  });
});

describe("spliceEntries", () => {
  const kb = "const ITEMS = [\n{ id: \"old\" },\n];\n";
  it("splices messy fenced prose output with trailing comma", () => {
    const raw = "Here you go:\n```javascript\n{ id: \"new1\" },\n{ id: \"new2\" },\n```";
    const out = spliceEntries(kb, "ITEMS", raw);
    expect(() => new Function(out)).not.toThrow();
    expect(out).toContain("new1");
    expect(out).toContain("old");
  });
  it("handles the model wrongly wrapping in const X = [...]", () => {
    const raw = "```\nconst ITEMS = [\n{ id: \"a\" }\n];\n```";
    const out = spliceEntries(kb, "ITEMS", raw);
    expect(out).toContain("\"a\"");
    expect(out).toContain("old");
  });
  it("throws on invalid entry syntax", () => {
    expect(() => spliceEntries(kb, "ITEMS", "{ id: \"broken\", ")).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/lib/loom/edits.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `src/lib/loom/edits.ts`**

```ts
export function extractCode(s: string): string {
  let t = (s || "").trim();
  const open = t.match(/^```[a-zA-Z0-9]*[ \t]*\r?\n/);
  if (open) {
    t = t.slice(open[0].length);
    t = t.replace(/\r?\n?```[a-zA-Z0-9]*[ \t]*$/, "");
  } else {
    const inner = t.match(/```[a-zA-Z0-9]*[ \t]*\r?\n([\s\S]*?)```/);
    if (inner) t = inner[1];
  }
  t = t.replace(/^```[a-zA-Z0-9]*[ \t]*\r?\n/, "").replace(/\r?\n?```[a-zA-Z0-9]*[ \t]*$/, "");
  return t.replace(/\s+$/, "");
}

export function scrubFences(t: string): string {
  return String(t ?? "")
    .replace(/^\s*```[a-zA-Z0-9]*[ \t]*\r?\n/, "")
    .replace(/\r?\n?```[a-zA-Z0-9]*[ \t]*\s*$/, "");
}

export function applyBlock(text: string, search: string, replace: string): string | null {
  if (search === "") return text.replace(/\n?$/, "") + "\n" + replace + "\n";
  if (text.includes(search)) return text.replace(search, replace);
  const T = text.split("\n");
  const S = search.split("\n").map((l) => l.trim());
  while (S.length && S[S.length - 1] === "") S.pop();
  while (S.length && S[0] === "") S.shift();
  if (!S.length) return null;
  for (let i = 0; i + S.length <= T.length; i++) {
    let ok = true;
    for (let j = 0; j < S.length; j++) if (T[i + j].trim() !== S[j]) { ok = false; break; }
    if (ok) return [...T.slice(0, i), ...replace.split("\n"), ...T.slice(i + S.length)].join("\n");
  }
  return null;
}

export function applyEditBlocks(base: string, raw: string): string | null {
  const re = /<{5,}\s*SEARCH\s*\r?\n([\s\S]*?)\r?\n?={5,}\s*\r?\n([\s\S]*?)\r?\n?>{5,}\s*REPLACE/g;
  const blocks = [...raw.matchAll(re)];
  if (!blocks.length) return null;
  let text = base;
  for (const b of blocks) {
    const applied = applyBlock(text, b[1].replace(/\r/g, ""), b[2].replace(/\r/g, ""));
    if (applied == null) throw new Error("an edit block's SEARCH text was not found in the file");
    text = applied;
  }
  return text;
}

export function spliceEntries(base: string, varName: string, raw: string): string {
  let snip = extractCode(raw).trim();
  snip = snip.replace(/^[^[{]*/, "");
  snip = snip.replace(/^(?:const|let|var)\s+\w+\s*=\s*/, "").replace(/;?\s*$/, "");
  snip = snip.replace(/^\[/, "").replace(/\]$/, "").trim();
  if (!snip) throw new Error("the model returned no new entries");
  if (!snip.endsWith(",")) snip += ",";
  new Function("return [\n" + snip + "\n]"); // throws on invalid entries
  const m = base.match(new RegExp("(?:const|let|var)\\s+" + varName + "\\s*=\\s*\\["));
  if (!m || m.index === undefined) throw new Error("could not find the " + varName + " array");
  const at = m.index + m[0].length;
  return base.slice(0, at) + "\n" + snip + "\n" + base.slice(at);
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/lib/loom/edits.test.ts` → PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/lib/loom/edits.ts src/lib/loom/edits.test.ts
git commit -m "feat(loom): pure edit engine — extract, edit-blocks, append-splice (EMBER-proven, TS)"
```

---

### Task 4: Prompts + planning (`prompts.ts`, `plan.ts`)

**Files:**
- Create: `src/lib/loom/prompts.ts`, `src/lib/loom/plan.ts`
- Test: `src/lib/loom/plan.test.ts`, `src/lib/loom/prompts.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `ctxFor(chars: number): number` — `min(32768, max(8192, ceil((chars*2/3.3 + 3000)/2048)*2048))`.
  - `PERMISSIONS = ["storage", "model", "notify"] as const`.
  - `ORGAN_CONTRACT: string` — the organ authoring contract given to the builder (see Step 3; it is the single source of truth for what an organ is).
  - `organSystemPrompt(kind: "manifest" | "code" | "tests" | "edit"): string`.
  - `newOrganPlan(request: string): { kind: "new"; steps: ["manifest", "code", "tests"] }` — deterministic; no LLM.
  - `parseSteps(raw: string, validFiles: string[]): { file: string; step: string }[]` — for EDITS of an existing organ; tolerant JSON extraction (fenced, bracket-scan, path-mention fallback), max 6 steps.

- [ ] **Step 1: Write the failing tests**

`src/lib/loom/prompts.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ctxFor, ORGAN_CONTRACT, PERMISSIONS } from "./prompts";

describe("ctxFor", () => {
  it("floors at 8192 and caps at 32768, stepping by 2048", () => {
    expect(ctxFor(900)).toBe(8192);
    expect(ctxFor(46000)).toBe(32768);
    expect(ctxFor(90000)).toBe(32768);
    expect(ctxFor(20000) % 2048).toBe(0);
  });
});

describe("contract", () => {
  it("documents the organ files and permission catalog", () => {
    for (const f of ["manifest.json", "organ.js", "test.js"]) expect(ORGAN_CONTRACT).toContain(f);
    for (const p of PERMISSIONS) expect(ORGAN_CONTRACT).toContain(p);
    expect(ORGAN_CONTRACT).toContain("export default");
  });
});
```

`src/lib/loom/plan.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { newOrganPlan, parseSteps } from "./plan";

describe("newOrganPlan", () => {
  it("is deterministic: manifest then code then tests", () => {
    expect(newOrganPlan("track my runs").steps).toEqual(["manifest", "code", "tests"]);
  });
});

describe("parseSteps", () => {
  const valid = ["manifest.json", "organ.js", "test.js"];
  it("parses fenced JSON steps", () => {
    const raw = '```json\n[{"file":"organ.js","step":"add a delete button"}]\n```';
    expect(parseSteps(raw, valid)).toEqual([{ file: "organ.js", step: "add a delete button" }]);
  });
  it("parses bare JSON inside prose", () => {
    const raw = 'Plan:\n[{"file":"organ.js","step":"x"},{"file":"test.js","step":"y"}]\nok';
    expect(parseSteps(raw, valid)).toHaveLength(2);
  });
  it("drops steps naming invalid files and caps at 6", () => {
    const steps = Array.from({ length: 9 }, (_, i) => ({ file: i % 2 ? "organ.js" : "evil.js", step: "s" + i }));
    const out = parseSteps(JSON.stringify(steps), valid);
    expect(out.length).toBeLessThanOrEqual(6);
    expect(out.every((s) => s.file === "organ.js")).toBe(true);
  });
  it("returns [] on garbage", () => {
    expect(parseSteps("no json here", valid)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/lib/loom` → new tests FAIL.

- [ ] **Step 3: Implement**

`src/lib/loom/prompts.ts`:

```ts
export const PERMISSIONS = ["storage", "model", "notify"] as const;
export type Permission = (typeof PERMISSIONS)[number];

export function ctxFor(chars: number): number {
  const tokens = Math.ceil((chars * 2) / 3.3) + 3000;
  return Math.min(32768, Math.max(8192, Math.ceil(tokens / 2048) * 2048));
}

export const ORGAN_CONTRACT = `An ORGAN is a small self-contained tool inside LOOM, made of exactly three files:

1. manifest.json — {"id": "<kebab-case>", "name": "<Display Name>", "description": "<one line>", "version": 1, "permissions": [...]}
   Allowed permissions (request ONLY what the organ truly needs): "storage" (persistent key-value store), "model" (chat with the local model), "notify" (show a notification).

2. organ.js — an ES module:
   export default {
     id: "<same id>",
     render(el, loom) {
       // el: the organ's root HTMLElement (render all UI inside it)
       // loom.storage.get(key, fallback) / loom.storage.set(key, value) / loom.storage.del(key)  [needs "storage"]
       // await loom.model.chat([{role:"user",content:"..."}]) -> string                            [needs "model"]
       // loom.ui.tokens -> { bg, panel, t1, t2, t3, accent, go, warn, danger }  (CSS color strings)
       // loom.notify(text)                                                                          [needs "notify"]
     }
   }
   Style with inline styles using loom.ui.tokens. No external imports, no network, no document.cookie, no window.top.

3. test.js — an ES module:
   export const tests = [
     { name: "renders without crashing", fn: async ({ el, loom, assert }) => { /* ... */ } },
   ];
   Each fn gets a fresh el (organ already rendered into it), a mock loom api, and assert(cond, msg).

Rules: complete files only, no placeholders or TODOs; small and focused; real functionality, never filler.`;

export function organSystemPrompt(kind: "manifest" | "code" | "tests" | "edit"): string {
  const base = `You are the Loom, the build engine inside LOOM, a sovereign offline computer. You write organs.\n\n${ORGAN_CONTRACT}\n\nOutput ONLY the requested file content in a single fenced code block. No prose before or after.`;
  switch (kind) {
    case "manifest": return base + `\nNow output manifest.json only. Choose a short kebab-case id and the MINIMAL permissions the request needs.`;
    case "code": return base + `\nNow output organ.js only. It must match the manifest's id and only use APIs its permissions allow.`;
    case "tests": return base + `\nNow output test.js only: 2-4 meaningful tests that verify the organ's real behavior (not trivial truths).`;
    case "edit": return base + `\nYou are EDITING one existing file. Output ONLY SEARCH/REPLACE edit blocks in this exact format (no prose, no full file):\n<<<<<<< SEARCH\n(lines copied exactly from the current file)\n=======\n(replacement lines)\n>>>>>>> REPLACE`;
  }
}
```

`src/lib/loom/plan.ts`:

```ts
export function newOrganPlan(_request: string): { kind: "new"; steps: ["manifest", "code", "tests"] } {
  return { kind: "new", steps: ["manifest", "code", "tests"] };
}

export function parseSteps(raw: string, validFiles: string[]): { file: string; step: string }[] {
  let arr: unknown = null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const src = fenced ? fenced[1] : raw;
  try { arr = JSON.parse(src); } catch {
    const bracket = src.match(/\[[\s\S]*\]/);
    if (bracket) { try { arr = JSON.parse(bracket[0]); } catch { /* fall through */ } }
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((x): x is { file: string; step: string } =>
      !!x && typeof (x as { file?: unknown }).file === "string" && typeof (x as { step?: unknown }).step === "string")
    .map((x) => ({ file: x.file.trim(), step: x.step.slice(0, 240) }))
    .filter((x) => validFiles.includes(x.file))
    .slice(0, 6);
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/lib/loom` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/loom/prompts.ts src/lib/loom/plan.ts src/lib/loom/prompts.test.ts src/lib/loom/plan.test.ts
git commit -m "feat(loom): organ contract, prompts, deterministic-first planning"
```

---

### Task 5: Validation gate + sandboxed iframe (`validate.ts`, `sandbox.ts`)

**Files:**
- Create: `src/lib/loom/validate.ts`, `src/lib/loom/sandbox.ts`
- Test: `src/lib/loom/validate.test.ts`

**Interfaces:**
- Consumes: `PERMISSIONS` from prompts.ts.
- Produces:
  - `manifestGuard(manifestRaw: string, expectedId?: string): { ok: true; manifest: OrganManifest } | { ok: false; error: string }` where `OrganManifest = { id: string; name: string; description: string; version: number; permissions: string[] }`. Checks: valid JSON, required fields, id matches `^[a-z0-9-]{1,32}$` (and equals expectedId when given), permissions ⊆ catalog.
  - `buildHarnessSrc(files: { manifest: string; code: string; tests: string }, nonce: string): string` — the iframe srcdoc: imports organ.js from a blob, renders into a detached div with a mock `loom` api, runs `tests` from test.js, `parent.postMessage({ nonce, ok, stage, errors, testResults }, "*")`. Any uncaught error or unhandled rejection posts a failure.
  - `sandboxRun(files, timeoutMs = 5000): Promise<SandboxVerdict>` where `SandboxVerdict = { ok: boolean; stage: "load" | "render" | "tests" | "timeout" | "pass"; errors: string[]; testResults: { name: string; ok: boolean; error?: string }[] }`. Creates `<iframe sandbox="allow-scripts">`, waits for the nonce'd message, removes the iframe, times out to `{ ok: false, stage: "timeout" ... }`.
  - `gate(files, expectedId?): Promise<{ ok: boolean; manifest?: OrganManifest; verdict?: SandboxVerdict; error?: string }>` — manifestGuard first, then sandboxRun; short-circuits on manifest failure.

- [ ] **Step 1: Write the failing tests** (pure parts — the live iframe is exercised in the app and selftest; jsdom cannot execute iframes)

`src/lib/loom/validate.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { manifestGuard } from "./validate";
import { buildHarnessSrc } from "./sandbox";

describe("manifestGuard", () => {
  const good = JSON.stringify({ id: "runs", name: "Runs", description: "d", version: 1, permissions: ["storage"] });
  it("accepts a valid manifest", () => {
    const r = manifestGuard(good);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.id).toBe("runs");
  });
  it("rejects invalid JSON, bad ids, unknown permissions, and id mismatch", () => {
    expect(manifestGuard("{not json").ok).toBe(false);
    expect(manifestGuard(JSON.stringify({ id: "Bad Id", name: "x", description: "d", version: 1, permissions: [] })).ok).toBe(false);
    expect(manifestGuard(JSON.stringify({ id: "ok", name: "x", description: "d", version: 1, permissions: ["filesystem"] })).ok).toBe(false);
    expect(manifestGuard(good, "other-id").ok).toBe(false);
  });
  it("rejects missing required fields", () => {
    expect(manifestGuard(JSON.stringify({ id: "ok", permissions: [] })).ok).toBe(false);
  });
});

describe("buildHarnessSrc", () => {
  it("embeds the nonce, both modules, and the postMessage report", () => {
    const src = buildHarnessSrc({ manifest: "{}", code: "export default {render(){}}", tests: "export const tests = []" }, "n0nce");
    expect(src).toContain("n0nce");
    expect(src).toContain("postMessage");
    expect(src).toContain("Blob");
    expect(src).toContain("unhandledrejection");
  });
});
```

- [ ] **Step 2: Run to verify failure** — modules missing → FAIL.

- [ ] **Step 3: Implement**

`src/lib/loom/validate.ts`:

```ts
import { PERMISSIONS } from "./prompts";
import { sandboxRun, type SandboxVerdict, type OrganFilesIn } from "./sandbox";

export type OrganManifest = { id: string; name: string; description: string; version: number; permissions: string[] };

const ID_RE = /^[a-z0-9-]{1,32}$/;

export function manifestGuard(manifestRaw: string, expectedId?: string):
  { ok: true; manifest: OrganManifest } | { ok: false; error: string } {
  let m: unknown;
  try { m = JSON.parse(manifestRaw); } catch (e) { return { ok: false, error: "manifest is not valid JSON: " + String(e) }; }
  const man = m as Partial<OrganManifest>;
  for (const field of ["id", "name", "description", "version", "permissions"] as const) {
    if (man[field] === undefined || man[field] === null) return { ok: false, error: `manifest missing "${field}"` };
  }
  if (typeof man.id !== "string" || !ID_RE.test(man.id)) return { ok: false, error: `invalid organ id: ${String(man.id)}` };
  if (expectedId && man.id !== expectedId) return { ok: false, error: `manifest id "${man.id}" does not match expected "${expectedId}"` };
  if (!Array.isArray(man.permissions)) return { ok: false, error: "permissions must be an array" };
  for (const p of man.permissions) {
    if (!(PERMISSIONS as readonly string[]).includes(p)) return { ok: false, error: `unknown permission: ${String(p)}` };
  }
  return { ok: true, manifest: man as OrganManifest };
}

export async function gate(files: OrganFilesIn, expectedId?: string):
  Promise<{ ok: boolean; manifest?: OrganManifest; verdict?: SandboxVerdict; error?: string }> {
  const mg = manifestGuard(files.manifest, expectedId);
  if (!mg.ok) return { ok: false, error: mg.error };
  const verdict = await sandboxRun(files);
  return { ok: verdict.ok, manifest: mg.manifest, verdict };
}
```

`src/lib/loom/sandbox.ts`:

```ts
export type OrganFilesIn = { manifest: string; code: string; tests: string };
export type SandboxVerdict = {
  ok: boolean;
  stage: "load" | "render" | "tests" | "timeout" | "pass";
  errors: string[];
  testResults: { name: string; ok: boolean; error?: string }[];
};

export function buildHarnessSrc(files: OrganFilesIn, nonce: string): string {
  // The harness runs INSIDE a sandboxed iframe. It loads organ.js and test.js from
  // blob URLs, renders the organ into a detached div with a MOCK loom api, runs the
  // tests, and posts one result message keyed by the nonce. Any uncaught error or
  // unhandled rejection fails the run.
  const codeB64 = btoa(unescape(encodeURIComponent(files.code)));
  const testsB64 = btoa(unescape(encodeURIComponent(files.tests)));
  return `<!doctype html><meta charset="utf-8"><body><script type="module">
const NONCE = ${JSON.stringify(nonce)};
const report = (r) => parent.postMessage(Object.assign({ nonce: NONCE }, r), "*");
const fail = (stage, msg) => report({ ok: false, stage, errors: [String(msg)], testResults: [] });
addEventListener("error", (e) => fail("load", e.message));
addEventListener("unhandledrejection", (e) => fail("load", e.reason));
const mockLoom = {
  storage: { _m: new Map(), get(k, f) { return this._m.has(k) ? this._m.get(k) : f; }, set(k, v) { this._m.set(k, v); }, del(k) { this._m.delete(k); } },
  model: { chat: async () => "(model unavailable in sandbox)" },
  ui: { tokens: { bg: "#060b18", panel: "#0d1424", t1: "#e8edf7", t2: "#9fb0cc", t3: "#5f6f8c", accent: "#f59e0b", go: "#4ade80", warn: "#fbbf24", danger: "#f87171" } },
  notify: () => {},
};
const modUrl = (b64) => URL.createObjectURL(new Blob([decodeURIComponent(escape(atob(b64)))], { type: "text/javascript" }));
try {
  const organ = (await import(modUrl("${codeB64}"))).default;
  if (!organ || typeof organ.render !== "function") { fail("load", "organ.js has no default export with a render() function"); }
  else {
    const el = document.createElement("div");
    try { await organ.render(el, mockLoom); } catch (e) { fail("render", e && e.message || e); throw e; }
    let tests = [];
    try { tests = (await import(modUrl("${testsB64}"))).tests || []; } catch (e) { fail("tests", "test.js failed to load: " + (e && e.message || e)); throw e; }
    const results = [];
    for (const t of tests) {
      const tEl = document.createElement("div");
      try { await organ.render(tEl, mockLoom); } catch { /* render already verified */ }
      const assert = (cond, msg) => { if (!cond) throw new Error(msg || "assertion failed"); };
      try { await t.fn({ el: tEl, loom: mockLoom, assert }); results.push({ name: t.name, ok: true }); }
      catch (e) { results.push({ name: t.name, ok: false, error: String(e && e.message || e) }); }
    }
    const allOk = results.every((r) => r.ok);
    report({ ok: allOk, stage: allOk ? "pass" : "tests", errors: allOk ? [] : results.filter((r) => !r.ok).map((r) => r.name + ": " + r.error), testResults: results });
  }
} catch (e) { /* already reported */ }
</${"script"}>`;
}

export function sandboxRun(files: OrganFilesIn, timeoutMs = 5000): Promise<SandboxVerdict> {
  return new Promise((resolve) => {
    const nonce = Math.random().toString(36).slice(2);
    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.style.display = "none";
    let done = false;
    const finish = (v: SandboxVerdict) => {
      if (done) return;
      done = true;
      window.removeEventListener("message", onMsg);
      iframe.remove();
      resolve(v);
    };
    const onMsg = (e: MessageEvent) => {
      if (!e.data || e.data.nonce !== nonce) return;
      finish({ ok: !!e.data.ok, stage: e.data.stage, errors: e.data.errors ?? [], testResults: e.data.testResults ?? [] });
    };
    window.addEventListener("message", onMsg);
    setTimeout(() => finish({ ok: false, stage: "timeout", errors: [`sandbox timed out after ${timeoutMs}ms`], testResults: [] }), timeoutMs);
    iframe.srcdoc = buildHarnessSrc(files, nonce);
    document.body.appendChild(iframe);
  });
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/lib/loom/validate.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/loom/validate.ts src/lib/loom/sandbox.ts src/lib/loom/validate.test.ts
git commit -m "feat(loom): validation gate — manifest guard + sandboxed-iframe smoke-test with kill timeout"
```

---

### Task 6: Organ Host + permission-gated API (`api.ts`, `host.tsx`)

**Files:**
- Create: `src/lib/organs/api.ts`, `src/lib/organs/host.tsx`
- Test: `src/lib/organs/host.test.tsx`
- Modify: `src/App.tsx` (mount `<OrganHost/>` under the StatusPanel)

**Interfaces:**
- Consumes: `organList`, `organRead`, `organGrant`, `fleetChat` from core.ts; `manifestGuard` from validate.ts.
- Produces:
  - `makeLoomApi(organId: string, granted: string[], deps?: { chat?: typeof fleetChat; notify?: (t: string) => void })` — returns the injected api. Ungranted capabilities exist but **throw** `new Error('permission "<p>" not granted')` when called (so organs fail loudly, not mysteriously). `storage` namespaced to `localStorage` key prefix `organ.<id>.`; `model.chat` calls companion role; `ui.tokens` always available.
  - `<OrganHost/>` — lists organs; for each: if manifest permissions ⊆ granted → hot-load `organ.js` via blob-URL dynamic import and `render(el, api)` inside an error boundary card; else → `<PermissionCard>` listing requested permissions with an Approve button calling `organGrant(id, JSON.stringify(manifest.permissions))` then reloading.
  - Every organ card shows name + description; a crashed organ shows the error message in the card (never propagates).

- [ ] **Step 1: Write the failing tests**

`src/lib/organs/host.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { makeLoomApi } from "./api";
import OrganHost from "./host";

beforeEach(() => { invoke.mockReset(); localStorage.clear(); });

describe("makeLoomApi", () => {
  it("namespaces storage and enforces grants", () => {
    const api = makeLoomApi("runs", ["storage"]);
    api.storage.set("count", 3);
    expect(JSON.parse(localStorage.getItem("organ.runs.count")!)).toBe(3);
    expect(api.storage.get("count", 0)).toBe(3);
    await expect(api.model.chat([{ role: "user", content: "x" }])).rejects.toThrow(/not granted/);
  });
  it("model.chat routes to the companion when granted", async () => {
    const chat = vi.fn().mockResolvedValue("hello");
    const api = makeLoomApi("runs", ["model"], { chat });
    await expect(api.model.chat([{ role: "user", content: "x" }])).resolves.toBe("hello");
    expect(chat).toHaveBeenCalledWith("companion", [{ role: "user", content: "x" }]);
  });
});

describe("OrganHost", () => {
  it("shows a permission card for an unapproved organ and grants on approve", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "organ_list") return [{
        id: "runs",
        manifest: JSON.stringify({ id: "runs", name: "Run Tracker", description: "d", version: 1, permissions: ["storage"] }),
        granted: null,
      }];
      if (cmd === "organ_grant") return "sha";
      if (cmd === "organ_read") return "export default { id: 'runs', render(el){ el.textContent = 'ok'; } }";
      return null;
    });
    render(<OrganHost />);
    expect(await screen.findByText("Run Tracker")).toBeTruthy();
    expect(screen.getByText("storage")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /approve/i }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("organ_grant",
      expect.objectContaining({ id: "runs", grantedJson: JSON.stringify(["storage"]) })));
  });
  it("renders an empty state when there are no organs", async () => {
    invoke.mockResolvedValue([]);
    render(<OrganHost />);
    expect(await screen.findByText(/No organs yet/i)).toBeTruthy();
  });
});
```

Note: `await expect(...)` inside a non-async `it` is invalid — make the first test `async`. Install `@testing-library/user-event` if absent: `npm i -D @testing-library/user-event`.

- [ ] **Step 2: Run to verify failure** — modules missing → FAIL.

- [ ] **Step 3: Implement**

`src/lib/organs/api.ts`:

```ts
import { fleetChat, type Msg } from "../core";

export type LoomApi = {
  storage: { get<T>(k: string, fallback: T): T; set(k: string, v: unknown): void; del(k: string): void };
  model: { chat(messages: Msg[]): Promise<string> };
  ui: { tokens: Record<string, string> };
  notify: (text: string) => void;
};

const TOKENS = { bg: "#060b18", panel: "#0d1424", t1: "#e8edf7", t2: "#9fb0cc", t3: "#5f6f8c", accent: "#f59e0b", go: "#4ade80", warn: "#fbbf24", danger: "#f87171" };

export function makeLoomApi(
  organId: string,
  granted: string[],
  deps: { chat?: typeof fleetChat; notify?: (t: string) => void } = {},
): LoomApi {
  const need = (p: string) => { if (!granted.includes(p)) throw new Error(`permission "${p}" not granted`); };
  const key = (k: string) => `organ.${organId}.${k}`;
  const chat = deps.chat ?? fleetChat;
  return {
    storage: {
      get(k, fallback) { need("storage"); const raw = localStorage.getItem(key(k)); return raw == null ? fallback : JSON.parse(raw); },
      set(k, v) { need("storage"); localStorage.setItem(key(k), JSON.stringify(v)); },
      del(k) { need("storage"); localStorage.removeItem(key(k)); },
    },
    model: { async chat(messages) { need("model"); return chat("companion", messages); } },
    ui: { tokens: TOKENS },
    notify: (text) => { need("notify"); (deps.notify ?? ((t: string) => console.info("[notify]", t)))(text); },
  };
}
```

`src/lib/organs/host.tsx`: component that on mount calls `organList()`, parses each entry with `manifestGuard`, splits approved (manifest.permissions every p in JSON.parse(granted ?? "[]")) vs unapproved; approved organs load via:

```ts
const code = await organRead(id, "organ.js");
const mod = await import(/* @vite-ignore */ URL.createObjectURL(new Blob([code], { type: "text/javascript" })));
mod.default.render(el, makeLoomApi(id, grantedList));
```

wrapped in try/catch per organ; catch sets that card's error state (rendered as a `var(--danger)` message in the card). PermissionCard: shows `manifest.name`, description, one line per requested permission (mono font), and an `Approve` button → `organGrant(id, JSON.stringify(manifest.permissions))` → refresh list. Empty state: "No organs yet. Ask the Loom to build one." Export default `OrganHost`.

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/lib/organs` → PASS.

- [ ] **Step 5: Mount in App.tsx** (below StatusPanel) and run `npm run check` → all PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(organs): host with error boundaries + permission-gated loom api + approval cards"
```

---

### Task 7: Build orchestrator + Loom console (`build.ts`, `LoomConsole.tsx`)

**Files:**
- Create: `src/lib/loom/build.ts`, `src/components/LoomConsole.tsx`
- Test: `src/lib/loom/build.test.ts`
- Modify: `src/App.tsx` (mount `<LoomConsole/>` above OrganHost)

**Interfaces:**
- Consumes: everything above (`prompts`, `plan`, `edits`, `validate/gate`, core wrappers).
- Produces:
  - `type BuildEvent = { ts: number; phase: string; detail: string }`
  - `type BuildResult = { ok: boolean; organId?: string; sha?: string; error?: string; log: BuildEvent[] }`
  - `buildOrgan(request: string, deps: BuildDeps): Promise<BuildResult>` where `BuildDeps = { chat: (role, messages, opts?) => Promise<string>; write: typeof organWrite; gate: typeof gate; onEvent?: (e: BuildEvent) => void }` — dependency-injected so the state machine is fully testable with mocks.
  - Flow (new organ): 1) builder writes `manifest.json` (system prompt `organSystemPrompt("manifest")`, user = request; `extractCode`, `manifestGuard` → id); 2) builder writes `organ.js` (context: manifest); 3) builder writes `test.js` (context: manifest + code); 4) `gate({manifest, code, tests}, id)`; 5) green → `organWrite(id, files, "loom: build <id> — <request 60 chars>")` → done. Any failure → `{ ok: false, error, log }` — **nothing written**.
  - Every chat call passes `{ numCtx: ctxFor(totalChars), temperature: 0.2 }`.
  - `isBusy(): boolean` + module-level single-flight: a second `buildOrgan` while one runs returns `{ ok: false, error: "a build is already running" }` immediately.
  - `<LoomConsole/>`: textarea ("Describe what LOOM should build for itself"), Build button (disabled while busy), live event log (mono, scrolling), success panel (organ id + commit sha + "approve it below to run it"), failure panel (stage + errors + Retry button).

- [ ] **Step 1: Write the failing tests** (fully mocked deps — no network)

`src/lib/loom/build.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { buildOrgan } from "./build";

const MANIFEST = JSON.stringify({ id: "runs", name: "Runs", description: "d", version: 1, permissions: ["storage"] });

function mkDeps(overrides: Partial<Parameters<typeof buildOrgan>[1]> = {}) {
  const chat = vi.fn()
    .mockResolvedValueOnce("```json\n" + MANIFEST + "\n```")
    .mockResolvedValueOnce("```js\nexport default { id: 'runs', render(el){ el.textContent='hi'; } }\n```")
    .mockResolvedValueOnce("```js\nexport const tests = [];\n```");
  const write = vi.fn().mockResolvedValue("sha123");
  const gate = vi.fn().mockResolvedValue({ ok: true, manifest: JSON.parse(MANIFEST), verdict: { ok: true, stage: "pass", errors: [], testResults: [] } });
  return { chat, write, gate, ...overrides };
}

describe("buildOrgan", () => {
  it("happy path: manifest -> code -> tests -> gate -> write, committing with the organ id", async () => {
    const deps = mkDeps();
    const r = await buildOrgan("track my runs", deps);
    expect(r.ok).toBe(true);
    expect(r.organId).toBe("runs");
    expect(r.sha).toBe("sha123");
    expect(deps.chat).toHaveBeenCalledTimes(3);
    expect(deps.write).toHaveBeenCalledWith("runs",
      expect.arrayContaining([expect.objectContaining({ name: "manifest.json" })]),
      expect.stringContaining("runs"));
  });
  it("never writes when the gate fails, and surfaces the errors", async () => {
    const deps = mkDeps({ gate: vi.fn().mockResolvedValue({ ok: false, verdict: { ok: false, stage: "render", errors: ["boom"], testResults: [] } }) });
    const r = await buildOrgan("x", deps);
    expect(r.ok).toBe(false);
    expect(deps.write).not.toHaveBeenCalled();
    expect(r.error).toContain("boom");
  });
  it("never writes when the manifest is invalid", async () => {
    const deps = mkDeps({ chat: vi.fn().mockResolvedValue("not json at all") });
    const r = await buildOrgan("x", deps);
    expect(r.ok).toBe(false);
    expect(deps.write).not.toHaveBeenCalled();
  });
  it("rejects a concurrent build", async () => {
    const slowGate = vi.fn().mockImplementation(() => new Promise((res) => setTimeout(() => res({ ok: false, verdict: { ok: false, stage: "load", errors: ["x"], testResults: [] } }), 50)));
    const deps = mkDeps({ gate: slowGate });
    const first = buildOrgan("a", deps);
    const second = await buildOrgan("b", mkDeps());
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/already running/i);
    await first;
  });
});
```

- [ ] **Step 2: Run to verify failure** — module missing → FAIL.

- [ ] **Step 3: Implement `build.ts`** per the interface (single-flight via a module-level `busy` boolean set in a try/finally; log via a local array + optional onEvent; each phase pushes an event; gate failure aggregates `verdict.errors.join("; ")` into `error`). Then `LoomConsole.tsx` calling `buildOrgan(request, { chat: fleetChat, write: organWrite, gate, onEvent })`, streaming events into state; after success trigger an `organs-changed` CustomEvent that OrganHost listens to for refresh.

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/lib/loom/build.test.ts` → PASS. Then `npm run check` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(loom): build orchestrator with single-flight queue + Loom console"
```

---

### Task 8: Real-model self-test (env-gated) + wiring check

**Files:**
- Create: `src/selftest/loom.selftest.test.ts`
- Modify: `package.json` (script `"selftest": "SELFTEST=1 vitest run src/selftest"`), `vitest.config.ts` (exclude `src/selftest` unless `SELFTEST=1`)

**Interfaces:**
- Consumes: `prompts.ts`, `edits.ts`, `validate.ts` (manifestGuard) — pure functions + direct `fetch` to `http://localhost:11434/api/chat` (node environment; no Tauri).
- Produces: `npm run selftest` — the replicability harness. 3 reps × 3 tasks against the real local builder (auto-picks the best installed coder from `/api/tags` using the same contains-"coder" rule):
  1. **build-manifest**: request → manifest.json → `manifestGuard` passes.
  2. **build-organ-code**: manifest → organ.js → contains `export default` and `render`, and `new Function` on a `import`-stripped copy doesn't throw for plain syntax errors (regex-strip `export default` → wrap).
  3. **edit-blocks**: given a sample organ.js, request a small change → `applyEditBlocks` applies cleanly.
- CI unaffected (suite excluded without `SELFTEST=1`).

- [ ] **Step 1: Configure exclusion.** In `vitest.config.ts`: `test: { environment: "jsdom", globals: true, exclude: [...(process.env.SELFTEST ? [] : ["src/selftest/**"]), "**/node_modules/**"] }`. Add the npm script.

- [ ] **Step 2: Write the suite** — `describe.skipIf(!process.env.SELFTEST)`; a `pickBuilder()` helper fetching `/api/tags` and applying the best-coder rule; each task loops `REPS = 3`, asserts every rep. Model calls: `{ model, messages, stream: false, options: { temperature: 0.2, num_ctx: ctxFor(promptChars) } }` with a 120s timeout via `AbortSignal.timeout`.

- [ ] **Step 3: Verify both modes.** `npm test` → selftest files reported 0 (excluded), everything else green. `npm run selftest` with Ollama running → suite runs against the real model (report pass/fail counts honestly; if the fleet pull hasn't finished it uses the best installed coder).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(loom): real-model self-test harness (npm run selftest), CI-excluded"
```

---

## Self-Review

**Spec coverage (phase 2 subset of the design spec):** the Loom engine (append/edit-blocks/deterministic-first plan/validate/model-authored tests) → Tasks 3–5, 7; Worker/sandbox-isolated smoke-test → Task 5 (sandboxed iframe with kill timeout — chosen over a Worker because organs render DOM); git commits per change → Task 2 (organ_write commits via Timeline); organ registry + error boundaries + hot-load → Task 6; permission manifest + kernel-only grants + approval UI → Tasks 2, 6 (user decision: manifest permissions); build queue + structured log → Task 7; self-test in CI → Task 8 (deterministic pipeline tests in CI; real-model harness local — CI runners have no Ollama, documented). Companion routing and the prompt compiler are Phase 3; the orb is Phase 4 (correctly out of scope).

**Placeholder scan:** every code step contains the actual code or a precise contract with exact names/signatures; no TBDs.

**Type consistency:** `OrganFile{name,content}` (Rust) ↔ `OrganFile` (TS); `organ_grant(id, grantedJson)` ↔ camelCase `grantedJson` arg (Tauri v2 auto-converts camelCase→snake_case params; the wrapper passes `{ id, grantedJson }` matching the test); `ChatOpts` snake_case over IPC; `gate`/`sandboxRun`/`manifestGuard` names used identically across Tasks 5–7; permission catalog strings identical in prompts.ts, validate.ts, api.ts.
