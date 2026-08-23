/**
 * notifyGate.ts — per-mount tokens for the `loom-notify` surface.
 *
 * HONESTY ENFORCEMENT, NOT A SECURITY SANDBOX. Organs share the shell's JS
 * realm, so organ code could always call window.dispatchEvent directly and
 * skip the grant + budget checks in api.ts. The real walls are the gate
 * (manifest guard + sandbox verdict) and owner approval. This module adds
 * defense-in-depth: api.notify stamps each event with a per-mount random
 * token held in this module-private registry — unreachable through the api
 * object handed to organ code — and Notices drops any `loom-notify` event
 * whose token is not currently registered. A forged plain dispatch simply
 * never renders a toast.
 */

/** organId -> the current per-mount token. A remount replaces (and thereby
 *  invalidates) the previous mount's token; deletion revokes it entirely. */
const live = new Map<string, string>();

/** Mint and register a fresh token for one organ's api mount. */
export function mintNotifyToken(organId: string): string {
  const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  live.set(organId, token);
  return token;
}

/** Forget an organ's token — called when the organ is purged. Idempotent. */
export function revokeNotifyToken(organId: string): void {
  live.delete(organId);
}

/** True when a `loom-notify` event token belongs to a currently live mount. */
export function isLiveNotifyToken(token: unknown): boolean {
  if (typeof token !== "string" || token === "") return false;
  for (const t of live.values()) if (t === token) return true;
  return false;
}
