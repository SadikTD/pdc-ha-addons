import { memo, useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { Loader2, VideoOff } from "lucide-react";
import { vodURL } from "../lib/api";

// One camera's recording, kept in step with a shared clock. Every quarter second the
// player compares its position with the clock: small drift is corrected by nudging the
// playback speed, large drift by seeking. Where the camera has no footage it shows a
// placeholder and picks up again when the clock reaches its next recording.

type Frag = { pos: number; dur: number; pdt: number };

function parsePlaylist(text: string): Frag[] {
  const frags: Frag[] = [];
  let pos = 0;
  let pdt = 0;
  let inFile = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
      pdt = Date.parse(line.slice(25));
      inFile = 0;
    } else if (line.startsWith("#EXTINF:")) {
      const dur = parseFloat(line.slice(8));
      frags.push({ pos, dur, pdt: pdt + inFile * 1000 });
      pos += dur;
      inFile += dur;
    }
  }
  return frags;
}

// Player position for wall-clock time t, or null when t falls in a gap.
function posAt(frags: Frag[], t: number): number | null {
  let lo = 0;
  let hi = frags.length - 1;
  if (hi < 0 || t < frags[0].pdt) return null;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frags[mid].pdt <= t) lo = mid;
    else hi = mid - 1;
  }
  const f = frags[lo];
  const into = (t - f.pdt) / 1000;
  return into <= f.dur + 0.5 ? f.pos + Math.min(into, f.dur) : null;
}

type Props = {
  camera: string;
  master: () => number;
  playing: boolean;
  rate: number;
  epoch: number; // changes on every user seek
  muted: boolean;
};

export const SyncPlayer = memo(function SyncPlayer({ camera, master, playing, rate, epoch, muted }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const hls = useRef<Hls | null>(null);
  const win = useRef<{ from: number; to: number; frags: Frag[] } | null>(null);
  const busy = useRef(false);
  const seq = useRef(0);
  const [state, setState] = useState<"loading" | "playing" | "gap" | "error">("loading");
  const live = useRef({ playing, rate });
  live.current = { playing, rate };

  const load = async (t: number) => {
    const v = video.current;
    if (!v) return;
    const n = ++seq.current;
    busy.current = true;
    setState("loading");
    const from = t - 60_000;
    const to = Math.min(Date.now() + 30_000, t + 30 * 60_000);
    let frags: Frag[] = [];
    try {
      frags = parsePlaylist(await (await fetch(vodURL(camera, from, to), { cache: "no-store" })).text());
    } catch {
      if (n === seq.current) {
        busy.current = false;
        setState("error");
      }
      return;
    }
    if (n !== seq.current) return;
    win.current = { from, to, frags };
    hls.current?.destroy();
    hls.current = null;
    if (!frags.length) {
      v.removeAttribute("src");
      busy.current = false;
      setState("gap");
      return;
    }
    const pos = posAt(frags, t) ?? 0;
    if (Hls.isSupported()) {
      const h = new Hls({ maxBufferLength: 12, maxMaxBufferLength: 30, backBufferLength: 10, startPosition: pos, enableWorker: true });
      hls.current = h;
      h.on(Hls.Events.MANIFEST_PARSED, () => {
        busy.current = false;
      });
      h.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) h.startLoad();
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) h.recoverMediaError();
      });
      h.loadSource(vodURL(camera, from, to));
      h.attachMedia(v);
    } else {
      v.src = vodURL(camera, from, to);
      v.addEventListener(
        "loadedmetadata",
        () => {
          v.currentTime = pos;
          busy.current = false;
        },
        { once: true },
      );
    }
  };

  useEffect(() => {
    load(master());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, epoch]);

  useEffect(() => () => hls.current?.destroy(), []);

  useEffect(() => {
    if (video.current) video.current.muted = muted;
  }, [muted]);

  // Keep in step with the shared clock.
  useEffect(() => {
    const id = window.setInterval(() => {
      const v = video.current;
      const w = win.current;
      if (!v || !w || busy.current) return;
      const t = master();
      const { playing, rate } = live.current;
      if ((t < w.from + 2000 || t > w.to - 5000) && t < Date.now() - 5000) {
        load(t);
        return;
      }
      const pos = posAt(w.frags, t);
      if (pos === null) {
        if (!v.paused) v.pause();
        setState("gap");
        return;
      }
      const drift = v.currentTime - pos;
      if (Math.abs(drift) > (playing ? 1.5 : 0.15)) {
        v.currentTime = pos;
      } else if (playing) {
        // Ahead: slow down a little; behind: speed up a little.
        v.playbackRate = rate * (1 - Math.max(-0.12, Math.min(0.12, drift * 0.25)));
      }
      if (playing && v.paused) v.play().catch(() => {});
      if (!playing && !v.paused) v.pause();
      setState(v.readyState >= 2 ? "playing" : "loading");
    }, 250);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, master]);

  return (
    <div className="relative h-full w-full bg-black">
      <video ref={video} className="h-full w-full object-contain" playsInline muted={muted} />
      {state === "loading" && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Loader2 className="size-7 animate-spin text-white/60" />
        </div>
      )}
      {(state === "gap" || state === "error") && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-ink-950/80 text-sm text-slate-400">
          <VideoOff className="size-6" />
          {state === "gap" ? "No recording at this moment" : "Couldn't load the recording"}
        </div>
      )}
    </div>
  );
});
