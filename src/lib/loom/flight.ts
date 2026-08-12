let busy = false;

export function isBusy(): boolean {
  return busy;
}

export async function withFlight<T>(fn: () => Promise<T>): Promise<T | { busy: true }> {
  if (busy) return { busy: true };
  busy = true;
  try {
    return await fn();
  } finally {
    busy = false;
  }
}
