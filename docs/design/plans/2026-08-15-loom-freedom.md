# LOOM Freedom Implementation Plan (Phase 7)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Free organ windows to roam the entire viewport (never off-screen), and open the model fleet: show the three local models in a redesigned multi-page Settings and let the user swap any role's model.

**Architecture:** The desktop plane becomes a full-shell overlay (absolute, inset 0) so window coordinates span the whole viewport; clamping happens against the viewport at every mutation point (load, spawn, drag, resize, viewport resize). Fleet model overrides flow frontend→Rust per call: the kernel settings store gains free-text `model.*` keys, `core.ts` reads them and passes an overrides object to `fleet_chat`/`fleet_status` (camelCase IPC args), Rust merges over `FleetConfig::default()`. Settings becomes a paged organ (sidebar nav) with a Models page.

**Tech Stack:** React 18 + TS (kernel), Tauri v2 Rust core, kit-composed seed organs (UIKIT_SRC constraints), vitest + cargo test.

## Global Constraints

- Brand: navy `#060b18`, cyan accent `#22d3ee`, glass surfaces. NO yellow. NO emojis anywhere.
- Tauri v2 IPC: JS invoke args MUST be camelCase (`overrides`, not `over_rides`); Rust params snake_case.
- Seed organ code strings (settings.ts): srcdoc-safe — ES2019, no backticks, no `${`, no `</script`, ASCII only; kit-composed (`loom.ui.*`); every interactive element carries `data-action`; tests use fresh per-test storage.
- Kernel settings whitelist lives in `src/lib/voice/settings.ts` (`SETTINGS_KEYS`/`ALLOWED`/defaults). Free-text keys must validate by regex, not enumeration.
- Nothing about T1 may regress the three-zone Shell layout scroll behavior: the chat log still scrolls in its own container; the orb band never scrolls away. Windows MAY overlap the orb visually (user decision: "drag anywhere on this fullscreen").
- Fleet default models (shown in Settings and used as reset values): builder `qwen3-coder:30b-a3b-q4_K_M`, companion `gpt-oss:20b`, rewriter `qwen3:1.7b`.
- Ollama model tag validation regex (frontend and Rust): `^[A-Za-z0-9][A-Za-z0-9._\-\/]*(:[A-Za-z0-9._\-]+)?$`, max 128 chars.
- All gates: `npm run check` (vitest + cargo) green, `npm run build` green. Real-model selftest only where a task says so.

---

### Task 1: Free the windows — full-viewport desktop plane + never-off-screen clamping

**Files:**
- Modify: `src/components/Shell.tsx` (desktop plane placement, Threads overlay coordinate space)
- Modify: `src/components/desktop/Desktop.tsx` (plane becomes full-shell overlay; spawn clamp vs viewport)
- Modify: `src/components/desktop/OrganWindow.tsx` (clamp everywhere: load x AND y, drag, resize, viewport-resize listener)
- Modify: `src/components/ambient/Threads.tsx` only if its container must move to the new coordinate space (keep anchors correct)
- Test: `src/components/desktop/desktop.test.tsx`, `src/components/Shell.test.tsx`

**Interfaces:**
- Consumes: `windowRegistry` (ambient), `loom.win.<id>` persistence, `[data-desktop-plane]` attribute used by OrganWindow clamps.
- Produces: the plane element still carries `data-desktop-plane` and now spans the full shell (absolute inset 0 within the Shell root, `pointerEvents: "none"`, windows re-enable `pointerEvents: "auto"`). Dock and permission modals keep their z-order above windows.

**Requirements (behavioral spec):**
1. The desktop plane is an overlay covering the ENTIRE shell viewport (absolute, inset 0, above the orb band visually, below dock/modals). `pointerEvents: none` on the plane; each window sets `pointerEvents: auto`. The orb, chat input, and top bar remain fully clickable wherever no window covers them.
2. A window can be dragged to any position in the viewport, and NEVER off it: clamp so the full window rect stays inside `[0, planeW-w] x [0, planeH-h]` when plane dims are known. If `w > planeW` (small screens), clamp x to 0 and additionally clamp width at render to `min(w, planeW)`.
3. Clamping applies at EVERY mutation point:
   - load: clamp persisted x AND y against current viewport (replace the y-only `clampLoadedY` with `clampToViewport(pos)` that also handles x and oversized w/h)
   - spawn cascade: clamp new-window positions against the plane
   - drag + resize: existing pointer clamps, now against the full plane
   - viewport resize: a `resize` listener re-clamps all open windows (single listener in Desktop, not per-window) and persists corrected positions
4. Chat/companion scrolling and orb centering are untouched (three-zone layout intact). Threads' bezier anchors remain correct in the new coordinate space (its container must share the plane's coordinate origin — move its overlay to the same shell-level inset-0 space if needed; `getOrbAnchor` math already uses container rects so aligning containers is sufficient).
5. Tests (real assertions, no vacuous guards):
   - persisted position far off-screen (e.g. x: 5000, y: 4000) loads clamped inside the viewport (mock `window.innerWidth/innerHeight`, and prototype `offsetWidth/offsetHeight` on the plane as done in the existing spawn-clamp test)
   - drag clamp keeps window fully inside plane bounds (extend existing drag test)
   - viewport-resize listener re-clamps an open window (dispatch `resize` after shrinking mocked dims; assert new pos)
   - plane has `pointerEvents: none`, windows `auto` (style assertions)

- [ ] Steps: write failing tests → implement → `npm run check` green → `npm run build` green → commit `feat(desktop): free the windows — full-viewport plane, never off-screen`.

---

### Task 2: Open the fleet — per-role model overrides end-to-end

**Files:**
- Modify: `src/lib/voice/settings.ts` (add `model.builder` / `model.companion` / `model.rewriter` free-text keys)
- Modify: `src-tauri/src/fleet.rs` (`FleetOverrides` param on `fleet_status` + `fleet_chat`; merge over defaults; validate tags)
- Modify: `src/lib/core.ts` (read model settings, pass `overrides` camelCase on every fleet invoke; expose `fleetDefaults()` constant)
- Test: `src/lib/voice/settings.test.ts` (or wherever settings tests live), `src-tauri/src/fleet.rs` #[cfg(test)], core.ts mocked-invoke tests

**Interfaces:**
- Consumes: existing `getSetting`/`setSetting` whitelist machinery; `fleet_status`/`fleet_chat` commands; `ChatOpts`/`Msg`.
- Produces:
  - Settings keys: `"model.builder" | "model.companion" | "model.rewriter"`, default `""` (= use fleet default). Free-text: whitelist validation switches to per-key rule — enumerated keys keep their arrays; `model.*` keys validate against the tag regex in Global Constraints (empty string allowed = unset).
  - Rust: `#[derive(Deserialize, Default)] pub struct FleetOverrides { pub builder: Option<String>, pub companion: Option<String>, pub rewriter: Option<String> }`; `fn effective_config(overrides: &FleetOverrides) -> FleetConfig` merging non-empty, regex-valid overrides over `FleetConfig::default()` (invalid/empty → ignored, default kept). `fleet_status(overrides: Option<FleetOverrides>)`, `fleet_chat(role, messages, opts, overrides: Option<FleetOverrides>)` use it. Fallback chain (`best_coder` → rewriter) operates on the EFFECTIVE config.
  - core.ts: `function modelOverrides(): { builder?: string; companion?: string; rewriter?: string }` built from settings (omit empty); every `invoke("fleet_chat", {...})`/`invoke("fleet_status", {...})` passes `overrides: modelOverrides()`. JS arg name `overrides` (camelCase — Tauri v2).
- Tests: Rust — merge logic (override wins, empty ignored, invalid tag ignored, fallback uses effective rewriter); TS — setSetting accepts valid tag / rejects garbage (`"bad tag!"`, 200-char string) / accepts empty; core invoke payload includes overrides (mocked invoke).

- [ ] Steps: failing tests → implement Rust merge + commands → implement TS settings + core plumbing → `npm run check` green → commit `feat(fleet): per-role model overrides — the fleet is yours`.

---

### Task 3: Settings, grown up — paged Settings organ with a Models page

**Files:**
- Modify: `src/organs/seeds/settings.ts` (paged layout: sidebar nav + pages Voice / Models / Appearance / Building)
- Modify: `src/lib/organs/api.ts` (loom.settings gains `models()` and `setModel(role, tag)` — settings-permission gated)
- Modify: `src/lib/loom/sandbox.ts` (settings mock extended with models/setModel so seed tests run in the gate)
- Modify: `src/components/desktop/Desktop.tsx` ORGAN_SIZES if settings needs a larger default (e.g. 640x560)
- Test: seed gate tests (existing seed validation path), api tests, selftest untouched

**Interfaces:**
- Consumes: Task 2's settings keys + `fleet_status` (for model presence) via core; kit v2 factories (`section`, `keyval`, `dot`, `toolbar`, `hero`).
- Produces: `loom.settings.models()` → `Promise<Array<{ role: "builder"|"companion"|"rewriter", model: string, default: string, override: string, present: boolean }>>` (model = effective); `loom.settings.setModel(role, tag)` → validates tag (same regex; empty = reset to default), writes `model.<role>` setting, resolves `{ok: boolean, error?: string}`.
- Settings organ structure:
  - Left sidebar nav (kit `list`/`listRow` or buttons with `data-action="page-voice"` etc.), pages: **Voice** (existing voice default/audition/mic test/speakReplies — ALL preserved), **Models** (new), **Appearance** (orb tier), **Building** (reviewBeforeSave).
  - Models page: one `section` per role. Each shows: role name, effective model (`keyval`), status `dot` (present green/absent muted) with "installed"/"not installed" text, the default tag, a kit `input` prefilled with the current override + Apply and Reset buttons (`data-action="model-apply-builder"`, `data-action="model-reset-builder"`, etc.). Invalid tag → inline error text (no alert). A short note that absent models fall back automatically.
  - Keep the whole organ kit-composed and srcdoc-safe; every control keeps `data-action`; model-authored-style tests in TEST_JS cover: page switch renders Models content; apply writes via settings mock; reset clears.
- Sandbox settings mock: `models()` returns a fixed 3-role fixture; `setModel` records calls + validates non-empty roles — enough for TEST_JS to assert against.

- [ ] Steps: failing tests (api + sandbox mock) → api implementation → seed rebuild → gate the seed locally (existing seed test path) → `npm run check` + `npm run build` green → commit `feat(settings): paged settings with a Models page — see and steer the fleet`.

---

## Self-Review Notes

- T1 plane `pointerEvents: none` is what keeps the orb/chat clickable under the overlay — called out explicitly with a test.
- T2 keeps ALL model selection per-call (no Rust state), so overrides apply instantly with no restart and no persistence drift; empty-string = unset keeps the whitelist machinery simple.
- T3 depends on T2's keys and api shape — briefs must carry the exact `models()` return type above.
- Voice page functionality preservation is restated in T3 because the settings seed was fully rebuilt once before (T4 Vitality) and review caught nothing missing only because it was explicitly checked.
