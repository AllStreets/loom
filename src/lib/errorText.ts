/**
 * errorText — a readable message from anything a promise can reject with.
 *
 * Tauri rejects with whatever the Rust command returned: a string, or a
 * serialized error object. `String(obj)` turns the second into "[object
 * Object]", which is what a failed build once showed the owner. This reads
 * the usual message fields first, then falls back to JSON.
 */
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const o = err as Record<string, unknown>;
    for (const key of ["message", "error", "reason", "msg"]) {
      const v = o[key];
      if (typeof v === "string" && v) return v;
    }
    try {
      const json = JSON.stringify(err);
      if (json && json !== "{}") return json;
    } catch {
      /* cyclic: fall through */
    }
  }
  return String(err);
}
