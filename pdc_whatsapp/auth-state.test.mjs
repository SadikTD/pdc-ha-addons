import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { useMultiFileAuthState } from 'baileys';
import { useAtomicAuthState } from './auth-state.mjs';
const dir = mkdtempSync(join(tmpdir(), 'auth-'));
// Session written by stock Baileys must load identically.
const stock = await useMultiFileAuthState(dir);
stock.state.creds.registered = true;
await stock.saveCreds();
await stock.state.keys.set({ 'pre-key': { '1': { public: Buffer.from([1,2,3]), private: Buffer.from([4]) } }, 'app-state-sync-key': { 'AAAAAMZ7': { keyData: Buffer.from([9]) } } });
const mine = await useAtomicAuthState(dir);
assert.equal(mine.state.creds.registered, true);
assert.deepEqual(mine.state.creds.noiseKey.public, stock.state.creds.noiseKey.public);
const k = await mine.state.keys.get('pre-key', ['1', '2']);
assert.deepEqual([...k['1'].public], [1,2,3]); assert.equal(k['2'], null);
const ask = await mine.state.keys.get('app-state-sync-key', ['AAAAAMZ7']);
assert.deepEqual([...ask.AAAAAMZ7.keyData], [9]);
// Writes round-trip, many concurrent writes stay valid, deletes work.
mine.state.creds.me = { id: '1@s.whatsapp.net' };
await Promise.all(Array.from({ length: 50 }, () => mine.saveCreds()));
await mine.state.keys.set({ 'pre-key': { '1': null } });
await mine.flush();
const again = await useAtomicAuthState(dir);
assert.equal(again.state.creds.me.id, '1@s.whatsapp.net');
assert.equal((await again.state.keys.get('pre-key', ['1']))['1'], null);
assert.ok(!readdirSync(dir).some(f => f.endsWith('.tmp')));
// Stock Baileys can still read what we wrote (rollback safety).
assert.equal((await useMultiFileAuthState(dir)).state.creds.me.id, '1@s.whatsapp.net');
// Corrupt creds must fail loudly, not silently create a new identity.
writeFileSync(join(dir, 'creds.json'), '{"noiseKey":');
await assert.rejects(useAtomicAuthState(dir), /Unreadable session file/);
console.log('auth-state OK');
