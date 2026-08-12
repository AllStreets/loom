// Pure helpers that emit loom-mood CustomEvents.
// Extracted so unit tests can cover them without rendering Companion.

export function dispatchMood(mood: string): void {
  window.dispatchEvent(new CustomEvent("loom-mood", { detail: { mood } }));
}

// Called at the very start of a turn (before handle resolves).
export function turnStartMood(): void {
  dispatchMood("thinking");
}

// Called when the first build/edit BuildEvent arrives for the current turn.
// Returns `true` if the mood was dispatched (i.e. we hadn't already done so
// this turn), `false` if it was already dispatched (caller should ignore).
export function firstEventMood(alreadyBuilding: boolean): boolean {
  if (alreadyBuilding) return false;
  dispatchMood("building");
  return true;
}

// Called when a turn settles (reply, success, failure, act, or catch).
// Dispatches "speaking" immediately, then schedules "idle" after 2500 ms.
// Returns the timer id so the caller can cancel it on new-turn-start or
// unmount.
export function settleMood(): ReturnType<typeof setTimeout> {
  dispatchMood("speaking");
  return setTimeout(() => dispatchMood("idle"), 2500);
}
