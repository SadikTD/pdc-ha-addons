import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import clsx from "clsx";
import { Columns2, Expand, ImageOff, Loader2, Maximize2, Minimize2, Pause, Play, RotateCcw, RotateCw, SkipBack, SkipForward, Volume2, VolumeX, ZoomIn, ZoomOut } from "lucide-react";
import { SyncPlayer } from "../components/SyncPlayer";
import { Scrubber, MIN_RANGE, MAX_RANGE } from "../components/Scrubber";
import { JumpTo } from "../components/JumpTo";
import { ZoomPan } from "../components/ZoomPan";
import { Empty, IconButton } from "../components/ui";
import { useStatus } from "../lib/status";
import { useToast } from "../lib/toast";
import { useTimeline } from "../lib/useTimeline";
import { usePreviewFrame, prefetchPreviews } from "../lib/usePreview";
import { api, type SentinelEvent, type Span } from "../lib/api";
import { DAY, HOUR, fmtDay, fmtTimeSec } from "../lib/format";
import { fitGrid } from "../lib/layout";

const RATES = [1, 2, 4, 8];
const ZOOMS: [string, number][] = [["5m", 5 * 60_000], ["30m", 30 * 60_000], ["1h", HOUR], ["6h", 6 * HOUR], ["24h", DAY]];
const GAP = 8;
const MIN_TILE = 300; // px: below this the grid scrolls instead of shrinking further
const NO_STYLE: React.CSSProperties = {};

function mergeSpans(lists: Span[][]): Span[] {
  const all = lists.flat().sort((a, b) => a.s - b.s);
  const out: Span[] = [];
  for (const s of all) {
    const last = out.at(-1);
    if (last && s.s <= last.e + 3000) last.e = Math.max(last.e, s.e);
    else out.push({ ...s });
  }
  return out;
}

// Every camera playing the same moment side by side, on one clock.
export function PlaybackPage() {
  const { status } = useStatus();
  const toast = useToast();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const initial = Math.min(Number(params.get("t")) || Date.now() - 5 * 60_000, Date.now() - 30_000);

  const all = useMemo(
    () => (status?.cameras ?? []).filter((c) => c.enabled || c.storage.count > 0).map((c) => ({ id: c.id, name: c.name })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [status?.cameras.map((c) => c.id + c.name).join()],
  );
  const [hidden, setHidden] = useState<string[]>(() => JSON.parse(localStorage.getItem("sentinel.playback.hidden") ?? "[]"));
  const cams = useMemo(() => all.filter((c) => !hidden.includes(c.id)), [all, hidden]);

  // Shared clock: base time at a performance.now() instant, advancing at `rate` while playing.
  const clock = useRef({ base: initial, at: performance.now(), rate: 1, playing: true });
  const master = useCallback(() => {
    const c = clock.current;
    return c.playing ? c.base + (performance.now() - c.at) * c.rate : c.base;
  }, []);
  const [t, setT] = useState(initial);
  const [epoch, setEpoch] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [rate, setRate] = useState(1);
  const [range, setRange] = useState(HOUR);
  const [scrubT, setScrubT] = useState<number | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [audio, setAudio] = useState<string | null>(null);
  const [jumpOpen, setJumpOpen] = useState(false);
  const [events, setEvents] = useState<SentinelEvent[]>([]);
  const [now, setNow] = useState(Date.now());
  const wasPlaying = useRef(true);
  const stage = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1000, h: 560 });

  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    if (stage.current) ro.observe(stage.current);
    return () => ro.disconnect();
  }, []);

  const rebase = (patch: Partial<typeof clock.current>) => {
    clock.current = { ...clock.current, base: master(), at: performance.now(), ...patch };
  };
  const seek = useCallback((to: number) => {
    const v = Math.min(to, Date.now() - 5000);
    clock.current = { ...clock.current, base: v, at: performance.now() };
    setT(v);
    setEpoch((e) => e + 1);
  }, []);
  const setPlay = (p: boolean) => {
    rebase({ playing: p });
    setPlaying(p);
  };

  useEffect(() => {
    const id = window.setInterval(() => {
      const m = master();
      if (clock.current.playing && m > Date.now() - 4000) {
        rebase({ base: Date.now() - 4000, playing: false });
        setPlaying(false);
        toast("Caught up with the present", "info");
      }
      setT(master());
      setNow(Date.now());
    }, 250);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    for (const c of cams) prefetchPreviews(c.id, initial, HOUR, 16);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cams.map((c) => c.id).join()]);

  const center = scrubT ?? t;
  const lanes = useTimeline(cams, center - range / 2, center + range / 2);
  const spans = useMemo(() => mergeSpans(lanes.map((l) => l.spans)), [lanes]);
  const activity = useMemo(() => lanes.flatMap((l) => l.activity), [lanes]);

  const hourBucket = Math.floor(center / HOUR);
  useEffect(() => {
    api
      .events({ cameras: cams.map((c) => c.id), from: center - 12 * HOUR, to: center + 12 * HOUR, limit: 3000 })
      .then(setEvents)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hourBucket, cams.map((c) => c.id).join(), Math.floor(now / 30_000)]);

  const jumpEvent = (dir: -1 | 1) => {
    const sorted = [...events].sort((a, b) => a.start - b.start);
    const e = dir < 0 ? [...sorted].reverse().find((x) => x.start < t - 6000) : sorted.find((x) => x.start > t + 1000);
    if (!e) return toast(dir < 0 ? "No earlier motion" : "No later motion", "info");
    seek(e.start - 3000);
  };

  const setRateTo = (r: number) => {
    rebase({ rate: r });
    setRate(r);
  };

  const toggleHidden = (id: string) => {
    const next = hidden.includes(id) ? hidden.filter((x) => x !== id) : [...hidden, id];
    setHidden(next);
    localStorage.setItem("sentinel.playback.hidden", JSON.stringify(next));
    if (focus === id) setFocus(null);
  };

  // Scrubbing: every tile shows preview frames; letting go moves every camera there.
  const onScrubStart = () => {
    wasPlaying.current = clock.current.playing;
    if (clock.current.playing) setPlay(false);
  };
  const onScrubEnd = (to: number) => {
    setScrubT(null);
    seek(to);
    if (wasPlaying.current) setPlay(true);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input,textarea,select")) return;
      if (e.key === " ") (e.preventDefault(), setPlay(!clock.current.playing));
      else if (e.key === "ArrowLeft") seek(master() - (e.shiftKey ? 60_000 : 10_000));
      else if (e.key === "ArrowRight") seek(master() + (e.shiftKey ? 60_000 : 10_000));
      else if (e.key === "[") jumpEvent(-1);
      else if (e.key === "]") jumpEvent(1);
      else if (e.key === "g" || e.key === "G") (e.preventDefault(), setJumpOpen(true));
      else if (e.key === "f" || e.key === "F") fullscreen();
      else if (e.key === "Escape") setFocus(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const fullscreen = () => (document.fullscreenElement ? document.exitFullscreen() : page.current?.requestFullscreen?.());
  const oldest = Math.min(...(status?.cameras ?? []).filter((c) => c.storage.oldest).map((c) => c.storage.oldest));

  // Focus: one big camera with the others in a strip underneath.
  const focused = focus ? cams.find((c) => c.id === focus) : undefined;
  const others = focused ? cams.filter((c) => c.id !== focused.id) : cams;
  const stripH = focused && others.length ? Math.min(120, Math.max(72, size.h * 0.18)) : 0;
  const grid = focused ? fitGrid(1, size.w, size.h - stripH - (stripH ? GAP : 0), MIN_TILE, GAP) : fitGrid(cams.length, size.w, size.h, MIN_TILE, GAP);
  const bigStyle = useMemo(() => ({ width: grid.tile }), [grid.tile]);
  const stripStyle = useMemo<React.CSSProperties>(() => ({ height: stripH, width: (stripH * 16) / 9, flex: "none" }), [stripH]);

  // Stable handlers (by camera id) so the tiles only redraw when their own props change,
  // not on every tick of the playback clock.
  const onAudio = useCallback((id: string) => setAudio((a) => (a === id ? null : id)), []);
  const onFocus = useCallback((id: string) => setFocus((f) => (f === id ? null : id)), []);
  const onOpen = useCallback((id: string) => nav(`/camera/${id}?t=${Math.round(master())}`), [nav, master]);

  const tile = (c: { id: string; name: string }, style: React.CSSProperties, small = false) => (
    <Tile
      key={c.id}
      id={c.id}
      name={c.name}
      style={style}
      small={small}
      master={master}
      playing={playing}
      rate={rate}
      epoch={epoch}
      muted={audio !== c.id}
      scrubT={scrubT}
      focused={focus === c.id}
      onAudio={onAudio}
      onFocus={onFocus}
      onOpen={onOpen}
    />
  );

  return (
    <div ref={page} className="flex flex-col gap-3 bg-ink-950 md:h-[calc(100dvh-4.5rem)]">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-2 text-2xl font-semibold tracking-tight text-white">Playback</h1>
        {all.map((c) => {
          const on = !hidden.includes(c.id);
          return (
            <button
              key={c.id}
              onClick={() => toggleHidden(c.id)}
              title={on ? "Hide this camera" : "Show this camera"}
              className={clsx("rounded-full border px-3 py-1 text-xs font-medium transition", on ? "border-violet-400/40 bg-violet-500/15 text-violet-100" : "border-white/5 text-slate-500 hover:text-slate-300")}
            >
              {c.name}
            </button>
          );
        })}
        <div className="ml-auto">
          <JumpTo onJump={seek} oldest={Number.isFinite(oldest) ? oldest : undefined} open={jumpOpen} setOpen={setJumpOpen} />
        </div>
      </div>

      {status && all.length === 0 ? (
        <Empty icon={<Columns2 className="size-6" />} title="No cameras yet" />
      ) : (
        <>
          <div ref={stage} className="relative min-h-[50vh] flex-1 overflow-y-auto md:min-h-0">
            {focused ? (
              <div className="flex h-full flex-col items-center gap-2">
                {tile(focused, bigStyle)}
                {others.length > 0 && (
                  <div className="flex max-w-full gap-2 overflow-x-auto" style={{ height: stripH }}>
                    {others.map((c) => tile(c, stripStyle, true))}
                  </div>
                )}
              </div>
            ) : (
              <div className="flex min-h-full items-center justify-center">
                <div className="grid" style={{ gap: GAP, gridTemplateColumns: `repeat(${grid.cols}, ${grid.tile}px)` }}>
                  {cams.map((c) => tile(c, NO_STYLE))}
                </div>
              </div>
            )}
          </div>

          <div className="glass shrink-0 rounded-2xl px-3 pb-2 pt-2">
            <div className="mb-5 flex flex-wrap items-center gap-1">
              <IconButton title="Previous motion on any camera ( [ )" onClick={() => jumpEvent(-1)}>
                <SkipBack className="size-4" />
              </IconButton>
              <IconButton title="Back 10 s (←)" onClick={() => seek(master() - 10_000)}>
                <RotateCcw className="size-4" />
              </IconButton>
              <IconButton title={playing ? "Pause (space)" : "Play (space)"} onClick={() => setPlay(!playing)} className="size-10 bg-white/5">
                {playing ? <Pause className="size-5 fill-current" /> : <Play className="size-5 fill-current" />}
              </IconButton>
              <IconButton title="Forward 10 s (→)" onClick={() => seek(master() + 10_000)}>
                <RotateCw className="size-4" />
              </IconButton>
              <IconButton title="Next motion on any camera ( ] )" onClick={() => jumpEvent(1)}>
                <SkipForward className="size-4" />
              </IconButton>
              <div className="mx-1 flex rounded-xl bg-white/5 p-0.5">
                {RATES.map((r) => (
                  <button key={r} onClick={() => setRateTo(r)} className={clsx("rounded-lg px-2 py-1 text-xs font-semibold tabular-nums transition", rate === r ? "bg-violet-500 text-white" : "text-slate-400 hover:text-white")}>
                    {r}×
                  </button>
                ))}
              </div>
              <span className="ml-1 hidden font-mono text-sm font-semibold text-white sm:inline">
                {fmtDay(center)} · {fmtTimeSec(center)}
              </span>
              <div className="ml-auto flex items-center gap-0.5">
                {ZOOMS.map(([l, r]) => (
                  <button
                    key={l}
                    onClick={() => setRange(r)}
                    className={clsx("hidden rounded-lg px-2 py-1 text-xs font-medium transition md:block", Math.abs(range - r) < 1000 ? "bg-white/10 text-white" : "text-slate-400 hover:bg-white/5 hover:text-white")}
                  >
                    {l}
                  </button>
                ))}
                <IconButton title="Zoom in" onClick={() => setRange((r) => Math.max(MIN_RANGE, r / 2))} className="size-8">
                  <ZoomIn className="size-4" />
                </IconButton>
                <IconButton title="Zoom out" onClick={() => setRange((r) => Math.min(MAX_RANGE, r * 2))} className="size-8">
                  <ZoomOut className="size-4" />
                </IconButton>
                <IconButton title="Fullscreen (F)" onClick={fullscreen} className="size-8">
                  <Expand className="size-4" />
                </IconButton>
              </div>
            </div>
            <Scrubber
              camera={focus ?? cams[0]?.id ?? ""}
              spans={spans}
              activity={activity}
              events={events}
              now={now}
              center={center}
              range={range}
              live={false}
              onScrubStart={onScrubStart}
              onScrub={setScrubT}
              onScrubEnd={onScrubEnd}
              onRange={setRange}
            />
          </div>
        </>
      )}
    </div>
  );
}

const Tile = memo(function Tile({
  id,
  name,
  style,
  small,
  master,
  playing,
  rate,
  epoch,
  muted,
  scrubT,
  focused,
  onAudio,
  onFocus,
  onOpen,
}: {
  id: string;
  name: string;
  style: React.CSSProperties;
  small: boolean;
  master: () => number;
  playing: boolean;
  rate: number;
  epoch: number;
  muted: boolean;
  scrubT: number | null;
  focused: boolean;
  onAudio: (id: string) => void;
  onFocus: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  const preview = usePreviewFrame(scrubT !== null ? id : null, scrubT);
  const picture = (
    <>
      <SyncPlayer camera={id} master={master} playing={playing} rate={rate} epoch={epoch} muted={muted} />
      <AnimatePresence>
        {scrubT !== null && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.3 } }} transition={{ duration: 0.1 }} className="absolute inset-0 bg-black">
            {preview?.url ? (
              <img src={preview.url} className="h-full w-full object-contain" draggable={false} />
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-slate-500">{preview ? <ImageOff className="size-5" /> : <Loader2 className="size-5 animate-spin" />}</div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
  return (
    <motion.div
      layout
      transition={{ type: "spring", stiffness: 420, damping: 40 }}
      style={style}
      className={clsx("group relative aspect-video overflow-hidden rounded-xl border bg-black", focused ? "border-violet-400/40" : "border-white/[0.07]", small && "cursor-pointer")}
      onClick={small ? () => onFocus(id) : undefined}
      onDoubleClick={small || focused ? undefined : () => onOpen(id)}
    >
      {/* The enlarged camera zooms like the Live page: scroll, drag, double-click, pinch. */}
      {focused ? <ZoomPan resetKey={id}>{picture}</ZoomPan> : picture}
      <div className="pointer-events-none absolute inset-x-0 top-0 bg-gradient-to-b from-black/60 to-transparent p-2">
        <span className={clsx("font-semibold text-white drop-shadow", small ? "text-[11px]" : "text-sm")}>{name}</span>
      </div>
      {!small && (
        <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition group-hover:opacity-100">
          <IconButton title={muted ? "Listen to this camera" : "Mute"} onClick={() => onAudio(id)} className="size-8 bg-black/50">
            {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
          </IconButton>
          <IconButton title={focused ? "Back to all cameras (Esc)" : "Enlarge"} onClick={() => onFocus(id)} className="size-8 bg-black/50">
            {focused ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          </IconButton>
        </div>
      )}
    </motion.div>
  );
});
