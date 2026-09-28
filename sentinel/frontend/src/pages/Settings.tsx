import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import clsx from "clsx";
import { Bell, Camera as CamIcon, CheckCircle2, Eye, EyeOff, HardDrive, Loader2, Pencil, Plus, Trash2, X, XCircle, Moon } from "lucide-react";
import { Button, Card, Field, IconButton, PageHeader, SectionTitle, StatePill, Toggle, inputCls, recState } from "../components/ui";
import { MaskEditor } from "../components/MaskEditor";
import { useStatus } from "../lib/status";
import { useToast } from "../lib/toast";
import { api, type Camera, type Settings, type StreamInfo } from "../lib/api";

const blankCamera = (): Camera => ({
  id: "",
  name: "",
  main_url: "",
  sub_url: "",
  enabled: true,
  record: true,
  audio: true,
  motion: true,
  retain_days: 2,
  motion_sensitivity: 50,
  motion_masks: [],
});

export function SettingsPage() {
  const toast = useToast();
  const { refresh } = useStatus();
  const [saved, setSaved] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [editing, setEditing] = useState<{ cam: Camera; index: number } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.settings().then((s) => {
      setSaved(s);
      setDraft(s);
    });
  }, []);

  const dirty = useMemo(() => JSON.stringify(saved) !== JSON.stringify(draft), [saved, draft]);

  const save = async (next: Settings, msg = "Settings saved") => {
    setSaving(true);
    try {
      const s = await api.saveSettings(next);
      setSaved(s);
      setDraft(s);
      toast(msg);
      refresh();
      return true;
    } catch (e) {
      toast((e as Error).message, "error");
      return false;
    } finally {
      setSaving(false);
    }
  };

  if (!draft || !saved) return <div className="skeleton h-96 rounded-2xl" />;

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setDraft({ ...draft, [k]: v });

  return (
    <>
      <PageHeader title="Settings" sub="Changes apply instantly — recording on other cameras is never interrupted." />

      <SectionTitle
        action={
          <Button variant="primary" size="sm" onClick={() => setEditing({ cam: blankCamera(), index: -1 })}>
            <Plus className="size-4" /> Add camera
          </Button>
        }
      >
        <span className="flex items-center gap-2"><CamIcon className="size-4" /> Cameras</span>
      </SectionTitle>
      <Card className="mb-8 divide-y divide-white/5">
        {saved.cameras.length === 0 && <div className="p-8 text-center text-sm text-slate-500">No cameras yet. Add one to start recording.</div>}
        {saved.cameras.map((c, i) => (
          <CameraRow key={c.id} cam={c} onEdit={() => setEditing({ cam: structuredClone(c), index: i })} />
        ))}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <SectionTitle>
            <span className="flex items-center gap-2"><Bell className="size-4" /> Alerts</span>
          </SectionTitle>
          <div className="space-y-4">
            <Field label="Notify service" hint="Home Assistant notify service for your phone, e.g. notify.mobile_app_pixel. A notification also appears in Home Assistant.">
              <input className={inputCls} value={draft.notify_service} placeholder="notify.mobile_app_…" onChange={(e) => set("notify_service", e.target.value)} />
            </Field>
            <Field label="Alert when a camera hasn't recorded for">
              <div className="flex items-center gap-3">
                <input type="range" min={1} max={60} value={draft.notify_after_minutes} onChange={(e) => set("notify_after_minutes", Number(e.target.value))} className="flex-1" />
                <span className="w-16 text-right text-sm tabular-nums text-white">{draft.notify_after_minutes} min</span>
              </div>
            </Field>
            <Field label="Quiet windows" hint="No outage alerts in these daily windows, e.g. your router's scheduled restart. Recording continues regardless.">
              <QuietWindows value={draft.quiet_windows} onChange={(v) => set("quiet_windows", v)} />
            </Field>
            <Toggle checked={draft.mqtt_enabled} onChange={(v) => set("mqtt_enabled", v)} label="Home Assistant entities (MQTT)" hint="Motion & recording sensors plus a snapshot camera per camera" />
          </div>
        </Card>
        <Card className="p-5">
          <SectionTitle>
            <span className="flex items-center gap-2"><HardDrive className="size-4" /> Storage</span>
          </SectionTitle>
          <Field label="Always keep this much disk free" hint="If the disk gets fuller than this, the oldest recordings are removed early so recording never stops.">
            <div className="flex items-center gap-3">
              <input type="range" min={2} max={100} value={draft.min_free_gb} onChange={(e) => set("min_free_gb", Number(e.target.value))} className="flex-1" />
              <span className="w-16 text-right text-sm tabular-nums text-white">{draft.min_free_gb} GB</span>
            </div>
          </Field>
          <p className="mt-4 text-xs text-slate-500">How long to keep footage is set per camera. Recordings are stored in <code className="text-slate-400">/media/sentinel</code>.</p>
        </Card>
      </div>

      <AnimatePresence>
        {dirty && (
          <motion.div
            initial={{ y: 80, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 80, opacity: 0 }}
            className="glass fixed inset-x-4 bottom-20 z-40 mx-auto flex max-w-xl items-center justify-between gap-3 rounded-2xl bg-ink-850/90 px-4 py-3 shadow-2xl md:bottom-6"
          >
            <span className="text-sm text-slate-300">You have unsaved changes</span>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setDraft(saved)}>Discard</Button>
              <Button size="sm" variant="primary" disabled={saving} onClick={() => save(draft)}>
                {saving && <Loader2 className="size-3.5 animate-spin" />} Save
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {editing && (
          <CameraEditor
            key={editing.index}
            initial={editing.cam}
            isNew={editing.index < 0}
            saving={saving}
            onClose={() => setEditing(null)}
            onSave={async (cam) => {
              const cams = [...saved.cameras];
              if (editing.index < 0) cams.push(cam);
              else cams[editing.index] = cam;
              if (await save({ ...saved, cameras: cams }, editing.index < 0 ? `${cam.name} added — recording starts now` : `${cam.name} saved`)) setEditing(null);
            }}
            onDelete={async () => {
              const cams = saved.cameras.filter((_, i) => i !== editing.index);
              if (await save({ ...saved, cameras: cams }, `${editing.cam.name} removed`)) setEditing(null);
            }}
          />
        )}
      </AnimatePresence>
    </>
  );
}

function CameraRow({ cam, onEdit }: { cam: Camera; onEdit: () => void }) {
  const { status } = useStatus();
  const st = status?.cameras.find((c) => c.id === cam.id);
  return (
    <div className="flex items-center gap-4 px-4 py-3.5">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500/20 to-cyan-500/10 text-violet-200">
        <CamIcon className="size-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium text-white">{cam.name}</span>
          <span className="text-xs text-slate-600">{cam.id}</span>
        </div>
        <div className="truncate text-xs text-slate-500">
          Keep {cam.retain_days}d · {cam.record ? "24/7 recording" : "live only"}
          {cam.audio && cam.record ? " · audio" : ""} · {cam.motion ? `motion ${cam.motion_sensitivity}%` : "no motion"}
          {cam.motion_masks.length ? ` · ${cam.motion_masks.length} zone${cam.motion_masks.length > 1 ? "s" : ""}` : ""}
        </div>
      </div>
      <StatePill state={recState(cam.enabled, cam.record, st?.recorder ?? null)} />
      <IconButton title="Edit" onClick={onEdit}>
        <Pencil className="size-4" />
      </IconButton>
    </div>
  );
}

function QuietWindows({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [from, setFrom] = useState("03:55");
  const [to, setTo] = useState("04:20");
  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-2">
        {value.map((w) => (
          <span key={w} className="flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 py-1 pl-3 pr-1.5 text-xs text-slate-200">
            <Moon className="size-3 text-violet-300" /> {w}
            <button type="button" onClick={() => onChange(value.filter((x) => x !== w))} className="rounded-full p-0.5 hover:bg-white/10">
              <X className="size-3" />
            </button>
          </span>
        ))}
        {value.length === 0 && <span className="text-xs text-slate-600">None</span>}
      </div>
      <div className="flex items-center gap-2">
        <input type="time" value={from} onChange={(e) => setFrom(e.target.value)} className={clsx(inputCls, "w-32")} />
        <span className="text-slate-500">–</span>
        <input type="time" value={to} onChange={(e) => setTo(e.target.value)} className={clsx(inputCls, "w-32")} />
        <Button size="sm" onClick={() => from && to && !value.includes(`${from}-${to}`) && onChange([...value, `${from}-${to}`])}>
          <Plus className="size-3.5" /> Add
        </Button>
      </div>
    </div>
  );
}

const redact = (u: string) => u.replace(/(\w+:\/\/)[^/@\s]*@/, "$1•••@");

function UrlField({ label, hint, value, onChange, cameraId, field, required }: { label: string; hint: string; value: string; onChange: (v: string) => void; cameraId: string; field: string; required?: boolean }) {
  const [reveal, setReveal] = useState(!value);
  const [test, setTest] = useState<{ state: "idle" | "busy" | "ok" | "err"; info?: StreamInfo; error?: string }>({ state: "idle" });
  const run = async () => {
    setTest({ state: "busy" });
    try {
      const r = await api.testStream(value, cameraId, field);
      setTest(r.ok ? { state: "ok", info: r.info } : { state: "err", error: r.error });
    } catch (e) {
      setTest({ state: "err", error: (e as Error).message });
    }
  };
  return (
    <Field label={label + (required ? "" : " (optional)")} hint={hint}>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <input
            className={clsx(inputCls, "pr-10 font-mono text-xs")}
            value={reveal ? value : redact(value)}
            readOnly={!reveal}
            onFocus={() => setReveal(true)}
            placeholder="rtsp://user:password@192.168.1.10:554/stream1"
            onChange={(e) => {
              onChange(e.target.value);
              setTest({ state: "idle" });
            }}
            spellCheck={false}
          />
          <button type="button" onClick={() => setReveal((r) => !r)} className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-500 hover:text-slate-300" title={reveal ? "Hide password" : "Show"}>
            {reveal ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
        <Button size="md" type="button" onClick={run} disabled={!value || test.state === "busy"}>
          {test.state === "busy" ? <Loader2 className="size-4 animate-spin" /> : "Test"}
        </Button>
      </div>
      <AnimatePresence>
        {(test.state === "ok" || test.state === "err") && (
          <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className={clsx("mt-2 flex items-center gap-2 rounded-lg px-3 py-2 text-xs", test.state === "ok" ? "bg-emerald-500/10 text-emerald-200" : "bg-rose-500/10 text-rose-200")}>
            {test.state === "ok" ? <CheckCircle2 className="size-4" /> : <XCircle className="size-4" />}
            {test.state === "ok" && test.info
              ? `Connected · ${test.info.width}×${test.info.height} ${test.info.video_codec.toUpperCase()} · ${test.info.fps} fps${test.info.audio_codec ? ` · ${test.info.audio_codec} audio` : " · no audio"}`
              : test.error}
          </motion.div>
        )}
      </AnimatePresence>
    </Field>
  );
}

function CameraEditor({ initial, isNew, saving, onClose, onSave, onDelete }: { initial: Camera; isNew: boolean; saving: boolean; onClose: () => void; onSave: (c: Camera) => void; onDelete: () => void }) {
  const [cam, setCam] = useState<Camera>(initial);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = <K extends keyof Camera>(k: K, v: Camera[K]) => setCam((c) => ({ ...c, [k]: v }));

  return (
    <>
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
      <motion.aside
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        exit={{ x: "100%" }}
        transition={{ type: "spring", stiffness: 380, damping: 40 }}
        className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l border-white/10 bg-ink-900 shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-white/5 px-5 py-4">
          <h2 className="text-lg font-semibold text-white">{isNew ? "Add camera" : `Edit ${initial.name}`}</h2>
          <IconButton title="Close" onClick={onClose}>
            <X className="size-5" />
          </IconButton>
        </div>
        <div className="flex-1 space-y-6 overflow-y-auto p-5">
          <Field label="Name">
            <input className={inputCls} value={cam.name} onChange={(e) => set("name", e.target.value)} placeholder="Front door" autoFocus={isNew} />
          </Field>
          <UrlField label="Main stream" required hint="Full-quality stream that gets recorded." value={cam.main_url} onChange={(v) => set("main_url", v)} cameraId={cam.id} field="main_url" />
          <UrlField label="Substream" hint="Low-res stream for the live grid and motion detection. Saves a lot of CPU and bandwidth." value={cam.sub_url} onChange={(v) => set("sub_url", v)} cameraId={cam.id} field="sub_url" />

          <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
            <Toggle checked={cam.enabled} onChange={(v) => set("enabled", v)} label="Enabled" />
            <Toggle checked={cam.record} onChange={(v) => set("record", v)} label="Record 24/7" hint="Continuous recording at full quality" />
            <Toggle checked={cam.audio} onChange={(v) => set("audio", v)} label="Record audio" hint="Converted to AAC when needed" />
            <Toggle checked={cam.motion} onChange={(v) => set("motion", v)} label="Motion detection" hint="Timeline heatmap, events, and HA motion sensor" />
          </div>

          <Field label="Keep recordings for">
            <div className="flex items-center gap-3">
              <input type="range" min={1} max={30} value={Math.min(30, cam.retain_days)} onChange={(e) => set("retain_days", Number(e.target.value))} className="flex-1" />
              <input type="number" min={1} max={365} value={cam.retain_days} onChange={(e) => set("retain_days", Math.max(1, Number(e.target.value)))} className={clsx(inputCls, "w-20 text-center")} />
              <span className="text-sm text-slate-400">days</span>
            </div>
          </Field>

          {cam.motion && (
            <>
              <Field label="Motion sensitivity" hint="Higher catches smaller movements; lower ignores rain, leaves and noise.">
                <div className="flex items-center gap-3">
                  <input type="range" min={1} max={100} value={cam.motion_sensitivity} onChange={(e) => set("motion_sensitivity", Number(e.target.value))} className="flex-1" />
                  <span className="w-10 text-right text-sm tabular-nums text-white">{cam.motion_sensitivity}</span>
                </div>
              </Field>
              <Field label="Ignore zones">
                {isNew ? (
                  <p className="text-xs text-slate-500">Save the camera first, then come back to draw zones on its picture.</p>
                ) : (
                  <MaskEditor camera={cam.id} masks={cam.motion_masks} onChange={(m) => set("motion_masks", m)} />
                )}
              </Field>
            </>
          )}

          {!isNew && (
            <div className="rounded-xl border border-rose-500/20 p-4">
              {confirmDelete ? (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-sm text-rose-200">Remove this camera? Its recordings are kept until they expire.</span>
                  <div className="flex gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button>
                    <Button size="sm" variant="danger" onClick={onDelete}>Remove</Button>
                  </div>
                </div>
              ) : (
                <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)}>
                  <Trash2 className="size-3.5" /> Remove camera
                </Button>
              )}
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-white/5 px-5 py-4">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={saving || !cam.name.trim() || !cam.main_url.trim()} onClick={() => onSave(cam)}>
            {saving && <Loader2 className="size-4 animate-spin" />} {isNew ? "Add & start recording" : "Save camera"}
          </Button>
        </div>
      </motion.aside>
    </>
  );
}
