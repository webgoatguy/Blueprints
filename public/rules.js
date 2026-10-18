// Hex Blueprints — game rules.
// Pure functions with no DOM access. The browser (public/client.js) and the
// server (api/game.js) both import this file, so they always agree on what
// counts as a legal move.

export const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
export const PLAYERS = ['blue', 'red'];
export const TYPES = ['wall', 'score', 'fragile', 'attack'];   // 'fragile' only appears in Fragile mode
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

// Pointy-top hexes: the six neighbours, in the same order as DIRS.
const DIR_NAMES = ['E', 'NE', 'NW', 'W', 'SW', 'SE'];
const AXES = { EW: ['E', 'W'], NWSE: ['NW', 'SE'], NESW: ['NE', 'SW'] };

// Starting blueprint: 7-cell flower. Centre = wall, the two cells on `axis` = `core` (Score, or
// Fragile in Fragile mode), other four = attack. Default axis 'EW' (left & right) is the original blueprint.
export function startBlueprint(axis = 'EW', core = 'score') {
  const scoreDirs = AXES[axis];
  const o = { [key(0, 0)]: 'wall' };
  DIRS.forEach(([dq, dr], i) => { o[key(dq, dr)] = scoreDirs.includes(DIR_NAMES[i]) ? core : 'attack'; });
  return o;
}

// A wall surrounded by six cells of one type.
export function ringBlueprint(type) {
  const o = { [key(0, 0)]: 'wall' };
  for (const [dq, dr] of DIRS) o[key(dq, dr)] = type;
  return o;
}

// Build-up II start: each side's three blueprints are already on the board in a vertical column,
// bp1 on top. Each one is 2 NE + 2 NW from the one below it. Red's column is 12 cells east.
// Blueprint 2 = wall + 6 Score cells; blueprints 1 and 3 = wall + 6 plain (attack) cells.
// Starting blueprints for formation starts, bp1..bp3 (bp1 goes on top):
//   'rings'   (Build-up II): wall + 6 plain, wall + 6 `core`, wall + 6 plain - same for both players.
//   'rotated' (Fragile):     three flowers with 2 `core` cells each, 120° rotations of each other.
//                            Blue: NW-SE, E-W, NE-SW.  Red (mirror image): NE-SW, E-W, NW-SE.
const ROTATED_AXES = { blue: ['NWSE', 'EW', 'NESW'], red: ['NESW', 'EW', 'NWSE'] };
function formationBlueprints(rules, p) {
  const core = rules.core || 'score';
  if (rules.blueprints === 'rotated') return ROTATED_AXES[p].map(a => startBlueprint(a, core));
  return [ringBlueprint('attack'), ringBlueprint(core), ringBlueprint('attack')];
}
const FORMATION = {
  blue: { middle: [-6, 0] },
  red: { middle: [6, 0] },
};
const STACK_STEP = [2, -4];          // 2 x NE (1,-1) + 2 x NW (0,-1)
const FORMATION_START_PTS = 1;       // starting Score cells already hold 1 point

/* ---------- game options (chosen when a game is created) ---------- */
// mode:      'classic' -> stamps may overlap; your cells overwrite enemy non-wall cells.
//                         Score = Score cells on the board + kills x killPoints.
//            'contact' -> stamps may not overlap ANY cell; enemy non-wall cells touching
//                         the new cells are deleted. At the end of each of your turns you
//                         bank 1 point per Score cell you have on the board.
//                         Score = banked points + kills x killPoints.
//            'buildup' -> Contact placement (no overlap; enemy non-wall cells touching the new
//                         cells are deleted). After every move (by either player) each Score cell
//                         on the board charges up by 1 point for its owner. Deleting an enemy
//                         Score cell steals all of its charge, banked permanently.
//                         Score = charge in your Score cells + stolen points + kills x killPoints.
//            'buildup2' -> Build-up rules, but blueprint 2 is a wall ringed by 6 Score cells and
//                         blueprints 1 and 3 are a wall ringed by 6 plain cells; all three start
//                         already placed on the board (see FORMATION). Starting Score cells hold 1 point.
//            'surround' -> Contact placement; only Wall and normal cells; one starting ring each.
//                         Enemy cells (walls too) inside a closed loop of your cells are deleted
//                         after your placement: 1 point each. Score = points from surrounding.
//            'fragile'  -> Formation start with rotated blueprints (2 Fragile cells each, see
//                         ROTATED_AXES) and Contact placement; there are no Score cells. Destroying a Fragile cell destroys that player's whole
//                         connected blob of Fragile cells (chain reaction, same colour only).
//                         Each Fragile cell shows its blob's size n; a blob is worth n^2 points.
//                         Score = sum of n^2 over your Fragile blobs right now.
// turnOrder: '122'  -> Blue 1, then Red 2, Blue 2, Red 2, ...
//            '1111' -> players simply alternate single moves
// killPoints: points earned for each enemy Score cell you destroy
export const MODES = ['classic', 'contact', 'buildup', 'buildup2', 'fragile', 'surround'];
export const MODE_NAMES = { classic: 'Classic', contact: 'Contact', buildup: 'Build-up', buildup2: 'Build-up II', fragile: 'Fragile', surround: 'Surround' };
// Each mode = a placement rule + a scoring rule + a starting setup (kept separate so they're easy to recombine).
const MODE_RULES = {
  classic: { placement: 'overwrite', scoring: 'count', start: 'walls' },
  contact: { placement: 'contact', scoring: 'bank', start: 'walls' },
  buildup: { placement: 'contact', scoring: 'buildup', start: 'walls' },
  buildup2: { placement: 'contact', scoring: 'buildup', start: 'formation', blueprints: 'rings' },
  fragile: { placement: 'contact', scoring: 'blob', start: 'formation', blueprints: 'rotated', core: 'fragile' },
  surround: { placement: 'contact', scoring: 'surround', start: 'single', surround: true },
};
export const placementOf = s => MODE_RULES[modeOf(s)].placement;
export const scoringOf = s => MODE_RULES[modeOf(s)].scoring;
export const usesKillPoints = mode => !['blob', 'surround'].includes(MODE_RULES[mode].scoring);
export const surroundOf = s => !!MODE_RULES[modeOf(s)].surround;
export const TURN_ORDERS = ['122', '1111'];
export const DEFAULT_KILL_POINTS = { classic: 2, contact: 20, buildup: 0, buildup2: 0, fragile: 0, surround: 0 };
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
  const st = normalizeSettings(settings);
  const s = {
    settings: st,
    moveNo: 0,
    board: {},
    blueprints: {},
    destroyed: { blue: 0, red: 0 },
    banked: { blue: 0, red: 0 },   // Contact: points banked each turn; Build-up: stolen charge
    lastMove: null,
  };
  if (MODE_RULES[st.mode].start === 'formation') {
    for (const p of PLAYERS) {
      const f = FORMATION[p];
      s.blueprints[p] = formationBlueprints(MODE_RULES[st.mode], p);
      s.blueprints[p].forEach((bp, i) => {
        const lift = 1 - i;   // bp1 one step up, bp2 in the middle, bp3 one step down
        const cq = f.middle[0] + lift * STACK_STEP[0], cr = f.middle[1] + lift * STACK_STEP[1];
        for (const k in bp) {
          const [q, r] = unkey(k);
          s.board[key(cq + q, cr + r)] = bp[k] === 'score'
            ? { owner: p, type: 'score', pts: FORMATION_START_PTS }
            : { owner: p, type: bp[k] };
        }
      });
    }
  } else if (MODE_RULES[st.mode].start === 'single') {
    // Surround: three plain rings (wall + 6 normal cells); one copy of it on the board per player,
    // Blue centred at (-3,0) and Red 6 cells to the right at (3,0).
    for (const p of PLAYERS) {
      s.blueprints[p] = [ringBlueprint('attack'), ringBlueprint('attack'), ringBlueprint('attack')];
      const cq = p === 'blue' ? -3 : 3;
      const bp = s.blueprints[p][0];
      for (const k in bp) { const [q, r] = unkey(k); s.board[key(cq + q, r)] = { owner: p, type: bp[k] }; }
    }
  } else {
    s.board[key(-3, 0)] = { owner: 'blue', type: 'wall' };
    s.board[key(3, 0)] = { owner: 'red', type: 'wall' };
    s.blueprints.blue = [startBlueprint(), startBlueprint(), startBlueprint()];
    s.blueprints.red = [startBlueprint(), startBlueprint(), startBlueprint()];
  }
  return s;
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

// Build-up mode: total charge stored in a player's Score cells on the board.
export function chargeOf(s, p) {
  let n = 0;
  for (const k in s.board) { const c = s.board[k]; if (c.type === 'score' && c.owner === p) n += c.pts || 0; }
  return n;
}

// Fragile mode: sizes of a player's connected blobs of Fragile cells, largest first.
// `gone` is an optional set of keys to treat as already removed (used for previews).
export function fragileBlobs(board, p, gone) {
  const seen = new Set(), sizes = [];
  for (const k in board) {
    const c = board[k];
    if (c.type !== 'fragile' || c.owner !== p || seen.has(k) || (gone && gone.has(k))) continue;
    let n = 0;
    const stack = [k];
    seen.add(k);
    while (stack.length) {
      const [q, r] = unkey(stack.pop());
      n++;
      for (const [dq, dr] of DIRS) {
        const nk = key(q + dq, r + dr), nc = board[nk];
        if (nc && nc.type === 'fragile' && nc.owner === p && !seen.has(nk) && !(gone && gone.has(nk))) { seen.add(nk); stack.push(nk); }
      }
    }
    sizes.push(n);
  }
  return sizes.sort((a, b) => b - a);
}

// Fragile mode: size of the blob each Fragile cell belongs to, for every Fragile cell on the board.
export function fragileBlobSizeMap(board) {
  const out = {};
  for (const k in board) {
    const c = board[k];
    if (c.type !== 'fragile' || k in out) continue;
    const members = [k], stack = [k], seen = new Set([k]);
    while (stack.length) {
      const [q, r] = unkey(stack.pop());
      for (const [dq, dr] of DIRS) {
        const nk = key(q + dq, r + dr), nc = board[nk];
        if (nc && nc.type === 'fragile' && nc.owner === c.owner && !seen.has(nk)) { seen.add(nk); stack.push(nk); members.push(nk); }
      }
    }
    for (const m of members) out[m] = members.length;
  }
  return out;
}
// Fragile mode: a blob of n cells is worth n squared; a player's score is the sum over their blobs.
export const blobPoints = sizes => sizes.reduce((a, n) => a + n * n, 0);

// Classic:  Score = your Score cells on the board + killPoints x enemy Score cells destroyed.
// Contact:  Score = points banked at the end of your turns + kills x killPoints.
// Build-up: Score = charge in your Score cells + banked (stolen/kept) charge + kills x killPoints.
// Fragile:  Score = sum of n^2 over your Fragile blobs (n = cells in the blob).
export function getScores(s) {
  const { killPoints: kp, mode } = settingsOf(s);
  const scoring = scoringOf(s);
  const out = {};
  for (const p of PLAYERS) {
    const onBoard = scoreCellsOf(s, p);
    const kills = s.destroyed[p];
    const banked = (s.banked && s.banked[p]) || 0;
    if (scoring === 'surround') {
      out[p] = { mode, scoring, surrounded: banked, total: banked };
      continue;
    }
    if (scoring === 'blob') {
      const blobs = fragileBlobs(s.board, p);
      const fragile = blobs.reduce((a, b) => a + b, 0);
      out[p] = { mode, scoring, blobs, fragile, largest: blobs[0] || 0, total: blobPoints(blobs) };
      continue;
    }
    const charge = scoring === 'buildup' ? chargeOf(s, p) : 0;
    const base = scoring === 'bank' ? banked : scoring === 'buildup' ? charge + banked : onBoard;
    out[p] = { mode, scoring, onBoard, banked, charge, perTurn: onBoard, perMove: onBoard,
      destroyed: kills, killPoints: kp, killScore: kills * kp, total: base + kills * kp };
  }
  return out;
}

/* ---------- Surround mode: enclosed areas ---------- */
// Hexes (empty or holding enemy cells) that `p`'s cells completely enclose, i.e. that can't reach
// infinity without crossing one of p's cells. The board is infinite, so any enclosed hex lies inside
// p's bounding box; flood-fill "outside" from a one-hex margin around that box and return the rest.
export function enclosedHexes(board, p) {
  let minQ = Infinity, maxQ = -Infinity, minR = Infinity, maxR = -Infinity, mine = 0;
  for (const k in board) {
    if (board[k].owner !== p) continue;
    const [q, r] = unkey(k);
    mine++;
    if (q < minQ) minQ = q; if (q > maxQ) maxQ = q; if (r < minR) minR = r; if (r > maxR) maxR = r;
  }
  if (mine < 6) return [];                         // a loop needs at least 6 cells
  const Q0 = minQ - 1, Q1 = maxQ + 1, R0 = minR - 1, R1 = maxR + 1;
  const isMine = (q, r) => { const c = board[key(q, r)]; return !!c && c.owner === p; };
  const outside = new Set(), stack = [];
  for (let q = Q0; q <= Q1; q++) for (const r of [R0, R1]) { const k = key(q, r); if (!outside.has(k)) { outside.add(k); stack.push([q, r]); } }
  for (let r = R0; r <= R1; r++) for (const q of [Q0, Q1]) { const k = key(q, r); if (!outside.has(k)) { outside.add(k); stack.push([q, r]); } }
  while (stack.length) {
    const [q, r] = stack.pop();
    for (const [dq, dr] of DIRS) {
      const nq = q + dq, nr = r + dr;
      if (nq < Q0 || nq > Q1 || nr < R0 || nr > R1) continue;
      const nk = key(nq, nr);
      if (outside.has(nk) || isMine(nq, nr)) continue;
      outside.add(nk);
      stack.push([nq, nr]);
    }
  }
  const out = [];
  for (let q = minQ; q <= maxQ; q++) for (let r = minR; r <= maxR; r++) {
    const k = key(q, r);
    if (!outside.has(k) && !isMine(q, r)) out.push(k);
  }
  return out;
}

/* ---------- placement ---------- */

// Stamp blueprint `bpIdx` so that its cell `handleKey` lands on board hex (hq, hr).
// Returns each stamped cell with a status, plus (Contact mode) the enemy cells that would be deleted.
export function evalPlacement(s, player, bpIdx, handleKey, hq, hr) {
  const contact = placementOf(s) === 'contact';
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
      if (!reason) {
        const m = MODE_NAMES[modeOf(s)];
        reason = ex.owner === player ? `Can’t overlap your own cells in ${m} mode` : `Can’t overlap opponent cells in ${m} mode`;
      }
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
        if (n && n.owner !== player && n.type !== 'wall') deletes.push({ k: nk, q: nq, r: nr, type: n.type, pts: n.pts || 0 });
      }
    }
  }

  // Fragile chain reaction: every destroyed Fragile cell takes its owner's whole connected
  // Fragile blob with it (same colour only). Works for both placement rules.
  const chainSeeds = [
    ...deletes.filter(d => d.type === 'fragile').map(d => d.k),
    ...cells.filter(c => c.status === 'capture' && s.board[c.k].type === 'fragile').map(c => c.k),
  ];
  if (chainSeeds.length) {
    const stamped = new Set(cells.map(c => c.k));
    const listed = new Set([...deletes.map(d => d.k), ...chainSeeds]);
    const stack = [...chainSeeds];
    while (stack.length) {
      const k = stack.pop(), owner = s.board[k].owner;
      const [q, r] = unkey(k);
      for (const [dq, dr] of DIRS) {
        const nq = q + dq, nr = r + dr, nk = key(nq, nr), n = s.board[nk];
        if (!n || n.type !== 'fragile' || n.owner !== owner || listed.has(nk)) continue;
        listed.add(nk);
        stack.push(nk);
        if (!stamped.has(nk)) deletes.push({ k: nk, q: nq, r: nr, type: 'fragile', pts: 0, chain: true });
      }
    }
  }
  if (contact) {
    captures = deletes.length;
    scoreKills = deletes.filter(d => d.type === 'score').length;
  } else {
    captures += deletes.length;
  }
  const fragileKills = deletes.filter(d => d.type === 'fragile').length +
    cells.filter(c => c.status === 'capture' && s.board[c.k].type === 'fragile').length;
  const chained = deletes.filter(d => d.chain).length;

  // Build-up mode: charge stolen from enemy Score cells / kept from your own overwritten ones.
  let stolen = 0, kept = 0;
  if (scoringOf(s) === 'buildup') {
    for (const c of cells) {
      const ex = s.board[c.k];
      if (!ex || ex.type !== 'score' || c.status === 'blocked') continue;
      if (ex.owner === player) kept += ex.pts || 0; else stolen += ex.pts || 0;
    }
    for (const d of deletes) if (d.type === 'score') stolen += d.pts;
  }

  if (!cells.length && !reason) reason = 'That blueprint is empty';
  if (!touches && !reason) reason = contact ? 'Must touch one of your cells' : 'Must touch or overlap one of your cells';

  // Surround mode: after the placement, every enemy cell (walls included) inside a closed loop of
  // the player's cells is deleted and worth 1 point - even if it's also being deleted by contact.
  let surrounded = 0, enclosed = [];
  if (!reason && surroundOf(s)) {
    const after = { ...s.board };
    for (const c of cells) after[c.k] = { owner: player, type: c.type };
    enclosed = enclosedHexes(after, player);
    const byKey = new Map(deletes.map(d => [d.k, d]));
    for (const k of enclosed) {
      const c = s.board[k];
      if (!c || c.owner === player) continue;
      surrounded++;
      const d = byKey.get(k);
      if (d) d.surround = true;
      else { const [q, r] = unkey(k); deletes.push({ k, q, r, type: c.type, pts: c.pts || 0, surround: true }); }
    }
    captures = deletes.length;
  }
  return { cells, deletes, ok: !reason, reason, captures, scoreKills, stolen, kept, fragileKills, chained, surrounded, enclosed };
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

// After every move:
//   Contact:  when a player's turn ends, they bank 1 point per Score cell they have on the board.
//   Build-up: every Score cell on the board (both players') charges up by 1 point.
function endOfMove(n, p, info) {
  n.moveNo++;
  const st = settingsOf(n);
  const scoring = scoringOf(n);
  if (!n.banked) n.banked = { blue: 0, red: 0 };
  if (scoring === 'bank' && playerAt(n.moveNo, st.turnOrder) !== p) {
    const gain = scoreCellsOf(n, p);
    n.banked[p] += gain;
    info.turnEnded = true;
    info.banked = gain;
  }
  if (scoring === 'buildup') {
    for (const k in n.board) { const c = n.board[k]; if (c.type === 'score') c.pts = (c.pts || 0) + 1; }
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
    if (!n.banked) n.banked = { blue: 0, red: 0 };
    for (const c of ev.cells) {
      const ex = n.board[c.k];
      if (ex && ex.owner !== p && ex.type === 'score') n.destroyed[p]++;
      n.board[c.k] = c.type === 'score' && scoringOf(s) === 'buildup'
        ? { owner: p, type: 'score', pts: 0 }
        : { owner: p, type: c.type };
    }
    for (const d of ev.deletes) {          // Contact placement only
      if (d.type === 'score') n.destroyed[p]++;
      delete n.board[d.k];
    }
    n.banked[p] += ev.stolen + ev.kept;   // Build-up: the charge moves to whoever broke the cell
    n.banked[p] += ev.surrounded;          // Surround: 1 point per surrounded enemy cell
    n.lastMove = { player: p, kind: 'place', bp: m.bp, cells: ev.cells.map(c => c.k), deleted: ev.deletes.map(d => d.k) };
    const info = { captures: ev.captures, scoreKills: ev.scoreKills, stolen: ev.stolen, kept: ev.kept,
      fragileKills: ev.fragileKills, chained: ev.chained, surrounded: ev.surrounded };
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
