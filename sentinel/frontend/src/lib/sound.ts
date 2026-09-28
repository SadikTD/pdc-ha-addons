import { useCallback, useSyncExternalStore } from "react";

// Cameras the user turned the sound on for, shared by the live grid, the dashboard card
// and the camera page: unmute a camera in the grid, open it, and it's still audible.
// Only for this visit: browsers block sound that starts without a click anyway.

const on = new Set<string>();
const listeners = new Set<() => void>();

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function setSound(cam: string, value: boolean) {
  if (value === on.has(cam)) return;
  if (value) on.add(cam);
  else on.delete(cam);
  listeners.forEach((fn) => fn());
}

export function useSound(cam: string): [boolean, (value: boolean) => void] {
  const value = useSyncExternalStore(subscribe, () => on.has(cam));
  const set = useCallback((v: boolean) => setSound(cam, v), [cam]);
  return [value, set];
}
