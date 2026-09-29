import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { motion } from "motion/react";
import clsx from "clsx";
import { Loader2, Play, Search, UserRound, X, Zap } from "lucide-react";
import { Button, Empty, PageHeader } from "../components/ui";
import { useStatus } from "../lib/status";
import { api, faceURL, type Label, type PersonInfo, type SearchQuery, type SentinelEvent } from "../lib/api";
import { DAY, HOUR, fmtDay, fmtDuration, fmtTimeSec, startOfDay } from "../lib/format";
import { EventPicture, LABELS, LABEL_ORDER, LabelChips, SEARCH_EXAMPLES } from "../lib/labels";
import { openEvent, readList } from "../lib/eventNav";
import { whenNear } from "../lib/lazy";

const RANGES = [
  { id: "today", label: "Today", from: () => startOfDay(Date.now()) },
  { id: "24h", label: "24 hours", from: () => Date.now() - DAY },
  { id: "7d", label: "7 days", from: () => Date.now() - 7 * DAY },
  { id: "custom", label: "Custom", from: () => 0 },
];
const CUSTOM = 3;
const PAGE = 60; // events drawn at a time; more are added while scrolling down

type Kind = "all" | Label | "motion";

function toLocalInput(ms: number) {
  return new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

// The last lists fetched, so coming back from an event shows the list at once (and
// refreshes it quietly) instead of starting over from a blank page.
const cache = new Map<string, SentinelEvent[]>();
function remember(key: string, list: SentinelEvent[]) {
  cache.delete(key);
  cache.set(key, list);
  if (cache.size > 6) cache.delete(cache.keys().next().value!);
}

export function EventsPage() {
  const { status } = useStatus();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();

  // Every filter lives in the address, so going back to the list (or reloading, or
  // sharing the link) shows exactly the same list.
  const set = (changes: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v === null || v === "") p.delete(k);
      else p.set(k, v);
    }
    setParams(p, { replace: true });
  };
  const cams = useMemo(() => (params.get("cams") ?? "").split(",").filter(Boolean), [params]);
  const range = Math.max(0, RANGES.findIndex((r) => r.id === (params.get("range") ?? "24h")));
  const kind = (params.get("kind") as Kind) || "all";
  const whoId = params.get("who") ?? "";
  const minPeak = Number(params.get("min")) || 0;
  const custom = {
    from: params.get("from") ?? toLocalInput(startOfDay(Date.now()) - DAY + 22 * HOUR),
    to: params.get("to") ?? toLocalInput(startOfDay(Date.now()) + 6 * HOUR),
  };
  const setKind = (k: Kind) => set({ kind: k === "all" ? null : k });
  const setRange = (i: number) =>
    set({ range: RANGES[i].id === "24h" ? null : RANGES[i].id, ...(i === CUSTOM ? { from: custom.from, to: custom.to } : { from: null, to: null }) });
  const setCustom = (edge: "from" | "to", v: string) => set({ [edge]: v });
  const setMinPeak = (v: number) => set({ min: v ? String(v) : null });
  const toggleCam = (id: string) => set({ cams: (cams.includes(id) ? cams.filter((x) => x !== id) : [...cams, id]).join() || null });

  // Search: the text being typed, and the question asked (from the URL, so it can be shared).
  const asked = params.get("q") ?? "";
  const [text, setText] = useState(asked);
  const [parsed, setParsed] = useState<SearchQuery | null>(null);
  const [searching, setSearching] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const names = Object.fromEntries((status?.cameras ?? []).map((c) => [c.id, c.name]));
  // People Sentinel recognises (named on the People page), for the "who" filter.
  const [people, setPeople] = useState<PersonInfo[]>([]);
  useEffect(() => {
    api.people().then((r) => setPeople(r.people)).catch(() => {});
  }, []);
  const ask = (q: string) => {
    setText(q);
    set({ q: q.trim() || null });
  };

  // What is fetched (the kind and size filters only narrow it down here).
  const dataKey = asked ? `q:${asked}` : `${cams.join()}|${range}|${range === CUSTOM ? `${custom.from}|${custom.to}` : ""}`;
  // Which list this is, to come back to it from an event.
  const listKey = `events?${params}`;
  const back = useRef(readList());
  if (back.current && back.current.key !== listKey) back.current = null;
  const [events, setEvents] = useState<SentinelEvent[] | null>(() => cache.get(dataKey) ?? null);
  const [shown, setShown] = useState(() => Math.max(PAGE, back.current?.shown ?? 0));
  const [lastSeen, setLastSeen] = useState<string | null>(() => back.current?.current ?? null);
  const animate = useRef(!events); // cards rise in on a fresh list, not when coming back
  const more = useRef<HTMLDivElement>(null);

  const loadedKey = useRef(dataKey);
  useEffect(() => {
    let alive = true;
    // A new question or filter starts at the top of a fresh list.
    if (loadedKey.current !== dataKey) {
      loadedKey.current = dataKey;
      setShown(PAGE);
      setLastSeen(null);
      setEvents(cache.get(dataKey) ?? null);
    }
    const got = (list: SentinelEvent[]) => {
      if (!alive) return;
      remember(dataKey, list);
      setEvents(list);
    };
    // Refreshes skip a hidden tab: no point fetching lists nobody is looking at.
    const every = (ms: number, f: () => void) => {
      const t = window.setInterval(() => !document.hidden && f(), ms);
      return () => window.clearInterval(t);
    };
    if (asked) {
      setSearching(true);
      const load = () =>
        api
          .search(asked, 1000)
          .then((r) => {
            if (!alive) return;
            got(r.events);
            setParsed(r.query);
          })
          .catch(() => alive && setEvents((e) => e ?? []))
          .finally(() => alive && setSearching(false));
      load();
      const stop = every(20_000, load);
      return () => {
        alive = false;
        stop();
      };
    }
    setParsed(null);
    const from = range === CUSTOM ? new Date(custom.from).getTime() : RANGES[range].from();
    const to = range === CUSTOM ? new Date(custom.to).getTime() : Date.now() + HOUR;
    if (!(from < to)) {
      setEvents([]);
      return;
    }
    const load = () =>
      api
        .events({ cameras: cams, from, to, limit: 3000 })
        .then(got)
        .catch(() => {});
    load();
    // Only a range that reaches the present can get new events.
    const stop = to > Date.now() - HOUR ? every(15_000, load) : () => {};
    return () => {
      alive = false;
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataKey]);

  const sized = useMemo(() => (events ?? []).filter((e) => e.peak >= minPeak), [events, minPeak]);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: sized.length, motion: 0, person: 0, cat: 0, dog: 0 };
    for (const e of sized) {
      if (e.labels?.length) for (const l of e.labels) c[l]++;
      else if (e.scan === "done") c.motion++;
    }
    return c;
  }, [sized]);
  const whoCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const e of sized) for (const w of e.who ?? []) c[w.person] = (c[w.person] ?? 0) + 1;
    return c;
  }, [sized]);
  const matching = useMemo(
    () =>
      sized.filter(
        (e) =>
          (kind === "all" ? true : kind === "motion" ? e.scan === "done" && !e.labels?.length : e.labels?.includes(kind)) &&
          (!whoId || !!e.who?.some((w) => w.person === whoId)),
      ),
    [sized, kind, whoId],
  );
  const perDay = useMemo(() => {
    const m = new Map<number, number>();
    for (const e of matching) m.set(startOfDay(e.start), (m.get(startOfDay(e.start)) ?? 0) + 1);
    return m;
  }, [matching]);
  const groups = useMemo(() => {
    const out: { day: number; items: SentinelEvent[] }[] = [];
    for (const e of matching.slice(0, shown)) {
      const d = startOfDay(e.start);
      if (out.at(-1)?.day !== d) out.push({ day: d, items: [] });
      out.at(-1)!.items.push(e);
    }
    return out;
  }, [matching, shown]);

  // Coming back from an event: the list is where it was, on the event just watched.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !events || !lastSeen || !back.current) return;
    const i = matching.findIndex((e) => e.id === lastSeen);
    if (i >= shown) return setShown(i + PAGE);
    restored.current = true;
    if (i < 0) return;
    requestAnimationFrame(() => document.querySelector(`[data-ev="${CSS.escape(lastSeen)}"]`)?.scrollIntoView({ block: "center" }));
  }, [events, matching, lastSeen, shown]);

  // Endless list: the next batch comes in as the end comes near.
  useEffect(() => {
    if (!more.current || shown >= matching.length) return;
    return whenNear(more.current, () => setShown((n) => n + PAGE));
  }, [shown, matching.length, events]);

  const total = matching.length;
  const pending = status?.detection?.backlog ?? 0;
  const kinds: { k: Kind; label: string; icon?: typeof Zap; color?: string }[] = [
    { k: "all", label: "All" },
    ...LABEL_ORDER.map((l) => ({ k: l as Kind, label: LABELS[l].plural, icon: LABELS[l].icon, color: LABELS[l].color })),
    { k: "motion", label: "Motion only", icon: Zap, color: "#fbbf24" },
  ];
  const whoName = people.find((p) => p.id === whoId)?.name;
  const what = whoName ? `event with ${whoName}` : kind === "all" ? "event" : kind === "motion" ? "plain motion event" : `event with ${LABELS[kind].plural.toLowerCase()}`;

  return (
    <>
      <PageHeader
        title="Events"
        sub={events ? `${total} ${total === 1 ? what : what.replace("event", "events")}${asked ? " found" : range === CUSTOM ? " in this range" : ""}${!asked && cams.length ? ` on ${cams.length} camera${cams.length > 1 ? "s" : ""}` : ""}` : "Loading…"}
      />

      {/* Search */}
      <form
        className="mb-3"
        onSubmit={(e) => {
          e.preventDefault();
          ask(text);
          input.current?.blur();
        }}
      >
        <div className="glass flex items-center gap-2 rounded-2xl px-3 py-2 focus-within:border-violet-400/40">
          {searching ? <Loader2 className="size-4 shrink-0 animate-spin text-violet-300" /> : <Search className="size-4 shrink-0 text-slate-400" />}
          <input
            ref={input}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder='Search, e.g. "person on the roof last night" or "cats yesterday after 10pm"'
            className="h-8 min-w-0 flex-1 bg-transparent text-sm text-white placeholder:text-slate-500 focus:outline-none"
          />
          {text && (
            <button type="button" title="Clear search" onClick={() => ask("")} className="rounded-lg p-1 text-slate-400 hover:bg-white/5 hover:text-white">
              <X className="size-4" />
            </button>
          )}
          <Button type="submit" size="sm" variant="primary">
            Search
          </Button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {asked && parsed ? (
            <>
              <span className="text-xs text-slate-500">Showing:</span>
              {parsed.chips.map((c) => (
                <span key={c} className="rounded-full border border-violet-400/30 bg-violet-500/15 px-2.5 py-0.5 text-xs font-medium text-violet-200">
                  {c}
                </span>
              ))}
              <button type="button" onClick={() => ask("")} className="ml-1 text-xs text-slate-400 underline-offset-2 hover:text-white hover:underline">
                Clear
              </button>
            </>
          ) : (
            <>
              <span className="text-xs text-slate-500">Try:</span>
              {SEARCH_EXAMPLES.map((q) => (
                <button
                  type="button"
                  key={q}
                  onClick={() => ask(q)}
                  className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-0.5 text-xs text-slate-300 transition hover:border-white/20 hover:text-white"
                >
                  {q}
                </button>
              ))}
            </>
          )}
        </div>
      </form>

      {/* Who */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {kinds.map(({ k, label, icon: I, color }) => (
          <button
            key={k}
            onClick={() => setKind(k)}
            className={clsx(
              "flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold transition",
              kind === k ? "border-white/20 bg-white/10 text-white" : "border-white/5 bg-white/[0.02] text-slate-400 hover:text-white",
            )}
          >
            {I && <I className="size-3.5" style={{ color }} />}
            {label}
            <span className="tabular-nums text-slate-500">{events ? counts[k] : "…"}</span>
          </button>
        ))}
        {people.length > 0 && <span className="mx-1 h-5 w-px bg-white/10" />}
        {people.map((p) => (
          <button
            key={p.id}
            onClick={() => set({ who: whoId === p.id ? null : p.id })}
            className={clsx(
              "flex items-center gap-1.5 rounded-xl border py-1 pl-1 pr-3 text-xs font-semibold transition",
              whoId === p.id ? "border-pink-400/50 bg-pink-500/20 text-white" : "border-white/5 bg-white/[0.02] text-slate-400 hover:text-white",
            )}
          >
            {p.cover ? <img src={faceURL(p.cover)} alt="" className="size-6 rounded-full object-cover" /> : <UserRound className="size-4" />}
            {p.name}
            <span className="tabular-nums text-slate-500">{events ? (whoCounts[p.id] ?? 0) : "…"}</span>
          </button>
        ))}
        {pending > 0 && (
          <span className="ml-1 flex items-center gap-1.5 text-xs text-slate-500" title="Events are checked for people and animals in the background">
            <Loader2 className="size-3 animate-spin" /> {pending} still being checked
          </span>
        )}
      </div>

      {/* When / where (not while searching: the question says that) */}
      {!asked && (
        <div className="mb-6 flex flex-wrap items-center gap-2">
          <div className="glass flex rounded-xl p-1">
            {RANGES.map((r, i) => (
              <button key={r.id} onClick={() => setRange(i)} className={clsx("rounded-lg px-3 py-1.5 text-xs font-medium transition", range === i ? "bg-white/10 text-white" : "text-slate-400 hover:text-white")}>
                {r.label}
              </button>
            ))}
          </div>
          {(status?.cameras ?? []).map((c) => {
            const on = cams.length === 0 || cams.includes(c.id);
            return (
              <button
                key={c.id}
                onClick={() => toggleCam(c.id)}
                className={clsx("rounded-full border px-3 py-1.5 text-xs font-medium transition", on && cams.length ? "border-violet-400/40 bg-violet-500/15 text-violet-200" : on ? "border-white/10 bg-white/5 text-slate-300" : "border-white/5 text-slate-500")}
              >
                {c.name}
              </button>
            );
          })}
          {cams.length > 0 && (
            <button onClick={() => set({ cams: null })} className="text-xs text-slate-400 underline-offset-2 hover:text-white hover:underline">
              All cameras
            </button>
          )}
          {range === CUSTOM && (
            <div className="glass flex flex-wrap items-center gap-2 rounded-xl px-2 py-1">
              <input type="datetime-local" value={custom.from} onChange={(e) => setCustom("from", e.target.value)} className="h-8 rounded-lg border border-white/10 bg-ink-950 px-2 text-xs text-white [color-scheme:dark]" />
              <span className="text-xs text-slate-500">to</span>
              <input type="datetime-local" value={custom.to} onChange={(e) => setCustom("to", e.target.value)} className="h-8 rounded-lg border border-white/10 bg-ink-950 px-2 text-xs text-white [color-scheme:dark]" />
            </div>
          )}
          <label className="ml-auto flex items-center gap-2 text-xs text-slate-400">
            Min. size
            <input type="range" min={0} max={10} step={0.5} value={minPeak} onChange={(e) => setMinPeak(Number(e.target.value))} className="w-28" />
            <span className="w-8 tabular-nums text-slate-300">{minPeak}%</span>
          </label>
        </div>
      )}
      {asked && <div className="mb-6" />}

      {events && total === 0 ? (
        <Empty
          icon={<Zap className="size-6" />}
          title={asked ? "Nothing found" : kind === "all" ? "No motion events" : `No ${kind === "motion" ? "plain motion" : LABELS[kind].plural.toLowerCase()} here`}
          sub={asked ? "Try fewer words, another day, or all cameras." : "Nothing matching in front of the selected cameras in this period."}
        />
      ) : !events ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          {Array.from({ length: 10 }, (_, i) => (
            <div key={i} className="skeleton aspect-video rounded-xl" />
          ))}
        </div>
      ) : (
        groups.map((g) => (
          <section key={g.day} className="mb-8">
            <h2 className="sticky top-0 z-10 -mx-1 mb-3 bg-ink-950/80 px-1 py-2 text-sm font-semibold text-slate-300 backdrop-blur">
              {fmtDay(g.day)} <span className="font-normal text-slate-500">· {perDay.get(g.day)}</span>
            </h2>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
              {g.items.map((e, i) => (
                <motion.button
                  key={e.id}
                  data-ev={e.id}
                  initial={animate.current ? { opacity: 0, y: 8 } : false}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(i, 15) * 0.02 }}
                  whileHover={{ y: -3 }}
                  onClick={() => openEvent(nav, e, matching, "Events", listKey, shown)}
                  className={clsx(
                    "group overflow-hidden rounded-xl border bg-ink-850 text-left shadow-lg shadow-black/30",
                    e.id === lastSeen ? "border-violet-400/70 ring-2 ring-violet-400/40" : "border-white/[0.07]",
                  )}
                >
                  <div className="relative aspect-video">
                    <EventPicture e={e} className="h-full w-full transition duration-500 group-hover:scale-105" />
                    <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition group-hover:opacity-100">
                      <span className="flex size-11 items-center justify-center rounded-full bg-white/90 text-ink-950">
                        <Play className="ml-0.5 size-5 fill-current" />
                      </span>
                    </div>
                    <span className="absolute left-2 top-2 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold text-white backdrop-blur">{names[e.camera] ?? e.camera}</span>
                    {!e.end ? (
                      <span className="absolute right-2 top-2 rounded-md bg-amber-400 px-1.5 py-0.5 text-[10px] font-bold text-black">LIVE</span>
                    ) : (
                      e.id === lastSeen && <span className="absolute right-2 top-2 rounded-md bg-violet-500 px-1.5 py-0.5 text-[10px] font-semibold text-white shadow">Last watched</span>
                    )}
                    <span className="absolute bottom-2 left-2">
                      <LabelChips
                        e={e}
                        showMotion
                        onWrong={(l) =>
                          api
                            .wrongLabel(e, l)
                            .then((n) => setEvents((list) => list?.map((x) => (x.id === n.id ? n : x)) ?? null))
                            .catch(() => {})
                        }
                      />
                    </span>
                  </div>
                  <div className="flex items-center justify-between px-3 py-2">
                    <span className="text-sm font-medium text-white">
                      {asked ? `${fmtDay(e.start)} ` : ""}
                      {fmtTimeSec(e.start)}
                    </span>
                    <span className="text-xs text-slate-500">{e.end ? fmtDuration(e.end - e.start) : "now"}</span>
                  </div>
                </motion.button>
              ))}
            </div>
          </section>
        ))
      )}
      {events && total > shown && (
        <div ref={more} className="flex justify-center pb-4">
          <Button onClick={() => setShown((n) => n + PAGE)}>
            Show more <span className="text-slate-500">· {total - shown} left</span>
          </Button>
        </div>
      )}
    </>
  );
}
