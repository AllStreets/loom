export const audioLevel = { current: 0 };

export function envelope(
  prev: number,
  sample: number,
  attack = 0.65,
  decay = 0.12
): number {
  if (sample > prev) {
    return prev + (sample - prev) * attack;
  }
  return prev + (sample - prev) * decay;
}
