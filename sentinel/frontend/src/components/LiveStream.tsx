import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Loader2 } from "lucide-react";

import { VideoRTC } from "../vendor/video-rtc.js";

// go2rtc's player, bundled with the app (fetching it from go2rtc at runtime made every
// tile wait for it behind the page's pictures). Its stream comes through Sentinel's
// /go2rtc proxy.
if (!customElements.get("video-stream")) customElements.define("video-stream", class extends VideoRTC {});
const base = () => location.origin + location.pathname;

// Streams whose video this browser can't decode (go2rtc then sends only the sound):
// shown as pictures instead, from then on without trying video first. Remembered across
// visits, so a browser without H.265 doesn't try (and wait for) video on every visit.
const PIC_KEY = "sentinel.picturesOnly";
const picturesOnly = new Set<string>(JSON.parse(localStorage.getItem(PIC_KEY) ?? "[]"));
const rememberPictures = (key: string) => {
  picturesOnly.add(key);
  localStorage.setItem(PIC_KEY, JSON.stringify([...picturesOnly]));
};
const neverStarted = new Map<string, number>();
const hasVideoCodec = (codecs: string) => /avc1|hvc1|hev1/.test(codecs);

type VideoStreamEl = HTMLElement & {
  mode: string;
  media: string;
  background: boolean;
  src: string;
  video?: HTMLVideoElement;
  ws?: WebSocket | null;
  pc?: RTCPeerConnection | null;
  wsState?: number;
  pcState?: number;
  disconnectTID?: number;
  mseCodecs?: string;
};

// go2rtc's player keeps streaming for 5 s after it leaves the page (in case it comes
// back); React has already taken it off the page when this runs, so that timer is
// pending. Cancel it and close the stream at once, the way its ondisconnect() does but
// without clearing the video's source: doing that while data is being appended makes
// go2rtc's own handlers throw. With the socket closed and the element gone, the browser
// frees the rest.
function closeStream(el: VideoStreamEl) {
  window.clearTimeout(el.disconnectTID);
  el.disconnectTID = 0;
  const v = el.video;
  if (v) {
    v.muted = true;
    v.pause();
  }
  el.wsState = WebSocket.CLOSED; // also stops go2rtc's automatic reconnect
  el.pcState = WebSocket.CLOSED;
  el.ws?.close();
  el.ws = null;
  el.pc?.close();
  el.pc = null;
  el.remove();
}

export function LiveStream({
  camera,
  hq = false,
  muted = true,
  onMutedByBrowser,
  onHasAudio,
  cover = false,
  fill = false,
  className,
  onVideo,
  poster,
}: {
  camera: string;
  hq?: boolean;
  // Sound is always part of the stream (it's tiny next to the video), so turning it on or
  // off is instant: it never reconnects.
  muted?: boolean;
  // The browser refused to start with sound (no click on the page yet): now muted.
  onMutedByBrowser?: () => void;
  // Whether the camera sends sound at all, known once the stream starts.
  onHasAudio?: (has: boolean) => void;
  cover?: boolean;
  // Stretch to the box: for substreams whose shape differs from the camera's picture
  // (e.g. 640x480 of a 16:9 camera).
  fill?: boolean;
  className?: string;
  onVideo?: (v: HTMLVideoElement | null) => void;
  poster?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const [state, setState] = useState<"loading" | "playing">("loading");
  // Bumped by the watchdog to throw the player away and start a fresh one.
  const [attempt, setAttempt] = useState(0);
  const latest = useRef({ muted, onMutedByBrowser, onHasAudio });
  latest.current = { muted, onMutedByBrowser, onHasAudio };

  useEffect(() => {
    let cancelled = false;
    let stallTimer = 0;
    const key = hq ? camera : `${camera}_sub`;
    const pictures = picturesOnly.has(key);
    let posterWatch: MutationObserver | null = null;
    let lastPoster = 0;
    setState("loading");
    const el = document.createElement("video-stream") as VideoStreamEl;
    // Smooth video (MSE) when the browser can decode the camera's codec; otherwise a
    // stream of pictures (e.g. H.265 cameras in browsers without HEVC support).
    el.mode = pictures ? "mjpeg" : "mse";
    el.media = "video,audio";
    el.background = false;
    host.current!.appendChild(el); // connecting creates its <video>
    const src = new URL(`go2rtc/api/ws?src=${encodeURIComponent(pictures ? `${camera}_pic` : key)}`, base());
    src.protocol = src.protocol === "https:" ? "wss:" : "ws:";
    el.src = src.toString();
    const v = el.video!;
    video.current = v;
    v.controls = false;
    v.muted = latest.current.muted;
    v.playsInline = true;
    // Pictures mode shows each frame as the video's poster.
    posterWatch = new MutationObserver(() => {
      lastPoster = Date.now();
      window.clearTimeout(stallTimer);
      setState("playing");
    });
    posterWatch.observe(v, { attributes: true, attributeFilter: ["poster"] });
    v.addEventListener("playing", () => {
      if (el.mseCodecs && !hasVideoCodec(el.mseCodecs)) {
        rememberPictures(key);
        setAttempt((n) => n + 1);
        return;
      }
      window.clearTimeout(stallTimer);
      neverStarted.delete(key);
      setState("playing");
      latest.current.onHasAudio?.(/mp4a|flac|opus/.test(el.mseCodecs ?? ""));
    });
    v.addEventListener("waiting", () => {
      stallTimer = window.setTimeout(() => setState("loading"), 1500);
    });
    v.addEventListener("volumechange", () => {
      // Not while closing: closeStream() mutes the video itself.
      if (!cancelled && v.muted && !latest.current.muted) latest.current.onMutedByBrowser?.();
    });
    onVideo?.(v);
    // Watchdog: a stream that never starts, or whose picture stops moving while the page
    // is visible (the socket can stay open while nothing arrives), is started again
    // instead of showing a frozen or blank tile forever.
    let lastTime = -1;
    let played = false;
    let lastMove = Date.now();
    const watchdog = window.setInterval(() => {
      const v = video.current;
      const moving = !!v && !v.paused && v.currentTime !== lastTime;
      if (document.hidden || moving || Date.now() - lastPoster < 4000) {
        if (v) lastTime = v.currentTime;
        played ||= moving || lastPoster > 0;
        lastMove = Date.now();
        return;
      }
      if (played && v?.paused && !lastPoster) v.play().catch(() => {});
      if (Date.now() - lastMove > (played ? 12_000 : 20_000)) {
        // Video that never starts twice in a row: this browser can't play it; use pictures.
        if (!played && !pictures) {
          const n = (neverStarted.get(key) ?? 0) + 1;
          neverStarted.set(key, n);
          if (n >= 2) picturesOnly.add(key);
        }
        setAttempt((n) => n + 1);
      }
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(watchdog);
      posterWatch?.disconnect();
      window.clearTimeout(stallTimer);
      video.current = null;
      onVideo?.(null);
      closeStream(el);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, hq, attempt]);

  useEffect(() => {
    const v = video.current;
    if (!v || v.muted === muted) return;
    v.muted = muted;
    // Unmuting happens on a click, so the browser allows it; resume in case it had paused.
    if (!muted && v.paused) v.play().catch(() => {});
  }, [muted]);

  return (
    <div className={clsx("relative overflow-hidden bg-black", cover && "cover", fill && "fill", className)}>
      {poster && state !== "playing" && <img src={poster} className={clsx("absolute inset-0 h-full w-full", fill ? "object-fill" : cover ? "object-cover" : "object-contain")} onError={(e) => (e.currentTarget.style.display = "none")} />}
      <div ref={host} className="absolute inset-0" />
      {state !== "playing" && (
        <div className={clsx("absolute inset-0 flex items-center justify-center", !poster && "bg-gradient-to-b from-ink-900/40 to-ink-950/70")}>
          <Loader2 className="size-7 animate-spin text-white/60" />
        </div>
      )}
    </div>
  );
}
