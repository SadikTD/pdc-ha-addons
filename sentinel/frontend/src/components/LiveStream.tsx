import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Loader2, VideoOff } from "lucide-react";

// go2rtc's <video-stream> web component, served through Sentinel's /go2rtc proxy.
let loader: Promise<unknown> | null = null;
const base = () => location.origin + location.pathname;
function loadPlayer() {
  loader ??= import(/* @vite-ignore */ new URL("go2rtc/video-stream.js", base()).href).catch((e) => {
    loader = null;
    throw e;
  });
  return loader;
}

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
  const [state, setState] = useState<"loading" | "playing" | "error">("loading");
  const latest = useRef({ muted, onMutedByBrowser, onHasAudio });
  latest.current = { muted, onMutedByBrowser, onHasAudio };

  useEffect(() => {
    let el: VideoStreamEl | null = null;
    let cancelled = false;
    let stallTimer = 0;
    setState("loading");
    loadPlayer()
      .then(() => {
        if (cancelled || !host.current) return;
        el = document.createElement("video-stream") as VideoStreamEl;
        el.mode = "mse";
        el.media = "video,audio";
        el.background = false;
        host.current.appendChild(el);
        const src = new URL(`go2rtc/api/ws?src=${encodeURIComponent(hq ? camera : `${camera}_sub`)}`, base());
        src.protocol = src.protocol === "https:" ? "wss:" : "ws:";
        el.src = src.toString();
        const v = el.video;
        if (!v) return;
        const stream = el;
        video.current = v;
        v.controls = false;
        v.muted = latest.current.muted;
        v.playsInline = true;
        v.addEventListener("playing", () => {
          window.clearTimeout(stallTimer);
          setState("playing");
          latest.current.onHasAudio?.(/mp4a|flac|opus/.test(stream.mseCodecs ?? ""));
        });
        v.addEventListener("waiting", () => {
          stallTimer = window.setTimeout(() => setState("loading"), 1500);
        });
        v.addEventListener("volumechange", () => {
          // Not while closing: closeStream() mutes the video itself.
          if (!cancelled && v.muted && !latest.current.muted) latest.current.onMutedByBrowser?.();
        });
        onVideo?.(v);
      })
      .catch(() => setState("error"));
    return () => {
      cancelled = true;
      window.clearTimeout(stallTimer);
      video.current = null;
      onVideo?.(null);
      if (el) closeStream(el);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, hq]);

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
          {state === "loading" ? (
            <Loader2 className="size-7 animate-spin text-white/60" />
          ) : (
            <div className="flex flex-col items-center gap-2 text-sm text-slate-400">
              <VideoOff className="size-6" /> Live view unavailable
            </div>
          )}
        </div>
      )}
    </div>
  );
}
