// Hex Blueprints — game rules ("Bounty II").
// Pure functions with no DOM access. The browser (public/client.js) and the
// server (api/game.js) both import this file, so they always agree on what
// counts as a legal move.
//
// Summary of the rules:
//   * Each player has three blueprints. A move is either PLACE (stamp a blueprint onto the board)
//     or EDIT (move one blueprint cell, keeping every blueprint connected).
//   * Placement: may not overlap any existing cell, and must touch one of your own cells.
//     Every enemy cell touching your newly placed cells is deleted, unless it is a Wall.
//   * Score: only from kills. Each enemy Score cell you delete pays out the number of Score cells
//     you had on the board BEFORE that placement (one payout per Score cell deleted).

export const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];   // E, NE, NW, W, SW, SE
export const PLAYERS = ['blue', 'red'];
export const TYPES = ['wall', 'score', 'attack'];
export const MAX_LOG = 1500; // hard cap on moves per game
const COORD_LIMIT = 5000;   // keeps coordinates sane

export const key = (q, r) => q + ',' + r;
export function unkey(k) { const i = k.indexOf(','); return [+k.slice(0, i), +k.slice(i + 1)]; }
const KEY_RE = /^-?\d{1,5},-?\d{1,5}$/;
export function isKey(k) {
  if (typeof k !== 'string' || !KEY_RE.test(k)) return false;
  const [q, r] = unkey(k);
  return Math.abs(q) <= COORD_LIMIT && Math.abs(r) <= COORD_LIMIT;
}

const clone = o => JSON.parse(JSON.stringify(o));
export const other = p => (p === 'blue' ? 'red' : 'blue');

/* ---------- game options ---------- */
// The game has a single mode. `mode` is stored with each game so that games saved under modes
// that have since been removed can be recognised (see isSupported).
export const MODE = 'bounty2';
export const TURN_ORDERS = ['122', '1111'];   // '122': Blue 1, then 2 each.  '1111': alternate single moves.

export function normalizeSettings(o) {
  const s = o && typeof o === 'object' ? o : {};
  return { mode: MODE, turnOrder: TURN_ORDERS.includes(s.turnOrder) ? s.turnOrder : '122' };
}
export const settingsOf = s => (s && s.settings) || { mode: null, turnOrder: '122' };
// False for games created under a mode that no longer exists.
export const isSupported = s => settingsOf(s).mode === MODE;

/* ---------- setup ---------- */
const DIR_NAMES = ['E', 'NE', 'NW', 'W', 'SW', 'SE'];   // same order as DIRS (pointy-top hexes)

// Normal type (blueprints 1 and 3): a Score cell surrounded by 6 normal cells.
function normalBlueprint() {
  const o = { [key(0, 0)]: 'score' };
  for (const [dq, dr] of DIRS) o[key(dq, dr)] = 'attack';
  return o;
}
// Score type (blueprint 2): a Score centre ringed by alternating Walls and Score cells (3 of each).
// Red's Walls are its W, NE and SE neighbours; Blue's are the mirror image (E, NW, SW).
const SCORE_TYPE_WALLS = { red: ['W', 'NE', 'SE'], blue: ['E', 'NW', 'SW'] };
function scoreBlueprint(p) {
  const o = { [key(0, 0)]: 'score' };
  DIRS.forEach(([dq, dr], i) => { o[key(dq, dr)] = SCORE_TYPE_WALLS[p].includes(DIR_NAMES[i]) ? 'wall' : 'score'; });
  return o;
}
export const startBlueprints = p => [normalBlueprint(), scoreBlueprint(p), normalBlueprint()];

// Starting board: every blueprint pre-placed on row r = 0, centres 4 apart (one empty tile between
// neighbours). [player, centre q, blueprint index] — the Score types sit at the two outer ends.
const LINE_START = [
  ['blue', -10, 1], ['blue', -6, 0], ['blue', -2, 2],
  ['red', 2, 0], ['red', 6, 2], ['red', 10, 1],
];

export function newState(settings) {
  const s = {
    settings: normalizeSettings(settings),
    moveNo: 0,
    board: {},
    blueprints: { blue: startBlueprints('blue'), red: startBlueprints('red') },
    destroyed: { blue: 0, red: 0 },   // enemy Score cells each player has deleted
    banked: { blue: 0, red: 0 },      // points scored from kills
    lastMove: null,
  };
  for (const [p, cq, idx] of LINE_START) {
    const bp = s.blueprints[p][idx];
    for (const k in bp) { const [q, r] = unkey(k); s.board[key(cq + q, r)] = { owner: p, type: bp[k] }; }
  }
  return s;
}

/* ---------- turn order ---------- */
export function playerAt(n, order = '122') {
  if (order === '1111') return n % 2 === 0 ? 'blue' : 'red';
  return n === 0 ? 'blue' : (Math.floor((n - 1) / 2) % 2 === 0 ? 'red' : 'blue');
}
// [which move of this turn, moves in this turn]
export function movePos(n, order = '122') {
  if (order === '1111') return [1, 1];
  return n === 0 ? [1, 1] : [((n - 1) % 2) + 1, 2];
}
export function turnNo(n, order = '122') {
  if (order === '1111') return n + 1;
  return n === 0 ? 1 : Math.floor((n - 1) / 2) + 2;
}
export const currentPlayer = s => playerAt(s.moveNo, settingsOf(s).turnOrder);

/* ---------- helpers ---------- */
export function isConnected(cells) {
  const keys = Object.keys(cells);
  if (keys.length <= 1) return true;
  const seen = new Set([keys[0]]), stack = [keys[0]];
  while (stack.length) {
    const [q, r] = unkey(stack.pop());
    for (const [dq, dr] of DIRS) {
      const k = key(q + dq, r + dr);
      if (k in cells && !seen.has(k)) { seen.add(k); stack.push(k); }
    }
  }
  return seen.size === keys.length;
}

export function scoreCellsOf(s, p) {
  let n = 0;
  for (const k in s.board) { const c = s.board[k]; if (c.type === 'score' && c.owner === p) n++; }
  return n;
}

// Score = points from kills. perKill = what the next kill would pay (Score cells on the board now).
export function getScores(s) {
  const out = {};
  for (const p of PLAYERS) {
    const onBoard = scoreCellsOf(s, p);
    out[p] = { onBoard, perKill: onBoard, destroyed: s.destroyed[p], total: s.banked[p] };
  }
  return out;
}

/* ---------- placement ---------- */
// Stamp blueprint `bpIdx` so that its cell `handleKey` lands on board hex (hq, hr).
export function evalPlacement(s, player, bpIdx, handleKey, hq, hr) {
  const bp = s.blueprints[player][bpIdx];
  const [aq, ar] = unkey(handleKey);
  const cells = [];
  let touches = false, reason = null;
  for (const k in bp) {
    const [q, r] = unkey(k);
    const bq = q - aq + hq, br = r - ar + hr, bk = key(bq, br);
    const ex = s.board[bk];
    let status = 'empty';
    if (ex) {
      status = 'blocked';
      if (!reason) reason = ex.owner === player ? 'Can’t overlap your own cells' : 'Can’t overlap opponent cells';
    }
    if (!touches) {
      for (const [dq, dr] of DIRS) {
        const n = s.board[key(bq + dq, br + dr)];
        if (n && n.owner === player) { touches = true; break; }
      }
    }
    cells.push({ k: bk, q: bq, r: br, type: bp[k], status });
  }

  // Every enemy non-Wall cell touching a newly placed cell is deleted.
  const deletes = [], seen = new Set();
  for (const c of cells) {
    for (const [dq, dr] of DIRS) {
      const nq = c.q + dq, nr = c.r + dr, nk = key(nq, nr);
      if (seen.has(nk)) continue;
      seen.add(nk);
      const n = s.board[nk];
      if (n && n.owner !== player && n.type !== 'wall') deletes.push({ k: nk, q: nq, r: nr, type: n.type });
    }
  }
  const scoreKills = deletes.filter(d => d.type === 'score').length;
  // Each Score kill pays the number of Score cells the player had BEFORE this placement.
  const perKill = scoreCellsOf(s, player);

  if (!cells.length && !reason) reason = 'That blueprint is empty';
  if (!touches && !reason) reason = 'Must touch one of your cells';
  return { cells, deletes, ok: !reason, reason, captures: deletes.length, scoreKills, perKill, bounty: scoreKills * perKill };
}

/* ---------- blueprint edits ---------- */
export function checkEdit(s, player, fromBp, fromKey, toBp, toKey) {
  const bps = s.blueprints[player], src = bps[fromBp], dst = bps[toBp];
  if (!(fromKey in src)) return { ok: false, reason: 'No cell there' };
  if (fromBp === toBp && fromKey === toKey) return { ok: false, noop: true, reason: 'That cell didn’t move' };
  if (toKey in dst) return { ok: false, reason: 'That spot is already taken' };
  const type = src[fromKey];
  if (fromBp === toBp) {
    const c = { ...src }; delete c[fromKey]; c[toKey] = type;
    return isConnected(c) ? { ok: true } : { ok: false, reason: 'Blueprint cells must stay connected' };
  }
  const s2 = { ...src }; delete s2[fromKey];
  if (!isConnected(s2)) return { ok: false, reason: 'Removing that cell would split the blueprint' };
  const d2 = { ...dst }; d2[toKey] = type;
  if (!isConnected(d2)) return { ok: false, reason: 'The cell must attach to the blueprint' };
  return { ok: true };
}

/* ---------- moves ---------- */
// A move is one of:
//   { t: 'place', p, bp, h: 'q,r', at: [q, r] }
//   { t: 'edit',  p, from: [bp, 'q,r'], to: [bp, 'q,r'] }

const isBp = b => Number.isInteger(b) && b >= 0 && b <= 2;
const isInt = n => Number.isInteger(n) && Math.abs(n) <= COORD_LIMIT;

// Strips unknown fields and rejects anything malformed (server-side safety).
export function sanitizeMove(m) {
  if (!m || typeof m !== 'object' || !PLAYERS.includes(m.p)) return null;
  if (m.t === 'place') {
    if (!isBp(m.bp) || !isKey(m.h) || !Array.isArray(m.at) || m.at.length !== 2 || !isInt(m.at[0]) || !isInt(m.at[1])) return null;
    return { t: 'place', p: m.p, bp: m.bp, h: m.h, at: [m.at[0], m.at[1]] };
  }
  if (m.t === 'edit') {
    const ok = x => Array.isArray(x) && x.length === 2 && isBp(x[0]) && isKey(x[1]);
    if (!ok(m.from) || !ok(m.to)) return null;
    return { t: 'edit', p: m.p, from: [m.from[0], m.from[1]], to: [m.to[0], m.to[1]] };
  }
  return null;
}

// Returns { ok, state, info } with a NEW state, or { ok: false, error }.
export function applyMove(s, move) {
  if (!isSupported(s)) return { ok: false, error: 'This game used a mode that has been removed' };
  const m = sanitizeMove(move);
  if (!m) return { ok: false, error: 'Malformed move' };
  if (m.p !== currentPlayer(s)) return { ok: false, error: 'It’s not your turn' };
  const p = m.p;
  if (m.t === 'place') {
    if (!(m.h in s.blueprints[p][m.bp])) return { ok: false, error: 'No cell there' };
    const ev = evalPlacement(s, p, m.bp, m.h, m.at[0], m.at[1]);
    if (!ev.ok) return { ok: false, error: ev.reason };
    const n = clone(s);
    for (const c of ev.cells) n.board[c.k] = { owner: p, type: c.type };
    for (const d of ev.deletes) delete n.board[d.k];
    n.destroyed[p] += ev.scoreKills;
    n.banked[p] += ev.bounty;
    n.lastMove = { player: p, kind: 'place', bp: m.bp, cells: ev.cells.map(c => c.k), deleted: ev.deletes.map(d => d.k) };
    n.moveNo++;
    return { ok: true, state: n, info: { captures: ev.captures, scoreKills: ev.scoreKills, bounty: ev.bounty, perKill: ev.perKill } };
  }
  const [fb, fk] = m.from, [tb, tk] = m.to;
  const res = checkEdit(s, p, fb, fk, tb, tk);
  if (!res.ok) return { ok: false, error: res.reason };
  const n = clone(s);
  const bps = n.blueprints[p];
  const type = bps[fb][fk];
  delete bps[fb][fk];
  bps[tb][tk] = type;
  n.lastMove = { player: p, kind: 'edit', fromBp: fb, toBp: tb, toKey: tk };
  n.moveNo++;
  return { ok: true, state: n, info: {} };
}

// Rebuild a state by replaying a move log from a starting state (used for take-backs).
// Pass the game's own saved starting state, so a later change to the starting position
// can't alter games that were already in progress.
export function replayFrom(start, log) {
  let s = clone(start);
  for (const m of log) {
    const r = applyMove(s, m);
    if (!r.ok) throw new Error('Corrupt move log: ' + r.error);
    s = r.state;
  }
  return s;
}
// Same, starting from today's starting position.
export const replay = (log, settings) => replayFrom(newState(settings), log);

// True if two states have the same board, blueprints, scores and move number.
export function sameState(a, b) {
  const canon = s => JSON.stringify([
    s.moveNo, s.banked, s.destroyed,
    Object.keys(s.board).sort().map(k => [k, s.board[k].owner, s.board[k].type]),
    PLAYERS.map(p => s.blueprints[p].map(bp => Object.keys(bp).sort().map(k => k + bp[k]))),
  ]);
  return canon(a) === canon(b);
}
