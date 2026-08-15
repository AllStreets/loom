/**
 * windowRegistry.ts
 * Module-level map of organ window positions.
 * OrganWindow calls set() on every drag move.
 * Threads reads getAll() on every tick.
 */

export type WinRect = { x: number; y: number; w: number; h: number };

const registry = new Map<string, WinRect>();

export const windowRegistry = {
  set(id: string, rect: WinRect) {
    registry.set(id, rect);
  },
  delete(id: string) {
    registry.delete(id);
  },
  getAll(): ReadonlyMap<string, WinRect> {
    return registry;
  },
};
