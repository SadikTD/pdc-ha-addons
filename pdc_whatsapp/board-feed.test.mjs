import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBoardPitches, withBoard, withBoardHistory, BOARD_PITCHED } from './board-feed.mjs';
import { TRELLO_SITE } from './monitor/trello-monitor.mjs';
import { OS_SITE } from './monitor/pitch-sources.mjs';

const options = { boardUrl: 'https://board.example', boardToken: 'f'.repeat(48), boardOnly: [] };
const pitch = (id, col, extra = {}) => ({ id: String(id), title: `Pitch ${id}`, col, colLabel: col === 'pitched' ? 'Pitched' : 'Writing', created: '2026-10-20T10:00:00.000Z',
  writer: 'Nadia', sources: ['https://x.com/a/status/1'], url: `https://board.example/b/wgtc/c/${id}`, ...extra });
function feed(pitches, status = 200) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), auth: init.headers.Authorization, method: init.method });
    return new Response(JSON.stringify({ pitches }), { status });
  };
  return { fetcher, calls };
}

test('board pitches become monitor cards; only Pitched ones are new pitches', async () => {
  const { fetcher, calls } = feed([pitch(1, 'pitched'), pitch(2, 'writing', { url: 'javascript:alert(1)' })]);
  const cards = await loadBoardPitches(options, OS_SITE, 8, fetcher);
  assert.deepEqual(calls, [{ url: 'https://board.example/api/feed/pitches?site=os-curveball&days=8', auth: `Bearer ${options.boardToken}`, method: 'GET' }]);
  assert.deepEqual(cards[0], { id: 'kb1', name: 'Pitch 1', desc: 'https://x.com/a/status/1', idList: BOARD_PITCHED, closed: false,
    shortUrl: 'https://board.example/b/wgtc/c/1', _listName: 'Board · Pitched', _writer: 'Nadia', _site: 'OS', _created: '2026-10-20T10:00:00.000Z' });
  assert.equal(cards[1].idList, 'board');
  assert.equal(cards[1].shortUrl, '');
});

test('a refused or broken feed fails the scan instead of checking a partial list', async () => {
  await assert.rejects(loadBoardPitches(options, OS_SITE, 8, feed([], 401).fetcher), /rejected the feed token/);
  await assert.rejects(loadBoardPitches(options, OS_SITE, 8, feed([], 503).fetcher), /read failed \(503\)/);
  const bad = async () => new Response('<html>', { status: 200 });
  await assert.rejects(loadBoardPitches(options, OS_SITE, 8, bad), /invalid response/);
});

test('each site reads its old platform plus the board; board-only sites skip the old platform', async () => {
  const env = { _storedSettings: [] };
  const own = { cards: [{ id: 'trello1', name: 'Old', idList: 'L1' }], watched: ['L1'] };
  const { fetcher, calls } = feed([pitch(5, 'pitched')]);
  const merged = await withBoard(async () => own, TRELLO_SITE, options, fetcher)(env);
  assert.deepEqual(merged.cards.map(c => c.id), ['trello1', 'kb5']);
  assert.deepEqual(merged.watched, ['L1', BOARD_PITCHED]);
  assert.match(calls[0].url, /site=wgtc&days=8$/); // the reference window (7 days) plus one
  const only = await withBoard(async () => { throw new Error('old platform read'); }, TRELLO_SITE, { ...options, boardOnly: ['wgtc'] }, fetcher)(env);
  assert.deepEqual(only.cards.map(c => c.id), ['kb5']);
  const load = async () => own;
  assert.equal(withBoard(load, TRELLO_SITE, { ...options, boardUrl: '' }, fetcher), load); // not set up: unchanged
});

test('older pitches include 90 days of the board, re-read every 15 minutes, last copy kept on failure', async () => {
  let now = 0, fail = false;
  const calls = [], logs = [];
  const fetcher = async url => { calls.push(String(url)); return fail ? new Response('', { status: 502 }) : new Response(JSON.stringify({ pitches: [pitch(9, 'archive')] })); };
  const base = async () => [{ id: 'h1' }];
  base.status = () => 'status';
  const history = withBoardHistory(base, options, { fetcher, clock: () => now, log: m => logs.push(m) });
  assert.deepEqual((await history(TRELLO_SITE)).map(c => [c.id, c.idList]), [['h1', undefined], ['kb9', 'history']]);
  assert.match(calls[0], /days=90$/);
  now = 60000; await history(TRELLO_SITE);
  assert.equal(calls.length, 1); // cached
  now = 16 * 60000; fail = true;
  assert.deepEqual((await history(TRELLO_SITE)).map(c => c.id), ['h1', 'kb9']);
  assert.equal(logs.length, 1);
  assert.equal(history.status(), 'status');
});

test('switched off in Settings, the board is not read at all', async () => {
  const load = async () => ({ cards: [], watched: [] });
  const off = { ...options, boardEnabled: false };
  assert.equal(withBoard(load, TRELLO_SITE, off, async () => { throw new Error('board read'); }), load);
  const base = async () => [];
  assert.equal(withBoardHistory(base, off), base);
});
