// Tracks which power is currently executing so shared resources (FOV, poses, motion)
// can be arbitrated between powers that run at the same time.

let current = null;

/** Run `fn` with `owner` (a power id) as the active context. Re-entrant. */
export function withOwner(owner, fn) {
  const prev = current;
  current = owner;
  try {
    return fn();
  } finally {
    current = prev;
  }
}

/** Power id whose handler is running right now (or null outside handlers). */
export function currentOwner() {
  return current;
}
