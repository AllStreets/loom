# LOOM Phase 19 — Vigor (design)

**Date:** 2026-08-22 · **Status:** approved for planning

## Problem

Built organs have a toy ceiling: storage + UI kit. A sentence like *"alert me when BTC drops 5% in an hour"* cannot produce a working thing, so the self-building loop — LOOM's revolutionary core — demos widgets instead of tools. Phase 19 gives organs **real powers**, governed the LOOM way: declared, permission-gated, revocable, honest.

## The powers

Extend `LoomApi` (`src/lib/organs/api.ts` — the `need()` grant seam already exists) with six capabilities. Every power is a token the organ's manifest must declare and the owner must approve on the permission card:

| power | surface (read-only unless noted) | notes |
|---|---|---|
| `market` | `loom.market.chart/crypto/book/trades/fx` | thin over the Phase-17 engine; per-organ rate budget |
| `watch` | `loom.watch.top(n)`, `loom.watch.list()` | salient items + watchlist; no engagement writes |
| `timeline` | `loom.timeline.log(n)` | the long-flagged read surface, finally |
| `voice` | `loom.voice.say(text)` | speaks via the existing TTS path; length-capped, rate-limited |
| `notify` | `loom.notify(title, body)` | LOOM-native toast surface (glass, calm, dismissible) + unseen count; NOT OS notifications v1 |
| `pulse` | `loom.pulse.every(ms, fn)` | scheduled runs while LOOM is open; min interval 30s, max 4 pulses/organ, auto-cleared on unmount/delete |

## Governance

- **Manifest declares** `powers: [...]`; undeclared calls throw the existing permission error. The **permission card** lists requested powers in plain language ("this organ can: read market data · speak · run every minute"). Granting stores per-organ tokens (existing grant store); **revocation** = organ Settings surface lists powers with revoke toggles.
- **Budgets:** market ≤ 30 req/min/organ; voice ≤ 1 utterance/30s/organ; notify ≤ 6/hour/organ — exceeded = calm per-organ error, never a crash, budget state visible on the organ window (small dim chip when throttled).
- **Sandbox/gate:** the validation sandbox mocks every power deterministically (canned market shapes, silent voice, captured notifications, immediate-fire pulse test hook) so gate + generated tests run offline and the model can test against power outputs.

## The builder learns its new hands

- Prompts/few-shots (`src/lib/loom/prompts.ts`) teach the six APIs with exact signatures + a worked example (the BTC-drop alert: pulse + market + notify + voice).
- Manifest guard extends to validate `powers` (subset of the six, else fail with reason).
- The real-model selftest gains one powered case (pulse+market+notify) proving the loop end-to-end.

## Non-goals

OS-level notifications, network beyond the market engine, organ-to-organ calls, background runs while LOOM is closed, kernel self-edit (Phase 21), unprompted proposals (Phase 20).

## Testing

api.ts power surfaces + budgets + revocation (unit); sandbox mocks (unit); permission-card rendering (component); manifest guard (unit); one gated end-to-end build fixture using powers; screenshot gate: permission card with powers, notify toast, throttle chip. `npm run check` green per task.
