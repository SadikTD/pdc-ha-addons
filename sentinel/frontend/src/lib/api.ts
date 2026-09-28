// Everything is relative: the app runs under a Home Assistant ingress prefix.

export type Rect = { x: number; y: number; w: number; h: number };

export type Camera = {
  id: string;
  name: string;
  main_url: string;
  sub_url: string;
  enabled: boolean;
  record: boolean;
  audio: boolean;
  motion: boolean;
  retain_days: number;
  motion_retain_days: number;
  motion_sensitivity: number;
  motion_masks: Rect[];
  motion_zones: Zone[];
};

export type Zone = { name: string; points: [number, number][] };

export type Settings = {
  cameras: Camera[];
  min_free_gb: number;
  notify_service: string;
  notify_after_minutes: number;
  quiet_windows: string[];
  mqtt_enabled: boolean;
  clip_retention_days: number;
  night_alerts: {
    enabled: boolean;
    from: string;
    to: string;
    cameras: string[];
    cooldown_seconds: number;
    followup_seconds: number;
    max_per_hour: number;
    min_seconds: number;
    close_up: boolean;
    save_clip: boolean;
  };
  whatsapp: { to: string; to_name: string; bridge_url: string };
  drive: {
    backup_alerts: boolean;
    backup_saved: boolean;
    backup_motion: boolean;
    motion_cameras: string[];
    quota_gb: number;
    retention_days: number;
  };
};

export type WhatsAppInfo = {
  token_set: boolean;
  error?: string;
  chats?: { recipient: string; groups: { id: string; name: string; size: number }[] };
};

export type AlertRecord = {
  id: string;
  camera: string;
  camera_name: string;
  at: number;
  event?: string;
  status: "sending" | "sent" | "failed";
  error?: string;
  clip?: string;
  test?: boolean;
};

export type DriveStatus = {
  configured: boolean;
  connected: boolean;
  account?: string;
  folder_url?: string;
  client_id?: string;
  auth?: { user_code: string; url: string; expires: number; error?: string };
  last_error?: string;
  last_ok?: number;
  usage: { used: number; files: number; free: number; measured: number };
  pending: number;
  uploading: number;
  failed: number;
  done: number;
};

export type StreamInfo = { video_codec: string; width: number; height: number; fps: number; audio_codec: string };

export type RecStatus = {
  state: "recording" | "starting" | "stalled" | "reconnecting" | "offline";
  since: number;
  last_error?: string;
  restarts_24h: number;
  bitrate_kbps: number;
  last_write: number;
  audio: boolean;
  stream: StreamInfo;
};

export type MotionStatus = { state: string; active: boolean; score: number; error?: string };

export type SentinelEvent = { id: string; camera: string; start: number; end: number; peak: number; thumb: boolean };

export type CamStorage = { bytes: number; count: number; oldest: number; newest: number; rate_bph: number; uptime_24h: number };

export type CameraStatus = Camera & {
  recorder: RecStatus | null;
  motion: MotionStatus | null;
  storage: CamStorage;
  last_event: SentinelEvent | null;
};

export type ClockStatus = {
  synced: boolean;
  offset_ms: number;
  last_check: number;
  last_success: number;
  server: string;
  error?: string;
  jumps: number;
};

export type Status = {
  version: string;
  uptime_ms: number;
  now: number;
  cameras: CameraStatus[];
  storage: {
    disk: { total: number; free: number; used: number };
    used: number;
    rate_bph: number;
    capacity_days: number;
    min_free_gb: number;
    orphans: { id: string; bytes: number; count: number }[] | null;
    breakdown: Record<string, number> | null;
    clips: number;
  };
  clock: ClockStatus;
  live: boolean;
  alerts: { enabled: boolean; active: boolean };
  drive: { connected: boolean; mode: string };
  mqtt: { connected: boolean; error: string };
  health: boolean;
};

export type Span = { s: number; e: number };
export type Clip = {
  id: string;
  name: string;
  camera: string;
  camera_name: string;
  from: number;
  to: number;
  created: number;
  status: "queued" | "saving" | "ready" | "failed";
  progress: number;
  error?: string;
  size: number;
  pinned: boolean;
  alert?: boolean;
  backup?: { state: "pending" | "uploading" | "done" | "failed"; progress: number; file_id?: string; error?: string; at: number; tries: number };
};
export type Incident = { t: number; level: "info" | "warn" | "error"; camera?: string; message: string };

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  status: () => request<Status>("GET", "api/status"),
  settings: () => request<Settings>("GET", "api/settings"),
  saveSettings: (s: Settings) => request<Settings>("PUT", "api/settings", s),
  testStream: (url: string, camera?: string, field?: string) =>
    request<{ ok: boolean; error?: string; info?: StreamInfo }>("POST", "api/test-stream", { url, camera, field }),
  coverage: (cam: string, from: number, to: number) => request<Span[]>("GET", `api/recordings/${cam}?from=${from}&to=${to}`),
  activity: (cam: string, from: number, to: number, step: number) =>
    request<[number, number][]>("GET", `api/activity/${cam}?from=${from}&to=${to}&step=${step}`),
  events: (opts: { cameras?: string[]; from?: number; to?: number; limit?: number }) => {
    const q = new URLSearchParams();
    if (opts.cameras?.length) q.set("cameras", opts.cameras.join(","));
    if (opts.from) q.set("from", String(opts.from));
    if (opts.to) q.set("to", String(opts.to));
    if (opts.limit) q.set("limit", String(opts.limit));
    return request<SentinelEvent[]>("GET", `api/events?${q}`);
  },
  incidents: (limit = 200) => request<Incident[]>("GET", `api/incidents?limit=${limit}`),
  motionGrid: (id: string) => request<{ w: number; h: number; grid: string | null }>("GET", `api/cameras/${id}/motion-grid`),
  restartCamera: (id: string) => request<{ ok: boolean }>("POST", `api/cameras/${id}/restart`),
  clips: () => request<Clip[]>("GET", "api/clips"),
  createClip: (camera: string, from: number, to: number, name: string) => request<Clip>("POST", "api/clips", { camera, from: Math.round(from), to: Math.round(to), name }),
  patchClip: (id: string, patch: { name?: string; pinned?: boolean }) => request<Clip>("PATCH", `api/clips/${id}`, patch),
  deleteClip: (id: string) => request<{ ok: boolean }>("DELETE", `api/clips/${id}`),
  backupClip: (id: string) => request<{ ok: boolean }>("POST", `api/clips/${id}/backup`),
  alerts: () => request<AlertRecord[]>("GET", "api/alerts"),
  testAlert: (camera: string) => request<{ ok: boolean }>("POST", "api/alerts/test", { camera }),
  whatsapp: () => request<WhatsAppInfo>("GET", "api/whatsapp"),
  setWhatsAppToken: (token: string) => request<{ ok: boolean }>("PUT", "api/whatsapp/token", { token }),
  drive: () => request<DriveStatus>("GET", "api/drive"),
  driveConnect: (client_id: string, client_secret: string) =>
    request<{ user_code: string; url: string; expires: number }>("POST", "api/drive/connect", { client_id, client_secret }),
  driveDisconnect: () => request<{ ok: boolean }>("POST", "api/drive/disconnect"),
  deleteRecordings: (id: string) => request<{ ok: boolean }>("DELETE", `api/recordings/${id}`),
};

export const snapshotURL = (cam: string, hq = false, bust = 0) => `api/cameras/${cam}/snapshot.jpg?${hq ? "hq=1&" : ""}t=${bust}`;
export const latestFrameURL = (cam: string) => `api/cameras/${cam}/latest.jpg`;
export const thumbURL = (e: SentinelEvent) => `api/events/${e.camera}/${e.id}/thumb.jpg`;
export const vodURL = (cam: string, from: number, to: number) => `api/vod.m3u8?camera=${cam}&from=${Math.round(from)}&to=${Math.round(to)}`;
export const clipVideoURL = (id: string, download = false) => `api/clips/${id}/video${download ? "?download=1" : ""}`;
export const clipThumbURL = (c: Clip) => `api/clips/${c.id}/thumb.jpg?v=${c.status}`;
