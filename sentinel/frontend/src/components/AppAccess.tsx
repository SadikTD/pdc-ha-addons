import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import clsx from "clsx";
import QRCode from "qrcode";
import { Check, Copy, Download, Globe, Home, KeyRound, Loader2, LogOut, Pencil, Plus, ShieldCheck, Smartphone, Trash2, UserRound, Users, X } from "lucide-react";
import { Button, Card, Field, IconButton, SectionTitle, Toggle, inputCls } from "./ui";
import { api, type AppSession, type AppStatus, type AppUser, type AppUserInput, type Camera } from "../lib/api";
import { fmtAgo } from "../lib/format";
import { useToast } from "../lib/toast";

export const APP_DOWNLOAD = "https://github.com/SadikTD/pdc-ha-addons/releases/latest";

// The Sentinel app: the server's ID (with a QR code the app scans), who may log in,
// and which phones are signed in.
export function AppAccessCard({ cameras }: { cameras: Camera[] }) {
  const toast = useToast();
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [users, setUsers] = useState<AppUser[] | null>(null);
  const [sessions, setSessions] = useState<AppSession[]>([]);
  const [editing, setEditing] = useState<AppUser | "new" | null>(null);
  const [qr, setQr] = useState("");
  const [copied, setCopied] = useState(false);

  const load = () => {
    api.appStatus().then(setStatus).catch(() => {});
    api.appUsers().then(setUsers).catch(() => setUsers([]));
    api.appSessions().then(setSessions).catch(() => {});
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!status?.id) return;
    QRCode.toDataURL(`sentinel://connect?id=${status.id}`, { margin: 1, width: 240, color: { dark: "#0b0f1a", light: "#ffffff" } }).then(setQr);
  }, [status?.id]);

  const online = status?.host?.online;
  const copy = () => {
    if (!status?.id) return;
    navigator.clipboard?.writeText(status.id).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const remove = async (u: AppUser) => {
    if (!confirm(`Remove ${u.username}? Their phones are signed out at once.`)) return;
    try {
      await api.deleteAppUser(u.id);
      toast(`${u.username} removed`);
      load();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const signOut = async (s: AppSession) => {
    try {
      await api.deleteAppSession(s.id);
      toast(`${s.device || "Phone"} signed out`);
      load();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const camName = (id: string) => cameras.find((c) => c.id === id)?.name ?? id;

  return (
    <Card className="mt-4 p-5">
      <SectionTitle
        sub="Watch live and recorded video on Android phones, at home or anywhere. Only people you add here can log in."
        action={
          <a href={APP_DOWNLOAD} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 text-xs font-medium text-slate-200 hover:bg-white/[0.08]">
            <Download className="size-3.5" /> Get the app
          </a>
        }
      >
        <span className="flex items-center gap-2"><Smartphone className="size-4" /> Sentinel app</span>
      </SectionTitle>

      <div className="grid gap-5 lg:grid-cols-[auto_1fr]">
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-white/5 bg-white/[0.02] p-4">
          {qr ? <img src={qr} alt="Sentinel ID QR code" className="size-40 rounded-xl" /> : <div className="size-40 animate-pulse rounded-xl bg-white/5" />}
          <button onClick={copy} className="group flex items-center gap-2 font-mono text-lg font-semibold tracking-wider text-white" title="Copy the Sentinel ID">
            {status?.id ?? "…"}
            {copied ? <Check className="size-4 text-emerald-400" /> : <Copy className="size-4 text-slate-500 group-hover:text-slate-300" />}
          </button>
          <span className="text-center text-xs text-slate-500">Scan in the app, or type this ID.<br />At home the app finds Sentinel by itself.</span>
        </div>

        <div className="min-w-0 space-y-4">
          <div className="flex flex-wrap gap-2">
            <span className={clsx("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold", online ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-300" : "border-amber-500/25 bg-amber-500/10 text-amber-300")}>
              <Globe className="size-3.5" /> {online ? "Reachable from anywhere" : status?.error || status?.host?.error || "Connecting…"}
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-xs text-slate-300">
              <Home className="size-3.5" /> {status?.lan?.[0] ?? "home network"}
            </span>
            {status?.host?.public && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-xs text-slate-400">
                internet {status.host.public}
              </span>
            )}
            <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-xs text-slate-400">
              <ShieldCheck className="size-3.5" /> end-to-end encrypted
            </span>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-slate-400"><Users className="size-3.5" /> Users</span>
              <Button size="sm" variant="primary" onClick={() => setEditing("new")}>
                <Plus className="size-4" /> Add user
              </Button>
            </div>
            <div className="divide-y divide-white/5 overflow-hidden rounded-xl border border-white/5">
              {users === null && <div className="p-4 text-sm text-slate-500">Loading…</div>}
              {users?.length === 0 && <div className="p-4 text-sm text-slate-500">No users yet. Add one, then log in with it in the app.</div>}
              {users?.map((u) => (
                <div key={u.id} className="flex items-center gap-3 px-3 py-2.5">
                  <div className={clsx("flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold", u.admin ? "bg-violet-500/20 text-violet-200" : "bg-cyan-500/15 text-cyan-200")}>
                    {(u.name || u.username).slice(0, 1).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm text-white">
                      <span className="truncate">{u.name || u.username}</span>
                      <span className="text-xs text-slate-500">@{u.username}</span>
                      {u.admin && <span className="rounded-md bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-violet-300">Admin</span>}
                      {u.disabled && <span className="rounded-md bg-slate-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-400">Off</span>}
                    </div>
                    <div className="truncate text-xs text-slate-500">
                      {u.admin || u.cameras.length === 0 ? "All cameras" : u.cameras.map(camName).join(", ")}
                      {" · "}
                      {u.last_login ? `last login ${fmtAgo(u.last_login)}` : "never logged in"}
                    </div>
                  </div>
                  <IconButton title="Edit" onClick={() => setEditing(u)}><Pencil className="size-4" /></IconButton>
                  <IconButton title="Remove" onClick={() => remove(u)} className="hover:text-rose-300"><Trash2 className="size-4" /></IconButton>
                </div>
              ))}
            </div>
          </div>

          {sessions.length > 0 && (
            <div>
              <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-slate-400"><Smartphone className="size-3.5" /> Signed-in phones</div>
              <div className="divide-y divide-white/5 overflow-hidden rounded-xl border border-white/5">
                {sessions.map((s) => (
                  <div key={s.id} className="flex items-center gap-3 px-3 py-2">
                    <Smartphone className="size-4 shrink-0 text-slate-500" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-slate-200">
                        {s.device || "Phone"} <span className="text-xs text-slate-500">@{s.username}</span>
                      </div>
                      <div className="truncate text-xs text-slate-500">
                        {fmtAgo(s.last_seen)} · {s.via === "home" ? "at home" : "over the internet"}
                        {s.push && " · notifications on"}
                      </div>
                    </div>
                    <IconButton title="Sign out this phone" onClick={() => signOut(s)} className="hover:text-rose-300"><LogOut className="size-4" /></IconButton>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <AnimatePresence>
        {editing && (
          <UserEditor
            user={editing === "new" ? null : editing}
            cameras={cameras}
            onClose={() => setEditing(null)}
            onSaved={(msg) => {
              toast(msg);
              setEditing(null);
              load();
            }}
          />
        )}
      </AnimatePresence>
    </Card>
  );
}

function newPassword() {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const b = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(b, (x) => chars[x % chars.length]).join("");
}

function UserEditor({ user, cameras, onClose, onSaved }: { user: AppUser | null; cameras: Camera[]; onClose: () => void; onSaved: (msg: string) => void }) {
  const toast = useToast();
  const [username, setUsername] = useState(user?.username ?? "");
  const [name, setName] = useState(user?.name ?? "");
  const [password, setPassword] = useState(user ? "" : newPassword());
  const [showPw, setShowPw] = useState(!user);
  const [admin, setAdmin] = useState(user?.admin ?? false);
  const [allCams, setAllCams] = useState(!user || user.cameras.length === 0);
  const [cams, setCams] = useState<string[]>(user?.cameras ?? []);
  const [disabled, setDisabled] = useState(user?.disabled ?? false);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const input: AppUserInput = { username, name, admin, cameras: allCams ? [] : cams, disabled };
    if (password) input.password = password;
    setSaving(true);
    try {
      if (user) await api.updateAppUser(user.id, input);
      else await api.createAppUser(input);
      onSaved(user ? `${username} saved` : `${username} added`);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm md:items-center md:p-6" onClick={onClose}>
      <motion.div
        initial={{ y: 40, opacity: 0, scale: 0.98 }}
        animate={{ y: 0, opacity: 1, scale: 1 }}
        exit={{ y: 40, opacity: 0 }}
        transition={{ type: "spring", stiffness: 380, damping: 32 }}
        className="glass max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-ink-850/95 p-5 md:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-white"><UserRound className="size-5" /> {user ? `Edit ${user.username}` : "Add user"}</h2>
          <IconButton title="Close" onClick={onClose}><X className="size-4" /></IconButton>
        </div>
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Username">
              <input className={inputCls} value={username} autoComplete="off" onChange={(e) => setUsername(e.target.value.toLowerCase())} placeholder="e.g. ammu" />
            </Field>
            <Field label="Name (optional)">
              <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Shown in the app" />
            </Field>
          </div>
          <Field label={user ? "New password (leave empty to keep)" : "Password"} hint={user ? "Changing it signs this user out on every phone." : "At least 8 characters. Share it with them privately."}>
            <div className="flex gap-2">
              <input className={clsx(inputCls, "font-mono")} type={showPw ? "text" : "password"} value={password} autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} />
              <Button type="button" size="md" onClick={() => { setPassword(newPassword()); setShowPw(true); }} title="Make a strong password">
                <KeyRound className="size-4" />
              </Button>
            </div>
          </Field>
          <Toggle checked={admin} onChange={setAdmin} label="Admin" hint="Can also delete clips, restart cameras, see the system log and manage users in the app" />
          {!admin && (
            <div>
              <Toggle checked={allCams} onChange={setAllCams} label="All cameras" hint="Including cameras added later" />
              {!allCams && (
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {cameras.map((c) => {
                    const on = cams.includes(c.id);
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => setCams(on ? cams.filter((x) => x !== c.id) : [...cams, c.id])}
                        className={clsx("flex items-center gap-2 rounded-xl border px-3 py-2 text-left text-sm transition", on ? "border-cyan-400/40 bg-cyan-500/10 text-white" : "border-white/10 bg-white/[0.02] text-slate-400 hover:text-slate-200")}
                      >
                        <span className={clsx("flex size-4 items-center justify-center rounded border", on ? "border-cyan-400 bg-cyan-400 text-ink-900" : "border-white/20")}>{on && <Check className="size-3" />}</span>
                        <span className="truncate">{c.name}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {user && <Toggle checked={disabled} onChange={setDisabled} label="Switched off" hint="Blocks this account without removing it" />}
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={saving || !username || (!user && password.length < 8) || (!admin && !allCams && cams.length === 0)} onClick={save}>
            {saving && <Loader2 className="size-4 animate-spin" />} {user ? "Save" : "Add user"}
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );
}
