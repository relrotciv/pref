'use strict';

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Preferans game engine (3 players, 32-card deck).
// Variant conventions implemented (documented in README.md):
//   sochi  – responsible whist, flat raspasy (1/trick), remiz x1, half-whist allowed
//   piter  – gentleman's whist, progressive raspasy (1-2-4-...), remiz x2, no half-whist
//   rostov – responsible whist, progressive raspasy (1-2-4-...), remiz x1, half-whist allowed
// ---------------------------------------------------------------------------

const SUITS = ['s', 'c', 'd', 'h'];
const BID_SUITS = ['s', 'c', 'd', 'h', 'nt'];
const GLYPH = { s: '♠', c: '♣', d: '♦', h: '♥', nt: 'БК' };
const RANK_NAME = { 7: '7', 8: '8', 9: '9', 10: '10', 11: 'В', 12: 'Д', 13: 'К', 14: 'Т' };
const DISPLAY_SUIT_ORDER = { s: 0, h: 1, c: 2, d: 3 };

const COST = { 6: 2, 7: 4, 8: 6, 9: 8, 10: 10 };
const WHIST_NEED = { 6: 4, 7: 2, 8: 1, 9: 1, 10: 0 };
const MISERE_RANK = 29; // between 8NT (28) and 9♠ (30)
const MISERE_COST = 10;

const VARIANTS = {
  sochi: {
    title: 'Сочинка', whist: 'responsible', progressiveRaspas: false, remizMult: 1, halfWhist: true,
  },
  piter: {
    title: 'Ленинградка', whist: 'gentleman', progressiveRaspas: true, remizMult: 2, halfWhist: false,
  },
  rostov: {
    title: 'Ростов', whist: 'responsible', progressiveRaspas: true, remizMult: 1, halfWhist: true,
  },
};

// Russian plural: ruPlural(2, 'взятка', 'взятки', 'взяток') -> 'взятки'
function ruPlural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
function tricksWord(n) { return ruPlural(n, 'взятка', 'взятки', 'взяток'); }

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

function makeDeck() {
  const d = [];
  for (const s of SUITS) for (let r = 7; r <= 14; r++) d.push(s + r);
  return d;
}
const suitOf = (c) => c[0];
const rankOf = (c) => parseInt(c.slice(1), 10);
const cardText = (c) => RANK_NAME[rankOf(c)] + GLYPH[suitOf(c)];

// Fisher-Yates with a cryptographically secure RNG (unbiased via crypto.randomInt).
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function sortHand(h) {
  return h.slice().sort((a, b) =>
    DISPLAY_SUIT_ORDER[suitOf(a)] - DISPLAY_SUIT_ORDER[suitOf(b)] || rankOf(b) - rankOf(a));
}

// ---------------------------------------------------------------------------
// Bids
// ---------------------------------------------------------------------------

function bidRank(bid) {
  if (bid.misere) return MISERE_RANK;
  return (bid.level - 6) * 10 + BID_SUITS.indexOf(bid.suit) * 2;
}

function bidText(bid) {
  if (!bid) return '';
  if (bid.raspas) return 'Распасы';
  if (bid.misere) return 'Мизер';
  return bid.level + (bid.suit === 'nt' ? 'БК' : GLYPH[bid.suit]);
}

// ---------------------------------------------------------------------------
// Game lifecycle
// ---------------------------------------------------------------------------

function newGame(id, variant, limit) {
  if (!VARIANTS[variant]) throw err('Неизвестная конвенция');
  limit = Math.floor(Number(limit));
  if (!(limit >= 2 && limit <= 1000)) throw err('Лимит пули — от 2 до 1000');
  return {
    id, variant, limit,
    phase: 'lobby',
    players: [],
    dealNo: 0, dealer: 0,
    hands: [[], [], []], talon: [], discard: [],
    bidding: null, whisting: null, play: null,
    declarer: -1, contract: null, wonBid: null, wonRank: -1,
    raspasStreak: 0,
    score: { pool: [0, 0, 0], gora: [0, 0, 0], whists: [[0, 0, 0], [0, 0, 0], [0, 0, 0]] },
    sheet: emptySheet(),
    lastWords: ['', '', ''],
    summary: null, result: null,
    endVotes: [false, false, false],
    log: [],
  };
}

function err(msg, code) {
  const e = new Error(msg);
  e.expected = true;
  if (code) e.code = code;
  return e;
}

// The "sheet" mirrors the paper pulya drawing: every entry is recorded as a
// running total (2.4.6…), one list per band, exactly as written by hand.
function emptySheet() {
  return {
    pool: [[], [], []],
    gora: [[], [], []],
    whists: [[[], [], []], [[], [], []], [[], [], []]],
  };
}

// Games saved before the sheet existed get one synthesized entry per total.
function ensureSheet(g) {
  if (g.sheet) return;
  g.sheet = emptySheet();
  for (let i = 0; i < 3; i++) {
    if (g.score.pool[i]) g.sheet.pool[i].push(g.score.pool[i]);
    if (g.score.gora[i]) g.sheet.gora[i].push(g.score.gora[i]);
    for (let j = 0; j < 3; j++) {
      if (g.score.whists[i][j]) g.sheet.whists[i][j].push(g.score.whists[i][j]);
    }
  }
}

function addPool(g, seat, n) {
  if (n <= 0) return;
  ensureSheet(g);
  g.score.pool[seat] += n;
  g.sheet.pool[seat].push(g.score.pool[seat]);
}

function addGora(g, seat, n) {
  if (n <= 0) return;
  ensureSheet(g);
  g.score.gora[seat] += n;
  g.sheet.gora[seat].push(g.score.gora[seat]);
}

function addWhists(g, seat, on, n) {
  if (n <= 0) return;
  ensureSheet(g);
  g.score.whists[seat][on] += n;
  g.sheet.whists[seat][on].push(g.score.whists[seat][on]);
}

function pname(g, seat) {
  return (g.players[seat] && g.players[seat].name) || `Игрок ${seat + 1}`;
}

function log(g, msg) {
  g.log.push(msg);
  if (g.log.length > 300) g.log.splice(0, g.log.length - 300);
}

function addPlayer(g, name, playerId) {
  if (g.players.length >= 3) throw err('За этим столом уже трое игроков', 'table_full');
  name = String(name || '').trim().slice(0, 20) || `Игрок ${g.players.length + 1}`;
  const seat = g.players.length;
  g.players.push({ id: playerId, name });
  log(g, `${name} садится за стол (место ${seat + 1})`);
  if (g.players.length === 3) startDeal(g);
  return seat;
}

function startDeal(g) {
  g.dealNo++;
  g.dealer = (g.dealNo - 1) % 3;
  const deck = shuffle(makeDeck());
  g.hands = [deck.slice(0, 10), deck.slice(10, 20), deck.slice(20, 30)];
  g.talon = deck.slice(30);
  // Deal integrity: the three hands plus the talon must be exactly the 32-card deck.
  const all = [...g.hands[0], ...g.hands[1], ...g.hands[2], ...g.talon];
  if (all.length !== 32 || new Set(all).size !== 32) {
    throw new Error('deal integrity violated');
  }
  g.discard = [];
  g.declarer = -1; g.contract = null; g.wonBid = null; g.wonRank = -1;
  g.whisting = null; g.play = null; g.summary = null;
  g.lightChoice = null; g.lightWhist = null; g.claim = null;
  g.lastWords = ['', '', ''];
  g.phase = 'bidding';
  const fh = (g.dealer + 1) % 3;
  g.bidding = {
    turn: fh, highRank: -1, highSeat: -1, highBid: null,
    passed: [false, false, false], hasBid: [false, false, false],
    misereLocked: [false, false, false],
  };
  log(g, `— Сдача ${g.dealNo}: сдаёт ${pname(g, g.dealer)}, первое слово за ${pname(g, fh)}`);
}

// ---------------------------------------------------------------------------
// Bidding
// ---------------------------------------------------------------------------

// Seniority: first hand (after dealer) outranks second, second outranks dealer.
function priority(g, seat) { return (seat - g.dealer + 2) % 3; }

function bidOptions(g, seat) {
  const b = g.bidding;
  const opts = { canPass: true, bids: [], misere: false };
  if (b.misereLocked[seat]) return opts; // declared misère: may only pass or win
  const minRank = b.highSeat < 0 ? 0
    : (priority(g, seat) < priority(g, b.highSeat) ? b.highRank : b.highRank + 1);
  for (let level = 6; level <= 10; level++) {
    for (const suit of BID_SUITS) {
      if (bidRank({ level, suit }) >= minRank) opts.bids.push({ level, suit });
    }
  }
  // Misère may only be a player's first word, and cannot "hold" another misère.
  if (!b.hasBid[seat] && MISERE_RANK >= minRank && b.highRank !== MISERE_RANK) opts.misere = true;
  return opts;
}

function actBid(g, seat, a) {
  const b = g.bidding;
  if (seat !== b.turn) throw err('Сейчас не ваше слово');
  if (a.type === 'pass') {
    b.passed[seat] = true;
    g.lastWords[seat] = 'пас';
    log(g, `${pname(g, seat)}: пас`);
  } else if (a.type === 'bid') {
    const bid = a.bid || {};
    const opts = bidOptions(g, seat);
    const ok = bid.misere ? opts.misere
      : opts.bids.some((x) => x.level === bid.level && x.suit === bid.suit);
    if (!ok) throw err('Такая заявка сейчас недоступна');
    b.highBid = bid.misere ? { misere: true } : { level: bid.level, suit: bid.suit };
    b.highRank = bidRank(b.highBid);
    b.highSeat = seat;
    b.hasBid[seat] = true;
    if (bid.misere) b.misereLocked[seat] = true;
    g.lastWords[seat] = bidText(b.highBid);
    log(g, `${pname(g, seat)}: ${bidText(b.highBid)}`);
  } else {
    throw err('Сейчас идёт торговля');
  }

  const passedN = b.passed.filter(Boolean).length;
  if (passedN === 3) { startRaspas(g); return; }
  if (passedN === 2 && b.highSeat >= 0 && !b.passed[b.highSeat]) { beginDiscard(g); return; }
  do { b.turn = (b.turn + 1) % 3; } while (b.passed[b.turn]);
}

function beginDiscard(g) {
  const b = g.bidding;
  g.declarer = b.highSeat;
  g.wonBid = b.highBid;
  g.wonRank = b.highRank;
  g.hands[g.declarer].push(...g.talon);
  g.phase = 'discard';
  log(g, `${pname(g, g.declarer)} выигрывает торговлю (${bidText(b.highBid)}) и берёт прикуп: ${cardText(g.talon[0])} ${cardText(g.talon[1])}`);
}

function finalContractOptions(g) {
  if (g.wonBid.misere) return [{ misere: true }];
  const out = [];
  for (let level = 6; level <= 10; level++) {
    for (const suit of BID_SUITS) {
      if (bidRank({ level, suit }) >= g.wonRank) out.push({ level, suit });
    }
  }
  return out;
}

function actDiscard(g, seat, a) {
  if (seat !== g.declarer) throw err('Снос делает только играющий');
  const cards = a.cards;
  if (!Array.isArray(cards) || cards.length !== 2 || cards[0] === cards[1]) {
    throw err('Выберите ровно две карты в снос');
  }
  const hand = g.hands[seat];
  for (const c of cards) if (!hand.includes(c)) throw err('У вас нет такой карты');

  let contract;
  if (g.wonBid.misere) {
    contract = { misere: true };
  } else {
    const c = a.contract || {};
    const ok = finalContractOptions(g).some((x) => x.level === c.level && x.suit === c.suit);
    if (!ok) throw err('Игра не может быть ниже выигранной заявки');
    contract = { level: c.level, suit: c.suit };
  }

  g.hands[seat] = hand.filter((c) => !cards.includes(c));
  g.discard = cards.slice();
  g.contract = contract;
  g.lastWords[seat] = bidText(contract);
  log(g, `${pname(g, seat)} сносит две карты и объявляет: ${bidText(contract)}`);

  if (contract.misere) {
    startPlay(g);
  } else {
    g.phase = 'whisting';
    g.whisting = { order: [(seat + 1) % 3, (seat + 2) % 3], idx: 0, decisions: {} };
  }
}

// ---------------------------------------------------------------------------
// Whisting
// ---------------------------------------------------------------------------

function whistOptions(g, seat) {
  const w = g.whisting;
  const v = VARIANTS[g.variant];
  if (w.idx === 0) return ['whist', 'pass'];
  const first = w.decisions[w.order[0]];
  const opts = ['whist', 'pass'];
  if (first === 'pass' && v.halfWhist && g.contract.level <= 7) opts.splice(1, 0, 'half');
  return opts;
}

function actWhist(g, seat, a) {
  const w = g.whisting;
  if (seat !== w.order[w.idx]) throw err('Сейчас не ваше слово');
  const d = a.decision;
  if (!whistOptions(g, seat).includes(d)) throw err('Такое слово сейчас недоступно');
  const ruWord = { whist: 'вист', pass: 'пас', half: 'полвиста' }[d];
  w.decisions[seat] = d;
  g.lastWords[seat] = ruWord;
  log(g, `${pname(g, seat)}: ${ruWord}`);
  w.idx++;
  if (w.idx < 2) return;

  const whisters = w.order.filter((s) => w.decisions[s] === 'whist');
  if (whisters.length === 0) {
    const half = w.order.find((s) => w.decisions[s] === 'half');
    scoreContractNoPlay(g, half === undefined ? null : half);
  } else if (whisters.length === 1) {
    // A lone whister chooses light (both defenders' cards open, whister
    // plays for both) or dark (normal closed play).
    g.phase = 'lightChoice';
    g.lightChoice = {
      whister: whisters[0],
      passer: w.order.find((s) => s !== whisters[0]),
    };
  } else {
    startPlay(g);
  }
}

function actLightChoice(g, seat, a) {
  const lc = g.lightChoice;
  if (seat !== lc.whister) throw err('Светлую или тёмную выбирает вистующий');
  if (a.open !== true && a.open !== false) throw err('Некорректный выбор');
  g.lightWhist = a.open ? { whister: lc.whister, passer: lc.passer } : null;
  g.lastWords[seat] = a.open ? 'вист в светлую' : 'вист в тёмную';
  log(g, `${pname(g, seat)}: вист ${a.open ? 'в светлую' : 'в тёмную'}`);
  g.lightChoice = null;
  startPlay(g);
}

// ---------------------------------------------------------------------------
// Trick play
// ---------------------------------------------------------------------------

function startRaspas(g) {
  g.contract = { raspas: true };
  g.declarer = -1;
  log(g, `Все спасовали — распасы (взятка идёт в гору по ${raspasCost(g)})`);
  startPlay(g);
}

function startPlay(g) {
  const c = g.contract;
  const trump = (c.misere || c.raspas || c.suit === 'nt') ? null : c.suit;
  const fh = (g.dealer + 1) % 3;
  g.phase = 'play';
  g.play = {
    trump, leader: fh, turn: fh, trick: [], lastTrick: null,
    tricks: [0, 0, 0], done: 0, misereOpen: false,
    light: g.lightWhist || null,
  };
  // Misère is always played open: if a defender leads, the declarer's cards
  // are exposed right after the discard; otherwise after the declarer's
  // first card (handled in actPlay).
  if (c.misere && fh !== g.declarer) g.play.misereOpen = true;
  // Misère is caught by one leader: once the cards open, the defenders agree
  // on who plays both hands ("играю") and who trusts ("доверяю").
  if (c.misere) g.play.mctl = { choices: {}, leader: null, passive: null, conflict: null };
}

function actMisereRole(g, seat, a) {
  const p = g.play;
  const m = p && p.mctl;
  if (!g.contract.misere || !m) throw err('Сейчас нет розыгрыша мизера');
  if (!p.misereOpen) throw err('Карты ещё не открыты');
  if (m.leader !== null) throw err('Роли уже распределены');
  if (seat === g.declarer) throw err('Роли выбирают вистующие');
  if (a.role !== 'play' && a.role !== 'trust') throw err('Некорректный выбор');
  m.choices[seat] = a.role;
  m.conflict = null;
  g.lastWords[seat] = a.role === 'play' ? 'играю' : 'доверяю';
  log(g, `${pname(g, seat)}: ${a.role === 'play' ? 'играю' : 'доверяю'}`);
  const d1 = (g.declarer + 1) % 3;
  const d2 = (g.declarer + 2) % 3;
  if (!m.choices[d1] || !m.choices[d2]) return;
  if (m.choices[d1] === m.choices[d2]) {
    m.conflict = m.choices[d1];
    m.choices = {};
    log(g, 'Оба выбрали одно и то же — один должен играть, второй довериться. Выберите заново');
    return;
  }
  m.leader = m.choices[d1] === 'play' ? d1 : d2;
  m.passive = m.leader === d1 ? d2 : d1;
  log(g, `${pname(g, m.leader)} руководит розыгрышем мизера, ${pname(g, m.passive)} доверяет`);
}

// Raspasy: for the first two tricks the talon card, revealed one per trick,
// IS the lead — every player must follow its suit if able, and the trick is
// won by the highest card of the talon suit.
function raspasLeadSuit(g) {
  const p = g.play;
  return (g.contract.raspas && p.done < 2) ? suitOf(g.talon[p.done]) : null;
}

function legalPlays(g, seat) {
  const p = g.play;
  const hand = g.hands[seat];
  const talonLead = raspasLeadSuit(g);
  if (p.trick.length === 0 && !talonLead) return hand.slice();
  const led = talonLead || suitOf(p.trick[0].card);
  const follow = hand.filter((c) => suitOf(c) === led);
  if (follow.length) return follow;
  if (p.trick.length === 0) return hand.slice(); // leader void in the talon suit
  if (p.trump) {
    const trumps = hand.filter((c) => suitOf(c) === p.trump);
    if (trumps.length) return trumps;
  }
  return hand.slice();
}

function trickWinner(trick, trump, leadSuit) {
  // leadSuit overrides the led suit (raspasy talon lead); if nobody followed
  // it, fall back to the suit of the first card actually played.
  const led = (leadSuit && trick.some((t) => suitOf(t.card) === leadSuit))
    ? leadSuit : suitOf(trick[0].card);
  const power = (t) => {
    const s = suitOf(t.card);
    if (trump && s === trump) return 200 + rankOf(t.card);
    if (s === led) return 100 + rankOf(t.card);
    return 0;
  };
  let best = trick[0];
  for (const t of trick) if (power(t) > power(best)) best = t;
  return best.seat;
}

// Fast finish: the declarer claims the remaining tricks ("все мои") or, on
// misère, claims to take none ("нет взяток"). Every defender who plays their
// own cards must agree; one refusal resumes play.
function actClaim(g, seat) {
  if (g.contract.raspas) throw err('На распасах нет быстрого завершения');
  if (seat !== g.declarer) throw err('Быстрое завершение объявляет играющий');
  if (g.claim) throw err('Предложение уже сделано');
  const others = [(seat + 1) % 3, (seat + 2) % 3];
  const deciders = others.filter((s) => !(g.play.light && s === g.play.light.passer));
  g.claim = { by: seat, deciders, agreed: [] };
  g.lastWords[seat] = g.contract.misere ? 'нет взяток!' : 'все мои!';
  log(g, `${pname(g, seat)}: ${g.contract.misere ? 'нет взяток' : 'все мои'} — предлагает завершить розыгрыш`);
}

function actClaimReply(g, seat, a) {
  const c = g.claim;
  if (!c) throw err('Нет активного предложения');
  if (!c.deciders.includes(seat)) throw err('Ваш ответ здесь не требуется');
  if (c.agreed.includes(seat)) throw err('Вы уже согласились');
  if (a.agree === false) {
    g.claim = null;
    g.lastWords[seat] = 'ещё поиграем';
    log(g, `${pname(g, seat)}: нет, ещё поиграем`);
    return;
  }
  if (a.agree !== true) throw err('Некорректный ответ');
  c.agreed.push(seat);
  log(g, `${pname(g, seat)}: согласен`);
  if (c.agreed.length < c.deciders.length) return;
  // Everyone agreed: assign the remaining tricks and score the deal.
  const rest = 10 - g.play.done;
  if (g.contract.misere) {
    g.play.tricks[(g.declarer + 1) % 3] += rest; // defenders' tricks don't score on misère
  } else {
    g.play.tricks[g.declarer] += rest;
  }
  g.play.done = 10;
  g.claim = null;
  log(g, 'Розыгрыш завершён досрочно');
  scoreContract(g);
}

function actPlay(g, actorSeat, a) {
  const p = g.play;
  let seat = actorSeat;
  // In light whist the whister plays the passer's cards too.
  if (p.light && actorSeat === p.light.whister && p.turn === p.light.passer) {
    seat = p.light.passer;
  }
  // On open misère the leading defender plays both defensive hands.
  const m = g.contract.misere ? p.mctl : null;
  if (m && m.leader !== null && actorSeat === m.leader && p.turn === m.passive) {
    seat = m.passive;
  }
  if (m && p.misereOpen && m.leader === null && actorSeat !== g.declarer) {
    throw err('Сначала решите, кто руководит розыгрышем: «играю» или «доверяю»');
  }
  if (m && m.leader !== null && actorSeat === m.passive) {
    throw err('Вы доверили розыгрыш партнёру');
  }
  if (seat !== p.turn) throw err('Сейчас не ваш ход');
  if (p.light && actorSeat === p.light.passer) throw err('В светлую за вас ходит вистующий');
  const card = a.card;
  if (!legalPlays(g, seat).includes(card)) throw err('Этой картой сейчас ходить нельзя');
  g.hands[seat] = g.hands[seat].filter((c) => c !== card);
  p.trick.push({ seat, card });
  if (g.contract.misere && seat === g.declarer) p.misereOpen = true;

  if (p.trick.length < 3) {
    p.turn = (p.turn + 1) % 3;
    return;
  }
  const winner = trickWinner(p.trick, p.trump, raspasLeadSuit(g));
  p.lastTrick = { cards: p.trick.slice(), winner };
  p.tricks[winner]++;
  p.done++;
  p.trick = [];
  p.leader = p.turn = winner;
  if (p.done === 10) {
    if (g.contract.raspas) scoreRaspas(g);
    else scoreContract(g);
  }
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function raspasCost(g) {
  const v = VARIANTS[g.variant];
  return v.progressiveRaspas ? (1 << Math.min(g.raspasStreak, 8)) : 1;
}

function scoreRaspas(g) {
  const cost = raspasCost(g);
  const lines = [`Распасы по ${cost} за взятку:`];
  for (let s = 0; s < 3; s++) {
    const t = g.play.tricks[s];
    const m = t * cost;
    addGora(g, s, m);
    lines.push(`${pname(g, s)}: ${t} ${tricksWord(t)} → +${m} в гору`);
  }
  g.raspasStreak++;
  finishDeal(g, lines);
}

function scoreContractNoPlay(g, halfSeat) {
  const c = g.contract;
  const d = g.declarer;
  const cost = COST[c.level];
  const lines = [];
  addPool(g, d, cost);
  lines.push(`Вистующие спасовали — ${pname(g, d)} записывает ${bidText(c)} без игры: +${cost} в пулю`);
  if (halfSeat !== null) {
    const hw = (WHIST_NEED[c.level] * cost) / 2;
    addWhists(g, halfSeat, d, hw);
    lines.push(`${pname(g, halfSeat)} на полвисте: +${hw} вистов на ${pname(g, d)}`);
  }
  g.raspasStreak = 0;
  finishDeal(g, lines);
}

function scoreContract(g) {
  const v = VARIANTS[g.variant];
  const c = g.contract;
  const d = g.declarer;
  const lines = [];

  if (c.misere) {
    const t = g.play.tricks[d];
    if (t === 0) {
      addPool(g, d, MISERE_COST);
      lines.push(`${pname(g, d)} сыграл мизер: +${MISERE_COST} в пулю`);
    } else {
      const m = t * MISERE_COST * v.remizMult;
      addGora(g, d, m);
      lines.push(`${pname(g, d)} взял ${t} ${tricksWord(t)} на мизере: +${m} в гору`);
    }
    g.raspasStreak = 0;
    finishDeal(g, lines);
    return;
  }

  const L = c.level;
  const cost = COST[L];
  const t = g.play.tricks[d];
  const w = g.whisting;
  const whisters = w.order.filter((s) => w.decisions[s] === 'whist');
  const defTricks = g.play.tricks[w.order[0]] + g.play.tricks[w.order[1]];

  if (t >= L) {
    addPool(g, d, cost);
    lines.push(`${pname(g, d)} сыграл ${bidText(c)} (взяток: ${t}): +${cost} в пулю`);
    if (whisters.length === 1) {
      // A lone whister plays for both defenders: all defensive tricks are theirs.
      const wt = defTricks;
      if (wt > 0) {
        addWhists(g, whisters[0], d, wt * cost);
        lines.push(`${pname(g, whisters[0])} (вист за двоих): ${wt} ${tricksWord(wt)} → +${wt * cost} вистов на ${pname(g, d)}`);
      }
    } else {
      for (const s of whisters) {
        const wt = g.play.tricks[s];
        if (wt > 0) {
          addWhists(g, s, d, wt * cost);
          lines.push(`${pname(g, s)}: ${wt} ${tricksWord(wt)} → +${wt * cost} вистов на ${pname(g, d)}`);
        }
      }
    }
    const need = WHIST_NEED[L];
    if (v.whist === 'responsible' && whisters.length > 0) {
      if (whisters.length === 1) {
        const short = need - defTricks;
        if (short > 0) {
          addGora(g, whisters[0], short * cost);
          lines.push(`Ответственный вист: ${pname(g, whisters[0])} недобрал ${short} → +${short * cost} в гору`);
        }
      } else {
        // Two whisters: the obligation splits evenly (the odd trick, if any,
        // falls on the first whister) and each answers only for his own share.
        const oblig = [Math.ceil(need / 2), Math.floor(need / 2)];
        whisters.forEach((s, i) => {
          const short = oblig[i] - g.play.tricks[s];
          if (short > 0) {
            addGora(g, s, short * cost);
            lines.push(`Ответственный вист: ${pname(g, s)} недобрал ${short} из ${oblig[i]} → +${short * cost} в гору`);
          }
        });
      }
    }
  } else {
    const k = L - t;
    const m = k * cost * v.remizMult;
    addGora(g, d, m);
    lines.push(`${pname(g, d)} остался без ${k} на ${bidText(c)}: +${m} в гору`);
    const consolers = whisters.length === 1 ? [whisters[0]] : whisters;
    for (const s of consolers) {
      const wt = whisters.length === 1 ? defTricks : g.play.tricks[s];
      const pts = wt * cost + k * cost;
      addWhists(g, s, d, pts);
      lines.push(`${pname(g, s)}: ${wt} ${tricksWord(wt)} + консоляция → +${pts} вистов на ${pname(g, d)}`);
    }
  }
  g.raspasStreak = 0;
  finishDeal(g, lines);
}

function finishDeal(g, lines) {
  g.summary = { deal: g.dealNo, lines };
  for (const l of lines) log(g, l);
  g.phase = 'hand_end';
  if (g.score.pool.every((p) => p >= g.limit)) settle(g);
}

// Final settlement: mountain and pool convert to whists at 10 whists per point,
// measured against the table average; player-to-player whists net pairwise.
function settleTotals(g) {
  const S = g.score;
  const sumG = S.gora[0] + S.gora[1] + S.gora[2];
  const sumP = S.pool[0] + S.pool[1] + S.pool[2];
  return [0, 1, 2].map((i) => {
    let w = 0;
    for (let j = 0; j < 3; j++) w += S.whists[i][j] - S.whists[j][i];
    const thirds = 3 * w + 10 * (sumG - 3 * S.gora[i]) + 10 * (3 * S.pool[i] - sumP);
    return Math.round((thirds / 3) * 100) / 100;
  });
}

function settle(g) {
  g.result = { totals: settleTotals(g) };
  g.phase = 'finished';
  log(g, `Игра окончена — итог (в вистах): ${g.players.map((p, i) => `${p.name} ${fmtSigned(g.result.totals[i])}`).join(', ')}`);
}

function fmtSigned(x) { return (x > 0 ? '+' : '') + x; }

// ---------------------------------------------------------------------------
// Actions entry point
// ---------------------------------------------------------------------------

function act(g, seat, a) {
  if (!a || typeof a.type !== 'string') throw err('Некорректное действие');
  if (seat < 0) throw err('Вы не сидите за этим столом');

  if (a.type === 'endVote') {
    if (g.phase === 'lobby' || g.phase === 'finished') throw err('Сейчас нельзя завершить игру');
    g.endVotes[seat] = !g.endVotes[seat];
    if (g.endVotes.every(Boolean)) {
      log(g, 'Все игроки согласились завершить игру досрочно');
      settle(g);
    }
    return;
  }

  switch (g.phase) {
    case 'bidding':
      actBid(g, seat, a); return;
    case 'discard':
      if (a.type !== 'discard') throw err('Ждём сноса играющего');
      actDiscard(g, seat, a); return;
    case 'whisting':
      if (a.type !== 'whistDecision') throw err('Идёт вистование');
      actWhist(g, seat, a); return;
    case 'lightChoice':
      if (a.type !== 'lightChoice') throw err('Ждём решения вистующего');
      actLightChoice(g, seat, a); return;
    case 'play':
      if (a.type === 'claim') { actClaim(g, seat); return; }
      if (a.type === 'claimReply') { actClaimReply(g, seat, a); return; }
      if (a.type === 'misereRole') { actMisereRole(g, seat, a); return; }
      if (a.type !== 'play') throw err('Ждём хода картой');
      if (g.claim) throw err('Сначала ответьте на предложение завершить розыгрыш');
      actPlay(g, seat, a); return;
    case 'hand_end':
      if (a.type !== 'next') throw err('Ждём следующей сдачи');
      startDeal(g); return;
    default:
      throw err('Сейчас нет доступных действий');
  }
}

// ---------------------------------------------------------------------------
// Per-player view
// ---------------------------------------------------------------------------

function view(g, seat, connected) {
  const v = VARIANTS[g.variant];
  const c = g.contract;
  const out = {
    id: g.id,
    variant: g.variant,
    variantTitle: v.title,
    rules: {
      whist: v.whist,
      progressiveRaspas: v.progressiveRaspas,
      remizMult: v.remizMult,
      halfWhist: v.halfWhist,
    },
    limit: g.limit,
    phase: g.phase,
    dealNo: g.dealNo,
    dealer: g.dealer,
    you: seat,
    players: g.players.map((p, i) => ({ name: p.name, connected: !!(connected && connected[i]) })),
    lastWords: g.lastWords,
    declarer: g.declarer,
    contractText: c ? bidText(c) : null,
    contract: c,
    handCounts: g.hands.map((h) => h.length),
    hand: seat >= 0 ? sortHand(g.hands[seat]) : [],
    talon: null,
    raspasNext: raspasCost(g),
    score: g.score,
    sheet: (ensureSheet(g), g.sheet),
    standings: settleTotals(g),
    summary: g.summary,
    result: g.result,
    endVotes: g.endVotes,
    log: g.log.slice(-40),
    bidding: null, whisting: null, play: null, discardInfo: null,
    openHands: {},
  };

  if (g.phase === 'discard') {
    out.talon = g.talon.slice();
    out.discardInfo = seat === g.declarer
      ? { contracts: finalContractOptions(g) }
      : { waiting: true };
  }

  if (g.phase === 'bidding') {
    out.bidding = {
      turn: g.bidding.turn,
      options: seat === g.bidding.turn ? bidOptions(g, seat) : null,
    };
  }

  if (g.phase === 'whisting') {
    const w = g.whisting;
    out.whisting = {
      turn: w.order[w.idx],
      decisions: w.decisions,
      options: seat === w.order[w.idx] ? whistOptions(g, seat) : null,
      need: WHIST_NEED[c.level],
    };
  }

  if (g.phase === 'lightChoice') {
    out.lightChoice = {
      turn: g.lightChoice.whister,
      yours: seat === g.lightChoice.whister,
    };
  }

  // The final trick of a deal is still needed at hand_end so clients can
  // show it for a moment before the summary.
  if (g.phase === 'hand_end' && g.play) out.lastTrick = g.play.lastTrick;

  if (g.phase === 'play') {
    const p = g.play;
    // In light whist the whister acts for the passer's turn as well;
    // on open misère the leading defender acts for the trusting one.
    let controller = p.turn;
    if (p.light && p.turn === p.light.passer) controller = p.light.whister;
    const m = c.misere ? p.mctl : null;
    if (m && m.leader !== null && p.turn === m.passive) controller = m.leader;
    // Until misère roles are settled, the defenders cannot play.
    if (m && m.leader === null && p.misereOpen && p.turn !== g.declarer) controller = -1;
    out.play = {
      turn: p.turn,
      trick: p.trick,
      lastTrick: p.lastTrick,
      tricks: p.tricks,
      trump: p.trump,
      done: p.done,
      legal: seat === controller ? legalPlays(g, p.turn) : null,
      actingFor: (seat === controller && controller !== p.turn) ? p.turn : null,
      light: p.light,
      mctl: m && m.leader !== null ? { leader: m.leader, passive: m.passive } : null,
      whistDecisions: g.whisting ? g.whisting.decisions : null,
      whistNeed: c && c.level ? WHIST_NEED[c.level] : null,
    };
    if (g.claim) {
      out.claim = {
        by: g.claim.by,
        misere: !!c.misere,
        yourReply: g.claim.deciders.includes(seat) && !g.claim.agreed.includes(seat),
      };
      // The claimant's cards open up so the agree/decline decision is informed.
      if (seat !== g.claim.by) {
        out.openHands[g.claim.by] = sortHand(g.hands[g.claim.by]);
      }
    }
    out.canClaim = seat === g.declarer && !g.claim && !c.raspas;
    if (c.raspas) {
      out.talon = g.talon.slice(0, Math.min(p.done + 1, 2));
    }
    if (c.misere && p.misereOpen && seat !== g.declarer) {
      out.openHands[g.declarer] = sortHand(g.hands[g.declarer]);
    }
    if (m && p.misereOpen && m.leader === null) {
      out.misereRoles = {
        yourChoice: seat !== g.declarer && seat >= 0 && !m.choices[seat],
        waiting: seat !== g.declarer && !!m.choices[seat],
        conflict: m.conflict,
      };
    }
    // Once misère roles are settled the position is fully open: everyone —
    // the leader, the trusting defender and the declarer — sees all cards.
    if (m && m.leader !== null) {
      for (let s = 0; s < 3; s++) {
        if (s !== seat) out.openHands[s] = sortHand(g.hands[s]);
      }
    }
    if (p.light) {
      // Light whist: both defenders' cards lie open for everyone.
      for (const s of [p.light.whister, p.light.passer]) {
        if (s !== seat) out.openHands[s] = sortHand(g.hands[s]);
      }
    }
  }

  return out;
}

module.exports = {
  VARIANTS, newGame, addPlayer, act, view, startDeal,
  bidText, cardText, settleTotals,
};
