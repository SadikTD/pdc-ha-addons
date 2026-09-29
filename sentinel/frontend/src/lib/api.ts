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
  person_retain_days: number;
  motion_sensitivity: number;
  motion_masks: Rect[];
  motion_zones: Zone[];
  occasional: boolean;
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
    any_motion?: boolean;
    save_clip: boolean;
  };
  whatsapp: { to: string; to_name: string; animals_to: string; animals_to_name: string; morning_report: boolean; bridge_url: string };
  daily_summary: { enabled: boolean; time: string };
  animals?: ("cat" | "dog")[];
  drive: {
    backup_alerts: boolean;
    backup_saved: boolean;
    backup_motion: boolean;
    motion_who?: "people_animals" | "all";
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
  status: "sending" | "sent" | "failed" | "skipped";
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

export type Label = "person" | "cat" | "dog";
export type DetectedObject = { label: Label; score: number; box: Rect; t: number };
export type SentinelEvent = {
  id: string;
  camera: string;
  start: number;
  end: number;
  peak: number;
  thumb: boolean;
  // Who was seen; empty with scan "done" = plain motion. scan "" = not checked yet.
  labels?: Label[];
  objects?: DetectedObject[];
  scan?: "" | "scanning" | "done" | "none";
  snap?: boolean;
};

export type DetectionStatus = { enabled: boolean; error?: string; backlog: number; scanned: number; found: number; avg_ms: number; scanning: string; last_found: number };

export type SearchQuery = { labels: Label[] | null; motion: boolean; cameras: string[] | null; from: number; to: number; day_from: number; day_to: number; chips: string[] };

export type CamDay = { id: string; name: string; counts: Record<string, number>; recorded: number; missing: number; first_person?: number; last_person?: number };
export type Highlight = SentinelEvent & { label: Label; score: number };
export type DaySummary = {
  date: string;
  from: number;
  to: number;
  totals: Record<string, number>;
  cameras: CamDay[];
  hours: [number, number, number, number][];
  highlights: Highlight[];
  pending: number;
  problems: number;
  text: string;
};

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
  detection?: DetectionStatus;
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
export type AppUser = { id: string; username: string; name: string; admin: boolean; cameras: string[]; disabled: boolean; created: number; last_login: number };
export type AppUserInput = Partial<{ username: string; name: string; password: string; admin: boolean; cameras: string[]; disabled: boolean }>;
export type AppSession = { id: string; user_id: string; username: string; device: string; created: number; last_seen: number; addr: string; via: string; push: boolean };
export type AppStatus = {
  id?: string;
  port: number;
  error: string;
  users: number;
  lan?: string[];
  host?: { online: boolean; public: string; error: string; since: number; connects: number; last_app: number; public_err: string };
};
export type PushStatus = { configured: boolean; project?: string; error: string; last_ok: number; sent: number };
export type Incident = { t: number; level: "info" | "warn" | "error"; camera?: string; message: string };

// timeoutMs aborts a request that hangs (e.g. the connection dropped mid-way).
async function request<T>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
      signal: timeoutMs && "timeout" in AbortSignal ? AbortSignal.timeout(timeoutMs) : undefined,
    });
  } catch (e) {
    throw new Error((e as Error).name === "TimeoutError" ? "Sentinel didn't answer in time" : "Can't reach Sentinel");
  }
  const text = await res.text();
  let data: { error?: string } | null = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: e.g. Home Assistant's own error page while the add-on restarts.
    if (!res.ok) throw new Error(res.status === 502 || res.status === 503 ? "Sentinel is restarting" : `HTTP ${res.status}`);
    throw new Error("Unexpected answer from Sentinel");
  }
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  status: () => request<Status>("GET", "api/status", undefined, 10_000),
  settings: () => request<Settings>("GET", "api/settings"),
  saveSettings: (s: Settings) => request<Settings>("PUT", "api/settings", s),
  testStream: (url: string, camera?: string, field?: string) =>
    request<{ ok: boolean; error?: string; info?: StreamInfo }>("POST", "api/test-stream", { url, camera, field }),
  coverage: (cam: string, from: number, to: number) => request<Span[]>("GET", `api/recordings/${cam}?from=${from}&to=${to}`),
  activity: (cam: string, from: number, to: number, step: number) =>
    request<[number, number][]>("GET", `api/activity/${cam}?from=${from}&to=${to}&step=${step}`),
  events: (opts: { cameras?: string[]; from?: number; to?: number; limit?: number; labels?: Label[]; motionOnly?: boolean }) => {
    const q = new URLSearchParams();
    if (opts.cameras?.length) q.set("cameras", opts.cameras.join(","));
    if (opts.labels?.length) q.set("labels", opts.labels.join(","));
    if (opts.motionOnly) q.set("motion", "1");
    if (opts.from) q.set("from", String(opts.from));
    if (opts.to) q.set("to", String(opts.to));
    if (opts.limit) q.set("limit", String(opts.limit));
    return request<SentinelEvent[]>("GET", `api/events?${q}`);
  },
  wrongLabel: (e: SentinelEvent, label: Label) => request<SentinelEvent>("POST", `api/events/${e.camera}/${e.id}/wrong`, { label }),
  search: (q: string, limit = 500) => request<{ query: SearchQuery; events: SentinelEvent[] }>("GET", `api/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  summary: (date?: string) => request<DaySummary>("GET", `api/summary${date ? `?date=${date}` : ""}`),
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
  morningReport: () => request<{ caption: string; from: number; to: number; people: number }>("GET", "api/whatsapp/morning-report"),
  testMorningReport: () => request<{ ok: boolean }>("POST", "api/whatsapp/morning-report/test"),
  setWhatsAppToken: (token: string) => request<{ ok: boolean }>("PUT", "api/whatsapp/token", { token }),
  drive: () => request<DriveStatus>("GET", "api/drive"),
  driveConnect: (client_id: string, client_secret: string) =>
    request<{ user_code: string; url: string; expires: number }>("POST", "api/drive/connect", { client_id, client_secret }),
  driveDisconnect: () => request<{ ok: boolean }>("POST", "api/drive/disconnect"),
  appStatus: () => request<AppStatus>("GET", "api/app/status"),
  appUsers: () => request<AppUser[]>("GET", "api/app/users"),
  createAppUser: (u: AppUserInput) => request<AppUser>("POST", "api/app/users", u),
  updateAppUser: (id: string, u: AppUserInput) => request<AppUser>("PATCH", `api/app/users/${id}`, u),
  deleteAppUser: (id: string) => request<{ ok: boolean }>("DELETE", `api/app/users/${id}`),
  appSessions: () => request<AppSession[]>("GET", "api/app/sessions"),
  deleteAppSession: (id: string) => request<{ ok: boolean }>("DELETE", `api/app/sessions/${id}`),
  pushStatus: () => request<PushStatus>("GET", "api/app/push"),
  setupPush: (account: unknown, client?: unknown) => request<PushStatus>("POST", "api/app/push", { account, client }),
  deletePush: () => request<{ ok: boolean }>("DELETE", "api/app/push"),
  testPush: () => request<{ sent: number }>("POST", "api/app/push/test"),
  deleteRecordings: (id: string) => request<{ ok: boolean }>("DELETE", `api/recordings/${id}`),
};

export const snapshotURL = (cam: string, hq = false, bust = 0) => `api/cameras/${cam}/snapshot.jpg?${hq ? "hq=1&" : ""}t=${bust}`;
export const latestFrameURL = (cam: string) => `api/cameras/${cam}/latest.jpg`;
// small: a 480 px copy for lists and grids (a fifth of the bytes; matters over remote access).
export const thumbURL = (e: SentinelEvent, small = false) => `api/events/${e.camera}/${e.id}/thumb.jpg${small ? "?small=1" : ""}`;
export const snapURL = (e: SentinelEvent, small = false) => `api/events/${e.camera}/${e.id}/snap.jpg${small ? "?small=1" : ""}`;
// The best picture of an event: who was seen if anyone, else the moment motion started.
export const eventPicture = (e: SentinelEvent, small = false) => (e.snap ? snapURL(e, small) : e.thumb ? thumbURL(e, small) : null);
export const vodURL = (cam: string, from: number, to: number) => `api/vod.m3u8?camera=${cam}&from=${Math.round(from)}&to=${Math.round(to)}`;
export const clipVideoURL = (id: string, download = false) => `api/clips/${id}/video${download ? "?download=1" : ""}`;
export const clipThumbURL = (c: Clip) => `api/clips/${c.id}/thumb.jpg?v=${c.status}`;
