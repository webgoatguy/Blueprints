// Hex Blueprints — game rules.
// Pure functions with no DOM access. The browser (public/client.js) and the
// server (api/game.js) both import this file, so they always agree on what
// counts as a legal move.

export const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
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

/* ---------- setup ---------- */

// Starting blueprint: 7-cell flower. Centre = wall, left & right = score, other four = attack.
export function startBlueprint() {
  const o = { [key(0, 0)]: 'wall' };
  for (const [dq, dr] of DIRS) o[key(dq, dr)] = dr === 0 ? 'score' : 'attack';
  return o;
}

/* ---------- game options (chosen when a game is created) ---------- */
// mode:      'classic' -> stamps may overlap; your cells overwrite enemy non-wall cells.
//                         Score = Score cells on the board + kills x killPoints.
//            'contact' -> stamps may not overlap ANY cell; enemy non-wall cells touching
//                         the new cells are deleted. At the end of each of your turns you
//                         bank 1 point per Score cell you have on the board.
//                         Score = banked points + kills x killPoints.
// turnOrder: '122'  -> Blue 1, then Red 2, Blue 2, Red 2, ...
//            '1111' -> players simply alternate single moves
// killPoints: points earned for each enemy Score cell you destroy
export const MODES = ['classic', 'contact'];
export const TURN_ORDERS = ['122', '1111'];
export const DEFAULT_KILL_POINTS = { classic: 2, contact: 20 };
export const DEFAULT_SETTINGS = { mode: 'classic', turnOrder: '122', killPoints: 2 };
const LEGACY_SETTINGS = { mode: 'classic', turnOrder: '122', killPoints: 1 }; // games saved before options existed
export const MAX_KILL_POINTS = 100;

export function normalizeSettings(o) {
  const s = o && typeof o === 'object' ? o : {};
  const mode = MODES.includes(s.mode) ? s.mode : 'classic';
  const kp = Number(s.killPoints);
  return {
    mode,
    turnOrder: TURN_ORDERS.includes(s.turnOrder) ? s.turnOrder : DEFAULT_SETTINGS.turnOrder,
    killPoints: Number.isInteger(kp) && kp >= 0 && kp <= MAX_KILL_POINTS ? kp : DEFAULT_KILL_POINTS[mode],
  };
}
// Games saved before an option existed fall back to the rules they were created with.
export const settingsOf = s => (s && s.settings ? { mode: 'classic', ...s.settings } : LEGACY_SETTINGS);
export const modeOf = s => settingsOf(s).mode;

export function newState(settings) {
  return {
    settings: normalizeSettings(settings),
    moveNo: 0,
    board: {
      [key(-3, 0)]: { owner: 'blue', type: 'wall' },
      [key(3, 0)]: { owner: 'red', type: 'wall' },
    },
    blueprints: {
      blue: [startBlueprint(), startBlueprint(), startBlueprint()],
      red: [startBlueprint(), startBlueprint(), startBlueprint()],
    },
    destroyed: { blue: 0, red: 0 },
    banked: { blue: 0, red: 0 },   // Contact mode: points banked at the end of each turn
    lastMove: null,
  };
}

/* ---------- turn order ---------- */
// '122':  Blue 1, then Red 2, Blue 2, Red 2, ...
// '1111': Blue 1, Red 1, Blue 1, Red 1, ...

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

// Classic: Score = your Score cells on the board + killPoints x enemy Score cells destroyed.
// Contact: Score = points banked at the end of your turns + killPoints x enemy Score cells destroyed.
export function getScores(s) {
  const { killPoints: kp, mode } = settingsOf(s);
  const out = {};
  for (const p of PLAYERS) {
    const onBoard = scoreCellsOf(s, p);
    const kills = s.destroyed[p];
    const banked = (s.banked && s.banked[p]) || 0;
    const base = mode === 'contact' ? banked : onBoard;
    out[p] = { mode, onBoard, banked, perTurn: onBoard, destroyed: kills, killPoints: kp, killScore: kills * kp, total: base + kills * kp };
  }
  return out;
}

/* ---------- placement ---------- */

// Stamp blueprint `bpIdx` so that its cell `handleKey` lands on board hex (hq, hr).
// Returns each stamped cell with a status, plus (Contact mode) the enemy cells that would be deleted.
export function evalPlacement(s, player, bpIdx, handleKey, hq, hr) {
  const contact = modeOf(s) === 'contact';
  const bp = s.blueprints[player][bpIdx];
  const [aq, ar] = unkey(handleKey);
  const cells = [];
  let touches = false, reason = null, captures = 0, scoreKills = 0;
  for (const k in bp) {
    const type = bp[k];
    const [q, r] = unkey(k);
    const bq = q - aq + hq, br = r - ar + hr, bk = key(bq, br);
    const ex = s.board[bk];
    let status = 'empty';
    if (ex && contact) {
      // Contact mode: no overlapping anything.
      status = 'blocked';
      if (!reason) reason = ex.owner === player ? 'Can’t overlap your own cells in Contact mode' : 'Can’t overlap opponent cells in Contact mode';
    } else if (ex) {
      if (ex.owner === player) { status = 'own'; touches = true; }
      // Any cell type can overwrite an opponent cell, unless that cell is a wall.
      else if (ex.type !== 'wall') {
        status = 'capture'; captures++;
        if (ex.type === 'score') scoreKills++;
      } else {
        status = 'blocked';
        if (!reason) reason = 'Opponent walls can’t be overwritten';
      }
    }
    if (!touches) {
      for (const [dq, dr] of DIRS) {
        const n = s.board[key(bq + dq, br + dr)];
        if (n && n.owner === player) { touches = true; break; }
      }
    }
    cells.push({ k: bk, q: bq, r: br, type, status });
  }

  // Contact mode: every enemy non-wall cell touching a newly placed cell gets deleted.
  const deletes = [];
  if (contact) {
    const seen = new Set();
    for (const c of cells) {
      for (const [dq, dr] of DIRS) {
        const nq = c.q + dq, nr = c.r + dr, nk = key(nq, nr);
        if (seen.has(nk)) continue;
        seen.add(nk);
        const n = s.board[nk];
        if (n && n.owner !== player && n.type !== 'wall') deletes.push({ k: nk, q: nq, r: nr, type: n.type });
      }
    }
    captures = deletes.length;
    scoreKills = deletes.filter(d => d.type === 'score').length;
  }

  if (!cells.length && !reason) reason = 'That blueprint is empty';
  if (!touches && !reason) reason = contact ? 'Must touch one of your cells' : 'Must touch or overlap one of your cells';
  return { cells, deletes, ok: !reason, reason, captures, scoreKills };
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

// Contact mode: when a player's turn ends, they bank 1 point per Score cell they have on the board.
function endOfMove(n, p, info) {
  n.moveNo++;
  const st = settingsOf(n);
  if (st.mode === 'contact' && playerAt(n.moveNo, st.turnOrder) !== p) {
    if (!n.banked) n.banked = { blue: 0, red: 0 };
    const gain = scoreCellsOf(n, p);
    n.banked[p] += gain;
    info.turnEnded = true;
    info.banked = gain;
  }
}

// Returns { ok, state, info } with a NEW state, or { ok: false, error }.
export function applyMove(s, move) {
  const m = sanitizeMove(move);
  if (!m) return { ok: false, error: 'Malformed move' };
  if (m.p !== currentPlayer(s)) return { ok: false, error: 'It’s not your turn' };
  const p = m.p;
  if (m.t === 'place') {
    if (!(m.h in s.blueprints[p][m.bp])) return { ok: false, error: 'No cell there' };
    const ev = evalPlacement(s, p, m.bp, m.h, m.at[0], m.at[1]);
    if (!ev.ok) return { ok: false, error: ev.reason };
    const n = clone(s);
    for (const c of ev.cells) {
      const ex = n.board[c.k];
      if (ex && ex.owner !== p && ex.type === 'score') n.destroyed[p]++;
      n.board[c.k] = { owner: p, type: c.type };
    }
    for (const d of ev.deletes) {          // Contact mode only
      if (d.type === 'score') n.destroyed[p]++;
      delete n.board[d.k];
    }
    n.lastMove = { player: p, kind: 'place', bp: m.bp, cells: ev.cells.map(c => c.k), deleted: ev.deletes.map(d => d.k) };
    const info = { captures: ev.captures, scoreKills: ev.scoreKills };
    endOfMove(n, p, info);
    return { ok: true, state: n, info };
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
  const info = {};
  endOfMove(n, p, info);
  return { ok: true, state: n, info };
}

// Rebuild a state from scratch by replaying a move log (used for take-backs).
export function replay(log, settings) {
  let s = newState(settings);
  for (const m of log) {
    const r = applyMove(s, m);
    if (!r.ok) throw new Error('Corrupt move log: ' + r.error);
    s = r.state;
  }
  return s;
}
