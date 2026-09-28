import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import clsx from "clsx";
import { Download, Film, Loader2, Pencil, Pin, PinOff, Play, Trash2, X, AlertTriangle, FolderOpen, Check, CloudUpload, CloudCheck, CloudAlert, Moon } from "lucide-react";
import { Button, Card, Empty, IconButton, PageHeader } from "../components/ui";
import { useStatus } from "../lib/status";
import { useToast } from "../lib/toast";
import { api, clipThumbURL, clipVideoURL, type Clip } from "../lib/api";
import { fmtBytes, fmtDay, fmtDuration, fmtTimeSec } from "../lib/format";

export function ClipsPage() {
  const toast = useToast();
  const { status } = useStatus();
  const [clips, setClips] = useState<Clip[] | null>(null);
  const [playing, setPlaying] = useState<Clip | null>(null);
  const [retention, setRetention] = useState<number | null>(null);

  const load = () => api.clips().then(setClips).catch(() => {});
  useEffect(() => {
    load();
    api.settings().then((s) => setRetention(s.clip_retention_days)).catch(() => {});
  }, []);
  // Poll faster while something is saving.
  const busy = clips?.some((c) => c.status === "saving" || c.status === "queued" || c.backup?.state === "uploading");
  useEffect(() => {
    const t = window.setInterval(load, busy ? 1000 : 10_000);
    return () => window.clearInterval(t);
  }, [busy]);

  const patch = async (c: Clip, p: { name?: string; pinned?: boolean }) => {
    try {
      const n = await api.patchClip(c.id, p);
      setClips((all) => all?.map((x) => (x.id === n.id ? n : x)) ?? null);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  const remove = async (c: Clip) => {
    try {
      await api.deleteClip(c.id);
      setClips((all) => all?.filter((x) => x.id !== c.id) ?? null);
      toast("Clip deleted");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const backup = async (c: Clip) => {
    try {
      await api.backupClip(c.id);
      toast("Uploading to Google Drive…", "info");
      load();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const total = clips?.reduce((n, c) => n + c.size, 0) ?? 0;
  const drive = !!status?.drive.connected;

  return (
    <>
      <PageHeader
        title="Clips"
        sub={
          clips
            ? `${clips.length} saved clip${clips.length === 1 ? "" : "s"} · ${fmtBytes(total)} · ${retention === 0 ? "kept until you delete them" : retention ? `kept ${retention} days unless pinned` : ""}`
            : "Loading…"
        }
      />
      <div className="mb-6 flex items-start gap-3 rounded-2xl border border-white/5 bg-white/[0.02] px-4 py-3 text-sm text-slate-400">
        <FolderOpen className="mt-0.5 size-4 shrink-0 text-violet-300" />
        <div>
          Clips are saved on your Home Assistant in <code className="text-slate-300">media/sentinel/exports</code> (also visible in Home Assistant's <b className="text-slate-300">Media</b> panel). <b className="text-slate-300">Download</b> saves a copy to this device's Downloads folder.
        </div>
      </div>

      {clips && clips.length === 0 ? (
        <Empty
          icon={<Film className="size-6" />}
          title="No clips yet"
          sub="Open a camera, press the scissors button under the player, pick a start and end on the timeline and press Save clip."
          action={
            <Link to="/">
              <Button variant="primary">Choose a camera</Button>
            </Link>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {!clips
            ? [0, 1, 2].map((i) => <div key={i} className="skeleton aspect-video rounded-2xl" />)
            : clips.map((c, i) => <ClipCard key={c.id} clip={c} index={i} cameraName={status?.cameras.find((x) => x.id === c.camera)?.name ?? c.camera_name} onPlay={() => setPlaying(c)} onPatch={(p) => patch(c, p)} onDelete={() => remove(c)} onBackup={drive ? () => backup(c) : undefined} />)}
        </div>
      )}

      <AnimatePresence>{playing && <Player clip={playing} onClose={() => setPlaying(null)} />}</AnimatePresence>
    </>
  );
}

function ClipCard({
  clip: c,
  index,
  cameraName,
  onPlay,
  onPatch,
  onDelete,
  onBackup,
}: {
  clip: Clip;
  index: number;
  cameraName: string;
  onPlay: () => void;
  onPatch: (p: { name?: string; pinned?: boolean }) => void;
  onDelete: () => void;
  onBackup?: () => void;
}) {
  const b = c.backup;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(c.name);
  const [confirm, setConfirm] = useState(false);
  const ready = c.status === "ready";
  const busy = c.status === "saving" || c.status === "queued";
  return (
    <Card transition={{ delay: Math.min(index, 10) * 0.03 }} className="group overflow-hidden">
      <button disabled={!ready} onClick={onPlay} className="relative block aspect-video w-full overflow-hidden bg-ink-800">
        {ready && <img src={clipThumbURL(c)} className="h-full w-full object-cover transition duration-500 group-hover:scale-105" loading="lazy" />}
        {ready && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 transition group-hover:opacity-100">
            <span className="flex size-12 items-center justify-center rounded-full bg-white/90 text-ink-950 shadow-xl">
              <Play className="ml-0.5 size-5 fill-current" />
            </span>
          </div>
        )}
        {busy && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8">
            <Loader2 className="size-6 animate-spin text-cyan-300" />
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
              <motion.div className="h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-400" animate={{ width: `${Math.max(4, c.progress)}%` }} />
            </div>
            <span className="text-xs text-slate-400">{c.status === "queued" ? "Waiting…" : `Saving ${Math.round(c.progress)}%`}</span>
          </div>
        )}
        {c.status === "failed" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-xs text-rose-200">
            <AlertTriangle className="size-5" /> {c.error || "Saving failed"}
          </div>
        )}
        <span className="absolute left-2 top-2 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold text-white backdrop-blur">{cameraName}</span>
        <span className="absolute bottom-2 right-2 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-white backdrop-blur">{fmtDuration(c.to - c.from)}</span>
        <span className="absolute right-2 top-2 flex gap-1">
          {c.alert && (
            <span className="flex items-center gap-1 rounded-md bg-indigo-500/90 px-1.5 py-0.5 text-[10px] font-semibold text-white" title="Saved automatically for a night alert">
              <Moon className="size-3" /> Alert
            </span>
          )}
          {b?.state === "done" && (
            <span className="rounded-md bg-emerald-500/90 p-1 text-white" title="Backed up to Google Drive">
              <CloudCheck className="size-3" />
            </span>
          )}
          {(b?.state === "uploading" || b?.state === "pending") && (
            <span className="flex items-center gap-1 rounded-md bg-cyan-500/90 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-white" title="Uploading to Google Drive">
              <CloudUpload className="size-3" /> {b.state === "pending" ? "Queued" : `${Math.round(b.progress)}%`}
            </span>
          )}
          {b?.state === "failed" && (
            <span className="rounded-md bg-rose-500/90 p-1 text-white" title={`Drive backup failed: ${b.error ?? ""} (retrying)`}>
              <CloudAlert className="size-3" />
            </span>
          )}
          {c.pinned && (
            <span className="rounded-md bg-violet-500 p-1 text-white" title="Pinned: never deleted automatically">
              <Pin className="size-3" />
            </span>
          )}
        </span>
      </button>
      <div className="p-3">
        {editing ? (
          <form
            className="flex gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              onPatch({ name });
              setEditing(false);
            }}
          >
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} className="h-8 min-w-0 flex-1 rounded-lg border border-white/10 bg-ink-900 px-2 text-sm text-white" />
            <IconButton type="submit" title="Save name" className="size-8">
              <Check className="size-4" />
            </IconButton>
          </form>
        ) : (
          <div className="truncate font-medium text-white" title={c.name}>
            {c.name}
          </div>
        )}
        <div className="mt-0.5 text-xs text-slate-500">
          {fmtDay(c.from)} · {fmtTimeSec(c.from)} → {fmtTimeSec(c.to)}
          {ready && ` · ${fmtBytes(c.size)}`}
        </div>
        <div className="mt-3 flex items-center gap-1">
          {confirm ? (
            <>
              <span className="mr-auto text-xs text-rose-200">Delete this clip?</span>
              <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
                Keep
              </Button>
              <Button size="sm" variant="danger" onClick={onDelete}>
                Delete
              </Button>
            </>
          ) : (
            <>
              <a href={ready ? clipVideoURL(c.id, true) : undefined} download className={clsx(!ready && "pointer-events-none opacity-40")}>
                <Button size="sm" variant="primary">
                  <Download className="size-3.5" /> Download
                </Button>
              </a>
              <div className="ml-auto flex">
                {onBackup && ready && b?.state !== "done" && b?.state !== "uploading" && (
                  <IconButton title={b?.state === "failed" ? "Retry the Google Drive backup" : "Back up to Google Drive"} onClick={onBackup} className="size-8">
                    <CloudUpload className="size-3.5" />
                  </IconButton>
                )}
                <IconButton title="Rename" onClick={() => setEditing((e) => !e)} className="size-8">
                  <Pencil className="size-3.5" />
                </IconButton>
                <IconButton title={c.pinned ? "Unpin (can be auto-deleted)" : "Pin (never auto-delete)"} onClick={() => onPatch({ pinned: !c.pinned })} className="size-8">
                  {c.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                </IconButton>
                <IconButton title="Delete" onClick={() => setConfirm(true)} disabled={busy} className="size-8 hover:text-rose-300">
                  <Trash2 className="size-3.5" />
                </IconButton>
              </div>
            </>
          )}
        </div>
      </div>
    </Card>
  );
}

function Player({ clip, onClose }: { clip: Clip; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm" onClick={onClose}>
      <motion.div initial={{ scale: 0.95, y: 10 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.95 }} className="w-full max-w-5xl overflow-hidden rounded-2xl border border-white/10 bg-ink-900 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3">
          <div className="min-w-0">
            <div className="truncate font-semibold text-white">{clip.name}</div>
            <div className="text-xs text-slate-500">
              {clip.camera_name} · {fmtDay(clip.from)} {fmtTimeSec(clip.from)} · {fmtDuration(clip.to - clip.from)}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <a href={clipVideoURL(clip.id, true)} download>
              <Button size="sm" variant="primary">
                <Download className="size-3.5" /> Download
              </Button>
            </a>
            <IconButton title="Close (Esc)" onClick={onClose}>
              <X className="size-5" />
            </IconButton>
          </div>
        </div>
        <video src={clipVideoURL(clip.id)} controls autoPlay className="aspect-video w-full bg-black" />
      </motion.div>
    </motion.div>
  );
}
