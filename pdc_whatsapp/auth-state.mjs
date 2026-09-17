// Drop-in replacement for Baileys' useMultiFileAuthState with crash-safe writes.
// Baileys writes session files in place, so a power cut mid-write can leave a
// truncated creds.json; Baileys then silently starts a brand-new session and
// the phone has to be paired again. Here every write goes to a temp file, is
// fsynced, then renamed over the original (atomic on the same filesystem).
// File names and JSON format are identical, so existing sessions keep working.
import { mkdir, readFile, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { initAuthCreds, BufferJSON, proto } from 'baileys';

const fixFileName = file => file.replace(/\//g, '__').replace(/:/g, '-');

export async function useAtomicAuthState(folder) {
  await mkdir(folder, { recursive: true });
  const queues = new Map(); // per-file promise chain so writes never interleave

  const serialized = (file, task) => {
    const next = (queues.get(file) || Promise.resolve()).then(task, task);
    queues.set(file, next.catch(() => {}));
    return next;
  };

  const writeData = (data, file) => serialized(file, async () => {
    const path = join(folder, fixFileName(file)), tmp = `${path}.tmp`;
    const handle = await open(tmp, 'w');
    try {
      await handle.writeFile(JSON.stringify(data, BufferJSON.replacer));
      await handle.sync();
    } finally { await handle.close(); }
    await rename(tmp, path);
  });

  const readData = file => serialized(file, async () => {
    try { return JSON.parse(await readFile(join(folder, fixFileName(file)), 'utf8'), BufferJSON.reviver); }
    catch (e) {
      if (e.code !== 'ENOENT') throw new Error(`Unreadable session file ${fixFileName(file)}: ${e.message}`);
      return null;
    }
  });

  const removeData = file => serialized(file, () => unlink(join(folder, fixFileName(file))).catch(() => {}));

  // A corrupt creds.json must stop startup loudly rather than create a new identity.
  const creds = (await readData('creds.json')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        async get(type, ids) {
          const data = {};
          await Promise.all(ids.map(async id => {
            let value = await readData(`${type}-${id}.json`).catch(() => null);
            if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
            data[id] = value;
          }));
          return data;
        },
        async set(data) {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id], file = `${category}-${id}.json`;
              tasks.push(value ? writeData(value, file) : removeData(file));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData(creds, 'creds.json'),
    // Resolves once every queued write has finished (used on shutdown).
    flush: () => Promise.all([...queues.values()]),
  };
}
