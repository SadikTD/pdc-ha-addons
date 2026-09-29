import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { motion } from "motion/react";
import clsx from "clsx";
import { Loader2, Play, Search, X, Zap } from "lucide-react";
import { Button, Empty, PageHeader } from "../components/ui";
import { useStatus } from "../lib/status";
import { api, type Label, type SearchQuery, type SentinelEvent } from "../lib/api";
import { DAY, HOUR, fmtDay, fmtDuration, fmtTimeSec, startOfDay } from "../lib/format";
import { EventPicture, LABELS, LABEL_ORDER, LabelChips, SEARCH_EXAMPLES } from "../lib/labels";

const RANGES = [
  { label: "Today", from: () => startOfDay(Date.now()) },
  { label: "24 hours", from: () => Date.now() - DAY },
  { label: "7 days", from: () => Date.now() - 7 * DAY },
  { label: "Custom", from: () => 0 },
];
const CUSTOM = 3;
const PAGE = 120; // events drawn at a time; "Show more" adds the next batch

type Kind = "all" | Label | "motion";

function toLocalInput(ms: number) {
  return new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function EventsPage() {
  const { status } = useStatus();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const [cams, setCams] = useState<string[]>([]);
  const [range, setRange] = useState(1);
  const [kind, setKind] = useState<Kind>((params.get("kind") as Kind) || "all");
  const [minPeak, setMinPeak] = useState(0);
  const [custom, setCustom] = useState(() => ({ from: toLocalInput(startOfDay(Date.now()) - DAY + 22 * HOUR), to: toLocalInput(startOfDay(Date.now()) + 6 * HOUR) }));
  const [events, setEvents] = useState<SentinelEvent[] | null>(null);
  const [shown, setShown] = useState(PAGE);
  // Search: the text being typed, and the question asked (from the URL, so it can be shared).
  const asked = params.get("q") ?? "";
  const [text, setText] = useState(asked);
  const [parsed, setParsed] = useState<SearchQuery | null>(null);
  const [searching, setSearching] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const names = Object.fromEntries((status?.cameras ?? []).map((c) => [c.id, c.name]));

  const ask = (q: string) => {
    setText(q);
    const p = new URLSearchParams(params);
    if (q.trim()) p.set("q", q.trim());
    else p.delete("q");
    setParams(p, { replace: true });
  };

  useEffect(() => {
    let alive = true;
    setShown(PAGE);
    if (asked) {
      setSearching(true);
      const load = () =>
        api
          .search(asked, 1000)
          .then((r) => {
            if (!alive) return;
            setEvents(r.events);
            setParsed(r.query);
          })
          .catch(() => alive && setEvents([]))
          .finally(() => alive && setSearching(false));
      load();
      const t = window.setInterval(load, 20_000);
      return () => {
        alive = false;
        window.clearInterval(t);
      };
    }
    setParsed(null);
    const from = range === CUSTOM ? new Date(custom.from).getTime() : RANGES[range].from();
    const to = range === CUSTOM ? new Date(custom.to).getTime() : Date.now() + HOUR;
    if (!(from < to)) return setEvents([]);
    const load = () =>
      api
        .events({ cameras: cams, from, to, limit: 3000 })
        .then((e) => alive && setEvents(e))
        .catch(() => {});
    load();
    // Only a range that reaches the present can get new events.
    const t = to > Date.now() - HOUR ? window.setInterval(load, 15_000) : 0;
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [asked, cams.join(), range, custom.from, custom.to]);

  const sized = useMemo(() => (events ?? []).filter((e) => e.peak >= minPeak), [events, minPeak]);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: sized.length, motion: 0, person: 0, cat: 0, dog: 0 };
    for (const e of sized) {
      if (e.labels?.length) for (const l of e.labels) c[l]++;
      else if (e.scan === "done") c.motion++;
    }
    return c;
  }, [sized]);
  const matching = useMemo(
    () => sized.filter((e) => (kind === "all" ? true : kind === "motion" ? e.scan === "done" && !e.labels?.length : e.labels?.includes(kind))),
    [sized, kind],
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

  const toggleCam = (id: string) => setCams((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  const total = matching.length;
  const pending = status?.detection?.backlog ?? 0;
  const kinds: { k: Kind; label: string; icon?: typeof Zap; color?: string }[] = [
    { k: "all", label: "All" },
    ...LABEL_ORDER.map((l) => ({ k: l as Kind, label: LABELS[l].plural, icon: LABELS[l].icon, color: LABELS[l].color })),
    { k: "motion", label: "Motion only", icon: Zap, color: "#fbbf24" },
  ];
  const what = kind === "all" ? "event" : kind === "motion" ? "plain motion event" : `event${""} with ${LABELS[kind].plural.toLowerCase()}`;

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
              <button onClick={() => ask("")} className="ml-1 text-xs text-slate-400 underline-offset-2 hover:text-white hover:underline">
                Clear
              </button>
            </>
          ) : (
            <>
              <span className="text-xs text-slate-500">Try:</span>
              {SEARCH_EXAMPLES.map((q) => (
                <button key={q} onClick={() => ask(q)} className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-0.5 text-xs text-slate-300 transition hover:border-white/20 hover:text-white">
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
            onClick={() => {
              setKind(k);
              const p = new URLSearchParams(params);
              if (k === "all") p.delete("kind");
              else p.set("kind", k);
              setParams(p, { replace: true });
            }}
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
              <button key={r.label} onClick={() => setRange(i)} className={clsx("rounded-lg px-3 py-1.5 text-xs font-medium transition", range === i ? "bg-white/10 text-white" : "text-slate-400 hover:text-white")}>
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
          {range === CUSTOM && (
            <div className="glass flex flex-wrap items-center gap-2 rounded-xl px-2 py-1">
              <input type="datetime-local" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} className="h-8 rounded-lg border border-white/10 bg-ink-950 px-2 text-xs text-white [color-scheme:dark]" />
              <span className="text-xs text-slate-500">to</span>
              <input type="datetime-local" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} className="h-8 rounded-lg border border-white/10 bg-ink-950 px-2 text-xs text-white [color-scheme:dark]" />
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
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(i, 15) * 0.02 }}
                  whileHover={{ y: -3 }}
                  onClick={() => nav(`/camera/${e.camera}?t=${(e.objects?.[0]?.t ?? e.start) - 3000}`)}
                  className="group overflow-hidden rounded-xl border border-white/[0.07] bg-ink-850 text-left shadow-lg shadow-black/30"
                >
                  <div className="relative aspect-video">
                    <EventPicture e={e} className="h-full w-full transition duration-500 group-hover:scale-105" />
                    <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition group-hover:opacity-100">
                      <span className="flex size-11 items-center justify-center rounded-full bg-white/90 text-ink-950">
                        <Play className="ml-0.5 size-5 fill-current" />
                      </span>
                    </div>
                    <span className="absolute left-2 top-2 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold text-white backdrop-blur">{names[e.camera] ?? e.camera}</span>
                    {!e.end && <span className="absolute right-2 top-2 rounded-md bg-amber-400 px-1.5 py-0.5 text-[10px] font-bold text-black">LIVE</span>}
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
                    <span className="text-sm font-medium text-white">{asked ? `${fmtDay(e.start)} ` : ""}{fmtTimeSec(e.start)}</span>
                    <span className="text-xs text-slate-500">{e.end ? fmtDuration(e.end - e.start) : "now"}</span>
                  </div>
                </motion.button>
              ))}
            </div>
          </section>
        ))
      )}
      {events && total > shown && (
        <div className="flex justify-center pb-4">
          <Button onClick={() => setShown((n) => n + PAGE)}>
            Show more <span className="text-slate-500">· {total - shown} left</span>
          </Button>
        </div>
      )}
    </>
  );
}
