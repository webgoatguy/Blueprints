// Hex Blueprints — browser client.
// Two modes:
//   'local'  — pass and play on one device (moves applied locally, full undo).
//   'online' — moves are sent to /api/game, which validates and stores them in Redis;
//              this page polls for the opponent's moves.

import * as R from './rules.js';

const { DIRS, PLAYERS, TYPES, key, unkey } = R;

/* ---------- constants ---------- */
const SQRT3 = Math.sqrt(3);
const NAME = { blue: 'Blue', red: 'Red' };
const TYPE_NAME = { score: 'Score', fragile: 'Fragile', attack: 'Attack', wall: 'Wall' };
const TYPE_DESC = {
  score: 'worth points (how depends on the mode)',
  fragile: 'Fragile mode only: destroying one destroys its whole connected same-colour blob; a blob of n cells is worth n² points',
  attack: 'plain cell with no special ability',
  wall: 'cannot be overwritten or deleted by the opponent'
};
const COL = {
  blue: { main: '#3b82f6', score: '#3b82f6', fragile: '#7fb2ff', attack: '#2056d6', wall: '#172f6e' },
  red:  { main: '#ef4444', score: '#ef4444', fragile: '#ff8f8f', attack: '#c42020', wall: '#6a1616' },
};
// Cell types shown in the legend for a given game
const typesFor = st => {
  const sc = R.scoringOf(st);
  return sc === 'blob' ? ['wall', 'fragile', 'attack'] : sc === 'surround' ? ['wall', 'attack'] : ['wall', 'score', 'attack'];
};
// Surround mode calls the plain cells "Normal" (it has no other cell types)
const typeLabel = (t, st) => (t === 'attack' && R.scoringOf(st) === 'surround' ? 'Normal' : TYPE_NAME[t]);
// Fragile icon: a crack (unit coordinates, scaled per cell)
const CRACK = [[-0.10, -0.85], [0.14, -0.33], [-0.2, 0.05], [0.16, 0.43], [-0.04, 0.86]];
const CRACK_BRANCHES = [[[0.14, -0.33], [0.5, -0.18]], [[-0.2, 0.05], [-0.52, 0.2]]];
const GRID = '#3c3c3c', BOARD_BG = '#2a2a2a';
const GOOD = '#34d399', BAD = '#fb7185', AMBER = '#fbbf24';
const MIN_SIZE = 10, MAX_SIZE = 80;
const API = '/api/game';

/* ---------- hex math (pointy-top, axial coords) ---------- */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const hx = (q, r) => SQRT3 * (q + r / 2);
const hy = (q, r) => 1.5 * r;
function hexRound(q, r) {
  const s = -q - r;
  let rq = Math.round(q), rr = Math.round(r);
  const rs = Math.round(s);
  const dq = Math.abs(rq - q), dr = Math.abs(rr - r), ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  return [rq + 0, rr + 0];
}
function unitToHex(px, py) { return hexRound(SQRT3 / 3 * px - py / 3, 2 / 3 * py); }

const HC = [], HS = [];
for (let i = 0; i < 6; i++) { const a = Math.PI / 180 * (60 * i + 30); HC.push(Math.cos(a)); HS.push(Math.sin(a)); }
function hexPath(ctx, cx, cy, r, append) {
  if (!append) ctx.beginPath();
  ctx.moveTo(cx + r * HC[0], cy + r * HS[0]);
  for (let i = 1; i < 6; i++) ctx.lineTo(cx + r * HC[i], cy + r * HS[i]);
  ctx.closePath();
}

/* ---------- drawing ---------- */
function drawIcon(ctx, cx, cy, s, type) {
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  if (type === 'score') {
    const R0 = s * 0.46, r = R0 * 0.44;
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r : R0;
      const x = cx + rr * Math.cos(a), y = cy + rr * Math.sin(a);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.closePath(); ctx.fill();
  } else if (type === 'wall') {
    const w = s * 0.92, h = s * 0.66, x0 = cx - w / 2, y0 = cy - h / 2, rh = h / 3, g = Math.max(1, s * 0.07);
    ctx.save();
    ctx.beginPath(); ctx.rect(x0, y0, w, h); ctx.clip();
    for (let row = 0; row < 3; row++) {
      const y = y0 + row * rh, off = row % 2 ? -w / 4 : 0;
      for (let bx = x0 + off; bx < x0 + w; bx += w / 2) ctx.fillRect(bx + g / 2, y + g / 2, w / 2 - g, rh - g);
    }
    ctx.restore();
  } else if (type === 'fragile') {
    const k = s * 0.62;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = Math.max(1.2, s * 0.11);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath();
    CRACK.forEach(([x, y], i) => i ? ctx.lineTo(cx + x * k, cy + y * k) : ctx.moveTo(cx + x * k, cy + y * k));
    for (const [[x1, y1], [x2, y2]] of CRACK_BRANCHES) { ctx.moveTo(cx + x1 * k, cy + y1 * k); ctx.lineTo(cx + x2 * k, cy + y2 * k); }
    ctx.stroke();
    ctx.restore();
  }
  // attack cells are intentionally drawn blank (no icon)
}

function drawCell(ctx, cx, cy, s, owner, type, alpha, label) {
  const a = alpha == null ? 1 : alpha;
  if (a !== 1) { ctx.save(); ctx.globalAlpha = a; }
  if (label != null && s >= 9) {
    // Build-up: Score cell showing its stored charge. Fragile: Fragile cell showing its blob's size.
    // The number replaces the icon, for readability.
    hexPath(ctx, cx, cy, s);
    ctx.fillStyle = COL[owner][type];
    ctx.fill();
    ctx.lineWidth = Math.max(1, s * 0.1);
    ctx.strokeStyle = GRID;
    ctx.stroke();
    const txt = String(label);
    const fs = s * (txt.length <= 2 ? 0.84 : txt.length === 3 ? 0.66 : 0.52);
    ctx.font = `800 ${fs}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(txt, cx, cy + fs * 0.05);
    if (a !== 1) ctx.restore();
    return;
  }
  hexPath(ctx, cx, cy, s);
  ctx.fillStyle = COL[owner][type];
  ctx.fill();
  if (type === 'wall') {
    hexPath(ctx, cx, cy, s * 0.8);
    ctx.lineWidth = Math.max(1, s * 0.09);
    ctx.strokeStyle = COL[owner].main;
    ctx.stroke();
  }
  hexPath(ctx, cx, cy, s);
  ctx.lineWidth = Math.max(1, s * 0.1);
  ctx.strokeStyle = GRID;
  ctx.stroke();
  if (s >= 7) drawIcon(ctx, cx, cy, s, type);
  if (a !== 1) ctx.restore();
}

function svgIcon(t) {
  let inner = '';
  if (t === 'score') {
    const pts = [];
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? 0.42 : 0.96;
      pts.push((rr * Math.cos(a)).toFixed(3) + ',' + (rr * Math.sin(a)).toFixed(3));
    }
    inner = `<polygon points="${pts.join(' ')}" fill="currentColor"/>`;
  } else if (t === 'wall') {
    const Rr = [[-0.95,-0.66,0.9],[0.05,-0.66,0.9],[-0.95,-0.2,0.42],[-0.45,-0.2,0.9],[0.53,-0.2,0.42],[-0.95,0.26,0.9],[0.05,0.26,0.9]];
    inner = Rr.map(([x, y, w]) => `<rect x="${x}" y="${y}" width="${w}" height="0.38" rx="0.05" fill="currentColor"/>`).join('');
  } else if (t === 'fragile') {
    const pts = CRACK.map(([x, y]) => `${x},${y}`).join(' ');
    const br = CRACK_BRANCHES.map(([[x1, y1], [x2, y2]]) => `M${x1},${y1}L${x2},${y2}`).join('');
    inner = `<polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="0.2" stroke-linejoin="round" stroke-linecap="round"/>` +
      `<path d="${br}" stroke="currentColor" stroke-width="0.2" stroke-linecap="round"/>`;
  } else {
    const pts = HC.map((c, i) => (c * 0.86).toFixed(3) + ',' + (HS[i] * 0.86).toFixed(3)).join(' ');
    inner = `<polygon points="${pts}" fill="none" stroke="currentColor" stroke-width="0.2"/>`;
  }
  return `<svg viewBox="-1 -1 2 2" aria-hidden="true">${inner}</svg>`;
}

function sizeCanvas(cv) {
  const w = cv.clientWidth, h = cv.clientHeight, dpr = window.devicePixelRatio || 1;
  const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  return { w, h, dpr };
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- browser storage (optional: everything still works without it) ---------- */
const LS = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const memCreds = {};
const credKey = id => 'hexbp:seat:' + id;
function saveCreds(id, seat, token) {
  memCreds[id] = { seat, token };
  LS.set(credKey(id), { seat, token });
  const list = (LS.get('hexbp:recent', []) || []).filter(g => g && g.id !== id);
  list.unshift({ id, seat, ts: Date.now() });
  LS.set('hexbp:recent', list.slice(0, 8));
}
function loadCreds(id) {
  const c = memCreds[id] || LS.get(credKey(id));
  return c && PLAYERS.includes(c.seat) && typeof c.token === 'string' ? c : null;
}
function touchRecent(id) {
  const list = LS.get('hexbp:recent', []) || [];
  const g = list.find(x => x && x.id === id);
  if (g) { g.ts = Date.now(); LS.set('hexbp:recent', list); }
}

/* ---------- app state ---------- */
let G = R.newState();                 // the rules state currently shown
const App = { mode: null, history: [] };   // mode: null (lobby) | 'local' | 'online'
const Net = {
  id: null, seat: null, token: null, v: 0, seats: { blue: null, red: null },
  lastBy: null, loaded: false, pending: false, timer: 0, fails: 0, epoch: 0, joinOffered: false,
};
const UI = { selected: null, hoverHex: null, press: null, drag: null,
  ptrType: window.matchMedia && matchMedia('(pointer: coarse)').matches ? 'touch' : 'mouse' };
const cam = { x: 0, y: 0, size: 36 };

const cur = () => R.currentPlayer(G);
const isOnline = () => App.mode === 'online';
const bothSeated = () => !!(Net.seats.blue && Net.seats.red);
const seatName = p => (isOnline() && Net.seats[p] && Net.seats[p].name) || NAME[p];

function canAct(p) {
  if (!App.mode || p !== cur()) return false;
  if (App.mode === 'local') return true;
  return Net.loaded && Net.seat === p && bothSeated() && !Net.pending;
}
function whyCant(p) {
  if (!isOnline()) return `It’s ${NAME[cur()]}’s turn`;
  if (!Net.seat) return 'You’re watching this game';
  if (p !== Net.seat) return `Those are ${seatName(p)}’s blueprints`;
  if (!bothSeated()) return 'Waiting for your opponent to join';
  if (Net.pending) return 'Sending your move…';
  return `Waiting for ${seatName(cur())}`;
}

/* ---------- DOM refs ---------- */
const $ = id => document.getElementById(id);
const boardCv = $('board'), statusEl = $('status'), turnEl = $('turn'), toastEl = $('toast');
const ghostEl = $('dragGhost'), rulesDlg = $('rules'), undoBtn = $('undoBtn'), inviteBtn = $('inviteBtn');
const lobbyEl = $('lobby'), connEl = $('conn'), inviteEl = $('invite'), mainEl = $('main');
const joinDlg = $('joinDlg'), menuDlg = $('menuDlg');
const PANEL = {}, BP = {};
const ro = new ResizeObserver(() => renderAll());

function buildPanels() {
  for (const p of PLAYERS) {
    const el = $('panel-' + p);
    el.style.setProperty('--pc', COL[p].main);
    el.innerHTML = `
      <div class="phead">
        <div class="pname"><span class="dot" style="background:${COL[p].main}"></span>${NAME[p]}<span class="badge">to move</span></div>
        <div class="pplayer"></div>
        <span class="inc" hidden></span>
        <div class="score"><b></b></div>
        <small class="breakdown"></small>
      </div>
      <div class="cards"></div>`;
    PANEL[p] = { el, badge: el.querySelector('.badge'), player: el.querySelector('.pplayer'),
      total: el.querySelector('.score b'), inc: el.querySelector('.inc'), sub: el.querySelector('.breakdown') };
    const cards = el.querySelector('.cards');
    BP[p] = [];
    for (let b = 0; b < 3; b++) {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `<div class="lbl"><span><span class="long">Blueprint </span>${b + 1}</span><span class="counts"></span></div><div class="cv"><canvas></canvas></div>`;
      cards.appendChild(card);
      const ref = { card, canvas: card.querySelector('canvas'), counts: card.querySelector('.counts'), layout: null };
      BP[p].push(ref);
      card.addEventListener('pointerdown', e => onBpDown(e, p, b));
      card.addEventListener('contextmenu', e => e.preventDefault());
      ro.observe(ref.canvas);
    }
  }
  $('rulesLegend').innerHTML = TYPES.map(t => `<li><span class="icon">${svgIcon(t)}</span> <b>${TYPE_NAME[t]}</b> — ${TYPE_DESC[t]}</li>`).join('');
}

// Board legend: only the cell types used by the current game's mode.
let legendKey = '';
function renderLegend() {
  const types = typesFor(G);
  const k = types.join();
  if (k === legendKey) return;
  legendKey = k;
  $('legend').innerHTML = types.map(t => `<span>${svgIcon(t)}${typeLabel(t, G)}</span>`).join('');
}

/* ---------- rendering ---------- */
let rafPending = false;
function requestRender() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; renderBoard(); renderStatus(); });
}
function renderAll() { renderHeader(); renderLegend(); renderPanels(); requestRender(); }

function renderHeader() {
  const order = R.settingsOf(G).turnOrder;
  const p = cur(), [m, of] = R.movePos(G.moveNo, order), t = R.turnNo(G.moveNo, order);
  const mine = isOnline() && Net.seat === p;
  const label = mine ? 'Your move' : `${esc(seatName(p))} to move`;
  const full = of > 1 ? `move ${m} of ${of} · turn ${t}` : `turn ${t}`;
  const short = of > 1 ? `${m}/${of}` : '';
  turnEl.innerHTML = `<span class="dot" style="background:${COL[p].main}"></span><span class="tl">${label}</span>` +
    `<span class="sub"><span class="full">${full}</span><span class="short">${short}</span></span>`;
  turnEl.style.boxShadow = `inset 0 0 0 1.5px ${COL[p].main}`;

  if (isOnline()) {
    undoBtn.innerHTML = '<span class="long">Take back</span><span class="sm">Undo</span>';
    undoBtn.title = 'Take back your last move (only until your opponent moves)';
    undoBtn.disabled = !(Net.seat && Net.lastBy === Net.seat && !Net.pending);
    const openSeat = PLAYERS.find(s => !Net.seats[s]);
    inviteBtn.hidden = !Net.loaded;
    inviteBtn.textContent = !Net.seat && openSeat ? `Join as ${NAME[openSeat]}` : 'Invite';
    inviteBtn.classList.toggle('optional', bothSeated());   // still in the menu; hidden on phones
    connEl.hidden = false;
  } else {
    undoBtn.textContent = 'Undo';
    undoBtn.title = 'Undo last move (Ctrl/⌘+Z)';
    undoBtn.disabled = !App.history.length;
    inviteBtn.hidden = true;
    connEl.hidden = true;
  }
  inviteEl.hidden = !(isOnline() && Net.loaded && Net.seat && !bothSeated());
  if (!inviteEl.hidden) {
    const url = inviteUrl();
    if ($('inviteUrl').value !== url) $('inviteUrl').value = url;
    $('inviteSeat').textContent = NAME[R.other(Net.seat)];
    $('inviteCode').textContent = Net.id;
  }
  mainEl.classList.toggle('flip', isOnline() && Net.seat === 'red');
  document.title = isOnline() && canAct(cur()) ? '● Your move · Hex Blueprints' : 'Hex Blueprints';
}

function setConn(ok) {
  connEl.classList.toggle('bad', !ok);
  connEl.querySelector('.label').textContent = ok ? `Game ${Net.id}` : 'Reconnecting…';
  connEl.title = ok ? 'Connected' : 'Trying to reach the server';
}

function renderPanels() {
  const sc = R.getScores(G), c = cur();
  for (const p of PLAYERS) {
    const P = PANEL[p];
    P.el.classList.toggle('can', canAct(p));
    P.el.classList.toggle('waiting', p !== c);
    P.badge.style.visibility = p === c ? 'visible' : 'hidden';
    P.total.textContent = sc[p].total;
    const s = sc[p];
    const killTxt = `${s.destroyed} enemy Score cell${s.destroyed === 1 ? '' : 's'} destroyed × ${s.killPoints} point${s.killPoints === 1 ? '' : 's'}`;
    if (s.scoring === 'bounty') {
      P.sub.textContent = `${s.destroyed} kill${s.destroyed === 1 ? '' : 's'} · ${s.onBoard} score cells`;
      P.sub.title = `${s.fromKills} points from destroying ${s.destroyed} enemy Score cell${s.destroyed === 1 ? '' : 's'}.\n` +
        `Each enemy Score cell you destroy pays out the number of Score cells you have on the board after that placement — currently ${s.onBoard}.`;
      P.inc.textContent = `+${s.perKill}/kill`;
      P.inc.hidden = false;
    } else if (s.scoring === 'surround') {
      P.sub.textContent = `${s.surrounded} surrounded`;
      P.sub.title = `1 point for every enemy cell you've destroyed by surrounding it with a closed loop of your cells (${s.surrounded} so far).\nDestroying by contact alone scores nothing.`;
      P.inc.hidden = true;
    } else if (s.scoring === 'blob') {
      const n = s.blobs.length;
      P.sub.textContent = `${s.fragile} fragile · ${n} blob${n === 1 ? '' : 's'}`;
      P.sub.title = `Score = the sum of n² over your Fragile blobs (n = cells in the blob)` +
        (n ? `: ${s.blobs.map(b => b + '²').join(' + ')} = ${s.total}.\n` : ': 0.\n') +
        `You have ${s.fragile} Fragile cell${s.fragile === 1 ? '' : 's'} in ${n} blob${n === 1 ? '' : 's'}` +
        (n ? `: ${s.blobs.join(', ')}.` : '.');
      P.inc.hidden = true;
    } else if (s.scoring === 'buildup') {
      P.sub.textContent = `${s.charge} charging + ${s.banked} stolen` + (s.killPoints ? ` + ${s.killScore} kill` : '');
      P.sub.title = `${s.charge} points stored in ${s.onBoard} Score cell${s.onBoard === 1 ? '' : 's'} on the board (lost to the opponent if they delete them)` +
        ` + ${s.banked} stolen from deleted enemy Score cells (kept permanently)` +
        (s.killPoints ? ` + ${killTxt}` : '') + `.\nYour Score cells gain +${s.perMove} in total after every move.`;
      P.inc.textContent = `+${s.perMove}/move`;
      P.inc.hidden = false;
    } else if (s.scoring === 'bank') {
      P.sub.textContent = `${s.banked} banked + ${s.killScore} kill pts`;
      P.sub.title = `${s.banked} points banked at the ends of turns + ${killTxt}.\n${s.perTurn} Score cell${s.perTurn === 1 ? '' : 's'} on the board → +${s.perTurn} at the end of each turn.`;
      P.inc.textContent = `+${s.perTurn}/turn`;
      P.inc.hidden = false;
    } else {
      P.sub.textContent = `${s.onBoard} on board + ${s.killScore} kill pts`;
      P.sub.title = `${s.onBoard} Score cells on the board + ${killTxt}`;
      P.inc.hidden = true;
    }
    P.inc.title = P.sub.title;
    P.total.parentElement.title = P.sub.title;
    if (isOnline()) {
      const seat = Net.seats[p];
      P.player.hidden = false;
      P.player.textContent = seat ? seat.name + (Net.seat === p ? ' (you)' : '') : (Net.loaded ? 'waiting for player…' : '');
      P.player.title = P.player.textContent;
      P.player.classList.toggle('me', Net.seat === p);
    } else {
      P.player.hidden = true;
    }
    for (let b = 0; b < 3; b++) {
      const ref = BP[p][b], cells = G.blueprints[p][b];
      ref.card.classList.toggle('sel', canAct(p) && !!UI.selected && UI.selected.bp === b);
      const cnt = { score: 0, fragile: 0, attack: 0, wall: 0 };
      for (const k in cells) cnt[cells[k]]++;
      const html = TYPES.filter(t => cnt[t])
        .map(t => `<span title="${TYPE_NAME[t]}">${svgIcon(t)}${cnt[t]}</span>`).join('') || '<span>empty</span>';
      if (ref.counts.innerHTML !== html) ref.counts.innerHTML = html;
      renderBlueprint(p, b);
    }
  }
}

function computeLayout(cells, w, h) {
  const keys = Object.keys(cells);
  const set = new Set(keys);
  if (!keys.length) set.add(key(0, 0));
  else for (const k of keys) { const [q, r] = unkey(k); for (const [dq, dr] of DIRS) set.add(key(q + dq, r + dr)); }
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (const k of set) {
    const [q, r] = unkey(k), x = hx(q, r), y = hy(q, r);
    minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y);
  }
  minx -= SQRT3 / 2; maxx += SQRT3 / 2; miny -= 1; maxy += 1;
  const pad = 6;
  const s = Math.max(3, Math.min((w - 2 * pad) / (maxx - minx), (h - 2 * pad) / (maxy - miny), 26));
  return { s, ox: w / 2 - s * (minx + maxx) / 2, oy: h / 2 - s * (miny + maxy) / 2, slots: [...set], slotSet: set };
}

function renderBlueprint(p, b) {
  const ref = BP[p][b], cv = ref.canvas;
  const { w, h, dpr } = sizeCanvas(cv);
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const cells = G.blueprints[p][b];
  const L = computeLayout(cells, w, h);
  ref.layout = L;
  if (w < 4 || h < 4) return;
  const s = L.s;
  const P = k => { const [q, r] = unkey(k); return [L.ox + s * hx(q, r), L.oy + s * hy(q, r)]; };
  const drag = UI.drag && UI.drag.p === p ? UI.drag : null;
  const empty = !Object.keys(cells).length;

  if (drag) {
    for (const sk of L.slots) {
      if (sk in cells) continue;
      const [x, y] = P(sk);
      hexPath(ctx, x, y, s * 0.88);
      if (drag.valid[b].has(sk)) {
        ctx.fillStyle = 'rgba(52,211,153,0.10)'; ctx.fill();
        ctx.setLineDash([3, 3]); ctx.strokeStyle = 'rgba(52,211,153,0.65)';
      } else {
        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      }
      ctx.lineWidth = 1.2; ctx.stroke(); ctx.setLineDash([]);
    }
  } else if (empty) {
    const [x, y] = P(L.slots[0]);
    hexPath(ctx, x, y, s * 0.88);
    ctx.setLineDash([4, 4]); ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 1.2; ctx.stroke(); ctx.setLineDash([]);
  }

  for (const k in cells) {
    const [x, y] = P(k);
    const faded = drag && drag.fromBp === b && drag.fromKey === k;
    drawCell(ctx, x, y, s, p, cells[k], faded ? 0.22 : 1);
  }

  const lm = G.lastMove;
  if (!drag && lm && lm.kind === 'edit' && lm.player === p && lm.toBp === b && lm.toKey in cells) {
    const [x, y] = P(lm.toKey);
    hexPath(ctx, x, y, s * 0.86);
    ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 1.5; ctx.stroke();
  }

  if (UI.selected && canAct(p) && UI.selected.bp === b && UI.selected.handle in cells) {
    const [x, y] = P(UI.selected.handle);
    hexPath(ctx, x, y, s * 0.84);
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = Math.max(2, s * 0.12); ctx.stroke();
  }

  if (drag && drag.target && drag.target.b === b) {
    const tk = drag.target.key, [x, y] = P(tk);
    const isSelf = b === drag.fromBp && tk === drag.fromKey;
    const ok = drag.valid[b].has(tk);
    if (ok) drawCell(ctx, x, y, s, p, drag.type, 0.7);
    hexPath(ctx, x, y, s * 0.9);
    ctx.strokeStyle = isSelf ? 'rgba(255,255,255,0.6)' : ok ? GOOD : BAD;
    ctx.lineWidth = 2; ctx.stroke();
  }
}

function boardDims() { return { w: boardCv.clientWidth, h: boardCv.clientHeight }; }

// The preview is evaluated a few times per frame; cache it per (state, blueprint, handle, hex).
let ghostMemo = { k: null, v: null };
function ghostEval() {
  if (!UI.selected || !UI.hoverHex || !canAct(cur())) return null;
  const k = [G.moveNo, Net.v, App.history.length, UI.selected.bp, UI.selected.handle, UI.hoverHex[0], UI.hoverHex[1]].join('|');
  if (ghostMemo.k === k && ghostMemo.g === G) return ghostMemo.v;
  const v = R.evalPlacement(G, cur(), UI.selected.bp, UI.selected.handle, UI.hoverHex[0], UI.hoverHex[1]);
  ghostMemo = { k, g: G, v };
  return v;
}

function renderBoard() {
  const { w, h, dpr } = sizeCanvas(boardCv);
  const ctx = boardCv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = BOARD_BG;
  ctx.fillRect(0, 0, w, h);
  const s = cam.size, ox = w / 2 + cam.x, oy = h / 2 + cam.y;
  const colW = SQRT3 * s, rowH = 1.5 * s;
  const X = (q, r) => ox + colW * (q + r / 2), Y = r => oy + rowH * r;

  // grid
  const rMin = Math.floor(-oy / rowH) - 1, rMax = Math.ceil((h - oy) / rowH) + 1;
  ctx.beginPath();
  for (let r = rMin; r <= rMax; r++) {
    const qMin = Math.floor(-ox / colW - r / 2) - 1, qMax = Math.ceil((w - ox) / colW - r / 2) + 1;
    for (let q = qMin; q <= qMax; q++) hexPath(ctx, X(q, r), Y(r), s, true);
  }
  ctx.lineWidth = Math.max(1, s * 0.1);
  ctx.strokeStyle = GRID;
  ctx.stroke();

  // cells
  const vis = (x, y) => x > -2 * s && x < w + 2 * s && y > -2 * s && y < h + 2 * s;
  const showCharge = R.scoringOf(G) === 'buildup';
  const blobSize = R.scoringOf(G) === 'blob' ? R.fragileBlobSizeMap(G.board) : null;
  for (const k in G.board) {
    const [q, r] = unkey(k), x = X(q, r), y = Y(r);
    if (!vis(x, y)) continue;
    const c = G.board[k];
    const label = showCharge && c.type === 'score' ? (c.pts || 0)
      : blobSize && c.type === 'fragile' ? blobSize[k] : null;
    drawCell(ctx, x, y, s, c.owner, c.type, 1, label);
  }

  // last placement
  const lm = G.lastMove;
  if (lm && lm.kind === 'place') {
    ctx.beginPath();
    for (const k of lm.cells) { const [q, r] = unkey(k); hexPath(ctx, X(q, r), Y(r), s * 0.86, true); }
    ctx.lineWidth = Math.max(1.5, s * 0.07);
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.stroke();
    // Contact mode: ghost outlines where the opponent's cells were just deleted
    const gone = (lm.deleted || []).filter(k => !G.board[k]);
    if (gone.length) {
      const victim = R.other(lm.player);
      ctx.beginPath();
      for (const k of gone) { const [q, r] = unkey(k); hexPath(ctx, X(q, r), Y(r), s * 0.8, true); }
      ctx.setLineDash([Math.max(3, s * 0.18), Math.max(3, s * 0.14)]);
      ctx.lineWidth = Math.max(1.5, s * 0.07);
      ctx.strokeStyle = COL[victim].main + 'aa';
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // placement preview
  const ev = ghostEval();
  if (ev) {
    const p = cur();
    // Surround mode: shade the area the placement would enclose
    if (ev.ok && ev.enclosed && ev.enclosed.length) {
      ctx.beginPath();
      for (const k of ev.enclosed) { const [q, r] = unkey(k); hexPath(ctx, X(q, r), Y(r), s * 0.96, true); }
      ctx.fillStyle = 'rgba(52,211,153,0.16)'; ctx.fill();
    }
    // Enemy cells this placement would delete: amber = contact, green = surrounded (scores a point)
    for (const d of ev.deletes || []) {
      const x = X(d.q, d.r), y = Y(d.r), k = s * 0.32;
      hexPath(ctx, x, y, s * 0.9);
      ctx.fillStyle = 'rgba(20,20,20,0.45)'; ctx.fill();
      ctx.lineWidth = Math.max(2, s * 0.09); ctx.strokeStyle = d.surround ? GOOD : AMBER; ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - k, y - k); ctx.lineTo(x + k, y + k);
      ctx.moveTo(x + k, y - k); ctx.lineTo(x - k, y + k);
      ctx.lineWidth = Math.max(2, s * 0.11); ctx.lineCap = 'round'; ctx.stroke(); ctx.lineCap = 'butt';
    }
    for (const c of ev.cells) drawCell(ctx, X(c.q, c.r), Y(c.r), s, p, c.type, 0.6);
    for (const c of ev.cells) {
      const x = X(c.q, c.r), y = Y(c.r);
      hexPath(ctx, x, y, s * 0.9);
      ctx.lineWidth = Math.max(2, s * 0.09);
      ctx.strokeStyle = (!ev.ok || c.status === 'blocked') ? BAD : c.status === 'capture' ? AMBER : GOOD;
      ctx.stroke();
      if (c.status === 'blocked') {
        const d = s * 0.38;
        ctx.beginPath();
        ctx.moveTo(x - d, y - d); ctx.lineTo(x + d, y + d);
        ctx.moveTo(x + d, y - d); ctx.lineTo(x - d, y + d);
        ctx.lineWidth = Math.max(2, s * 0.13); ctx.strokeStyle = BAD; ctx.lineCap = 'round'; ctx.stroke(); ctx.lineCap = 'butt';
      }
    }
  } else if (UI.hoverHex && !UI.selected && UI.ptrType === 'mouse' && App.mode) {
    const [q, r] = UI.hoverHex;
    hexPath(ctx, X(q, r), Y(r), s * 0.92);
    ctx.lineWidth = Math.max(1.5, s * 0.06); ctx.strokeStyle = 'rgba(255,255,255,0.14)'; ctx.stroke();
  }

  boardCv.style.cursor = bpress && bpress.moved ? 'grabbing' : (UI.selected && canAct(cur())) ? 'crosshair' : 'grab';
}

function renderStatus() {
  const p = cur();
  const who = isOnline() && Net.seat === p ? '<b>Your move</b>' : `<b style="color:${COL[p].main}">${esc(seatName(p))}</b>`;
  const touch = UI.ptrType !== 'mouse';
  let html;
  if (!App.mode) html = '';
  else if (isOnline() && !Net.loaded) html = 'Loading game…';
  else if (UI.drag) {
    html = `${who}: drop the cell on a <span class="ok">highlighted</span> slot in any of your blueprints`;
  } else if (UI.selected && canAct(p)) {
    const ev = ghostEval(), name = `Blueprint ${UI.selected.bp + 1}`;
    if (!ev) html = `${who}: placing <b>${name}</b> — ${touch ? 'tap a hex to preview' : 'hover the board'} · Esc to cancel`;
    else if (ev.ok) html = `<span class="ok">Legal</span>` + esc(gainText(ev)) +
      ` · ${touch ? 'tap the same hex again to place' : 'click to place'}`;
    else html = `<span class="err">${esc(ev.reason)}</span>`;
  } else if (canAct(p)) {
    html = `${who}: ${touch ? 'tap' : 'click'} a blueprint to place it, or drag one of its cells to rearrange`;
  } else if (isOnline()) {
    if (!Net.seat) html = `Watching · <b style="color:${COL[p].main}">${esc(seatName(p))}</b> to move`;
    else if (!bothSeated()) html = 'Waiting for your opponent to join';
    else if (Net.pending) html = 'Sending your move…';
    else html = `Waiting for <b style="color:${COL[p].main}">${esc(seatName(p))}</b>…`;
  } else html = '';
  statusEl.hidden = !html;
  if (statusEl.innerHTML !== html) statusEl.innerHTML = html;
}

/* ---------- toast ---------- */
let toastT = 0;
function toast(msg, kind) {
  const k = kind || 'err';
  toastEl.textContent = msg;
  toastEl.className = 'show ' + k;
  clearTimeout(toastT);
  toastT = setTimeout(() => { toastEl.className = k; }, 2200);
}

/* ---------- view ---------- */
function fitView() {
  const { w, h } = boardDims();
  if (!w || !h) return;
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (const k in G.board) {
    const [q, r] = unkey(k), x = hx(q, r), y = hy(q, r);
    minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y);
  }
  if (minx === Infinity) minx = maxx = miny = maxy = 0;
  const padX = 4 * SQRT3, padY = 6;
  const s = clamp(Math.min(w / (maxx - minx + 2 * padX), h / (maxy - miny + 2 * padY)), MIN_SIZE, 40);
  cam.size = s;
  cam.x = -s * (minx + maxx) / 2;
  cam.y = -s * (miny + maxy) / 2;
  requestRender();
}
function zoomAt(mx, my, f) {
  const { w, h } = boardDims();
  const ns = clamp(cam.size * f, MIN_SIZE, MAX_SIZE);
  const wx = (mx - w / 2 - cam.x) / cam.size, wy = (my - h / 2 - cam.y) / cam.size;
  cam.size = ns;
  cam.x = mx - w / 2 - wx * ns;
  cam.y = my - h / 2 - wy * ns;
  requestRender();
}
function hexAtClient(cx, cy) {
  const rect = boardCv.getBoundingClientRect();
  const x = cx - rect.left, y = cy - rect.top;
  return unitToHex((x - rect.width / 2 - cam.x) / cam.size, (y - rect.height / 2 - cam.y) / cam.size);
}

/* ---------- describing captures (preview + toasts) ---------- */
function captureDetails(x, past) {
  const kp = R.settingsOf(G).killPoints, det = [];
  if (x.surrounded) det.push(`${x.surrounded} surrounded, +${x.surrounded} pt${x.surrounded === 1 ? '' : 's'}`);
  if (x.fragileKills) det.push(`${x.fragileKills} fragile` + (x.chained ? `, ${x.chained} by chain reaction` : ''));
  if (x.scoreKills) det.push(`${x.scoreKills} score`);
  if (x.bounty) det.push(`+${x.bounty} pts = ${x.scoreKills} × ${x.perKill} score cells`);
  if (x.stolen) det.push(`${past ? 'stole' : 'steals'} ${x.stolen} pts`);
  if (x.scoreKills && kp) det.push(`+${x.scoreKills * kp} pts`);
  return det;
}
function gainText(ev) {
  let t = '';
  if (ev.captures) {
    const det = captureDetails(ev);
    t += ` · ${R.placementOf(G) === 'contact' ? 'deletes' : 'captures'} ${ev.captures}${det.length ? ` (${det.join(', ')})` : ''}`;
  }
  if (ev.kept) t += ` · keeps ${ev.kept} pts`;
  if (R.scoringOf(G) === 'blob') t += blobPreview(ev);
  return t;
}
// Fragile mode: how both players' scores (sum of n² over blobs) would change if this placement is made.
function blobPreview(ev) {
  const p = cur(), o = R.other(p);
  const board = { ...G.board };
  for (const c of ev.cells) board[c.k] = { owner: p, type: c.type };
  for (const d of ev.deletes) delete board[d.k];
  const now = R.getScores(G);
  const who = x => (isOnline() && Net.seat === x ? 'you' : seatName(x));
  const me = R.blobPoints(R.fragileBlobs(board, p)), them = R.blobPoints(R.fragileBlobs(board, o));
  return ` · ${who(p)} ${now[p].total}→${me}, ${who(o)} ${now[o].total}→${them}`;
}

/* ---------- making moves ---------- */
async function commit(move) {
  const r = R.applyMove(G, move);
  if (!r.ok) { toast(r.error); return; }
  const info = r.info || {};
  const who = move.p === Net.seat && isOnline() ? 'You' : NAME[move.p];
  const parts = [];
  if (info.captures) {
    const det = captureDetails(info, true);
    parts.push(`${who} ${R.placementOf(G) === 'contact' ? 'deleted' : 'captured'} ${info.captures} cell${info.captures > 1 ? 's' : ''}` +
      (det.length ? ` (${det.join(', ')})` : ''));
  }
  if (info.kept) parts.push(`${parts.length ? 'kept' : `${who} kept`} ${info.kept} pts from overwritten Score cells`);
  if (info.turnEnded) parts.push(`${parts.length ? 'turn over' : 'Turn over'}: +${info.banked} banked`);
  const captureMsg = parts.length ? parts.join(' · ') : null;

  if (!isOnline()) {
    App.history.push(G);
    if (App.history.length > 1000) App.history.shift();
    G = r.state;
    UI.selected = null;
    if (captureMsg) toast(captureMsg, 'info');
    renderAll();
    return;
  }

  // Online: show the move immediately, then confirm with the server.
  const before = G;
  G = r.state;
  UI.selected = null;
  Net.pending = true;
  Net.epoch++;
  renderAll();
  try {
    const res = await api('POST', { action: 'move', id: Net.id, token: Net.token, v: Net.v, move });
    Net.pending = false;
    if (res.game) applyGame(res.game, true);
    if (res.ok) { if (captureMsg) toast(captureMsg, 'info'); }
    else {
      toast(res.error || 'Move rejected');
      if (!res.game) { G = before; await refresh(); }
    }
  } catch {
    Net.pending = false;
    G = before;
    toast('Connection problem — your move was not sent');
    await refresh();
  }
  renderAll();
  schedulePoll();
}

function tryPlace(h) {
  const p = cur(), sel = UI.selected;
  if (!sel || !canAct(p)) return;
  const ev = R.evalPlacement(G, p, sel.bp, sel.handle, h[0], h[1]);
  if (!ev.ok) { toast(ev.reason); return; }
  commit({ t: 'place', p, bp: sel.bp, h: sel.handle, at: [h[0], h[1]] });
}

async function undo() {
  if (!isOnline()) {
    if (!App.history.length) return;
    cancelDrag(true);
    G = App.history.pop();
    UI.selected = null;
    renderAll();
    return;
  }
  if (!(Net.seat && Net.lastBy === Net.seat) || Net.pending) return;
  cancelDrag(true);
  UI.selected = null;
  Net.pending = true;
  Net.epoch++;
  renderAll();
  try {
    const res = await api('POST', { action: 'undo', id: Net.id, token: Net.token, v: Net.v });
    Net.pending = false;
    if (res.game) applyGame(res.game, true);
    if (res.ok) toast('Move taken back', 'info'); else toast(res.error || 'Couldn’t take that back');
  } catch {
    Net.pending = false;
    toast('Connection problem — try again');
  }
  renderAll();
  schedulePoll();
}

/* ---------- networking ---------- */
async function api(method, body, query) {
  const url = API + (query ? '?' + new URLSearchParams(query) : '');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, method === 'GET'
      ? { cache: 'no-store', signal: ctrl.signal }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
    let data;
    try { data = await res.json(); } catch { data = { ok: false, error: `Server error (${res.status})` }; }
    if (!res.ok) data.ok = false;
    data.status = res.status;
    return data;
  } finally { clearTimeout(t); }
}

// Take a game snapshot from the server. `force` replaces the board even if the
// version number is unchanged (used after an optimistic move was rejected).
function applyGame(g, force) {
  if (!g || g.id !== Net.id) return;
  if (!force && g.v < Net.v) return;
  const changed = g.v !== Net.v || !Net.loaded;
  Net.v = g.v;
  Net.seats = g.seats;
  Net.lastBy = g.lastBy;
  if (Net.seat && !g.seats[Net.seat]) { Net.seat = null; Net.token = null; }
  const first = !Net.loaded;
  Net.loaded = true;
  if (changed || force) {
    G = g.state;
    if (UI.drag) cancelDrag(true);
    if (UI.selected && (!canAct(cur()) || !(UI.selected.handle in G.blueprints[cur()][UI.selected.bp]))) UI.selected = null;
  }
  if (first) requestAnimationFrame(fitView);
  renderAll();
}

async function refresh() {
  try {
    const res = await api('GET', null, { id: Net.id });
    if (res.ok && res.game) applyGame(res.game, true);
  } catch { /* poll will retry */ }
}

function pollDelay() {
  if (document.hidden) return 20000;
  if (Net.fails) return Math.min(30000, 2000 * 2 ** Math.min(Net.fails, 4));
  if (!Net.seat || !bothSeated() || cur() !== Net.seat) return 1500;
  return 4000; // your turn: only need to notice take-backs
}
function schedulePoll(delay) {
  clearTimeout(Net.timer);
  if (!isOnline()) return;
  Net.timer = setTimeout(poll, delay ?? pollDelay());
}
async function poll() {
  if (!isOnline()) return;
  if (Net.pending || UI.drag) { schedulePoll(800); return; }
  const id = Net.id, epoch = Net.epoch;
  try {
    const res = await api('GET', null, { id, v: Net.v });
    if (!isOnline() || Net.id !== id) return;
    if (res.ok) {
      Net.fails = 0; setConn(true);
      if (res.game && epoch === Net.epoch && !Net.pending) applyGame(res.game);
    } else if (res.status === 404) {
      toast(res.error || 'Game not found');
      goHome();
      return;
    } else { Net.fails++; setConn(false); }
  } catch { Net.fails++; setConn(false); }
  schedulePoll();
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && isOnline()) schedulePoll(0);
});

/* ---------- online game lifecycle ---------- */
const inviteUrl = () => `${location.origin}${location.pathname}?g=${Net.id}`;
const rejoinUrl = () => `${inviteUrl()}#seat=${Net.seat}&t=${encodeURIComponent(Net.token)}`;

async function openOnline(id, firstGame) {
  stopOnline();
  App.mode = 'online';
  App.history = [];
  Object.assign(Net, { id, seat: null, token: null, v: 0, seats: { blue: null, red: null }, lastBy: null,
    loaded: false, pending: false, fails: 0, joinOffered: false });
  const creds = loadCreds(id);
  if (creds) { Net.seat = creds.seat; Net.token = creds.token; touchRecent(id); }
  UI.selected = null;
  G = R.newState();
  hideLobby();
  setConn(true);
  renderAll();
  requestAnimationFrame(fitView);

  let res = firstGame ? { ok: true, game: firstGame } : null;
  if (!res) {
    try { res = await api('GET', null, { id }); }
    catch { res = { ok: false, error: 'Couldn’t reach the server. Online play needs the deployed site (or npm run dev).' }; }
  }
  if (Net.id !== id || !isOnline()) return;
  if (!res.ok || !res.game) { toast(res.error || 'Could not load that game'); goHome(); return; }
  applyGame(res.game, true);
  maybeOfferJoin();
  schedulePoll();
}

function stopOnline() {
  clearTimeout(Net.timer);
  Net.id = null;
}

function maybeOfferJoin(force) {
  if (!isOnline() || Net.seat) return;
  const open = PLAYERS.find(p => !Net.seats[p]);
  if (!open || (Net.joinOffered && !force)) return;
  Net.joinOffered = true;
  const taken = PLAYERS.find(p => Net.seats[p]);
  $('joinCode').textContent = Net.id;
  $('joinText').textContent = taken
    ? `${Net.seats[taken].name} is playing ${NAME[taken]}. Join as ${NAME[open]}?`
    : `Join this game as ${NAME[open]}?`;
  $('joinBtn').textContent = `Join as ${NAME[open]}`;
  $('joinRules').textContent = 'Options for this game: ' + settingsText(R.settingsOf(G));
  $('joinName').value = LS.get('hexbp:name', '') || '';
  if (!joinDlg.open) joinDlg.showModal();
}

async function joinGame() {
  const name = $('joinName').value.trim();
  LS.set('hexbp:name', name);
  const btn = $('joinBtn');
  btn.disabled = true;
  try {
    const res = await api('POST', { action: 'join', id: Net.id, name });
    if (res.ok) {
      saveCreds(Net.id, res.seat, res.token);
      Net.seat = res.seat; Net.token = res.token;
      joinDlg.close();
      applyGame(res.game, true);
      toast(`You’re playing ${NAME[res.seat]}`, 'info');
      schedulePoll();
    } else {
      toast(res.error || 'Could not join');
      if (res.game) applyGame(res.game, true);
      joinDlg.close();
    }
  } catch {
    toast('Couldn’t reach the server');
  } finally { btn.disabled = false; }
}

async function createGame() {
  const name = $('nameIn').value.trim();
  LS.set('hexbp:name', name);
  const seat = document.querySelector('#seatSeg [aria-pressed=true]').dataset.seat;
  LS.set('hexbp:seatPref', seat);
  const btn = $('createBtn');
  btn.disabled = true;
  try {
    const res = await api('POST', { action: 'create', seat, name, settings: chosenSettings() });
    if (!res.ok) { toast(res.error || 'Could not create a game'); return; }
    saveCreds(res.id, res.seat, res.token);
    history.pushState(null, '', `${location.pathname}?g=${res.id}`);
    await openOnline(res.id, res.game);
  } catch {
    toast('Couldn’t reach the server. Online play needs the deployed site (or npm run dev).');
  } finally { btn.disabled = false; }
}

async function copyText(text, okMsg) {
  try { await navigator.clipboard.writeText(text); toast(okMsg, 'info'); return; } catch { /* fall back */ }
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  if (ok) toast(okMsg, 'info');
  else window.prompt('Copy this link:', text);
}

/* ---------- lobby / local ---------- */
function showLobby() {
  stopOnline();
  App.mode = null;
  App.history = [];
  UI.selected = null;
  cancelDrag(true);
  G = R.newState();
  if (joinDlg.open) joinDlg.close();
  $('nameIn').value = LS.get('hexbp:name', '') || '';
  const pref = LS.get('hexbp:seatPref', 'blue');
  for (const b of document.querySelectorAll('#seatSeg button')) b.setAttribute('aria-pressed', String(b.dataset.seat === pref));
  renderOptions();
  renderRecent();
  lobbyEl.hidden = false;
  renderAll();
  requestAnimationFrame(fitView);
}
function hideLobby() { lobbyEl.hidden = true; }

function goHome() {
  if (location.search || location.hash) history.pushState(null, '', location.pathname);
  showLobby();
}

function renderRecent() {
  const list = (LS.get('hexbp:recent', []) || []).filter(g => g && /^[A-Z2-9]{6}$/.test(g.id) && PLAYERS.includes(g.seat));
  const ul = $('recentList');
  ul.innerHTML = '';
  $('recentSec').hidden = !list.length;
  for (const g of list) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.innerHTML = `<i style="background:${COL[g.seat].main}"></i><span class="code">${g.id}</span><span>you’re ${NAME[g.seat]}</span><span class="when">${ago(g.ts)}</span>`;
    b.addEventListener('click', () => { history.pushState(null, '', `${location.pathname}?g=${g.id}`); openOnline(g.id); });
    li.appendChild(b);
    ul.appendChild(li);
  }
}
function ago(ts) {
  const m = Math.round((Date.now() - (ts || 0)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

function startLocal() {
  stopOnline();
  if (location.search) history.pushState(null, '', location.pathname);
  App.mode = 'local';
  App.history = [];
  UI.selected = null;
  G = R.newState(chosenSettings());
  hideLobby();
  toast('Options: ' + settingsText(R.settingsOf(G)), 'info');
  renderAll();
  requestAnimationFrame(fitView);
}

/* ---------- game options (mode, turn order, kill points) ---------- */
const MODE_LABEL = R.MODE_NAMES;
const MODE_HINT = {
  classic: 'Classic: stamps may overlap. Your cells overwrite enemy cells (except walls). Score = Score cells on the board + kills.',
  contact: 'Contact: no overlapping. Placing next to enemy cells deletes them (except walls). You bank 1 point per Score cell at the end of each of your turns.',
  buildup: 'Build-up: Contact placement (no overlapping; touching deletes enemy cells except walls). Every Score cell gains 1 point after every move. Delete an enemy Score cell to steal all of its points.',
  buildup2: 'Build-up II: Build-up rules, but each side starts with its three blueprints already on the board. Blueprint 2 is a wall ringed by 6 Score cells (starting at 1 point); blueprints 1 and 3 are a wall ringed by 6 plain cells.',
  bounty: 'Bounty: Contact placement, starting from three rotated blueprints already on the board. No points per turn: each enemy Score cell you destroy pays out the number of Score cells you have on the board.',
  surround: 'Surround: only Walls and normal cells; one starting ring each. Contact placement. Enclose enemy cells inside a closed loop of your cells to delete them (walls too): 1 point each.',
  fragile: 'Fragile: each side starts with its three blueprints on the board (each a wall with 2 Fragile cells, rotated 120° from each other). Contact placement. Destroying a Fragile cell destroys its whole connected same-colour blob. A blob of n cells is worth n² points.',
};
const ORDER_LABEL = { '122': '1-2-2-2…', '1111': '1-1-1-1…' };
function settingsText(st) {
  return `${MODE_LABEL[st.mode] || 'Classic'} mode · turns ${ORDER_LABEL[st.turnOrder]}` +
    (R.usesKillPoints(st.mode) ? ` · ${st.killPoints} point${st.killPoints === 1 ? '' : 's'} per enemy Score cell destroyed` : '');
}

// Lobby choices, remembered per browser. Each mode keeps its own kill-points value
// (Classic defaults to 2, Contact to 20).
function loadLobbyOpts() {
  const saved = LS.get('hexbp:options', null);
  const old = LS.get('hexbp:settings', null);   // from before modes existed
  const o = saved && typeof saved === 'object' ? saved : {};
  const kp = { ...R.DEFAULT_KILL_POINTS, ...(old && Number.isInteger(old.killPoints) ? { classic: old.killPoints } : {}), ...(o.kp || {}) };
  for (const m of R.MODES) kp[m] = R.normalizeSettings({ mode: m, killPoints: kp[m] }).killPoints;
  return {
    mode: R.MODES.includes(o.mode) ? o.mode : 'classic',
    turnOrder: R.TURN_ORDERS.includes(o.turnOrder) ? o.turnOrder : (old && R.TURN_ORDERS.includes(old.turnOrder) ? old.turnOrder : '122'),
    kp,
  };
}
let lobbyOpts = loadLobbyOpts();
const chosenSettings = () => R.normalizeSettings({ mode: lobbyOpts.mode, turnOrder: lobbyOpts.turnOrder, killPoints: lobbyOpts.kp[lobbyOpts.mode] });
function setLobbyOpts(patch) {
  if (patch.mode) lobbyOpts.mode = patch.mode;
  if (patch.turnOrder) lobbyOpts.turnOrder = patch.turnOrder;
  if ('killPoints' in patch) {
    lobbyOpts.kp[lobbyOpts.mode] = R.normalizeSettings({ mode: lobbyOpts.mode, killPoints: clamp(Math.round(patch.killPoints) || 0, 0, R.MAX_KILL_POINTS) }).killPoints;
  }
  LS.set('hexbp:options', lobbyOpts);
  renderOptions();
}
function renderOptions() {
  for (const b of document.querySelectorAll('#modeSeg button')) b.setAttribute('aria-pressed', String(b.dataset.mode === lobbyOpts.mode));
  for (const b of document.querySelectorAll('#orderSeg button')) b.setAttribute('aria-pressed', String(b.dataset.order === lobbyOpts.turnOrder));
  const kp = lobbyOpts.kp[lobbyOpts.mode];
  if (document.activeElement !== $('kpVal') || Number($('kpVal').value) !== kp) $('kpVal').value = kp;
  $('kpMinus').disabled = kp <= 0;
  $('kpPlus').disabled = kp >= R.MAX_KILL_POINTS;
  $('modeHint').textContent = MODE_HINT[lobbyOpts.mode] || '';
  $('kpField').hidden = !R.usesKillPoints(lobbyOpts.mode);   // Fragile scores by blob size only
}
function fillRulesDialog() {
  const st = App.mode ? R.settingsOf(G) : chosenSettings();
  $('rulesThis').textContent = (App.mode ? 'This game: ' : 'Selected options: ') + settingsText(st);
  // Each mode's section shows this game's value if it's that mode, otherwise that mode's default.
  for (const el of document.querySelectorAll('.rulesKp')) {
    el.textContent = el.dataset.mode === st.mode ? st.killPoints : R.DEFAULT_KILL_POINTS[el.dataset.mode];
  }
}

function openMenu() {
  const stack = $('menuStack');
  stack.innerHTML = '';
  $('menuInfo').textContent = 'Options: ' + settingsText(R.settingsOf(G));
  const add = (title, sub, fn) => {
    const b = document.createElement('button');
    b.innerHTML = `${esc(title)}<small>${esc(sub)}</small>`;
    b.addEventListener('click', () => { menuDlg.close(); fn(); });
    stack.appendChild(b);
  };
  if (isOnline()) {
    add('Copy invite link', `For your opponent or spectators · code ${Net.id}`, () => copyText(inviteUrl(), 'Invite link copied'));
    if (Net.seat && Net.token) {
      add('Copy my rejoin link', 'Opens this game as you on another device. Keep it private.', () => copyText(rejoinUrl(), 'Rejoin link copied — keep it private'));
    }
    if (!Net.seat && PLAYERS.some(p => !Net.seats[p])) add('Join this game', 'Take the open seat', () => maybeOfferJoin(true));
    add('Back to home', 'This game stays saved — reopen it from “Your games”.', goHome);
  } else {
    add('New pass-and-play game', 'Start over on this device', () => {
      if (G.moveNo > 0 && !confirm('Start a new game? The current game will be lost.')) return;
      startLocal();
    });
    add('Back to home', 'Play online, or join a friend’s game', () => {
      if (G.moveNo > 0 && !confirm('Leave this game? It will be lost.')) return;
      goHome();
    });
  }
  menuDlg.showModal();
}

function route() {
  const params = new URLSearchParams(location.search);
  const id = (params.get('g') || '').toUpperCase();
  // A private rejoin link looks like ?g=ABC123#seat=red&t=TOKEN
  const h = new URLSearchParams(location.hash.slice(1));
  if (/^[A-Z2-9]{6}$/.test(id) && h.get('t') && PLAYERS.includes(h.get('seat'))) {
    saveCreds(id, h.get('seat'), h.get('t'));
    history.replaceState(null, '', `${location.pathname}?g=${id}`);
  }
  if (/^[A-Z2-9]{6}$/.test(id)) openOnline(id);
  else showLobby();
}

/* ---------- board input ---------- */
const ptrs = new Map();
let bpress = null, pinch = null;

boardCv.addEventListener('pointerdown', e => {
  UI.ptrType = e.pointerType;
  try { boardCv.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (ptrs.size === 1) {
    bpress = { id: e.pointerId, x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y, moved: false, button: e.button, type: e.pointerType };
  } else if (ptrs.size === 2) {
    const [a, b] = [...ptrs.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, size: cam.size, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, cx: cam.x, cy: cam.y };
    if (bpress) bpress.moved = true;
  }
});

boardCv.addEventListener('pointermove', e => {
  if (ptrs.has(e.pointerId)) {
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && ptrs.size >= 2) {
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const rect = boardCv.getBoundingClientRect(), w = rect.width, h = rect.height;
      const ns = clamp(pinch.size * d / pinch.d, MIN_SIZE, MAX_SIZE);
      const wx = (pinch.mx - rect.left - w / 2 - pinch.cx) / pinch.size;
      const wy = (pinch.my - rect.top - h / 2 - pinch.cy) / pinch.size;
      cam.size = ns;
      cam.x = mx - rect.left - w / 2 - wx * ns;
      cam.y = my - rect.top - h / 2 - wy * ns;
      requestRender();
      return;
    }
    if (bpress && e.pointerId === bpress.id) {
      const dx = e.clientX - bpress.x, dy = e.clientY - bpress.y;
      if (!bpress.moved && Math.hypot(dx, dy) > 6) bpress.moved = true;
      if (bpress.moved) { cam.x = bpress.cx + dx; cam.y = bpress.cy + dy; requestRender(); }
    }
  }
  if (e.pointerType === 'mouse') {
    UI.ptrType = 'mouse';
    const hh = hexAtClient(e.clientX, e.clientY);
    if (!UI.hoverHex || hh[0] !== UI.hoverHex[0] || hh[1] !== UI.hoverHex[1]) { UI.hoverHex = hh; requestRender(); }
  }
});

function endBoardPointer(e, isCancel) {
  const wasClick = !isCancel && bpress && e.pointerId === bpress.id && !bpress.moved && ptrs.size === 1;
  const press = bpress;
  ptrs.delete(e.pointerId);
  if (ptrs.size < 2) pinch = null;
  if (ptrs.size === 0) bpress = null;
  if (wasClick) boardClick(e, press);
  requestRender();
}
boardCv.addEventListener('pointerup', e => endBoardPointer(e, false));
boardCv.addEventListener('pointercancel', e => endBoardPointer(e, true));
boardCv.addEventListener('pointerleave', e => {
  if (e.pointerType === 'mouse' && !ptrs.size) { UI.hoverHex = null; requestRender(); }
});
boardCv.addEventListener('contextmenu', e => e.preventDefault());
boardCv.addEventListener('wheel', e => {
  e.preventDefault();
  const rect = boardCv.getBoundingClientRect();
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-dy * 0.0015));
}, { passive: false });

function boardClick(e, press) {
  if (!App.mode) return;
  if (press.type === 'mouse' && press.button === 2) { UI.selected = null; renderAll(); return; }
  if (press.type === 'mouse' && press.button !== 0) return;
  const hh = hexAtClient(e.clientX, e.clientY);
  if (!UI.selected || !canAct(cur())) {
    UI.hoverHex = hh;
    if (canAct(cur())) toast(isOnline() ? 'Pick one of your blueprints first' : `Pick one of ${NAME[cur()]}’s blueprints first`, 'info');
    else if (isOnline()) toast(whyCant(cur()), 'info');
    return;
  }
  if (press.type !== 'mouse') {
    if (!UI.hoverHex || UI.hoverHex[0] !== hh[0] || UI.hoverHex[1] !== hh[1]) { UI.hoverHex = hh; requestRender(); return; }
  }
  UI.hoverHex = hh;
  tryPlace(hh);
}

/* ---------- blueprint input (click = pick up, drag a cell = edit) ---------- */
function bpHit(p, b, cx, cy) {
  const ref = BP[p][b], L = ref.layout;
  if (!L) return null;
  const rect = ref.canvas.getBoundingClientRect();
  const x = cx - rect.left, y = cy - rect.top;
  if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;
  const [q, r] = unitToHex((x - L.ox) / L.s, (y - L.oy) / L.s);
  return key(q, r);
}

function onBpDown(e, p, b) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (!App.mode) return;
  UI.ptrType = e.pointerType;
  if (!canAct(p)) { toast(whyCant(p)); return; }
  e.preventDefault();
  const k = bpHit(p, b, e.clientX, e.clientY);
  const cellKey = k && k in G.blueprints[p][b] ? k : null;
  UI.press = { p, b, key: cellKey, x: e.clientX, y: e.clientY, id: e.pointerId, moved: false };
}

window.addEventListener('pointermove', e => {
  const pr = UI.press;
  if (!pr || e.pointerId !== pr.id) return;
  if (!pr.moved && Math.hypot(e.clientX - pr.x, e.clientY - pr.y) > 6) {
    pr.moved = true;
    if (pr.key && canAct(pr.p)) startDrag(pr);
  }
  if (UI.drag) updateDrag(e.clientX, e.clientY);
});
window.addEventListener('pointerup', e => {
  const pr = UI.press;
  if (!pr || e.pointerId !== pr.id) return;
  UI.press = null;
  if (UI.drag) { finishDrag(); return; }
  if (!pr.moved) clickBlueprint(pr.p, pr.b, pr.key);
});
window.addEventListener('pointercancel', e => {
  if (UI.press && e.pointerId === UI.press.id) { UI.press = null; cancelDrag(); }
});
window.addEventListener('blur', () => { UI.press = null; cancelDrag(); });

function clickBlueprint(p, b, k) {
  if (!canAct(p)) return;
  const cells = G.blueprints[p][b];
  if (!Object.keys(cells).length) { toast('That blueprint is empty'); return; }
  const handle = k && k in cells ? k : centralKey(cells);
  if (UI.selected && UI.selected.bp === b && UI.selected.handle === handle) UI.selected = null;
  else UI.selected = { bp: b, handle };
  renderAll();
}

function centralKey(cells) {
  const ks = Object.keys(cells);
  let mx = 0, my = 0;
  for (const k of ks) { const [q, r] = unkey(k); mx += hx(q, r); my += hy(q, r); }
  mx /= ks.length; my /= ks.length;
  let best = ks[0], bd = Infinity;
  for (const k of ks) {
    const [q, r] = unkey(k), d = (hx(q, r) - mx) ** 2 + (hy(q, r) - my) ** 2;
    if (d < bd - 1e-9) { bd = d; best = k; }
  }
  return best;
}

function startDrag(pr) {
  const p = pr.p;
  const valid = [0, 1, 2].map(b => {
    const set = new Set(), L = BP[p][b].layout;
    if (L) for (const sk of L.slots) if (R.checkEdit(G, p, pr.b, pr.key, b, sk).ok) set.add(sk);
    return set;
  });
  UI.drag = { p, fromBp: pr.b, fromKey: pr.key, type: G.blueprints[p][pr.b][pr.key], valid, target: null };
  const dpr = window.devicePixelRatio || 1;
  ghostEl.width = Math.round(52 * dpr); ghostEl.height = Math.round(52 * dpr);
  const g = ghostEl.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, 52, 52);
  drawCell(g, 26, 26, 22, p, UI.drag.type, 0.9);
  ghostEl.style.display = 'block';
  renderPanels(); renderStatus();
}

function updateDrag(x, y) {
  const d = UI.drag;
  ghostEl.style.transform = `translate(${x - 26}px, ${y - 26}px)`;
  let t = null;
  for (let b = 0; b < 3; b++) {
    const k = bpHit(d.p, b, x, y);
    if (k && BP[d.p][b].layout.slotSet.has(k)) { t = { b, key: k }; break; }
  }
  const prev = d.target;
  if ((!prev && !t) || (prev && t && prev.b === t.b && prev.key === t.key)) return;
  d.target = t;
  renderPanels(); renderStatus();
}

function cancelDrag(silent) {
  if (!UI.drag) return;
  UI.drag = null;
  ghostEl.style.display = 'none';
  if (!silent) renderAll();
}

function finishDrag() {
  const d = UI.drag;
  cancelDrag(true);
  if (!d || !d.target) { renderAll(); return; }
  const { b, key: k } = d.target;
  const res = R.checkEdit(G, d.p, d.fromBp, d.fromKey, b, k);
  if (res.noop) { renderAll(); return; }
  if (!res.ok) { toast(res.reason); renderAll(); return; }
  commit({ t: 'edit', p: d.p, from: [d.fromBp, d.fromKey], to: [b, k] });
}

/* ---------- buttons & keys ---------- */
undoBtn.addEventListener('click', undo);
$('rulesBtn').addEventListener('click', () => { fillRulesDialog(); rulesDlg.showModal(); });
$('lobbyRules').addEventListener('click', () => { fillRulesDialog(); rulesDlg.showModal(); });
for (const b of document.querySelectorAll('#modeSeg button')) b.addEventListener('click', () => setLobbyOpts({ mode: b.dataset.mode }));
for (const b of document.querySelectorAll('#orderSeg button')) b.addEventListener('click', () => setLobbyOpts({ turnOrder: b.dataset.order }));
$('kpMinus').addEventListener('click', () => setLobbyOpts({ killPoints: lobbyOpts.kp[lobbyOpts.mode] - 1 }));
$('kpPlus').addEventListener('click', () => setLobbyOpts({ killPoints: lobbyOpts.kp[lobbyOpts.mode] + 1 }));
$('kpVal').addEventListener('change', () => setLobbyOpts({ killPoints: Number($('kpVal').value) }));
$('kpVal').addEventListener('blur', renderOptions);
$('menuBtn').addEventListener('click', openMenu);
inviteBtn.addEventListener('click', () => {
  if (!Net.seat && PLAYERS.some(p => !Net.seats[p])) maybeOfferJoin(true);
  else copyText(inviteUrl(), 'Invite link copied');
});
$('inviteCopy').addEventListener('click', () => copyText(inviteUrl(), 'Invite link copied'));
$('joinBtn').addEventListener('click', joinGame);
$('joinName').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); joinGame(); } });
$('watchBtn').addEventListener('click', () => joinDlg.close());
$('createBtn').addEventListener('click', createGame);
$('localBtn').addEventListener('click', startLocal);
$('joinForm').addEventListener('submit', e => {
  e.preventDefault();
  const code = $('codeIn').value.trim().toUpperCase();
  if (!/^[A-Z2-9]{6}$/.test(code)) { toast('Game codes are 6 letters/numbers, like ABC123'); return; }
  history.pushState(null, '', `${location.pathname}?g=${code}`);
  openOnline(code);
});
for (const b of document.querySelectorAll('#seatSeg button')) {
  b.addEventListener('click', () => {
    for (const o of document.querySelectorAll('#seatSeg button')) o.setAttribute('aria-pressed', String(o === b));
  });
}
for (const dlg of [rulesDlg, menuDlg, joinDlg]) {
  dlg.addEventListener('click', e => {
    if (e.target !== dlg) return;
    const r = dlg.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close();
  });
}
$('zin').addEventListener('click', () => { const { w, h } = boardDims(); zoomAt(w / 2, h / 2, 1.25); });
$('zout').addEventListener('click', () => { const { w, h } = boardDims(); zoomAt(w / 2, h / 2, 0.8); });
$('fit').addEventListener('click', fitView);
window.addEventListener('popstate', route);

window.addEventListener('keydown', e => {
  if (rulesDlg.open || menuDlg.open || joinDlg.open || !App.mode) return;
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
  const k = e.key;
  if (k === 'Escape') {
    if (UI.drag) { UI.press = null; cancelDrag(); }
    else if (UI.selected) { UI.selected = null; renderAll(); }
  } else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') {
    e.preventDefault(); undo();
  } else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
    if (k === '1' || k === '2' || k === '3') clickBlueprint(cur(), +k - 1, null);
    else if (k === 'f' || k === 'F') fitView();
    else if (k === '+' || k === '=') { const { w, h } = boardDims(); zoomAt(w / 2, h / 2, 1.25); }
    else if (k === '-' || k === '_') { const { w, h } = boardDims(); zoomAt(w / 2, h / 2, 0.8); }
  }
});

/* ---------- start ---------- */
buildPanels();
ro.observe(boardCv);
route();
