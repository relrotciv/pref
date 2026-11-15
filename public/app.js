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
  if (!r.ok) {
    const e = new Error(data.error || 'Запрос не удался');
    e.code = data.code;
    throw e;
  }
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
  // Peek at the table first: if it is already full, offer to start a new
  // table instead of a doomed name form. Plain JSON with a hard timeout —
  // if anything goes wrong we just show the join form.
  app.innerHTML = '<div class="join"><p class="chip">Открываем стол…</p></div>';
  let decided = false;
  const decide = (st) => {
    if (decided) return;
    decided = true;
    if (st && st.full) renderTableFull(st);
    else renderJoinForm();
  };
  setTimeout(() => decide(null), 5000);
  fetch(`/api/game/${gameId}/info`, { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then(decide)
    .catch(() => decide(null));
}

function renderTableFull(st) {
  app.innerHTML = '';
  app.appendChild(el(`
    <div class="join">
      <h2>Стол занят</h2>
      <p class="chip">${st && st.players && st.players.length
        ? `За этим столом уже играют: ${st.players.map((p) => esc(p.name)).join(', ')}.`
        : 'За этим столом уже сидят три игрока.'}</p>
      <div style="display:flex;flex-direction:column;gap:10px;margin-top:18px">
        <button class="primary" id="btnNewTable">Создать новый стол</button>
        <button class="hbtn" id="btnSpectate" style="padding:10px">Наблюдать за игрой</button>
      </div>
      <p class="chip" style="margin-top:14px">Если это ваш стол — откройте его в браузере,
        где вы садились за него, или по персональной ссылке с ?as=…</p>
    </div>`));
  document.getElementById('btnNewTable').onclick = () => { location.href = '/'; };
  document.getElementById('btnSpectate').onclick = () => { playerId = ''; connect(); };
}

function renderJoinForm() {
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
    const btn = e.target.querySelector('button');
    if (btn.disabled) return; // guard against double submits
    btn.disabled = true;
    btn.textContent = 'Садимся…';
    try {
      const { playerId: pid } = await api(`/api/game/${gameId}/join`, { name: input.value });
      localStorage.setItem('pref:pid:' + gameId, pid);
      localStorage.setItem('pref:name', input.value.trim());
      playerId = pid;
      connect();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Сесть за стол';
      if (err.code === 'table_full') renderTableFull(null);
      else toast(err.message);
    }
  });
}

let lastUpdateAt = 0;
let lastV = 0;
let sessionToken = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let frozen = false;      // showing a just-completed trick for a moment
let pendingReal = null;  // freshest state held back while frozen

function finishApply(st) {
  state = st;
  if (state.phase !== lastPhase) {
    selectedDiscards = new Set();
    selectedContract = null;
    lastPhase = state.phase;
  }
  render();
}

// Did this update complete a trick? Return the finished trick if so.
function completedTrick(prev, st) {
  if (!prev || prev.phase !== 'play' || !prev.play || prev.play.trick.length !== 2) return null;
  let lt = null;
  if (st.phase === 'play' && st.play && st.play.trick.length === 0 && st.play.lastTrick) lt = st.play.lastTrick;
  if (st.phase === 'hand_end' && st.lastTrick) lt = st.lastTrick;
  if (!lt) return null;
  const prevCards = prev.play.trick.map((t) => t.card);
  if (!prevCards.every((c) => lt.cards.some((x) => x.card === c))) return null;
  return lt;
}

// A snapshot of the previous state with the full trick on the table and all
// interaction stripped — shown for a couple of seconds before the table clears.
function makeFrozen(prev, lt) {
  const f = structuredClone(prev);
  // The third card is on the table now — take it out of its player's hand
  // (own hand, open hand, card counter) so it is not shown twice.
  const third = lt.cards.find((x) => !f.play.trick.some((t) => t.card === x.card));
  if (third) {
    f.handCounts[third.seat] = Math.max(0, f.handCounts[third.seat] - 1);
    if (third.seat === f.you) f.hand = f.hand.filter((c) => c !== third.card);
    if (f.openHands && f.openHands[third.seat]) {
      f.openHands[third.seat] = f.openHands[third.seat].filter((c) => c !== third.card);
    }
  }
  f.play.trick = lt.cards;
  f.play.turn = -1;
  f.play.legal = null;
  f.play.actingFor = null;
  f.claim = null;
  f.canClaim = false;
  f.misereRoles = null;
  f._frozenWinner = lt.winner;
  return f;
}

function applyState(st) {
  if (!st) return;
  if (st.v && st.v <= lastV) return; // stale (SSE and long-poll race)
  lastV = st.v || lastV;
  lastUpdateAt = Date.now();
  if (frozen) { pendingReal = st; return; } // will render when the pause ends
  const lt = completedTrick(state, st);
  if (lt) {
    frozen = true;
    pendingReal = st;
    state = makeFrozen(state, lt);
    render();
    setTimeout(() => {
      frozen = false;
      const real = pendingReal;
      pendingReal = null;
      finishApply(real);
    }, 2000);
    return;
  }
  finishApply(st);
}

function connect() {
  app.innerHTML = '<div class="join"><p class="chip">Подключаемся к столу…</p></div>';
  const token = ++sessionToken;
  if (evtSource) evtSource.close();
  evtSource = new EventSource(`/api/game/${gameId}/events?playerId=${playerId}`);
  evtSource.onmessage = (e) => applyState(JSON.parse(e.data));
  evtSource.onerror = () => { /* EventSource auto-reconnects; long-poll covers us */ };
  pollLoop(token);
}

// Long-polling companion channel: the server answers the moment the table
// changes, so updates are instant even where SSE does not deliver.
async function pollLoop(token) {
  while (token === sessionToken) {
    try {
      const r = await fetch(
        `/api/game/${gameId}/state?playerId=${playerId}&v=${lastV}&wait=1`,
        { cache: 'no-store' });
      if (token !== sessionToken) return;
      if (r.ok) applyState(await r.json());
      else await sleep(2000);
    } catch (e) {
      if (token !== sessionToken) return;
      await sleep(2000);
    }
  }
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
  const n = state.handCounts[seat];
  return `
    <div class="seat ${turnSeat === seat ? 'turn' : ''}">
      <div class="nm"><span class="dot ${p && p.connected ? 'on' : ''}"></span>
        ${youName(seat)} ${badges.join(' ')}</div>
      <div class="sub">${word}${tricks}</div>
      ${state.phase !== 'lobby' && !isYou(seat)
        ? `<div class="cardsback">${n} ${ruPlural(n, 'карта', 'карты', 'карт')}</div>` : ''}
    </div>`;
}

// Open hands (misère, light whist): full-size cards on the partner's side of
// the table, one cascaded row per suit.
function openHandBlock(seat) {
  const s = state;
  if (seat == null || !s.openHands || !s.openHands[seat]) return '';
  const acting = s.play && s.play.actingFor === seat && s.play.legal;
  const legalSet = acting ? new Set(s.play.legal) : null;
  const bySuit = {};
  for (const c of s.openHands[seat]) (bySuit[c[0]] = bySuit[c[0]] || []).push(c);
  // Long suits continue on extra rows so cards always lie loosely.
  const chunks = [];
  for (const su of ['s', 'h', 'c', 'd']) {
    const cardsOfSuit = bySuit[su] || [];
    for (let i = 0; i < cardsOfSuit.length; i += 4) chunks.push(cardsOfSuit.slice(i, i + 4));
  }
  const rows = chunks.map((arr) => {
    return `<div class="suit-row">${arr.map((c, i) => {
      const card = acting
        ? cardHTML(c, legalSet.has(c) ? 'playable raise' : 'dim',
          `data-opencard="${c}" ${legalSet.has(c) ? '' : 'disabled'}`)
        : cardHTML(c, '', 'disabled');
      return `<div class="cslot ${i === arr.length - 1 ? 'last' : ''}">${card}</div>`;
    }).join('')}</div>`;
  }).join('');
  return `<div class="open-block rows${Math.min(chunks.length, 6)}">
    <div class="lbl">${esc(name(seat))} — в открытую${acting ? ' · <b>ваш ход</b>' : ''}</div>
    ${rows}
  </div>`;
}

function currentTurn() {
  if (state.bidding) return state.bidding.turn;
  if (state.whisting) return state.whisting.turn;
  if (state.lightChoice) return state.lightChoice.turn;
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
      <h1><a href="/" title="Создать новый стол">Преферанс<span class="pip"> ♠</span></a></h1>
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
      <div class="opponents">${seatPanel(seats.left)}<div class="table-info" id="info"></div>${seatPanel(seats.right)}</div>
      <div class="middle${Object.keys(s.openHands || {}).length >= 2 ? ' two-open' : ''}">
        <div class="side left">${openHandBlock(seats.left)}</div>
        <div class="center" id="center"></div>
        <div class="side right">${openHandBlock(seats.right)}${s.you < 0 ? openHandBlock(seats.me) : ''}</div>
      </div>
      <div class="actions" id="actions"></div>
      <div class="hand-row">
        <div class="hand-side left" id="handSideL"></div>
        <div class="hand" id="hand"></div>
        <div class="hand-side right" id="handSideR"></div>
      </div>
      ${s.you >= 0 ? `<div class="myseat"><span class="nm">${esc(name(s.you))}</span>
        <span class="sub">${esc(s.lastWords[s.you] || '')}${s.play
          ? ` · взятки: <b>${s.play.tricks[s.you]}</b>` : ''}</span></div>` : ''}
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
  renderTalonCorner();
  // Light whist: the whister plays the passer's open cards.
  app.querySelectorAll('[data-opencard]').forEach((b) => {
    b.onclick = () => act({ type: 'play', card: b.dataset.opencard });
  });
  if (s.phase === 'finished') openScore();
}

// Who leads the first trick of this deal (always the first hand).
function firstLeadLine() {
  const s = state;
  const fh = (s.dealer + 1) % 3;
  return `<div class="hint">В розыгрыше первым ходит${fh === s.you
    ? 'е <b>вы</b>' : ` <b>${esc(name(fh))}</b>`}</div>`;
}

function renderCenter() {
  const s = state;
  const c = document.getElementById('center');
  const turn = currentTurn();
  const yourTurn = turn === s.you;
  let html = '';
  // Contract, whose move and the last trick live in the strip between the
  // opponents' panels, so the player's own cards can never cover them.
  let info = '';

  const contractLine = s.contractText
    ? `<div class="contract-line">${s.declarer >= 0 ? `${youName(s.declarer)} ${isYou(s.declarer) ? 'играете' : 'играет'}` : ''} <b>${esc(s.contractText)}</b>${trumpNote()}</div>`
    : '';

  if (s.phase === 'lobby') {
    html += `<div class="status">Ждём игроков — за столом <b>${s.players.length} из 3</b></div>
      <div class="share"><code>${esc(location.href)}</code>
        <button class="hbtn" id="shareBtn">Копировать</button></div>
      <div class="hint">Отправьте эту ссылку двум партнёрам. Регистрация не нужна.</div>`;
  } else if (s.phase === 'bidding') {
    info += `<div class="status${yourTurn ? ' me-turn' : ''}">${yourTurn
      ? '<b>Ваше слово.</b> Заявка или пас.'
      : `Торговля — слово за <b>${youName(turn)}</b>`}</div>`;
    info += firstLeadLine();
  } else if (s.phase === 'discard') {
    info += contractLine;
    info += `<div class="status${isYou(s.declarer) ? ' me-turn' : ''}">${isYou(s.declarer)
      ? '<b>Выберите две карты</b> в снос, объявите игру и подтвердите.'
      : `<b>${youName(s.declarer)}</b> выбирает снос и объявляет игру…`}</div>`;
    info += firstLeadLine();
  } else if (s.phase === 'whisting') {
    info += contractLine;
    let whistStatus;
    if (s.whisting.reWhist) {
      whistStatus = yourTurn
        ? '<b>Партнёр объявил полвиста.</b> Перевистовать (вист) или оставить (пас)?'
        : `<b>${youName(turn)}</b> решает, перевистовать ли после полвиста…`;
    } else {
      whistStatus = yourTurn
        ? `<b>Ваше слово:</b> вист или пас? (вистующим положено взяток: ${s.whisting.need})`
        : `Ждём слова <b>${youName(turn)}</b>`;
    }
    info += `<div class="status${yourTurn ? ' me-turn' : ''}">${whistStatus}</div>`;
    info += firstLeadLine();
  } else if (s.phase === 'lightChoice') {
    info += contractLine;
    info += `<div class="status${s.lightChoice.yours ? ' me-turn' : ''}">${s.lightChoice.yours
      ? '<b>Вы вистуете один.</b> Играть в светлую (карты защитников открываются, вы ходите за обоих) или в тёмную?'
      : `<b>${youName(s.lightChoice.turn)}</b> выбирает: в светлую или в тёмную…`}</div>`;
  } else if (s.phase === 'play') {
    info += contractLine;
    if (s.talon && s.contract && s.contract.raspas && s.play.done < 2) {
      const active = s.play.done < 2 ? Math.min(s.play.done, 1) : -1;
      html += `<div class="talon"><span class="lbl">Ход из прикупа</span>${s.talon.map((t, i) =>
        cardHTML(t, i === active ? 'talon-active' : '', 'disabled')).join('')}</div>`;
    }
    html += renderTrick();
    let playStatus;
    if (s._frozenWinner !== undefined && s._frozenWinner !== null) {
      playStatus = s._frozenWinner === s.you
        ? 'Взятка <b>ваша</b>…'
        : `Взятку забирает <b>${esc(name(s._frozenWinner))}</b>…`;
    } else if (s.misereRoles) {
      const conflictNote = s.misereRoles.conflict
        ? '<b>Оба выбрали одно и то же</b> — один должен играть, второй довериться. '
        : '';
      if (s.misereRoles.yourChoice) {
        playStatus = `${conflictNote}Мизер открыт. Кто руководит розыгрышем — <b>вы решаете</b>: играю или доверяю?`;
      } else if (s.misereRoles.waiting) {
        playStatus = `${conflictNote}Ждём решения партнёра…`;
      } else {
        playStatus = `${conflictNote}Вистующие решают, кто руководит розыгрышем…`;
      }
    } else if (s.claim) {
      const word = s.claim.misere ? '«нет взяток»' : '«все мои»';
      playStatus = s.claim.yourReply
        ? `<b>${youName(s.claim.by)}</b> говорит ${word}. Завершить розыгрыш?`
        : `<b>${youName(s.claim.by)}</b> предлагает завершить розыгрыш (${word}) — ждём ответа…`;
    } else if (s.play.actingFor !== null && s.play.actingFor !== undefined) {
      playStatus = `<b>Ваш ход из открытой руки</b> (${esc(name(s.play.actingFor))}).`;
    } else if (s.play.light && s.play.light.passer === s.you && turn === s.you) {
      playStatus = `Вист в светлую: за вас ходит <b>${esc(name(s.play.light.whister))}</b>…`;
    } else if (s.play.mctl && s.play.mctl.passive === s.you && turn === s.you) {
      playStatus = `За вас ходит <b>${esc(name(s.play.mctl.leader))}</b> — вы доверили розыгрыш…`;
    } else if (yourTurn) {
      playStatus = '<b>Ваш ход.</b>';
    } else {
      playStatus = `Ходит <b>${youName(turn)}</b>…`;
    }
    const myAction = (s._frozenWinner === undefined || s._frozenWinner === null) && (
      (s.misereRoles && s.misereRoles.yourChoice)
      || (s.claim && s.claim.yourReply)
      || (s.play.actingFor !== null && s.play.actingFor !== undefined)
      || (!s.misereRoles && !s.claim && yourTurn && !!s.play.legal));
    const last = s.play.lastTrick
      ? `<div class="last-trick">Прошлая взятка: ${s.play.lastTrick.cards.map((x) => miniCard(x.card)).join(' ')}
        — ${youName(s.play.lastTrick.winner)}</div>`
      : '';
    info += `<div class="info-row"><div class="status${myAction ? ' me-turn' : ''}">${playStatus}</div>${last}</div>`;
  } else if (s.phase === 'hand_end') {
    html += `<div class="summary-panel">
      <div class="t">Сдача ${s.summary.deal}</div>
      ${s.summary.lines.map((l) => `<div>${esc(l)}</div>`).join('')}
    </div>`;
  } else if (s.phase === 'finished') {
    info += `<div class="status"><b>Игра окончена.</b> Итог — в пуле.</div>`;
  }

  c.innerHTML = html;
  document.getElementById('info').innerHTML = info;
  const sb = document.getElementById('shareBtn');
  if (sb) sb.onclick = () => navigator.clipboard.writeText(location.href).then(() => toast('Ссылка скопирована'));
}

function trumpNote() {
  const s = state;
  if (!s.play || !s.contract || s.contract.misere || s.contract.raspas) return '';
  return s.play.trump ? `, козырь ${GLYPH[s.play.trump]}` : ', без козыря';
}

// The trick lies as a triangle: every card faces its player — left opponent
// top-left, right opponent top-right, own card at the bottom.
function renderTrick() {
  const s = state;
  const seats = s.you >= 0
    ? { left: (s.you + 1) % 3, right: (s.you + 2) % 3, me: s.you }
    : { left: 0, right: 1, me: 2 };
  const slot = (seat, pos) => {
    const played = s.play.trick.find((x) => x.seat === seat);
    const who = `<div class="who">${youName(seat)}</div>`;
    const card = played ? cardHTML(played.card, '', 'disabled') : '<div class="empty"></div>';
    return `<div class="slot pos-${pos}">${pos === 'me' ? card + who : who + card}</div>`;
  };
  return `<div class="trick">
    ${slot(seats.left, 'left')}${slot(seats.right, 'right')}${slot(seats.me, 'me')}
  </div>`;
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

  if (s.phase === 'lightChoice' && s.lightChoice.yours) {
    a.appendChild(el(`<div class="action-row">
      <button class="abtn" data-light="1">В светлую</button>
      <button class="abtn" data-light="0">В тёмную</button>
    </div>`));
    a.querySelectorAll('[data-light]').forEach((b) => {
      b.onclick = () => act({ type: 'lightChoice', open: b.dataset.light === '1' });
    });
  }

  if (s.phase === 'play' && s.misereRoles && s.misereRoles.yourChoice) {
    a.appendChild(el(`<div class="action-row">
      <button class="abtn" data-mrole="play">Играю</button>
      <button class="abtn" data-mrole="trust">Доверяю</button>
    </div>`));
    a.querySelectorAll('[data-mrole]').forEach((b) => {
      b.onclick = () => act({ type: 'misereRole', role: b.dataset.mrole });
    });
  }

  // Claim controls live beside the hand, on free space to the right of the cards.
  if (s.phase === 'play') {
    const side = document.getElementById('handSideR');
    if (s.claim && s.claim.yourReply) {
      side.appendChild(el(`<div class="claim-box">
        <button class="abtn" data-agree>Согласен</button>
        <button class="abtn warn" data-decline>Нет, ещё поиграем</button>
      </div>`));
      side.querySelector('[data-agree]').onclick = () => act({ type: 'claimReply', agree: true });
      side.querySelector('[data-decline]').onclick = () => act({ type: 'claimReply', agree: false });
    } else if (s.canClaim) {
      side.appendChild(el(`<div class="claim-box">
        <button class="abtn" data-claim>${s.contract && s.contract.misere ? 'Нет взяток' : 'Все мои'}</button>
      </div>`));
      side.querySelector('[data-claim]').onclick = () => act({ type: 'claim' });
    }
  }

  if (s.phase === 'hand_end' && s.you >= 0) {
    a.appendChild(el(`<div class="action-row"><button class="abtn" data-next>Следующая сдача →</button></div>`));
    a.querySelector('[data-next]').onclick = () => act({ type: 'next' });
  }

  if (s.phase === 'finished') {
    a.appendChild(el(`<div class="action-row">
      <button class="abtn" data-sheet>Открыть пулю</button>
      <button class="abtn" data-newtable>Новый стол</button>
    </div>`));
    a.querySelector('[data-sheet]').onclick = () => openScore();
    a.querySelector('[data-newtable]').onclick = () => { location.href = '/'; };
  }
}

// ---------------------------------------------------------------------------
// Hand
// ---------------------------------------------------------------------------

// Once the talon is turned face up it stays in the bottom-left corner for the
// rest of the deal, so nobody has to remember it.
function renderTalonCorner() {
  const s = state;
  const side = document.getElementById('handSideL');
  if (!side || !s.openTalon || !s.openTalon.length) return;
  side.appendChild(el(`<div class="talon talon-corner"><span class="lbl">Прикуп</span><div class="cards">${
    s.openTalon.map((t) => cardHTML(t, '', 'disabled')).join('')}</div></div>`));
  fitTalonCorner();
}

// Fit the corner talon into the free space between the screen edge and the
// hand: first pack the hand's cards a little tighter, then shrink the talon.
const TALON_EDGE = 14;     // distance from the screen edge (matches the CSS)
const TALON_CLEAR = 14;    // minimum gap to the hand
const TALON_MIN_W = 46;
const HAND_OVERLAPS = [0.45, 0.52, 0.58]; // share of a card hidden under the next
function fitTalonCorner() {
  const corner = document.querySelector('.talon-corner');
  const hand = document.getElementById('hand');
  if (hand) hand.style.removeProperty('--hand-ov');
  if (!corner) return;
  corner.style.removeProperty('--talon-w');
  if (window.innerWidth <= 700) return; // phones: talon has its own line
  const first = hand && hand.querySelector('.card');
  if (!first) return; // spectators: the whole bottom row is free
  const cards = corner.querySelectorAll('.card');
  const n = cards.length;
  const gap = 6;
  const label = corner.querySelector('.lbl').getBoundingClientRect().width;
  const natural = cards[0].getBoundingClientRect().width;
  const avail = () => first.getBoundingClientRect().left - TALON_EDGE - TALON_CLEAR;
  const need = (w) => Math.max(label, n * w + (n - 1) * gap);
  if (need(natural) <= avail()) return;
  for (const ov of HAND_OVERLAPS) {
    hand.style.setProperty('--hand-ov', ov);
    if (need(natural) <= avail()) return;
  }
  const w = Math.max(TALON_MIN_W, Math.min(natural, (avail() - (n - 1) * gap) / n));
  corner.style.setProperty('--talon-w', `${w}px`);
}
window.addEventListener('resize', fitTalonCorner);

function renderHand() {
  const s = state;
  const h = document.getElementById('hand');
  if (s.you < 0 || !s.hand.length) { h.innerHTML = ''; return; }

  const discardMode = s.phase === 'discard' && isYou(s.declarer);
  // When acting for the passer (light whist), legal refers to THEIR hand.
  const legal = (s.play && s.play.legal && s.play.actingFor == null)
    ? new Set(s.play.legal) : null;

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
  const T1 = 0.45; // whists | pool boundary
  const T2 = 0.7;  // pool | mountain boundary (mountain is nearest the centre)

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

    const goraC = avg([lerp(z.P1, O, T2), lerp(z.P2, O, T2), lerp(z.P1, O, 0.93), lerp(z.P2, O, 0.93)]);
    out += textBlock(goraC, angle, joined(s.sheet.gora[z.seat]), 13, 16, 3, 'pen');

    const poolC = avg([lerp(z.P1, O, T1), lerp(z.P2, O, T1), lerp(z.P1, O, T2), lerp(z.P2, O, T2)]);
    out += textBlock(poolC, angle, joined(s.sheet.pool[z.seat]), 13, 30, 3, 'pen');

    for (const h of z.halves) {
      const hc = avg([h.v, M, lerp(M, O, T1), lerp(h.v, O, T1)]);
      out += textBlock(hc, angle, joined(s.sheet.whists[z.seat][h.opp]), 13, 17, 4, 'pen');
      const lp = lerp(mid(h.v, M), O, 0.075);
      out += `<text transform="translate(${lp.x.toFixed(1)} ${lp.y.toFixed(1)}) rotate(${angle})"
        class="plbl" text-anchor="middle" dominant-baseline="middle">${esc(nm(h.opp).slice(0, 10))}</text>`;
    }

    // Faint band labels only where nothing is written yet.
    if (!s.sheet.gora[z.seat].length) out += `<text transform="translate(${goraC.x.toFixed(1)} ${goraC.y.toFixed(1)}) rotate(${angle})" class="bandlbl" text-anchor="middle" dominant-baseline="middle">гора</text>`;
    if (!s.sheet.pool[z.seat].length) out += `<text transform="translate(${poolC.x.toFixed(1)} ${poolC.y.toFixed(1)}) rotate(${angle})" class="bandlbl" text-anchor="middle" dominant-baseline="middle">пуля</text>`;
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
      <div class="meta" style="margin-top:2px">Полосы от центра: гора · пуля · висты
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
          ? 'ответственный — недобор положенных взяток (4 на шестерной, 2 на семерной, 1 на восьмерной и девятерной) пишется в гору. При двух вистующих каждый отвечает за половину нормы. Гора пишется, только если вместе вистующие взяли меньше нормы, и только тому, кто недобрал свою половину. На восьмерной и девятерной за взятку отвечает второй вистующий.'
          : 'джентльменский — недобор вистующих не наказывается.'}</li>
        <li><b>Распасы:</b> ${s.rules.progressiveRaspas
          ? 'прогрессирующие — каждый следующий распас удваивает цену взятки (1, 2, 4, …); сыгранная игра сбрасывает прогрессию.'
          : 'без прогрессии — взятка всегда стоит 1 в гору.'}</li>
        <li><b>Подсад:</b> каждая недобранная взятка стоит цену игры${s.rules.remizMult === 2 ? ' × 2 (вдвое)' : ''} в гору.</li>
        <li><b>Полвиста:</b> ${s.rules.halfWhist
          ? 'разрешён на шестерной и семерной после паса первого вистующего — половина вистов, без розыгрыша.'
          : 'в этой конвенции не используется.'}</li>
        <li><b>Торговля:</b> от 6♠ до 10БК; мизер стоит между 8БК и 9♠ и может быть только первым словом. Старшая рука может держать равную заявку.</li>
        <li><b>Распасы (розыгрыш):</b> карты прикупа открываются по одной; в первых двух взятках ходом считается карта прикупа — все обязаны класть её масть (при отсутствии — любую), взятку берёт старшая карта масти прикупа. Обе талонные взятки и третья разыгрываются от первой руки, и лишь с четвёртой ходит взявший взятку.</li>
        <li><b>Светлая/тёмная:</b> если вистует один, он выбирает: в светлую (карты обоих защитников открываются всем, вистующий ходит и за пасовавшего) или в тёмную. При двух вистующих игра всегда тёмная.</li>
        <li><b>Мизер:</b> всегда в открытую — карты играющего открываются сразу после сноса, если первый ход не его, иначе после его первого хода; показываются все 12 карт вместе со снесёнными, чтобы снос не был виден. Затем вистующие решают, кто руководит ловлей («играю» / «доверяю»): руководящий ходит за обоих, второй наблюдает, и с этого момента все карты открыты всем, включая играющего.</li>
        <li><b>Закрытая пуля:</b> когда своя пуля набрана до ${s.limit}, дальнейшие очки пишутся в пулю соперника с наименьшей пулей — по 10 вистов на него за каждое очко; если закрыты все пули, очко списывает собственную гору.</li>
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
