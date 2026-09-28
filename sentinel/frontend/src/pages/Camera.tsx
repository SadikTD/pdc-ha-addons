import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import clsx from "clsx";
import {
  ArrowLeft, Camera as CamIcon, Save, Expand, PlayCircle, Loader2, Pause, Play, Radio, RotateCcw, RotateCw, Scissors, SkipBack, SkipForward,
  Volume2, VolumeX, X, ZoomIn, ZoomOut, Zap, ImageOff,
} from "lucide-react";
import { LiveStream } from "../components/LiveStream";
import { VodPlayer, type VodHandle } from "../components/VodPlayer";
import { Scrubber, MIN_RANGE, MAX_RANGE } from "../components/Scrubber";
import { ZoomPan } from "../components/ZoomPan";
import { Button, Card, IconButton, StatePill, recState } from "../components/ui";
import { useStatus } from "../lib/status";
import { useToast } from "../lib/toast";
import { useTimeline } from "../lib/useTimeline";
import { usePreviewFrame, prefetchPreviews } from "../lib/usePreview";
import { api, thumbURL, type SentinelEvent, type Span } from "../lib/api";
import { DAY, HOUR, fmtBitrate, fmtBytes, fmtDay, fmtDuration, fmtTimeSec } from "../lib/format";

const RATES = [1, 2, 4, 8, 16];
const ZOOMS: [string, number][] = [["5m", 5 * 60_000], ["30m", 30 * 60_000], ["1h", HOUR], ["6h", 6 * HOUR], ["24h", DAY]];

function findPlayable(spans: Span[], t: number): number | null {
  for (const s of spans) {
    if (t >= s.s && t < s.e - 1000) return t;
    if (s.s > t) return s.s;
  }
  return null;
}

// Remount per camera / deep link so playback state never leaks between cameras.
export function CameraPage() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  return <CameraView key={id + ":" + (params.get("t") ?? "")} id={id} initialT={Number(params.get("t")) || 0} />;
}

function CameraView({ id, initialT }: { id: string; initialT: number }) {
  const { status } = useStatus();
  const toast = useToast();
  const cam = status?.cameras.find((c) => c.id === id);

  const [now, setNow] = useState(Date.now());
  const [mode, setMode] = useState<"live" | "playback">(initialT ? "playback" : "live");
  const [seek, setSeek] = useState({ t: initialT, n: 0 });
  const [curT, setCurT] = useState<number | null>(initialT || null);
  const [scrubT, setScrubT] = useState<number | null>(null);
  const [pendingT, setPendingT] = useState<number | null>(null);
  const [playing, setPlaying] = useState(true);
  const [rate, setRate] = useState(1);
  const [audio, setAudio] = useState(false);
  const [range, setRange] = useState(HOUR);
  const [selection, setSelection] = useState<{ from: number; to: number } | null>(null);
  const [events, setEvents] = useState<SentinelEvent[]>([]);
  const vod = useRef<VodHandle>(null);
  const liveVideo = useRef<HTMLVideoElement | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const pendingTimer = useRef(0);
  const previewUntil = useRef<number | null>(null);

  const center = scrubT ?? pendingT ?? (mode === "live" ? now : (curT ?? now));
  const live = mode === "live" && scrubT === null && pendingT === null;

  const lanes = useTimeline(useMemo(() => [{ id, name: cam?.name ?? id }], [id, cam?.name]), center - range / 2, center + range / 2);
  const spans = lanes[0]?.spans ?? [];

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    prefetchPreviews(id, initialT || Date.now() - 2 * 60_000, range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const dayBucket = Math.floor((center - range) / DAY);
  useEffect(() => {
    const from = Math.min(center - range, now - DAY);
    api.events({ cameras: [id], from: from - DAY, to: now + HOUR, limit: 1000 }).then(setEvents).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, Math.floor(now / 20_000), dayBucket]);

  const goLive = useCallback(() => {
    setMode("live");
    setCurT(null);
    setRate(1);
    setPendingT(null);
  }, []);

  const seekTo = useCallback(
    (t: number, quiet = false) => {
      if (t >= Date.now() - 4000) return goLive();
      const p = findPlayable(spans, t);
      if (p === null || p >= Date.now() - 4000) {
        if (!quiet) toast("No recording after that point — showing live", "info");
        return goLive();
      }
      if (p - t > 5000 && !quiet) toast(`No recording at ${fmtTimeSec(t)} — jumped to ${fmtTimeSec(p)}`, "info");
      setMode("playback");
      setCurT(p);
      setPendingT(p);
      window.clearTimeout(pendingTimer.current);
      pendingTimer.current = window.setTimeout(() => setPendingT(null), 8000);
      setSeek((s) => ({ t: p, n: s.n + 1 }));
    },
    [spans, goLive, toast],
  );

  // ---- scrubbing ----
  const onScrubStart = () => {
    if (mode === "playback") vod.current?.video?.pause();
  };
  const onScrubEnd = (t: number) => {
    setScrubT(null);
    seekTo(t, true);
  };

  const preview = usePreviewFrame(scrubT !== null || pendingT !== null ? id : null, scrubT ?? pendingT);
  const showOverlay = scrubT !== null || pendingT !== null;

  const nudge = (sec: number) => {
    const base = mode === "live" ? Date.now() : (curT ?? Date.now());
    seekTo(base + sec * 1000, true);
  };

  const jumpEvent = (dir: -1 | 1) => {
    const ref = center + dir * 3000;
    const sorted = [...events].sort((a, b) => a.start - b.start);
    const e = dir < 0 ? [...sorted].reverse().find((x) => x.start < ref - 3000) : sorted.find((x) => x.start > ref);
    if (!e) return toast(dir < 0 ? "No earlier motion" : "No later motion", "info");
    seekTo(e.start - 3000, true);
  };

  const togglePlay = () => {
    if (mode === "live") return seekTo(Date.now() - 10_000, true);
    vod.current?.toggle();
  };

  const snapshot = () => {
    const v = mode === "live" ? liveVideo.current : vod.current?.video;
    if (!v || !v.videoWidth) return toast("No frame to capture yet", "error");
    const c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext("2d")!.drawImage(v, 0, 0);
    const t = mode === "live" ? Date.now() : (curT ?? Date.now());
    c.toBlob((b) => {
      if (!b) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(b);
      a.download = `${id}_${new Date(t).toISOString().replace(/[:.]/g, "-")}.jpg`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }, "image/jpeg", 0.92);
    toast("Snapshot saved");
  };

  const startClip = () => {
    const mid = Math.min(center, Date.now() - 20_000);
    setSelection({ from: mid - 15_000, to: Math.min(Date.now() - 2000, mid + 15_000) });
    setRange((r) => Math.min(r, 10 * 60_000));
  };
  const markIn = () => setSelection((s) => (s ? { from: Math.min(center, s.to - 1000), to: s.to } : { from: center, to: Math.min(Date.now() - 2000, center + 30_000) }));
  const markOut = () => setSelection((s) => (s ? { from: s.from, to: Math.max(center, s.from + 1000) } : { from: center - 30_000, to: center }));
  const previewClip = () => {
    if (!selection) return;
    previewUntil.current = selection.to;
    seekTo(selection.from, true);
  };

  const fullscreen = () => {
    const el = stage.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else el.requestFullscreen?.();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input,textarea,select")) return;
      if (e.key === " ") (e.preventDefault(), togglePlay());
      else if (e.key === "ArrowLeft") nudge(e.shiftKey ? -60 : -10);
      else if (e.key === "ArrowRight") nudge(e.shiftKey ? 60 : 10);
      else if (e.key === "[") jumpEvent(-1);
      else if (e.key === "]") jumpEvent(1);
      else if (e.key === "i" || e.key === "I") markIn();
      else if (e.key === "o" || e.key === "O") markOut();
      else if (e.key === "Escape") setSelection(null);
      else if (e.key === "l" || e.key === "L") goLive();
      else if (e.key === "f" || e.key === "F") fullscreen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const zoom = (f: number) => setRange((r) => Math.min(MAX_RANGE, Math.max(MIN_RANGE, r * f)));

  const listEvents = events.filter((e) => e.start >= center - Math.max(range, 6 * HOUR) && e.start <= center + Math.max(range, 6 * HOUR));

  if (status && !cam) {
    return (
      <div className="py-20 text-center text-slate-400">
        Camera not found. <Link to="/" className="text-violet-300 underline">Back to live view</Link>
      </div>
    );
  }

  const state = cam ? recState(cam.enabled, cam.record, cam.recorder) : "starting";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link to="/" className="flex size-9 items-center justify-center rounded-xl bg-white/5 text-slate-300 transition hover:bg-white/10 hover:text-white">
            <ArrowLeft className="size-4" />
          </Link>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-white md:text-2xl">{cam?.name ?? "…"}</h1>
            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <StatePill state={state} />
              {cam?.recorder?.stream.video_codec && (
                <span>
                  {cam.recorder.stream.width}×{cam.recorder.stream.height} · {cam.recorder.stream.video_codec.toUpperCase()} · {cam.recorder.stream.fps} fps
                </span>
              )}
              {cam?.recorder && cam.recorder.bitrate_kbps > 0 && <span>· {fmtBitrate(cam.recorder.bitrate_kbps)}</span>}
              {cam && <span>· {fmtBytes(cam.storage.bytes)} stored</span>}
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
        <div className="flex min-w-0 flex-col gap-3">
          {/* Player stage */}
          <div ref={stage} className="group relative aspect-video overflow-hidden rounded-2xl border border-white/[0.07] bg-black shadow-2xl shadow-black/50">
            <ZoomPan resetKey={id}>
            <div className="absolute inset-0">
              {mode === "live" ? (
                <LiveStream camera={id} hq audio={audio} className="h-full w-full" onVideo={(v) => (liveVideo.current = v)} />
              ) : (
                <VodPlayer
                  ref={vod}
                  camera={id}
                  seek={seek}
                  rate={rate}
                  onTime={(t) => {
                    if (pendingT !== null || scrubT !== null) return;
                    setCurT(t);
                    if (previewUntil.current && t >= previewUntil.current) {
                      previewUntil.current = null;
                      vod.current?.video?.pause();
                    }
                  }}
                  onPlaying={(p) => {
                    setPlaying(p);
                    if (p) setPendingT(null);
                  }}
                  onCaughtUp={() => {
                    toast("Caught up — back to live", "info");
                    goLive();
                  }}
                  onNoFootage={(t) => {
                    const next = spans.find((s) => s.s > t + 1000);
                    if (next && next.s < Date.now() - 4000) setSeek((s) => ({ t: next.s, n: s.n + 1 }));
                    else goLive();
                  }}
                />
              )}
            </div>

            {/* Scrub preview overlay */}
            <AnimatePresence>
              {showOverlay && (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.35 } }} transition={{ duration: 0.12 }} className="absolute inset-0 bg-black">
                  {preview?.url ? (
                    <img src={preview.url} className="h-full w-full object-contain" draggable={false} />
                  ) : (
                    <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-slate-500">
                      {preview ? <><ImageOff className="size-6" /> No preview for this moment</> : <Loader2 className="size-6 animate-spin" />}
                    </div>
                  )}
                  <div className="absolute inset-x-0 bottom-0 flex items-end justify-between bg-gradient-to-t from-black/70 to-transparent p-4">
                    <div>
                      <div className="font-mono text-2xl font-semibold text-white drop-shadow md:text-3xl">{fmtTimeSec(scrubT ?? pendingT ?? 0)}</div>
                      <div className="text-xs text-white/70">{fmtDay(scrubT ?? pendingT ?? 0)}</div>
                    </div>
                    <span className="flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs text-white/80 backdrop-blur">
                      {scrubT !== null ? "Release to play" : <><Loader2 className="size-3 animate-spin" /> Loading video</>}
                    </span>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
            </ZoomPan>

            {/* Top overlay */}
            <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between bg-gradient-to-b from-black/60 to-transparent p-3">
              {live ? (
                <span className="flex items-center gap-2 rounded-lg bg-rose-500/90 px-2.5 py-1 text-xs font-bold uppercase tracking-wider text-white shadow-lg">
                  <span className="size-1.5 animate-pulse-dot rounded-full bg-white" /> Live
                </span>
              ) : !showOverlay && curT ? (
                <span className="rounded-lg bg-black/60 px-2.5 py-1 font-mono text-sm font-semibold text-white backdrop-blur">
                  {fmtDay(curT)} · {fmtTimeSec(curT)}
                  {rate !== 1 && <span className="ml-2 text-cyan-300">{rate}×</span>}
                </span>
              ) : (
                <span />
              )}
              {cam?.motion?.active && live && <span className="rounded-full bg-amber-400 px-2 py-0.5 text-[10px] font-bold uppercase text-black">Motion</span>}
            </div>
          </div>

          {/* Controls */}
          <Card className="flex flex-wrap items-center gap-1 p-2">
            <IconButton title="Previous motion ( [ )" onClick={() => jumpEvent(-1)}>
              <SkipBack className="size-4" />
            </IconButton>
            <IconButton title="Back 10 s (←)" onClick={() => nudge(-10)}>
              <RotateCcw className="size-4" />
            </IconButton>
            <IconButton title={mode === "live" ? "Rewind 10 s" : playing ? "Pause (space)" : "Play (space)"} onClick={togglePlay} className="size-11 bg-white/5">
              {mode === "playback" && !playing ? <Play className="size-5 fill-current" /> : <Pause className="size-5 fill-current" />}
            </IconButton>
            <IconButton title="Forward 10 s (→)" onClick={() => nudge(10)} disabled={mode === "live"}>
              <RotateCw className="size-4" />
            </IconButton>
            <IconButton title="Next motion ( ] )" onClick={() => jumpEvent(1)} disabled={mode === "live"}>
              <SkipForward className="size-4" />
            </IconButton>
            <div className="mx-1 hidden rounded-xl bg-white/5 p-0.5 sm:flex">
              {RATES.map((r) => (
                <button
                  key={r}
                  disabled={mode === "live"}
                  onClick={() => setRate(r)}
                  className={clsx("rounded-lg px-2 py-1 text-xs font-semibold tabular-nums transition disabled:opacity-30", rate === r && mode === "playback" ? "bg-violet-500 text-white" : "text-slate-400 hover:text-white")}
                >
                  {r}×
                </button>
              ))}
            </div>
            <div className="ml-auto flex items-center gap-1">
              {mode === "live" && (
                <IconButton title={audio ? "Mute" : "Listen"} onClick={() => setAudio((a) => !a)}>
                  {audio ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
                </IconButton>
              )}
              <IconButton title="Snapshot" onClick={snapshot}>
                <CamIcon className="size-4" />
              </IconButton>
              <IconButton title="Export clip" onClick={startClip}>
                <Scissors className="size-4" />
              </IconButton>
              <IconButton title="Fullscreen (F)" onClick={fullscreen}>
                <Expand className="size-4" />
              </IconButton>
              <Button variant={live ? "ghost" : "primary"} size="sm" onClick={goLive} disabled={live} className="ml-1">
                <Radio className="size-3.5" /> Live
              </Button>
            </div>
          </Card>

          {/* Timeline */}
          <Card className="px-3 pb-3 pt-3 md:px-4">
            <div className="mb-6 flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-semibold text-white">{fmtDay(center)}</span>
              <div className="flex items-center gap-0.5">
                {ZOOMS.map(([l, r]) => (
                  <button
                    key={l}
                    onClick={() => setRange(r)}
                    className={clsx("rounded-lg px-2 py-1 text-xs font-medium transition", Math.abs(range - r) < 1000 ? "bg-white/10 text-white" : "text-slate-400 hover:bg-white/5 hover:text-white")}
                  >
                    {l}
                  </button>
                ))}
                <IconButton title="Zoom in" onClick={() => zoom(0.5)} className="size-8">
                  <ZoomIn className="size-4" />
                </IconButton>
                <IconButton title="Zoom out" onClick={() => zoom(2)} className="size-8">
                  <ZoomOut className="size-4" />
                </IconButton>
              </div>
            </div>
            <Scrubber
              camera={id}
              spans={spans}
              activity={lanes[0]?.activity ?? []}
              events={events}
              now={now}
              center={center}
              range={range}
              live={live}
              selection={selection}
              onSelection={setSelection}
              onScrubStart={onScrubStart}
              onScrub={setScrubT}
              onScrubEnd={onScrubEnd}
              onRange={setRange}
            />
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500">
              <span className="flex items-center gap-1.5"><span className="h-2 w-4 rounded-sm bg-gradient-to-r from-violet-500/70 to-cyan-400/40" /> Recorded</span>
              <span className="flex items-center gap-1.5"><span className="h-2 w-4 rounded-sm bg-amber-400" /> Motion</span>
              <span className="flex items-center gap-1.5"><span className="h-2 w-4 rounded-sm bg-rose-500/30" /> Not recorded</span>
              <span className="ml-auto hidden md:inline">Drag to scrub · click to jump · scroll to zoom · scroll on the video to magnify</span>
            </div>
            <AnimatePresence>
              {selection && (
                <ClipEditor
                  cameraId={id}
                  cameraName={cam?.name ?? id}
                  selection={selection}
                  setSelection={setSelection}
                  onMarkIn={markIn}
                  onMarkOut={markOut}
                  onPreview={previewClip}
                />
              )}
            </AnimatePresence>
          </Card>
        </div>

        {/* Events */}
        <Card className="flex max-h-[calc(100vh-10rem)] min-h-64 flex-col overflow-hidden xl:sticky xl:top-4">
          <div className="flex items-center justify-between border-b border-white/5 px-4 py-3">
            <span className="flex items-center gap-2 text-sm font-semibold text-white">
              <Zap className="size-4 text-amber-300" /> Motion events
            </span>
            <span className="text-xs text-slate-500">{listEvents.length}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {listEvents.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-slate-500">No motion around this time</div>
            ) : (
              listEvents.map((e) => {
                const active = center >= e.start - 3000 && center <= (e.end || now);
                return (
                  <button
                    key={e.id}
                    onClick={() => seekTo(e.start - 3000, true)}
                    className={clsx("flex w-full items-center gap-3 rounded-xl p-2 text-left transition hover:bg-white/5", active && "bg-violet-500/10 ring-1 ring-violet-400/30")}
                  >
                    <div className="relative aspect-video w-24 shrink-0 overflow-hidden rounded-lg bg-ink-800">
                      {e.thumb ? <img src={thumbURL(e)} loading="lazy" className="h-full w-full object-cover" /> : <Zap className="absolute inset-0 m-auto size-4 text-slate-600" />}
                      {!e.end && <span className="absolute right-1 top-1 rounded bg-amber-400 px-1 text-[9px] font-bold text-black">NOW</span>}
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-white">{fmtTimeSec(e.start)}</div>
                      <div className="text-xs text-slate-500">
                        {fmtDay(e.start)} · {e.end ? fmtDuration(e.end - e.start) : "ongoing"}
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

function toTimeInput(ms: number) {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

function ClipEditor({
  cameraId,
  cameraName,
  selection,
  setSelection,
  onMarkIn,
  onMarkOut,
  onPreview,
}: {
  cameraId: string;
  cameraName: string;
  selection: { from: number; to: number };
  setSelection: (s: { from: number; to: number } | null) => void;
  onMarkIn: () => void;
  onMarkOut: () => void;
  onPreview: () => void;
}) {
  const toast = useToast();
  const nav = useNavigate();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const len = selection.to - selection.from;
  const defaultName = `${cameraName} · ${fmtTimeSec(selection.from)}`;

  const nudge = (edge: "from" | "to", ms: number) => {
    const s = { ...selection, [edge]: selection[edge] + ms };
    if (s.to - s.from < 1000 || s.to > Date.now()) return;
    setSelection(s);
  };
  const setTime = (edge: "from" | "to", value: string) => {
    const [h, m, sec] = value.split(":").map(Number);
    const d = new Date(selection[edge]);
    d.setHours(h, m, sec || 0, 0);
    const s = { ...selection, [edge]: d.getTime() };
    if (s.to - s.from >= 1000) setSelection(s);
  };
  const save = async () => {
    setSaving(true);
    try {
      await api.createClip(cameraId, selection.from, selection.to, name || defaultName);
      toast("Saving clip — it will be in Clips in a moment", "success", { label: "Open Clips", onClick: () => nav("/clips") });
      setSelection(null);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setSaving(false);
    }
  };

  const edgeRow = (edge: "from" | "to", label: string, onMark: () => void, kbd: string) => (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="w-10 text-[11px] font-semibold uppercase tracking-wider text-cyan-300/80">{label}</span>
      <button onClick={() => nudge(edge, -1000)} className="rounded-md px-1.5 py-1 text-xs text-slate-400 hover:bg-white/10 hover:text-white" title="1 s earlier">
        −1s
      </button>
      <input
        type="time"
        step={1}
        value={toTimeInput(selection[edge])}
        onChange={(e) => setTime(edge, e.target.value)}
        className="h-8 rounded-lg border border-white/10 bg-ink-900 px-2 font-mono text-sm text-white"
      />
      <button onClick={() => nudge(edge, 1000)} className="rounded-md px-1.5 py-1 text-xs text-slate-400 hover:bg-white/10 hover:text-white" title="1 s later">
        +1s
      </button>
      <button onClick={onMark} className="rounded-lg border border-cyan-400/30 px-2 py-1 text-xs font-medium text-cyan-200 hover:bg-cyan-400/10" title={`Set to the playhead (${kbd})`}>
        Set to playhead <kbd className="ml-1 rounded bg-white/10 px-1 text-[10px]">{kbd}</kbd>
      </button>
    </div>
  );

  return (
    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
      <div className="mt-4 rounded-2xl border border-cyan-400/25 bg-gradient-to-br from-cyan-400/[0.07] to-violet-500/[0.05] p-4">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold text-white">
            <Scissors className="size-4 text-cyan-300" /> New clip
            <span className="rounded-full bg-cyan-400/15 px-2 py-0.5 text-xs font-semibold text-cyan-200">{fmtDuration(len)}</span>
          </div>
          <IconButton title="Cancel (Esc)" onClick={() => setSelection(null)} className="size-8">
            <X className="size-4" />
          </IconButton>
        </div>
        <p className="mb-3 text-xs text-slate-400">
          Drag the cyan handles on the timeline, or scrub to a moment and press <b className="text-slate-200">I</b> for the start and <b className="text-slate-200">O</b> for the end.
        </p>
        <div className="flex flex-col gap-2">
          {edgeRow("from", "Start", onMarkIn, "I")}
          {edgeRow("to", "End", onMarkOut, "O")}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={defaultName}
            className="h-9 min-w-48 flex-1 rounded-xl border border-white/10 bg-ink-900 px-3 text-sm text-white placeholder:text-slate-600"
          />
          <Button size="sm" onClick={onPreview}>
            <PlayCircle className="size-4" /> Preview
          </Button>
          <Button size="sm" variant="primary" onClick={save} disabled={saving || len > 3 * HOUR}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Save clip
          </Button>
        </div>
        {len > 3 * HOUR && <p className="mt-2 text-xs text-rose-300">Clips can be up to 3 hours long.</p>}
      </div>
    </motion.div>
  );
}

