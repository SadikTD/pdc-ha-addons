import type { NavigateFunction } from "react-router-dom";
import type { SentinelEvent } from "./api";

// Opening an event from a list (Events, Summary, Live) remembers that list for this tab:
// the player then steps through it (previous / next), and going back returns to the
// list where it was left, on the event last watched.

export type ListItem = { c: string; id: string; t: number };
export type EventList = {
  from: string; // shown on the back button, e.g. "Events"
  key: string; // which list (page + filters), so only that list restores itself
  items: ListItem[];
  current: string; // the event last opened
  shown?: number; // how far the list had been scrolled out
};

const KEY = "sentinel.eventList";

// Where playback starts: a few seconds before whoever was seen, else before the motion.
export const playTime = (e: Pick<SentinelEvent, "start" | "objects">) => (e.objects?.[0]?.t ?? e.start) - 3000;

export const eventPath = (it: ListItem) => `/camera/${it.c}?t=${it.t}&ev=${encodeURIComponent(it.id)}`;

export function readList(): EventList | null {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? "null");
  } catch {
    return null;
  }
}

function save(l: EventList) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(l));
  } catch {
    // Storage full: stepping through the list just won't be offered.
  }
}

export function setCurrent(id: string) {
  const l = readList();
  if (l) save({ ...l, current: id });
}

export function openEvent(nav: NavigateFunction, e: SentinelEvent, list: SentinelEvent[], from: string, key: string, shown?: number) {
  const items = list.map((x) => ({ c: x.camera, id: x.id, t: playTime(x) }));
  save({ from, key, items, current: e.id, shown });
  nav(eventPath({ c: e.camera, id: e.id, t: playTime(e) }), { state: { from } });
}
