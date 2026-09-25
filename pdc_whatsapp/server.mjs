// Entry point: Baileys session + HTTP endpoint. Pure request logic lives in bridge.mjs,
// the Home Assistant sidebar dashboard in ui.mjs.
import http from 'node:http';
import { rm, mkdir, readFile } from 'node:fs/promises';
import makeWASocket, { DisconnectReason, Browsers, fetchLatestBaileysVersion } from 'baileys';
import pino from 'pino';
import { DATA, loadOptions, createLedger, createHandler, createEventLog, log } from './bridge.mjs';
import { useAtomicAuthState } from './auth-state.mjs';
import { createUiHandler } from './ui.mjs';

const AUTH_DIR = `${DATA}/auth`;
const PORT = Number(process.env.PORT || 8787);
const UI_PORT = Number(process.env.UI_PORT || 8099);

// ---------------------------------------------------------------------------
// Supervisor / Home Assistant API. Needs homeassistant_api (notifications) and
// hassio_api (saving this add-on's own options from the Settings page).
// ---------------------------------------------------------------------------
async function supervisor(method, path, body) {
  if (!process.env.SUPERVISOR_TOKEN) return { status: null, body: null };
  try {
    const res = await fetch(`http://supervisor${path}`, {
      method, signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch (e) { log(`Supervisor ${method} ${path} failed:`, e?.message || e); return { status: null, body: null }; }
}

// Settings sidebar bell, so a broken link is noticed without reading the add-on log.
async function haNotify(options, message) {
  if (!process.env.SUPERVISOR_TOKEN || (message && !options.notifications)) return;
  const service = message ? 'create' : 'dismiss';
  const body = { notification_id: 'pdc_whatsapp_bridge', ...(message ? { title: 'PDC WhatsApp Bridge', message } : {}) };
  const { status } = await supervisor('POST', `/core/api/services/persistent_notification/${service}`, body);
  if (status !== 200) log('Could not update Home Assistant notification');
}

// ---------------------------------------------------------------------------
// Baileys connection with pairing-code login and automatic reconnects.
// ---------------------------------------------------------------------------
export function startWhatsApp(options, events) {
  // Baileys warns about app-state sync (chat mutes, pins) it can't decrypt on a fresh link.
  // Sending doesn't use that data, so only real errors are logged.
  const logger = pino({ level: 'error' });
  const notify = message => haNotify(options, message);
  let sock = null, auth = null, connected = false, accountOk = false, paired = false;
  let retry = 0, reconnectTimer = null, offlineSince = Date.now(), notified = false, stopping = false;
  let pairingCode = null, pairingAt = null, user = null, connectedSince = null, reconnects = 0, lastDisconnect = null;

  const schedule = delay => {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => connect().catch(e => {
      log('Connect failed:', e?.message || e);
      events.add('error', `Connect failed: ${e?.message || e}`);
      if (/Unreadable session file/.test(e?.message)) {
        notify('The saved WhatsApp session is damaged. Stop the add-on, then start it again to get a new pairing code if this keeps happening.');
      }
      schedule(30000);
    }), delay);
  };

  // Warn in Home Assistant if WhatsApp has been unreachable for a while.
  setInterval(() => {
    if (!connected && !notified && offlineSince && Date.now() - offlineSince > options.offlineMinutes * 60000) {
      notified = true;
      notify(paired
        ? `WhatsApp has been disconnected for over ${options.offlineMinutes} minutes. Pitch alerts are queued and will send once it reconnects. Check the add-on log.`
        : 'WhatsApp is not linked. Open PDC Monitor in the sidebar (or the add-on log) and enter the pairing code on the sender phone under Linked devices.');
    }
  }, 60000).unref();

  async function connect() {
    if (stopping) return;
    await mkdir(AUTH_DIR, { recursive: true });
    auth ||= await useAtomicAuthState(AUTH_DIR);
    const { state, saveCreds } = auth;
    paired = Boolean(state.creds.registered);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({}));
    const current = sock = makeWASocket({
      auth: state, logger, browser: Browsers.macOS('Chrome'), // WhatsApp rejects phone-number pairing for unknown client names
      markOnlineOnConnect: false, syncFullHistory: false, shouldSyncHistoryMessage: () => false,
      ...(version ? { version } : {}),
    });
    current.ev.on('creds.update', saveCreds);
    let pairingRequested = false;

    current.ev.on('connection.update', async ({ connection, lastDisconnect: last, qr }) => {
      if (current !== sock) return; // events from a replaced socket
      if (qr && !state.creds.registered && !pairingRequested) {
        pairingRequested = true;
        try {
          const code = await current.requestPairingCode(options.sender);
          pairingCode = `${code.slice(0, 4)}-${code.slice(4)}`; pairingAt = Date.now();
          events.add('pairing', `Pairing code ${pairingCode} issued for +${options.sender}`);
          log('==============================================================');
          log(`PAIRING CODE for +${options.sender}:  ${pairingCode}`);
          log('On that phone: WhatsApp > Settings > Linked devices > Link a device');
          log('> "Link with phone number instead", then enter the code above.');
          log('==============================================================');
        } catch (e) { log('Could not request pairing code:', e?.message || e); events.add('error', `Could not request pairing code: ${e?.message || e}`); }
      }
      if (connection === 'open') {
        connected = true; paired = true; retry = 0; offlineSince = 0; pairingCode = null; connectedSince = Date.now();
        const number = current.user?.id?.split(':')[0]?.split('@')[0];
        user = { number: number ? `+${number}` : null, name: current.user?.name || current.user?.verifiedName || null };
        accountOk = number === options.sender;
        log(accountOk ? `Connected as +${options.sender}` : `WRONG ACCOUNT linked (${current.user?.id}); sends are blocked`);
        events.add(accountOk ? 'connected' : 'wrong_account', accountOk ? `Connected as +${options.sender}` : `Linked account ${user.number} is not +${options.sender}; sends are blocked`);
        if (accountOk) { if (notified) notify(null); notified = false; }
        else notify(`The linked WhatsApp account is not +${options.sender}, so alerts are blocked. Unlink this device on that phone and pair the correct number.`);
      }
      if (connection === 'close') {
        if (connected || !offlineSince) offlineSince = Date.now();
        const wasConnected = connected;
        connected = false; connectedSince = null;
        if (stopping) return;
        const code = last?.error?.output?.statusCode;
        lastDisconnect = { at: Date.now(), code: code ?? null };
        if (wasConnected) reconnects++;
        if (code === DisconnectReason.loggedOut) {
          log('WhatsApp rejected the session (unlinked on the phone, or pairing failed). Starting over with a new pairing code.');
          events.add('logged_out', 'WhatsApp ended the session (unlinked on the phone, or pairing failed)');
          current.ev.removeAllListeners('creds.update');
          await auth.flush().catch(() => {});
          await rm(AUTH_DIR, { recursive: true, force: true });
          auth = null; paired = false; retry = 0; user = null;
          if (state.creds.registered) {
            notified = true;
            notify('This bridge was unlinked from WhatsApp, so pitch alerts are paused. Open PDC Monitor in the sidebar and enter the new pairing code on the sender phone.');
          }
        } else if (code === DisconnectReason.forbidden) {
          notified = true;
          events.add('forbidden', 'WhatsApp refused the connection (403); the sender number may be restricted');
          notify('WhatsApp refused the connection (403). The sender number may be restricted. Check WhatsApp on that phone.');
        } else if (code !== DisconnectReason.restartRequired) {
          events.add('disconnected', `Connection closed (${code ?? 'no code'})`);
        }
        const delay = code === DisconnectReason.restartRequired ? 500 : Math.min(60000, 2000 * 2 ** retry++);
        log(`Connection closed (${code ?? 'no code'}); reconnecting in ${Math.round(delay / 1000)}s`);
        schedule(delay);
      }
    });
  }

  schedule(0);
  return {
    status: () => ({
      connected, paired, accountOk, pairingCode, pairingAt, user, connectedSince, reconnects, lastDisconnect,
      offlineSince: connected ? null : offlineSince || null, sender: `+${options.sender}`,
    }),
    async send(jid, text) {
      let timer;
      try {
        const msg = await Promise.race([
          sock.sendMessage(jid, { text }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('send timeout')), 20000); }),
        ]);
        if (!msg?.key?.id) throw new Error('no message id returned');
        return msg.key.id;
      } finally { clearTimeout(timer); }
    },
    // Dashboard "Relink": unlink this device and start over with a fresh pairing code.
    async relink() {
      log('Relink requested from the dashboard');
      events.add('relink', 'Unlinked from the dashboard; a new pairing code follows');
      clearTimeout(reconnectTimer);
      const current = sock; sock = null; // ignore events from the old socket
      current?.ev.removeAllListeners('creds.update');
      try { await current?.logout(); } catch { current?.end(undefined); }
      await auth?.flush().catch(() => {});
      await rm(AUTH_DIR, { recursive: true, force: true });
      auth = null; paired = false; connected = false; accountOk = false; user = null; pairingCode = null;
      connectedSince = null; offlineSince = Date.now(); retry = 0; notified = false;
      schedule(500);
    },
    // Home Assistant stops/updates the add-on with SIGTERM: finish session writes first.
    async stop() {
      stopping = true; clearTimeout(reconnectTimer);
      await auth?.flush().catch(() => {});
      sock?.end(undefined);
    },
  };
}

process.on('unhandledRejection', e => log('Unhandled rejection:', e?.stack || e));

const options = loadOptions();
await mkdir(DATA, { recursive: true });
const version = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8')).version;
const events = createEventLog();
events.add('started', `Add-on ${version} started`);
const ledger = createLedger();
const wa = startWhatsApp(options, events);
const server = http.createServer(createHandler({ options, ledger, wa, events }));
server.requestTimeout = 60000;
server.listen(PORT, () => log(`Bridge listening on :${PORT}`));

// Sidebar dashboard (Ingress). Only the Supervisor's ingress proxy may connect.
const ui = http.createServer(createUiHandler({
  options, ledger, wa, events, version, supervisor,
  restart: () => setTimeout(() => supervisor('POST', '/addons/self/restart'), 1500),
}));
ui.listen(UI_PORT, () => log(`Dashboard listening on :${UI_PORT}`));

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, async () => {
    log(`${signal} received; saving session and shutting down`);
    server.close(); ui.close();
    events.flush();
    const force = setTimeout(() => process.exit(0), 8000);
    await wa.stop();
    clearTimeout(force);
    process.exit(0);
  });
}
