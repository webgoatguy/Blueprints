// Single Vercel serverless function that runs every online game.
//
//   GET  /api/game?id=ABC123&v=7         -> latest game (or {unchanged:true} if still at v7)
//   POST /api/game  {action:'create', seat:'blue'|'red'|'random', name}
//   POST /api/game  {action:'join',   id, name}
//   POST /api/game  {action:'move',   id, token, v, move}
//   POST /api/game  {action:'undo',   id, token, v}       (take back your own last move)
//
// The server is authoritative: every move is checked with the same rules the
// browser uses (public/rules.js) before it is saved.

import crypto from 'node:crypto';
import { getStore } from '../lib/store.js';
import { applyMove, sanitizeMove, replay, newState, PLAYERS, MAX_LOG } from '../public/rules.js';

const TTL = 60 * 60 * 24 * 60;              // games expire after 60 days without activity
const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ID_RE = /^[A-Z2-9]{6}$/;
const gameKey = id => `hexbp:game:${id}`;

const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const newToken = () => crypto.randomBytes(18).toString('base64url');
const newId = () => Array.from({ length: 6 }, () => ID_ALPHABET[crypto.randomInt(ID_ALPHABET.length)]).join('');

function cleanName(n, fallback) {
  const s = String(n ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
  return s || fallback;
}

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

// What players are allowed to see (never the seat token hashes).
function publicView(g) {
  const last = g.log[g.log.length - 1];
  return {
    id: g.id,
    v: g.v,
    seats: Object.fromEntries(PLAYERS.map(p => [p, g.seats[p] ? { name: g.seats[p].name } : null])),
    moves: g.log.length,
    lastBy: last ? last.p : null,
    state: g.state,
  };
}

function seatFor(g, token) {
  if (!token) return null;
  const h = sha(token);
  return PLAYERS.find(p => g.seats[p] && g.seats[p].h === h) || null;
}

async function load(store, id) {
  if (!ID_RE.test(String(id || ''))) throw new HttpError(400, 'Invalid game code');
  const raw = await store.get(gameKey(id));
  if (!raw) throw new HttpError(404, 'Game not found. It may have expired, or the code is wrong.');
  return { raw, game: JSON.parse(raw) };
}

// Read-modify-write with an atomic compare-and-set. `mutate` returns the
// response payload; returning without changing `game.v` means "nothing to save".
async function update(store, id, mutate) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { raw, game } = await load(store, id);
    const before = game.v;
    const result = await mutate(game);
    if (game.v === before) return result;
    game.updated = Date.now();
    if (await store.cas(gameKey(id), raw, JSON.stringify(game), TTL)) return result;
    // Someone else wrote first; loop re-reads and re-validates.
  }
  throw new HttpError(409, 'The game is busy, please try again');
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  let data = '';
  for await (const chunk of req) { data += chunk; if (data.length > 20000) break; }
  try { return JSON.parse(data || '{}'); } catch { return {}; }
}

/* ---------- actions ---------- */

async function create(store, body) {
  let seat = body.seat;
  if (seat === 'random' || !PLAYERS.includes(seat)) seat = crypto.randomInt(2) ? 'red' : 'blue';
  const token = newToken();
  const now = Date.now();
  for (let i = 0; i < 6; i++) {
    const id = newId();
    const game = {
      id, v: 1, created: now, updated: now,
      seats: { blue: null, red: null },
      log: [],
      state: newState(),
    };
    game.seats[seat] = { h: sha(token), name: cleanName(body.name, seat === 'blue' ? 'Blue' : 'Red') };
    if (await store.setNX(gameKey(id), JSON.stringify(game), TTL)) {
      return { ok: true, id, seat, token, game: publicView(game) };
    }
  }
  throw new HttpError(500, 'Could not create a game, please try again');
}

async function join(store, body) {
  const token = newToken();
  return update(store, body.id, g => {
    const seat = PLAYERS.find(p => !g.seats[p]);
    if (!seat) throw new HttpError(409, 'Both seats are already taken — you can still watch.', { game: publicView(g) });
    g.seats[seat] = { h: sha(token), name: cleanName(body.name, seat === 'blue' ? 'Blue' : 'Red') };
    g.v++;
    return { ok: true, seat, token, game: publicView(g) };
  });
}

function requireSeat(g, body) {
  const seat = seatFor(g, body.token);
  if (!seat) throw new HttpError(403, 'You are not a player in this game');
  if (body.v !== g.v) throw new HttpError(409, 'The board changed — it has been refreshed.', { game: publicView(g) });
  return seat;
}

async function move(store, body) {
  return update(store, body.id, g => {
    const seat = requireSeat(g, body);
    if (!g.seats.blue || !g.seats.red) throw new HttpError(409, 'Wait for your opponent to join first');
    if (g.log.length >= MAX_LOG) throw new HttpError(409, 'This game has reached the move limit');
    // The seat comes from the token, never from the client.
    const m = sanitizeMove({ ...(body.move || {}), p: seat });
    if (!m) throw new HttpError(400, 'Malformed move');
    const r = applyMove(g.state, m);
    if (!r.ok) throw new HttpError(400, r.error, { game: publicView(g) });
    g.log.push(m);
    g.state = r.state;
    g.v++;
    return { ok: true, info: r.info, game: publicView(g) };
  });
}

async function undo(store, body) {
  return update(store, body.id, g => {
    const seat = requireSeat(g, body);
    const last = g.log[g.log.length - 1];
    if (!last || last.p !== seat) throw new HttpError(409, 'You can only take back your own last move, before your opponent moves', { game: publicView(g) });
    g.log.pop();
    g.state = replay(g.log);
    g.v++;
    return { ok: true, game: publicView(g) };
  });
}

/* ---------- handler ---------- */

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const store = await getStore();
    if (req.method === 'GET') {
      const q = req.query || Object.fromEntries(new URL(req.url, 'http://x').searchParams);
      const { game } = await load(store, q.id);
      const v = Number(q.v);
      if (v && v === game.v) return res.status(200).json({ ok: true, unchanged: true, v });
      return res.status(200).json({ ok: true, game: publicView(game) });
    }
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

    const body = await readBody(req);
    const actions = { create, join, move, undo };
    const fn = actions[body.action];
    if (!fn) return res.status(400).json({ ok: false, error: 'Unknown action' });
    return res.status(200).json(await fn(store, body));
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    return res.status(status).json({ ok: false, error: err.message || 'Server error', ...(err.extra || {}) });
  }
}
