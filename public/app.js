'use strict';

// ---------------------------------------------------------------------------
// Preferans client. Renders the personalized game view pushed over SSE.
// ---------------------------------------------------------------------------

const GLYPH = { s: '♠', c: '♣', d: '♦', h: '♥', nt: 'БК' };
const RANK_NAME = { 7: '7', 8: '8', 9: '9', 10: '10', 11: 'В', 12: 'Д', 13: 'К', 14: 'Т' };
const CARD_FILE_RANK = { 7: '7', 8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const RED = { d: true, h: true };
const VARIANT_NAME = { sochi: 'Сочинка', piter: 'Ленинградка (Питер)', rostov: 'Ростов' };
const VARIANT_DESC = {
  sochi: 'Ответственный вист · распасы без прогрессии (по 1 за взятку) · есть полвиста',
  piter: 'Джентльменский вист · прогрессирующие распасы (1-2-4…) · подсад пишется вдвое',
  rostov: 'Ответственный вист · прогрессирующие распасы (1-2-4…) · есть полвиста',
};

const app = document.getElementById('app');
const toastEl = document.getElementById('toast');
let toastTimer = null;

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstChild;
}

function ruPlural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

async function api(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Запрос не удался');
  return data;
}

// ---------------------------------------------------------------------------
// Home page — create a table
// ---------------------------------------------------------------------------

function initHome() {
  app.innerHTML = '';
  app.appendChild(el(`
    <div class="home">
      <h1>Преферанс</h1>
      <p class="sub">Три кресла, одна колода, тридцать две карты.</p>
      <form id="createForm">
        <div class="variant-row">
          <label class="head">Конвенция</label>
          ${['sochi', 'piter', 'rostov'].map((v, i) => `
            <label class="variant-opt">
              <input type="radio" name="variant" value="${v}" ${i === 0 ? 'checked' : ''}>
              <div><b>${VARIANT_NAME[v]}</b><br><span>${VARIANT_DESC[v]}</span></div>
            </label>`).join('')}
        </div>
        <div>
          <label class="head" for="limit">Лимит пули</label><br>
          <input type="number" id="limit" value="10" min="2" max="1000" step="1">
          <span class="chip"> — игра идёт, пока каждый не закроет пулю</span>
        </div>
        <button class="primary" type="submit">Сдать карты</button>
      </form>
    </div>`));

  document.getElementById('createForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const variant = document.querySelector('input[name=variant]:checked').value;
    const limit = document.getElementById('limit').value;
    try {
      const { id } = await api('/api/game', { variant, limit });
      location.href = `/g/${id}`;
    } catch (err) { toast(err.message); }
  });
}

// ---------------------------------------------------------------------------
// Game page
// ---------------------------------------------------------------------------

let gameId = null;
let playerId = null;
let state = null;
let lastPhase = null;
let selectedDiscards = new Set();
let selectedContract = null;
let evtSource = null;

function initGame(id) {
  gameId = id;
  // ?as=<playerId> lets a player open their existing seat on another device.
  const asPid = new URLSearchParams(location.search).get('as');
  if (asPid) {
    localStorage.setItem('pref:pid:' + id, asPid);
    history.replaceState(null, '', `/g/${id}`);
  }
  playerId = localStorage.getItem('pref:pid:' + id);
  if (playerId) { connect(); } else { renderJoin(); }
}

function renderJoin() {
  const savedName = localStorage.getItem('pref:name') || '';
  app.innerHTML = '';
  app.appendChild(el(`
    <div class="join">
      <h2>Садитесь за стол</h2>
      <p class="chip">Вас пригласили на пульку.</p>
      <form id="joinForm">
        <input id="nameInput" maxlength="20" placeholder="Ваше имя" value="${esc(savedName)}" required>
        <button class="primary" type="submit" style="width:100%">Сесть за стол</button>
      </form>
    </div>`));
  const input = document.getElementById('nameInput');
  input.focus();
  document.getElementById('joinForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { playerId: pid } = await api(`/api/game/${gameId}/join`, { name: input.value });
      localStorage.setItem('pref:pid:' + gameId, pid);
      localStorage.setItem('pref:name', input.value.trim());
      playerId = pid;
      connect();
    } catch (err) { toast(err.message); }
  });
}

function connect() {
  if (evtSource) evtSource.close();
  evtSource = new EventSource(`/api/game/${gameId}/events?playerId=${playerId}`);
  evtSource.onmessage = (e) => {
    state = JSON.parse(e.data);
    if (state.phase !== lastPhase) {
      selectedDiscards = new Set();
      selectedContract = null;
      lastPhase = state.phase;
    }
    render();
  };
  evtSource.onerror = () => { /* EventSource auto-reconnects */ };
}

function act(action) {
  api(`/api/game/${gameId}/action`, { playerId, action }).catch((e) => toast(e.message));
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function cardName(card) {
  const s = card[0];
  return RANK_NAME[parseInt(card.slice(1), 10)] + GLYPH[s];
}

function cardFile(card) {
  const s = card[0];
  return `/cards/${CARD_FILE_RANK[parseInt(card.slice(1), 10)]}${s.toUpperCase()}.svg`;
}

function cardHTML(card, cls, attrs) {
  return `<button class="card ${cls || ''}" data-card="${card}" ${attrs || ''}>
    <img src="${cardFile(card)}" alt="${cardName(card)}" draggable="false">
  </button>`;
}

function miniCard(card) {
  return `<img class="mini-card" src="${cardFile(card)}" alt="${cardName(card)}" draggable="false">`;
}

function bidLabel(b) {
  if (b.misere) return 'Мизер';
  return b.level + (b.suit === 'nt' ? 'БК' : GLYPH[b.suit]);
}

function name(seat) {
  if (seat < 0 || !state.players[seat]) return `Игрок ${seat + 1}`;
  return state.players[seat].name;
}

function isYou(seat) { return seat === state.you; }
function youName(seat) { return isYou(seat) ? 'Вы' : esc(name(seat)); }

function seatPanel(seat) {
  const p = state.players[seat];
  const badges = [];
  if (seat === state.dealer && state.dealNo > 0) badges.push('<span class="badge">сдаёт</span>');
  if (seat === state.declarer) badges.push('<span class="badge">играет</span>');
  const turnSeat = currentTurn();
  const tricks = state.play ? ` · взятки: <b>${state.play.tricks[seat]}</b>` : '';
  const word = state.lastWords[seat] ? `<span class="word">${esc(state.lastWords[seat])}</span>` : '';
  let openHand = '';
  if (state.openHands && state.openHands[seat]) {
    openHand = `<div class="open-hand">${state.openHands[seat].map(miniCard).join('')}</div>`;
  }
  const n = state.handCounts[seat];
  return `
    <div class="seat ${turnSeat === seat ? 'turn' : ''}">
      <div class="nm"><span class="dot ${p && p.connected ? 'on' : ''}"></span>
        ${youName(seat)} ${badges.join(' ')}</div>
      <div class="sub">${word}${tricks}</div>
      ${state.phase !== 'lobby' && !isYou(seat)
        ? `<div class="cardsback">${n} ${ruPlural(n, 'карта', 'карты', 'карт')}</div>` : ''}
      ${openHand}
    </div>`;
}

function currentTurn() {
  if (state.bidding) return state.bidding.turn;
  if (state.whisting) return state.whisting.turn;
  if (state.play) return state.play.turn;
  if (state.phase === 'discard') return state.declarer;
  return -1;
}

// ---------------------------------------------------------------------------
// Main render
// ---------------------------------------------------------------------------

function render() {
  const s = state;
  document.body.classList.add('in-game');
  const seats = s.you >= 0
    ? { left: (s.you + 1) % 3, right: (s.you + 2) % 3, me: s.you }
    : { left: 0, right: 1, me: 2 };

  app.innerHTML = `
    <header>
      <h1>Преферанс<span class="pip"> ♠</span></h1>
      <div class="chips">
        <span class="chip"><b>${esc(s.variantTitle)}</b></span>
        <span class="chip">пуля до <b>${s.limit}</b></span>
        ${s.dealNo ? `<span class="chip">сдача <b>${s.dealNo}</b></span>` : ''}
        ${s.rules.progressiveRaspas ? `<span class="chip">распасы <b>×${s.raspasNext}</b></span>` : ''}
      </div>
      <span class="spacer"></span>
      <button class="hbtn" id="btnScore">Пуля</button>
      <button class="hbtn" id="btnLog">Журнал</button>
      <button class="hbtn" id="btnRules">Правила</button>
      <button class="hbtn" id="btnCopy">Ссылка</button>
    </header>
    <div class="table-wrap">
      <div class="opponents">${seatPanel(seats.left)}${seatPanel(seats.right)}</div>
      <div class="center" id="center"></div>
      <div class="actions" id="actions"></div>
      <div class="hand" id="hand"></div>
      ${s.you >= 0 ? `<div class="myseat"><span class="nm">${esc(name(s.you))}</span>
        <span class="sub">${esc(s.lastWords[s.you] || '')}</span></div>` : ''}
    </div>
    <dialog id="dlgScore"></dialog>
    <dialog id="dlgRules"></dialog>
    <dialog id="dlgLog"></dialog>`;

  document.getElementById('btnScore').onclick = () => openScore();
  document.getElementById('btnRules').onclick = () => openRules();
  document.getElementById('btnLog').onclick = () => openLog();
  document.getElementById('btnCopy').onclick = () => {
    navigator.clipboard.writeText(location.href)
      .then(() => toast('Ссылка скопирована — отправьте её партнёрам'))
      .catch(() => toast(location.href));
  };

  renderCenter();
  renderActions();
  renderHand();
  if (s.phase === 'finished') openScore();
}

function renderCenter() {
  const s = state;
  const c = document.getElementById('center');
  const turn = currentTurn();
  const yourTurn = turn === s.you;
  let html = '';

  const contractLine = s.contractText
    ? `<div class="contract-line">${s.declarer >= 0 ? `${youName(s.declarer)} ${isYou(s.declarer) ? 'играете' : 'играет'}` : ''} <b>${esc(s.contractText)}</b>${trumpNote()}</div>`
    : '';

  if (s.phase === 'lobby') {
    html += `<div class="status">Ждём игроков — за столом <b>${s.players.length} из 3</b></div>
      <div class="share"><code>${esc(location.href)}</code>
        <button class="hbtn" id="shareBtn">Копировать</button></div>
      <div class="hint">Отправьте эту ссылку двум партнёрам. Регистрация не нужна.</div>`;
  } else if (s.phase === 'bidding') {
    html += `<div class="status">${yourTurn ? '<b>Ваше слово.</b> Заявка или пас.' : `Торговля — слово за <b>${youName(turn)}</b>`}</div>`;
  } else if (s.phase === 'discard') {
    html += contractLine;
    html += `<div class="talon"><span class="lbl">Прикуп</span>${s.talon.map((t) => cardHTML(t, '', 'disabled')).join('')}</div>`;
    html += `<div class="status">${isYou(s.declarer)
      ? '<b>Выберите две карты</b> в снос, объявите игру и подтвердите.'
      : `<b>${youName(s.declarer)}</b> выбирает снос и объявляет игру…`}</div>`;
  } else if (s.phase === 'whisting') {
    html += contractLine;
    html += `<div class="status">${yourTurn
      ? `<b>Ваше слово:</b> вист или пас? (вистующим положено взяток: ${s.whisting.need})`
      : `Ждём слова <b>${youName(turn)}</b>`}</div>`;
  } else if (s.phase === 'play') {
    html += contractLine;
    if (s.talon && s.contract && s.contract.raspas) {
      const active = s.play.done < 2 ? Math.min(s.play.done, 1) : -1;
      html += `<div class="talon"><span class="lbl">Ход из прикупа</span>${s.talon.map((t, i) =>
        cardHTML(t, i === active ? 'talon-active' : '', 'disabled')).join('')}</div>`;
    }
    html += renderTrick();
    html += `<div class="status">${yourTurn ? '<b>Ваш ход.</b>' : `Ходит <b>${youName(turn)}</b>…`}</div>`;
    if (s.play.lastTrick) {
      html += `<div class="last-trick">Прошлая взятка: ${s.play.lastTrick.cards.map((x) => miniCard(x.card)).join(' ')}
        — ${youName(s.play.lastTrick.winner)}</div>`;
    }
  } else if (s.phase === 'hand_end') {
    html += `<div class="summary-panel">
      <div class="t">Сдача ${s.summary.deal}</div>
      ${s.summary.lines.map((l) => `<div>${esc(l)}</div>`).join('')}
    </div>`;
  } else if (s.phase === 'finished') {
    html += `<div class="status"><b>Игра окончена.</b> Итог — в пуле.</div>`;
  }

  c.innerHTML = html;
  const sb = document.getElementById('shareBtn');
  if (sb) sb.onclick = () => navigator.clipboard.writeText(location.href).then(() => toast('Ссылка скопирована'));
}

function trumpNote() {
  const s = state;
  if (!s.play || !s.contract || s.contract.misere || s.contract.raspas) return '';
  return s.play.trump ? `, козырь ${GLYPH[s.play.trump]}` : ', без козыря';
}

function renderTrick() {
  const s = state;
  const slots = [];
  // Show trick slots in play order starting from the leader.
  const order = [];
  const leader = s.play.trick.length ? s.play.trick[0].seat : s.play.turn;
  for (let i = 0; i < 3; i++) order.push((leader + i) % 3);
  for (const seat of order) {
    const played = s.play.trick.find((x) => x.seat === seat);
    slots.push(`<div class="slot">${played ? cardHTML(played.card, '', 'disabled') : '<div class="empty"></div>'}
      <div class="who">${youName(seat)}</div></div>`);
  }
  return `<div class="trick">${slots.join('')}</div>`;
}

// ---------------------------------------------------------------------------
// Actions area
// ---------------------------------------------------------------------------

function renderActions() {
  const s = state;
  const a = document.getElementById('actions');
  a.innerHTML = '';

  if (s.phase === 'bidding' && s.bidding.options) {
    const o = s.bidding.options;
    const avail = new Set(o.bids.map((b) => b.level + b.suit));
    let grid = '<div class="bid-grid">';
    for (let level = 6; level <= 10; level++) {
      for (const suit of ['s', 'c', 'd', 'h', 'nt']) {
        const ok = avail.has(level + suit);
        grid += `<button ${ok ? '' : 'disabled'} class="${RED[suit] ? 'redsuit' : ''}"
          data-bid="${level}:${suit}">${level}${suit === 'nt' ? 'БК' : GLYPH[suit]}</button>`;
      }
    }
    grid += '</div>';
    a.appendChild(el(`<div class="actions-inner" style="display:flex;flex-direction:column;gap:10px;align-items:center">
      ${grid}
      <div class="action-row">
        <button class="abtn" data-misere ${o.misere ? '' : 'disabled'}>Мизер</button>
        <button class="abtn warn" data-pass>Пас</button>
      </div></div>`));
    a.querySelectorAll('[data-bid]').forEach((b) => {
      b.onclick = () => {
        const [level, suit] = b.dataset.bid.split(':');
        act({ type: 'bid', bid: { level: +level, suit } });
      };
    });
    a.querySelector('[data-misere]').onclick = () => act({ type: 'bid', bid: { misere: true } });
    a.querySelector('[data-pass]').onclick = () => act({ type: 'pass' });
  }

  if (s.phase === 'discard' && s.discardInfo && s.discardInfo.contracts && isYou(s.declarer)) {
    const forced = s.discardInfo.contracts.length === 1 && s.discardInfo.contracts[0].misere;
    if (forced) selectedContract = { misere: true };
    let picker = '';
    if (!forced) {
      const avail = new Set(s.discardInfo.contracts.map((b) => b.level + b.suit));
      picker = '<div class="hint">Ваша игра:</div><div class="bid-grid">';
      for (let level = 6; level <= 10; level++) {
        for (const suit of ['s', 'c', 'd', 'h', 'nt']) {
          const key = level + suit;
          const ok = avail.has(key);
          const sel = selectedContract && selectedContract.level === level && selectedContract.suit === suit;
          picker += `<button ${ok ? '' : 'disabled'} data-fc="${level}:${suit}"
            class="${RED[suit] ? 'redsuit' : ''}"
            style="${sel ? 'background:rgba(201,163,90,.35);border-color:#c9a35a' : ''}">
            ${level}${suit === 'nt' ? 'БК' : GLYPH[suit]}</button>`;
        }
      }
      picker += '</div>';
    }
    const ready = selectedDiscards.size === 2 && selectedContract;
    a.appendChild(el(`<div style="display:flex;flex-direction:column;gap:10px;align-items:center">
      ${picker}
      <div class="action-row">
        <button class="abtn" data-confirm ${ready ? '' : 'disabled'}>
          Снос ${selectedDiscards.size}/2 · играть ${selectedContract ? esc(bidLabel(selectedContract)) : '…'}
        </button>
      </div></div>`));
    a.querySelectorAll('[data-fc]').forEach((b) => {
      b.onclick = () => {
        const [level, suit] = b.dataset.fc.split(':');
        selectedContract = { level: +level, suit };
        renderActions();
      };
    });
    a.querySelector('[data-confirm]').onclick = () => {
      act({ type: 'discard', cards: [...selectedDiscards], contract: selectedContract });
    };
  }

  if (s.phase === 'whisting' && s.whisting.options) {
    const labels = { whist: 'Вист', half: 'Полвиста', pass: 'Пас' };
    a.appendChild(el(`<div class="action-row">${s.whisting.options.map((o) =>
      `<button class="abtn ${o === 'pass' ? 'warn' : ''}" data-w="${o}">${labels[o]}</button>`).join('')}</div>`));
    a.querySelectorAll('[data-w]').forEach((b) => {
      b.onclick = () => act({ type: 'whistDecision', decision: b.dataset.w });
    });
  }

  if (s.phase === 'hand_end' && s.you >= 0) {
    a.appendChild(el(`<div class="action-row"><button class="abtn" data-next>Следующая сдача →</button></div>`));
    a.querySelector('[data-next]').onclick = () => act({ type: 'next' });
  }

  if (s.phase === 'finished') {
    a.appendChild(el(`<div class="action-row"><button class="abtn" data-sheet>Открыть пулю</button></div>`));
    a.querySelector('[data-sheet]').onclick = () => openScore();
  }
}

// ---------------------------------------------------------------------------
// Hand
// ---------------------------------------------------------------------------

function renderHand() {
  const s = state;
  const h = document.getElementById('hand');
  if (s.you < 0 || !s.hand.length) { h.innerHTML = ''; return; }

  const discardMode = s.phase === 'discard' && isYou(s.declarer);
  const legal = (s.play && s.play.legal) ? new Set(s.play.legal) : null;

  const someBlocked = legal && legal.size < s.hand.length;
  h.innerHTML = s.hand.map((card) => {
    let cls = '';
    if (discardMode) {
      cls = 'playable' + (selectedDiscards.has(card) ? ' sel' : '');
    } else if (legal) {
      cls = legal.has(card) ? (someBlocked ? 'playable raise' : 'playable') : 'dim';
    }
    return cardHTML(card, cls);
  }).join('');

  h.querySelectorAll('.card').forEach((b) => {
    const card = b.dataset.card;
    b.onclick = () => {
      if (discardMode) {
        if (selectedDiscards.has(card)) selectedDiscards.delete(card);
        else if (selectedDiscards.size < 2) selectedDiscards.add(card);
        renderHand();
        renderActions();
      } else if (legal && legal.has(card)) {
        act({ type: 'play', card });
      }
    };
  });
}

// ---------------------------------------------------------------------------
// Score sheet (classic triangle pulya) & rules dialogs
// ---------------------------------------------------------------------------
// A triangle: each player owns one side. Bands from the centre outward:
// pool, then mountain, then whists (the outer band, split per opponent).
// Every entry is a running total, dot-separated, as written by hand.

function pulyaSVG() {
  const s = state;
  const W = 680;
  const H = 590;
  const A = { x: W / 2, y: 30 };
  const B = { x: 30, y: H - 62 };
  const C = { x: W - 30, y: H - 62 };
  const O = { x: (A.x + B.x + C.x) / 3, y: (A.y + B.y + C.y) / 3 };
  const lerp = (p, q, t) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
  const mid = (p, q) => lerp(p, q, 0.5);
  const avg = (pts) => ({
    x: pts.reduce((a2, p) => a2 + p.x, 0) / pts.length,
    y: pts.reduce((a2, p) => a2 + p.y, 0) / pts.length,
  });
  const T1 = 0.45; // whists | mountain boundary
  const T2 = 0.75; // mountain | pool boundary

  const bottom = s.you >= 0 ? s.you : 0;
  const leftS = (bottom + 1) % 3;
  const rightS = (bottom + 2) % 3;
  const zones = [
    { seat: bottom, P1: B, P2: C, halves: [{ v: B, opp: leftS }, { v: C, opp: rightS }] },
    { seat: leftS, P1: A, P2: B, halves: [{ v: A, opp: rightS }, { v: B, opp: bottom }] },
    { seat: rightS, P1: C, P2: A, halves: [{ v: C, opp: bottom }, { v: A, opp: leftS }] },
  ];

  const nm = (i) => (s.players[i] ? s.players[i].name : `Игрок ${i + 1}`);
  const joined = (arr) => (arr && arr.length ? arr.join('.') : '');

  function sideAngle(P1, P2) {
    let a = Math.atan2(P2.y - P1.y, P2.x - P1.x) * 180 / Math.PI;
    if (a > 90) a -= 180;
    if (a < -90) a += 180;
    return Math.round(a * 10) / 10;
  }

  // Wrap a dot-separated string at entry boundaries; keep the tail if too long.
  function textBlock(pos, angle, str, size, maxChars, maxLines, cls) {
    if (!str) return '';
    const parts = str.split('.');
    const lines = [];
    let cur = '';
    for (const p of parts) {
      const nxt = cur ? cur + '.' + p : p;
      if (nxt.length > maxChars && cur) { lines.push(cur); cur = p; } else cur = nxt;
    }
    if (cur) lines.push(cur);
    let shown = lines;
    if (lines.length > maxLines) {
      shown = lines.slice(-maxLines);
      shown[0] = '…' + shown[0];
    }
    const first = -((shown.length - 1) * 0.55);
    const tspans = shown.map((l, i) =>
      `<tspan x="0" dy="${i === 0 ? first + 'em' : '1.1em'}">${esc(l)}</tspan>`).join('');
    return `<text transform="translate(${pos.x.toFixed(1)} ${pos.y.toFixed(1)}) rotate(${angle})"
      class="${cls}" font-size="${size}" text-anchor="middle" dominant-baseline="middle">${tspans}</text>`;
  }

  let out = '';
  const ink = 'var(--ink)';

  // Frame: outer triangle, spokes to the centre, band separators, whist splits.
  out += `<path d="M${A.x} ${A.y} L${B.x} ${B.y} L${C.x} ${C.y} Z" fill="none" stroke="${ink}" stroke-width="1.6"/>`;
  for (const V of [A, B, C]) out += `<line x1="${V.x}" y1="${V.y}" x2="${O.x}" y2="${O.y}" stroke="${ink}" stroke-width="1"/>`;
  for (const z of zones) {
    for (const t of [T1, T2]) {
      const p = lerp(z.P1, O, t);
      const q = lerp(z.P2, O, t);
      out += `<line x1="${p.x}" y1="${p.y}" x2="${q.x}" y2="${q.y}" stroke="${ink}" stroke-width="1"/>`;
    }
    const M = mid(z.P1, z.P2);
    const Mi = lerp(M, O, T1);
    out += `<line x1="${M.x}" y1="${M.y}" x2="${Mi.x}" y2="${Mi.y}" stroke="${ink}" stroke-width="1"/>`;
  }

  // Numbers and labels per zone.
  for (const z of zones) {
    const angle = sideAngle(z.P1, z.P2);
    const M = mid(z.P1, z.P2);

    const poolC = avg([lerp(z.P1, O, T2), lerp(z.P2, O, T2), lerp(z.P1, O, 0.93), lerp(z.P2, O, 0.93)]);
    out += textBlock(poolC, angle, joined(s.sheet.pool[z.seat]), 13, 14, 2, 'pen');

    const goraC = avg([lerp(z.P1, O, T1), lerp(z.P2, O, T1), lerp(z.P1, O, T2), lerp(z.P2, O, T2)]);
    out += textBlock(goraC, angle, joined(s.sheet.gora[z.seat]), 13, 30, 3, 'pen');

    for (const h of z.halves) {
      const hc = avg([h.v, M, lerp(M, O, T1), lerp(h.v, O, T1)]);
      out += textBlock(hc, angle, joined(s.sheet.whists[z.seat][h.opp]), 13, 17, 4, 'pen');
      const lp = lerp(mid(h.v, M), O, 0.075);
      out += `<text transform="translate(${lp.x.toFixed(1)} ${lp.y.toFixed(1)}) rotate(${angle})"
        class="plbl" text-anchor="middle" dominant-baseline="middle">${esc(nm(h.opp).slice(0, 10))}</text>`;
    }

    // Faint band labels only where nothing is written yet.
    if (!s.sheet.pool[z.seat].length) out += `<text transform="translate(${poolC.x.toFixed(1)} ${poolC.y.toFixed(1)}) rotate(${angle})" class="bandlbl" text-anchor="middle" dominant-baseline="middle">пуля</text>`;
    if (!s.sheet.gora[z.seat].length) out += `<text transform="translate(${goraC.x.toFixed(1)} ${goraC.y.toFixed(1)}) rotate(${angle})" class="bandlbl" text-anchor="middle" dominant-baseline="middle">гора</text>`;
  }

  // Player names along their own side, outside the triangle.
  const nameSpots = [
    { seat: bottom, p: { x: W / 2, y: H - 30 }, a: 0 },
    { seat: leftS, p: lerp(mid(A, B), O, -0.085), a: sideAngle(A, B) },
    { seat: rightS, p: lerp(mid(C, A), O, -0.085), a: sideAngle(C, A) },
  ];
  for (const n of nameSpots) {
    out += `<text transform="translate(${n.p.x.toFixed(1)} ${n.p.y.toFixed(1)}) rotate(${n.a})"
      class="pname ${n.seat === s.you ? 'me' : ''}" text-anchor="middle" dominant-baseline="middle">${esc(nm(n.seat))}</text>`;
  }

  // Centre: the pool limit.
  out += `<circle cx="${O.x}" cy="${O.y}" r="24" fill="var(--paper)" stroke="${ink}" stroke-width="1.4"/>`;
  out += `<text x="${O.x}" y="${O.y}" class="pen big" text-anchor="middle" dominant-baseline="central" font-size="17">${s.limit}</text>`;

  return `<svg class="pulya" viewBox="0 0 ${W} ${H}" role="img" aria-label="Пуля">${out}</svg>`;
}

function openScore() {
  const s = state;
  const d = document.getElementById('dlgScore');
  const nm = (i) => esc(s.players[i] ? s.players[i].name : `Игрок ${i + 1}`);
  const fmt = (x) => (x > 0 ? '+' : '') + x;

  d.innerHTML = `
    <div class="sheet">
      <h3>Пуля ${s.phase === 'finished' ? '— итог' : ''}</h3>
      <div class="meta">${esc(s.variantTitle)} · пуля до ${s.limit} · сдача ${s.dealNo}
        ${s.rules.progressiveRaspas ? ` · распасы ×${s.raspasNext}` : ''}</div>
      ${pulyaSVG()}
      <div class="meta" style="margin-top:2px">Полосы от центра: пуля · гора · висты
        (внешняя полоса, на каждого соперника). Записи — нарастающим итогом.</div>
      <table class="totals">
        <tr><th></th><th>Пуля</th><th>Гора</th><th>${s.phase === 'finished' ? 'Итог (висты)' : 'Если закрыть сейчас'}</th></tr>
        ${[0, 1, 2].map((i) => `<tr><td>${nm(i)}</td><td>${s.score.pool[i]} / ${s.limit}</td>
          <td>${s.score.gora[i]}</td>
          <td class="tot ${s.standings[i] > 0 ? 'pos' : s.standings[i] < 0 ? 'neg' : ''}">${fmt(s.standings[i])}</td></tr>`).join('')}
      </table>
      <div class="foot">
        ${s.you >= 0 && s.phase !== 'finished' && s.phase !== 'lobby' ? `
          <button id="voteEnd" class="${s.endVotes[s.you] ? 'voted' : ''}">
            ${s.endVotes[s.you] ? 'Отозвать голос за завершение' : 'Голосовать за завершение'}
            (${s.endVotes.filter(Boolean).length}/3)</button>` : ''}
        <button id="closeScore">Закрыть</button>
      </div>
    </div>`;
  d.querySelector('#closeScore').onclick = () => d.close();
  const v = d.querySelector('#voteEnd');
  if (v) v.onclick = () => { act({ type: 'endVote' }); d.close(); };
  if (!d.open) d.showModal();
}

function openLog() {
  const s = state;
  const d = document.getElementById('dlgLog');
  d.innerHTML = `
    <div class="sheet">
      <h3>Журнал стола</h3>
      <div class="log-lines">${s.log.map((l) => `<div>${esc(l)}</div>`).join('') || '<div>Пока пусто.</div>'}</div>
      <div class="foot"><button id="closeLog">Закрыть</button></div>
    </div>`;
  d.querySelector('#closeLog').onclick = () => d.close();
  d.showModal();
  const lines = d.querySelector('.log-lines');
  lines.scrollTop = lines.scrollHeight;
}

function openRules() {
  const s = state;
  const d = document.getElementById('dlgRules');
  d.innerHTML = `
    <div class="sheet">
      <h3>Правила стола — ${esc(s.variantTitle)}</h3>
      <ul>
        <li><b>Вист:</b> ${s.rules.whist === 'responsible'
          ? 'ответственный — если вистующие недобирают положенные взятки (4 на шестерной, 2 на семерной, 1 на восьмерной и девятерной), недобор пишется им в гору.'
          : 'джентльменский — недобор вистующих не наказывается.'}</li>
        <li><b>Распасы:</b> ${s.rules.progressiveRaspas
          ? 'прогрессирующие — каждый следующий распас удваивает цену взятки (1, 2, 4, …); сыгранная игра сбрасывает прогрессию.'
          : 'без прогрессии — взятка всегда стоит 1 в гору.'}</li>
        <li><b>Подсад:</b> каждая недобранная взятка стоит цену игры${s.rules.remizMult === 2 ? ' × 2 (вдвое)' : ''} в гору.</li>
        <li><b>Полвиста:</b> ${s.rules.halfWhist
          ? 'разрешён на шестерной и семерной после паса первого вистующего — половина вистов, без розыгрыша.'
          : 'в этой конвенции не используется.'}</li>
        <li><b>Торговля:</b> от 6♠ до 10БК; мизер стоит между 8БК и 9♠ и может быть только первым словом. Старшая рука может держать равную заявку.</li>
        <li><b>Распасы (розыгрыш):</b> карты прикупа открываются по одной; в первых двух взятках ходом считается карта прикупа — все обязаны класть её масть (при отсутствии — любую), взятку берёт старшая карта масти прикупа.</li>
        <li><b>Мизер:</b> карты играющего открываются после первого хода.</li>
        <li><b>Конец игры:</b> когда каждый закрыл пулю до ${s.limit}, либо когда все трое проголосовали за завершение. Пуля и гора переводятся в висты по 10 за очко относительно среднего по столу; висты сводятся попарно.</li>
      </ul>
      <div class="foot"><button id="closeRules">Закрыть</button></div>
    </div>`;
  d.querySelector('#closeRules').onclick = () => d.close();
  d.showModal();
}

// ---------------------------------------------------------------------------

const m = location.pathname.match(/^\/g\/([a-z0-9]+)$/);
if (m) initGame(m[1]); else initHome();
