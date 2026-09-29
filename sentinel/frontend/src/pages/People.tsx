import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import clsx from "clsx";
import { Check, Loader2, Pencil, ScanFace, Trash2, UserRound, X } from "lucide-react";
import { Button, Card, Empty, IconButton, PageHeader, SectionTitle, inputCls } from "../components/ui";
import { useStatus } from "../lib/status";
import { useToast } from "../lib/toast";
import { api, faceURL, type FaceGroup, type FaceInfo, type FaceStatus, type PersonInfo } from "../lib/api";
import { fmtDay, fmtTime } from "../lib/format";

// People: who Sentinel recognises. Faces it has seen but can't put a name to are shown
// in groups (most likely the same person); naming a group names every face in it, and
// every face named makes that person easier to recognise.

export function PeoplePage() {
  const toast = useToast();
  const [people, setPeople] = useState<PersonInfo[] | null>(null);
  const [status, setStatus] = useState<FaceStatus | null>(null);
  const [groups, setGroups] = useState<FaceGroup[] | null>(null);
  const [open, setOpen] = useState<PersonInfo | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, g] = await Promise.all([api.people(), api.unknownFaces(40)]);
      setPeople(p.people);
      setStatus(p.status);
      setGroups(g);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }, [toast]);

  useEffect(() => {
    load();
    const t = window.setInterval(() => !document.hidden && load(), 30_000);
    return () => window.clearInterval(t);
  }, [load]);

  const names = useMemo(() => (people ?? []).map((p) => p.name), [people]);

  return (
    <>
      <PageHeader
        title="People"
        sub="Sentinel recognises the people you name: by face on any camera, and on the same day by their clothes when a camera only sees them from above."
      />
      {status && !status.enabled && (
        <Card className="mb-4 border-amber-400/20 bg-amber-400/[0.05] p-4 text-sm text-amber-100">
          {status.error ? `Face recognition isn't working: ${status.error}` : "Face recognition is off (Settings → Alerts)."}
        </Card>
      )}
      {status?.enabled && status.backlog > 0 && (
        <p className="mb-4 flex items-center gap-2 text-xs text-slate-400">
          <Loader2 className="size-3.5 animate-spin" /> Looking for faces in {status.backlog} earlier event{status.backlog === 1 ? "" : "s"} with people (in the background)…
        </p>
      )}

      {/* Named */}
      <section className="mb-10">
        <SectionTitle sub={people?.length ? "Tap someone to see the faces taken for them and remove wrong ones." : undefined}>
          <span className="flex items-center gap-2">
            <UserRound className="size-4" /> Known people
          </span>
        </SectionTitle>
        {!people ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="skeleton h-44 rounded-2xl" />
            ))}
          </div>
        ) : people.length === 0 ? (
          <p className="rounded-2xl border border-white/5 bg-white/[0.02] px-4 py-6 text-sm text-slate-400">Nobody yet. Name someone below and Sentinel starts recognising them.</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
            {people.map((p) => (
              <PersonCard key={p.id} p={p} onOpen={() => setOpen(p)} />
            ))}
          </div>
        )}
      </section>

      {/* Unknown */}
      <section>
        <SectionTitle sub="Faces seen but not known yet, grouped by likeness (most seen first). Name a group once; remove any face that doesn't belong by tapping it first.">
          <span className="flex items-center gap-2">
            <ScanFace className="size-4" /> Who is this?
          </span>
        </SectionTitle>
        {!groups ? (
          <div className="skeleton h-32 rounded-2xl" />
        ) : groups.length === 0 ? (
          <Empty
            icon={<ScanFace className="size-6" />}
            title="No new faces"
            sub={status?.faces ? "Every clear face seen so far has a name." : "Faces appear here as people walk past the cameras facing them. Cameras looking straight down rarely see one."}
          />
        ) : (
          <div className="flex flex-col gap-3">
            <AnimatePresence initial={false}>
              {groups
                .filter((g) => g.size > 1 || g.suggest)
                .map((g) => (
                  <GroupCard key={g.ids[0]} g={g} names={names} onDone={load} />
                ))}
            </AnimatePresence>
            {groups.some((g) => g.size === 1 && !g.suggest) && (
              <Singles faces={groups.filter((g) => g.size === 1 && !g.suggest).map((g) => g.faces[0])} names={names} onDone={load} />
            )}
          </div>
        )}
      </section>

      <AnimatePresence>{open && <PersonSheet p={open} onClose={() => setOpen(null)} onChanged={load} />}</AnimatePresence>
    </>
  );
}

function PersonCard({ p, onOpen }: { p: PersonInfo; onOpen: () => void }) {
  const { status } = useStatus();
  const cam = status?.cameras.find((c) => c.id === p.last?.cam);
  return (
    <button onClick={onOpen} className="group flex flex-col items-center gap-2 rounded-2xl border border-white/[0.07] bg-ink-850 p-4 text-center transition hover:border-white/15 hover:bg-white/[0.03]">
      <Avatar id={p.cover} className="size-20" />
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold text-white">{p.name}</div>
        <div className="text-xs text-slate-500">
          {p.sightings} event{p.sightings === 1 ? "" : "s"} this week · {p.faces} face{p.faces === 1 ? "" : "s"}
        </div>
        {p.last && (
          <div className="mt-1 text-[11px] text-slate-400">
            Last: {cam?.name ?? p.last.cam}, {fmtDay(p.last.t)} {fmtTime(p.last.t)}
          </div>
        )}
      </div>
    </button>
  );
}

function Avatar({ id, className }: { id?: string; className?: string }) {
  return id ? (
    <img src={faceURL(id)} alt="" className={clsx("rounded-full object-cover ring-2 ring-white/10", className)} />
  ) : (
    <span className={clsx("flex items-center justify-center rounded-full bg-white/5 text-slate-500 ring-2 ring-white/10", className)}>
      <UserRound className="size-1/2" />
    </span>
  );
}

function Face({ f, dim, onClick, badge }: { f: FaceInfo; dim?: boolean; onClick?: () => void; badge?: React.ReactNode }) {
  const { status } = useStatus();
  const cam = status?.cameras.find((c) => c.id === f.cam)?.name ?? f.cam;
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${cam}, ${fmtDay(f.t)} ${fmtTime(f.t)}`}
      className={clsx("relative size-16 shrink-0 overflow-hidden rounded-xl ring-1 ring-white/10 transition sm:size-[72px]", dim ? "opacity-25 grayscale" : "hover:ring-white/40")}
    >
      <img src={faceURL(f.id)} alt="" loading="lazy" className="h-full w-full object-cover" />
      {dim && <X className="absolute inset-0 m-auto size-6 text-white" />}
      {badge}
    </button>
  );
}

function GroupCard({ g, names, onDone }: { g: FaceGroup; names: string[]; onDone: () => void }) {
  const toast = useToast();
  const [left, setLeft] = useState<Set<string>>(new Set()); // faces taken out of the group
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const ids = g.ids.filter((id) => !left.has(id));
  const toggle = (id: string) => setLeft((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set(s).add(id)));

  const act = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    try {
      await fn();
      toast(msg, "success");
      onDone();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  const save = (who: { person?: string; name?: string }, label: string) =>
    act(() => api.nameFaces(ids, who), `${ids.length} face${ids.length === 1 ? "" : "s"} named ${label}. Sentinel will recognise them from now on.`);

  return (
    <motion.div layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0, marginBottom: -12 }}>
      <Card className="p-4">
        <div className="flex flex-wrap gap-2">
          {g.faces.map((f) => (
            <Face key={f.id} f={f} dim={left.has(f.id)} onClick={() => toggle(f.id)} />
          ))}
          {g.size > g.faces.length && (
            <span className="flex size-16 items-center justify-center rounded-xl bg-white/5 text-xs text-slate-400 sm:size-[72px]">+{g.size - g.faces.length}</span>
          )}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-slate-500">
            {g.size} face{g.size === 1 ? "" : "s"}
            {left.size > 0 && ` (${left.size} taken out)`}
          </span>
          {g.suggest && (
            <Button size="sm" variant="primary" disabled={busy || ids.length === 0} onClick={() => save({ person: g.suggest!.person }, g.suggest!.name)}>
              <Check className="size-3.5" /> This is {g.suggest.name}
            </Button>
          )}
          <form
            className="flex min-w-60 flex-1 items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) save({ name: name.trim() }, name.trim());
            }}
          >
            <input list="people-names" value={name} onChange={(e) => setName(e.target.value)} placeholder={g.suggest ? "Or someone else…" : "Who is this?"} className={clsx(inputCls, "h-9 flex-1")} />
            <datalist id="people-names">
              {names.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
            <Button size="sm" type="submit" variant={g.suggest ? "subtle" : "primary"} disabled={busy || !name.trim() || ids.length === 0}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} Save
            </Button>
          </form>
          <Button size="sm" variant="ghost" disabled={busy} title="Not a face (a pattern, a picture): similar ones are ignored too" onClick={() => act(() => api.notFaces(ids), "Ignored. Similar ones won't show up again.")}>
            Not a face
          </Button>
        </div>
      </Card>
    </motion.div>
  );
}

// Faces seen once: tap the ones of the same person, then name them together.
function Singles({ faces, names, onDone }: { faces: FaceInfo[]; names: string[]; onDone: () => void }) {
  const toast = useToast();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const ids = [...picked];
  const toggle = (id: string) => setPicked((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set(s).add(id)));
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    try {
      await fn();
      toast(msg, "success");
      setPicked(new Set());
      setName("");
      onDone();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="p-4">
      <div className="mb-2 text-sm font-semibold text-white">Seen once</div>
      <p className="mb-3 text-xs text-slate-400">Tap the faces of one person (they may be seen from different angles), then name them together.</p>
      <div className="flex flex-wrap gap-2">
        {faces.map((f) => (
          <div key={f.id} className={clsx("rounded-xl", picked.has(f.id) && "ring-2 ring-violet-400")}>
            <Face f={f} onClick={() => toggle(f.id)} badge={picked.has(f.id) ? <Check className="absolute right-1 top-1 size-4 rounded-full bg-violet-500 p-0.5 text-white" /> : undefined} />
          </div>
        ))}
      </div>
      {ids.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-slate-400">{ids.length} picked</span>
          <form
            className="flex min-w-60 flex-1 items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const n = name.trim();
              if (n) act(() => api.nameFaces(ids, { name: n }), `${ids.length} face${ids.length === 1 ? "" : "s"} named ${n}.`);
            }}
          >
            <input list="people-names-once" value={name} onChange={(e) => setName(e.target.value)} placeholder="Who is this?" className={clsx(inputCls, "h-9 flex-1")} />
            <datalist id="people-names-once">
              {names.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
            <Button size="sm" type="submit" variant="primary" disabled={busy || !name.trim()}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} Save
            </Button>
          </form>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => api.notFaces(ids), "Ignored.")}>
            Not a face
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>
            Clear
          </Button>
        </div>
      )}
    </Card>
  );
}

function PersonSheet({ p, onClose, onChanged }: { p: PersonInfo; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const nav = useNavigate();
  const [faces, setFaces] = useState<FaceInfo[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(p.name);

  const load = useCallback(() => api.personFaces(p.id, 90).then(setFaces).catch(() => setFaces([])), [p.id]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const notThem = async (f: FaceInfo) => {
    setFaces((l) => l?.filter((x) => x.id !== f.id) ?? null);
    try {
      await api.notPerson([f.id], p.id);
      onChanged();
    } catch (e) {
      toast((e as Error).message, "error");
      load();
    }
  };
  const rename = async () => {
    try {
      await api.renamePerson(p.id, name);
      setEditing(false);
      onChanged();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  const forget = async () => {
    if (!confirm(`Forget ${p.name}? Their faces become unknown again; nothing else is deleted.`)) return;
    try {
      await api.forgetPerson(p.id);
      onChanged();
      onClose();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center" onClick={onClose}>
      <motion.div
        initial={{ y: 30, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 30, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-t-3xl border border-white/10 bg-ink-900 p-5 sm:rounded-3xl"
      >
        <div className="mb-4 flex items-center gap-4">
          <Avatar id={p.cover} className="size-16" />
          <div className="min-w-0 flex-1">
            {editing ? (
              <form
                className="flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  rename();
                }}
              >
                <input autoFocus value={name} onChange={(e) => setName(e.target.value)} className={clsx(inputCls, "h-9")} />
                <Button size="sm" type="submit" variant="primary">
                  Save
                </Button>
              </form>
            ) : (
              <div className="flex items-center gap-2">
                <h2 className="truncate text-xl font-semibold text-white">{p.name}</h2>
                <IconButton title="Rename" onClick={() => setEditing(true)} className="size-8">
                  <Pencil className="size-3.5" />
                </IconButton>
              </div>
            )}
            <div className="text-xs text-slate-400">
              {p.sightings} event{p.sightings === 1 ? "" : "s"} this week ·{" "}
              <Link to={`/events?who=${p.id}`} className="text-violet-300 hover:underline" onClick={onClose}>
                show them
              </Link>
            </div>
          </div>
          <IconButton title="Close (Esc)" onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        </div>
        <p className="mb-3 text-xs text-slate-400">
          Faces taken for {p.name}: the ones you named first, then recognised ones, newest first. Tap a face that isn't {p.name} to take it out (Sentinel learns from it).
        </p>
        {!faces ? (
          <Loader2 className="size-5 animate-spin text-slate-500" />
        ) : faces.length === 0 ? (
          <p className="text-sm text-slate-500">No faces kept.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {faces.map((f) => (
              <div key={f.id} className="group relative">
                <Face
                  f={f}
                  onClick={() => nav(`/camera/${f.cam}?t=${f.t - 3000}`)}
                  badge={
                    <span className={clsx("absolute inset-x-0 bottom-0 bg-black/60 text-center text-[9px] font-semibold", f.by === "you" ? "text-emerald-300" : "text-slate-300")}>
                      {f.by === "you" ? "named" : `${Math.round((f.sim ?? 0) * 100)}%`}
                    </span>
                  }
                />
                <button
                  onClick={() => notThem(f)}
                  title={`Not ${p.name}`}
                  className="absolute -right-1.5 -top-1.5 hidden size-6 items-center justify-center rounded-full bg-rose-500 text-white shadow group-hover:flex"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="mt-6 flex justify-between border-t border-white/5 pt-4">
          <span className="text-[11px] text-slate-500">
            Faces are kept on the Pi only. Recognised by face: pink name; ≈ name: going by clothes the same day.
          </span>
          <Button size="sm" variant="ghost" onClick={forget}>
            <Trash2 className="size-3.5" /> Forget {p.name}
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );
}
