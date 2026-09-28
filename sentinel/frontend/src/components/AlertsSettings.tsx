import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import clsx from "clsx";
import {
  CheckCircle2, ChevronDown, CloudUpload, ExternalLink, KeyRound, Loader2, MessageCircle, Moon, RefreshCw, Send, Unplug, XCircle,
} from "lucide-react";
import { Button, Card, Field, SectionTitle, Toggle, inputCls } from "./ui";
import { useToast } from "../lib/toast";
import { api, type AlertRecord, type Camera, type DriveStatus, type Settings, type WhatsAppInfo } from "../lib/api";
import { fmtAgo, fmtBytes, fmtDay, fmtTimeSec } from "../lib/format";

type SetFn = <K extends keyof Settings>(k: K, v: Settings[K]) => void;

// ---------------------------------------------------------------- night alerts

const secs = (v: number) => (v < 60 ? `${v} seconds` : v === 60 ? "1 minute" : `${v / 60} minutes`);

// Plain-language summary of what the timing settings do together.
function describeTiming(n: Settings["night_alerts"]) {
  const parts = [`Someone appears → a picture within ${Math.max(n.min_seconds, 2)} s.`];
  parts.push(n.followup_seconds ? `If they stay in view, another every ${secs(n.followup_seconds)}.` : "If they stay in view, no more pictures until the motion stops.");
  parts.push(
    n.cooldown_seconds
      ? `If they leave and come back within ${secs(n.cooldown_seconds)}, that return is sent as soon as the ${secs(n.cooldown_seconds)} are up.`
      : "Every new motion is sent straight away.",
  );
  if (n.max_per_hour) parts.push(`At most ${n.max_per_hour} pictures per camera per hour.`);
  return parts.join(" ");
}

export function NightAlertsCard({ draft, set, cameras }: { draft: Settings; set: SetFn; cameras: Camera[] }) {
  const toast = useToast();
  const n = draft.night_alerts;
  const setN = (patch: Partial<Settings["night_alerts"]>) => set("night_alerts", { ...n, ...patch });
  const [wa, setWa] = useState<WhatsAppInfo | null>(null);
  const [loadingWa, setLoadingWa] = useState(false);
  const [token, setToken] = useState("");
  const [testCam, setTestCam] = useState(cameras[0]?.id ?? "");
  const [testing, setTesting] = useState(false);
  const [alerts, setAlerts] = useState<AlertRecord[]>([]);
  const [advanced, setAdvanced] = useState(!!draft.whatsapp.bridge_url);

  const loadWa = useCallback(async () => {
    setLoadingWa(true);
    try {
      setWa(await api.whatsapp());
    } catch (e) {
      setWa({ token_set: false, error: (e as Error).message });
    } finally {
      setLoadingWa(false);
    }
  }, []);

  useEffect(() => {
    loadWa();
    const load = () => api.alerts().then(setAlerts).catch(() => {});
    load();
    const t = window.setInterval(load, 10_000);
    return () => window.clearInterval(t);
  }, [loadWa]);

  const saveToken = async () => {
    try {
      await api.setWhatsAppToken(token);
      setToken("");
      toast("Bridge token saved");
      loadWa();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      await api.testAlert(testCam);
      toast("Test picture sent to WhatsApp");
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setTesting(false);
      api.alerts().then(setAlerts).catch(() => {});
    }
  };

  const chats = wa?.chats;
  const options = chats ? [...chats.groups.map((g) => ({ id: g.id, name: `${g.name} (group, ${g.size} members)`, short: g.name })), { id: chats.recipient, name: `${chats.recipient} (direct message)`, short: chats.recipient }] : [];
  const saved = draft.whatsapp.to && !options.some((o) => o.id === draft.whatsapp.to) ? [{ id: draft.whatsapp.to, name: draft.whatsapp.to_name || draft.whatsapp.to, short: draft.whatsapp.to_name }] : [];
  const allCams = n.cameras.length === 0;

  return (
    <Card className="p-5">
      <SectionTitle sub="A WhatsApp picture of whatever moves at night: a close-up of the moving area and the full scene, taken from the full-quality recording.">
        <span className="flex items-center gap-2"><Moon className="size-4" /> Night alerts</span>
      </SectionTitle>
      <div className="space-y-5">
        <Toggle checked={n.enabled} onChange={(v) => setN({ enabled: v })} label="Send night alerts" hint={n.enabled ? `Every day from ${n.from} to ${n.to}` : "Off"} />

        <div className={clsx("space-y-5 transition", !n.enabled && "pointer-events-none opacity-40")}>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="From">
              <input type="time" value={n.from} onChange={(e) => setN({ from: e.target.value })} className={clsx(inputCls, "w-32 [color-scheme:dark]")} />
            </Field>
            <Field label="Until">
              <input type="time" value={n.to} onChange={(e) => setN({ to: e.target.value })} className={clsx(inputCls, "w-32 [color-scheme:dark]")} />
            </Field>
          </div>

          <div className="grid gap-4 rounded-xl border border-white/5 bg-white/[0.02] p-4 sm:grid-cols-2">
            <Field label="Gap between alerts (per camera)" hint="Motion during the gap isn't lost: it's sent the moment the gap ends.">
              <select value={n.cooldown_seconds} onChange={(e) => setN({ cooldown_seconds: Number(e.target.value) })} className={inputCls}>
                {[0, 10, 20, 30, 60, 120, 300].map((v) => (
                  <option key={v} value={v}>
                    {v === 0 ? "None: alert on every motion" : secs(v)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="While motion continues" hint="Someone lingering keeps sending fresh pictures instead of just one.">
              <select value={n.followup_seconds} onChange={(e) => setN({ followup_seconds: Number(e.target.value) })} className={inputCls}>
                {[0, 15, 30, 60, 120].map((v) => (
                  <option key={v} value={v}>
                    {v === 0 ? "Only the first picture" : `New picture every ${secs(v)}`}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Safety limit" hint="Stops rain or a swaying tree from flooding the group; resets after an hour.">
              <select value={n.max_per_hour} onChange={(e) => setN({ max_per_hour: Number(e.target.value) })} className={inputCls}>
                {[10, 20, 30, 60, 120, 0].map((v) => (
                  <option key={v} value={v}>
                    {v === 0 ? "No limit" : `${v} pictures per camera per hour`}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Ignore motion shorter than" hint="Filters insects, rain and flickering lights.">
              <div className="flex h-10 items-center gap-3">
                <input type="range" min={0} max={10} value={n.min_seconds} onChange={(e) => setN({ min_seconds: Number(e.target.value) })} className="flex-1" />
                <span className="w-10 text-right text-sm tabular-nums text-white">{n.min_seconds} s</span>
              </div>
            </Field>
            <p className="text-xs leading-relaxed text-slate-500 sm:col-span-2">
              {describeTiming(n)}
            </p>
          </div>

          <div>
            <div className="mb-1.5 text-xs font-medium text-slate-400">Cameras</div>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => setN({ cameras: [] })} className={clsx("rounded-full border px-3 py-1.5 text-xs font-medium transition", allCams ? "border-violet-400/40 bg-violet-500/15 text-violet-100" : "border-white/10 text-slate-400 hover:text-white")}>
                All cameras
              </button>
              {cameras.map((c) => {
                const on = !allCams && n.cameras.includes(c.id);
                return (
                  <button
                    key={c.id}
                    onClick={() => setN({ cameras: on ? n.cameras.filter((x) => x !== c.id) : [...n.cameras, c.id] })}
                    className={clsx("rounded-full border px-3 py-1.5 text-xs font-medium transition", on ? "border-violet-400/40 bg-violet-500/15 text-violet-100" : "border-white/10 text-slate-400 hover:text-white")}
                  >
                    {c.name}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="rounded-xl border border-white/5 bg-white/[0.02] px-4 py-2">
            <Toggle checked={n.close_up} onChange={(v) => setN({ close_up: v })} label="Close-up of the moving area" hint="Zooms into what moved (a face or person up close), plus the full view" />
            <Toggle checked={n.save_clip} onChange={(v) => setN({ save_clip: v })} label="Save a clip of each alert" hint="From 10 s before to 10 s after the motion, in Clips (and Google Drive, if on)" />
          </div>
        </div>

        {/* WhatsApp delivery */}
        <div className="rounded-2xl border border-emerald-400/15 bg-emerald-400/[0.03] p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-sm font-semibold text-white">
              <MessageCircle className="size-4 text-emerald-300" /> WhatsApp
            </span>
            <span className="text-xs text-slate-500">via the PDC WhatsApp Bridge add-on</span>
          </div>

          {!wa ? (
            <Loader2 className="size-4 animate-spin text-slate-500" />
          ) : (
            <div className="space-y-3">
              <Field label="Bridge API token" hint={wa.token_set ? "Saved. Paste a new one to replace it." : "The api_token from the PDC WhatsApp Bridge add-on's configuration. Stored only in Sentinel's secrets file."}>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <KeyRound className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-500" />
                    <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder={wa.token_set ? "•••••••• (saved)" : "Paste the token"} className={clsx(inputCls, "pl-9")} />
                  </div>
                  <Button type="button" onClick={saveToken} disabled={!token.trim()}>
                    Save
                  </Button>
                </div>
              </Field>

              {wa.token_set && (
                <div>
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="text-xs font-medium text-slate-400">Send alerts to</span>
                    <button type="button" onClick={loadWa} className="flex items-center gap-1 text-xs text-slate-500 hover:text-white">
                      <RefreshCw className={clsx("size-3", loadingWa && "animate-spin")} /> Refresh
                    </button>
                  </div>
                  <select
                    value={draft.whatsapp.to}
                    onChange={(e) => {
                      const o = [...options, ...saved].find((x) => x.id === e.target.value);
                      set("whatsapp", { ...draft.whatsapp, to: e.target.value, to_name: o?.short ?? "" });
                    }}
                    className={inputCls}
                  >
                    <option value="">Choose a chat…</option>
                    {[...saved, ...options].map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                  {wa.error ? (
                    <p className="mt-1.5 flex items-start gap-1.5 text-xs text-rose-300">
                      <XCircle className="mt-px size-3.5 shrink-0" /> {wa.error}
                    </p>
                  ) : (
                    <p className="mt-1.5 text-xs text-slate-500">Groups the bridge's WhatsApp number is in. To use a family group, add that number to the group first.</p>
                  )}
                </div>
              )}

              <button type="button" onClick={() => setAdvanced((a) => !a)} className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300">
                <ChevronDown className={clsx("size-3.5 transition", advanced && "rotate-180")} /> Bridge address
              </button>
              {advanced && (
                <Field label="Bridge address (optional)" hint="Leave empty to find the bridge add-on automatically.">
                  <input className={inputCls} value={draft.whatsapp.bridge_url} placeholder="http://172.30.33.4:8787" onChange={(e) => set("whatsapp", { ...draft.whatsapp, bridge_url: e.target.value })} />
                </Field>
              )}

              {wa.token_set && draft.whatsapp.to && (
                <div className="flex flex-wrap items-center gap-2 border-t border-white/5 pt-3">
                  <select value={testCam} onChange={(e) => setTestCam(e.target.value)} className={clsx(inputCls, "h-9 w-auto")}>
                    {cameras.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <Button size="sm" type="button" onClick={test} disabled={testing || !testCam}>
                    {testing ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />} Send a test picture
                  </Button>
                  <span className="text-xs text-slate-500">Save settings first if you just picked the chat.</span>
                </div>
              )}
            </div>
          )}
        </div>

        {alerts.length > 0 && (
          <div>
            <div className="mb-2 text-xs font-medium text-slate-400">Recent alerts</div>
            <div className="divide-y divide-white/5 rounded-xl border border-white/5">
              {alerts.slice(0, 8).map((a) => (
                <div key={a.id} className="flex items-center gap-3 px-3 py-2 text-xs">
                  {a.status === "sent" ? <CheckCircle2 className="size-4 shrink-0 text-emerald-400" /> : a.status === "failed" ? <XCircle className="size-4 shrink-0 text-rose-400" /> : <Loader2 className="size-4 shrink-0 animate-spin text-slate-400" />}
                  <div className="min-w-0 flex-1">
                    <span className="font-medium text-white">{a.camera_name}</span>
                    {a.test && <span className="ml-1.5 rounded bg-white/10 px-1 text-[10px] text-slate-300">TEST</span>}
                    {a.clip && <span className="ml-1.5 rounded bg-cyan-400/15 px-1 text-[10px] text-cyan-200">CLIP</span>}
                    {a.error && <div className="truncate text-rose-300" title={a.error}>{a.error}</div>}
                  </div>
                  <span className="shrink-0 tabular-nums text-slate-500" title={new Date(a.at).toLocaleString()}>
                    {fmtDay(a.at)} {fmtTimeSec(a.at)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- Google Drive

function DriveUsage({ st, quotaGB }: { st: DriveStatus; quotaGB: number }) {
  const u = st.usage;
  if (!u.measured) return <p className="text-xs text-slate-500">Measuring Drive usage…</p>;
  const cap = quotaGB > 0 ? quotaGB * 1e9 : u.free >= 0 ? u.used + u.free : 0;
  const pct = cap ? Math.min(100, (u.used / cap) * 100) : 0;
  return (
    <div>
      <div className="mb-1.5 flex justify-between text-xs">
        <span className="text-slate-300">
          {fmtBytes(u.used)} used by Sentinel{quotaGB > 0 ? ` of ${quotaGB} GB` : ""} · {u.files} file{u.files === 1 ? "" : "s"}
        </span>
        {u.free >= 0 && <span className="text-slate-500">{fmtBytes(u.free)} free on Drive</span>}
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-white/5">
        <motion.div initial={{ width: 0 }} animate={{ width: `${pct}%` }} className={clsx("h-full rounded-full", pct > 90 ? "bg-amber-400" : "bg-gradient-to-r from-violet-500 to-cyan-400")} />
      </div>
    </div>
  );
}

export function DriveCard({ draft, set, cameras }: { draft: Settings; set: SetFn; cameras: Camera[] }) {
  const toast = useToast();
  const [st, setSt] = useState<DriveStatus | null>(null);
  const [id, setId] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [help, setHelp] = useState(false);

  const load = useCallback(() => api.drive().then(setSt).catch(() => {}), []);
  useEffect(() => {
    load();
    const t = window.setInterval(load, st?.auth ? 3000 : 10_000);
    return () => window.clearInterval(t);
  }, [load, !!st?.auth]); // eslint-disable-line react-hooks/exhaustive-deps

  const connect = async () => {
    setBusy(true);
    try {
      await api.driveConnect(id, secret);
      setSecret("");
      load();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    await api.driveDisconnect();
    toast("Google Drive disconnected", "info");
    load();
  };

  const d = draft.drive;
  return (
    <Card className="p-5">
      <SectionTitle sub="Copies clips to your Google Drive as soon as they're saved, so evidence survives even if the Pi is stolen or broken.">
        <span className="flex items-center gap-2"><CloudUpload className="size-4" /> Google Drive backup</span>
      </SectionTitle>
      {!st ? (
        <Loader2 className="size-4 animate-spin text-slate-500" />
      ) : st.connected ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-400/20 bg-emerald-400/[0.05] px-4 py-3">
            <div className="flex items-center gap-2 text-sm">
              <CheckCircle2 className="size-4 text-emerald-400" />
              <span className="text-slate-200">
                Connected as <b className="text-white">{st.account}</b>
              </span>
            </div>
            <div className="flex items-center gap-2">
              {st.folder_url && (
                <a href={st.folder_url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 rounded-lg bg-white/5 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-white/10">
                  <ExternalLink className="size-3.5" /> Open folder
                </a>
              )}
              <Button size="sm" variant="ghost" type="button" onClick={disconnect}>
                <Unplug className="size-3.5" /> Disconnect
              </Button>
            </div>
          </div>
          <div>
            <div className="mb-1 text-xs font-medium text-slate-400">Back up automatically</div>
            <div className="rounded-xl border border-white/5 bg-white/[0.02] px-4 py-2">
              <Toggle checked={d.backup_motion} onChange={(v) => set("drive", { ...d, backup_motion: v })} label="Every motion event" hint="Each motion, from 10 s before to 10 s after, uploaded as it happens" />
              {d.backup_motion && (
                <div className="flex flex-wrap gap-1.5 pb-2 pt-1">
                  <button type="button" onClick={() => set("drive", { ...d, motion_cameras: [] })} className={clsx("rounded-full border px-2.5 py-1 text-xs font-medium transition", d.motion_cameras.length === 0 ? "border-violet-400/40 bg-violet-500/15 text-violet-100" : "border-white/10 text-slate-400 hover:text-white")}>
                    All cameras
                  </button>
                  {cameras.map((c) => {
                    const on = d.motion_cameras.includes(c.id);
                    return (
                      <button
                        type="button"
                        key={c.id}
                        onClick={() => set("drive", { ...d, motion_cameras: on ? d.motion_cameras.filter((x) => x !== c.id) : [...d.motion_cameras, c.id] })}
                        className={clsx("rounded-full border px-2.5 py-1 text-xs font-medium transition", on ? "border-violet-400/40 bg-violet-500/15 text-violet-100" : "border-white/10 text-slate-400 hover:text-white")}
                      >
                        {c.name}
                      </button>
                    );
                  })}
                </div>
              )}
              <Toggle checked={d.backup_alerts} onChange={(v) => set("drive", { ...d, backup_alerts: v })} label="Night alert clips" />
              <Toggle checked={d.backup_saved} onChange={(v) => set("drive", { ...d, backup_saved: v })} label="Clips I save" />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Sentinel may use up to" hint="When it's full, the oldest backups are deleted to make room.">
              <select value={d.quota_gb} onChange={(e) => set("drive", { ...d, quota_gb: Number(e.target.value) })} className={inputCls}>
                {[...new Set([2, 5, 10, 15, 25, 50, 100, 200, d.quota_gb])].filter((v) => v > 0).sort((a, b) => a - b).map((v) => (
                  <option key={v} value={v}>
                    {v} GB of Drive space
                  </option>
                ))}
                <option value={0}>No limit (until Drive is full)</option>
              </select>
            </Field>
            <Field label="Also delete backups older than">
              <select value={d.retention_days} onChange={(e) => set("drive", { ...d, retention_days: Number(e.target.value) })} className={inputCls}>
                {[7, 14, 30, 60, 90, 180, 365].map((n) => (
                  <option key={n} value={n}>
                    {n} days
                  </option>
                ))}
                <option value={0}>Never (only when space runs out)</option>
              </select>
            </Field>
          </div>
          <DriveUsage st={st} quotaGB={d.quota_gb} />
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
            <span>{st.done} backed up</span>
            {st.uploading > 0 && <span className="text-cyan-300">{st.uploading} uploading</span>}
            {st.pending > 0 && <span>{st.pending} waiting</span>}
            {st.failed > 0 && <span className="text-rose-300">{st.failed} failed (retrying)</span>}
            {st.last_ok ? <span>Last upload {fmtAgo(st.last_ok)}</span> : null}
          </div>
          {st.last_error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{st.last_error}</p>}
        </div>
      ) : st.auth && !st.auth.error ? (
        <motion.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} className="rounded-2xl border border-violet-400/25 bg-violet-500/[0.06] p-5 text-center">
          <p className="text-sm text-slate-300">
            Open{" "}
            <a href={st.auth.url} target="_blank" rel="noreferrer" className="font-semibold text-violet-200 underline">
              {st.auth.url.replace(/^https?:\/\//, "")}
            </a>{" "}
            on any device, sign in and enter this code:
          </p>
          <div className="my-4 select-all font-mono text-3xl font-bold tracking-[0.2em] text-white">{st.auth.user_code}</div>
          <p className="flex items-center justify-center gap-2 text-xs text-slate-500">
            <Loader2 className="size-3.5 animate-spin" /> Waiting for you to allow access…
          </p>
        </motion.div>
      ) : (
        <div className="space-y-3">
          {st.auth?.error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{st.auth.error}</p>}
          <button type="button" onClick={() => setHelp((h) => !h)} className="flex items-center gap-1.5 text-xs font-medium text-violet-300 hover:text-violet-200">
            <ChevronDown className={clsx("size-3.5 transition", help && "rotate-180")} /> One-time setup (about 5 minutes)
          </button>
          <AnimatePresence>
            {help && (
              <motion.ol initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="list-decimal space-y-1.5 overflow-hidden rounded-xl bg-white/[0.02] py-3 pl-8 pr-4 text-xs text-slate-400">
                <li>
                  Open{" "}
                  <a className="text-violet-300 underline" href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noreferrer">
                    Google Cloud Console
                  </a>{" "}
                  and create a project (any name, e.g. “Sentinel”).
                </li>
                <li>
                  <a className="text-violet-300 underline" href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noreferrer">
                    Enable the Google Drive API
                  </a>{" "}
                  for it.
                </li>
                <li>
                  In <b className="text-slate-300">Google Auth Platform → Branding</b>, fill in an app name and your email. Under <b className="text-slate-300">Audience</b> choose External and press <b className="text-slate-300">Publish app</b> (otherwise Google disconnects it after 7 days; no review is needed for this permission).
                </li>
                <li>
                  In <b className="text-slate-300">Clients → Create client</b>, pick <b className="text-slate-300">TVs and Limited Input devices</b>, then copy the client ID and secret here.
                </li>
                <li>Press Connect and enter the code Google shows you. Sentinel can only see the files it uploads itself.</li>
              </motion.ol>
            )}
          </AnimatePresence>
          <Field label="OAuth client ID">
            <input className={clsx(inputCls, "font-mono text-xs")} value={id} onChange={(e) => setId(e.target.value)} placeholder={st.client_id || "1234567890-abc.apps.googleusercontent.com"} />
          </Field>
          <Field label="Client secret">
            <input type="password" autoComplete="off" className={clsx(inputCls, "font-mono text-xs")} value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={st.configured ? "•••••••• (saved)" : "GOCSPX-…"} />
          </Field>
          <Button variant="primary" type="button" onClick={connect} disabled={busy || (!st.configured && (!id.trim() || !secret.trim()))}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <CloudUpload className="size-4" />} Connect Google Drive
          </Button>
        </div>
      )}
    </Card>
  );
}
