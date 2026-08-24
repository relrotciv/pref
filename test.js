'use strict';

// Random-play stress test for the engine: three bots play full games in all
// three variants, choosing only actions the view says are available.
// Run: node test.js

const engine = require('./engine');

let assertions = 0;
function assert(cond, msg) {
  assertions++;
  if (!cond) throw new Error('ASSERT: ' + msg);
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function stepBot(g) {
  // Find whose turn it is from a neutral view, then act with that seat's view.
  for (let seat = 0; seat < 3; seat++) {
    const v = engine.view(g, seat);

    if (v.phase === 'bidding' && v.bidding.options) {
      const o = v.bidding.options;
      const choices = [];
      // Bias toward passing so games actually end, and raspasy happen.
      choices.push('pass', 'pass', 'pass');
      if (o.bids.length) choices.push('bid');
      if (o.misere) choices.push('misere');
      const c = pick(choices);
      if (c === 'pass') engine.act(g, seat, { type: 'pass' });
      else if (c === 'misere') engine.act(g, seat, { type: 'bid', bid: { misere: true } });
      else engine.act(g, seat, { type: 'bid', bid: pick(o.bids.slice(0, 5)) });
      return true;
    }

    if (v.phase === 'discard' && v.discardInfo && v.discardInfo.contracts) {
      assert(v.hand.length === 12, 'declarer holds 12 before discard');
      const cards = [v.hand[0], v.hand[1]];
      const contract = pick(v.discardInfo.contracts.slice(0, 6));
      engine.act(g, seat, { type: 'discard', cards, contract });
      return true;
    }

    if (v.phase === 'whisting' && v.whisting.options) {
      engine.act(g, seat, { type: 'whistDecision', decision: pick(v.whisting.options) });
      return true;
    }

    if (v.phase === 'play' && v.play.legal) {
      assert(v.play.legal.length > 0, 'always at least one legal card');
      // No card may ever appear twice among the not-yet-played cards. In a
      // contract game the talon lives on in the declarer's hand / discard, so
      // count the discard; in raspasy the talon stays aside, so count it.
      const aside = g.contract.raspas ? g.talon : g.discard;
      const live = [...g.hands[0], ...g.hands[1], ...g.hands[2],
        ...aside, ...g.play.trick.map((t) => t.card)];
      assert(new Set(live).size === live.length, 'no duplicate cards in play');
      assert(live.length === 32 - 3 * g.play.done, 'live card count consistent');
      engine.act(g, seat, { type: 'play', card: pick(v.play.legal) });
      return true;
    }
  }

  if (g.phase === 'hand_end') {
    // Invariants at deal end.
    if (g.play && g.play.done === 10) {
      assert(g.play.tricks[0] + g.play.tricks[1] + g.play.tricks[2] === 10, 'tricks sum to 10');
    }
    const S = g.score;
    const last = (a) => (a.length ? a[a.length - 1] : 0);
    for (let i = 0; i < 3; i++) {
      assert(S.pool[i] >= 0 && S.gora[i] >= 0, 'pool/mountain non-negative');
      assert(Number.isInteger(S.pool[i]) && Number.isInteger(S.gora[i]), 'integer scores');
      for (let j = 0; j < 3; j++) assert(Number.isInteger(S.whists[i][j]), 'integer whists');
      // The written sheet must always agree with the totals.
      assert(last(g.sheet.pool[i]) === S.pool[i], 'sheet pool matches total');
      assert(last(g.sheet.gora[i]) === S.gora[i], 'sheet mountain matches total');
      for (let j = 0; j < 3; j++) {
        assert(last(g.sheet.whists[i][j]) === S.whists[i][j], 'sheet whists match total');
      }
      // Running totals must be strictly increasing.
      for (const arr of [g.sheet.pool[i], g.sheet.gora[i], g.sheet.whists[i][0], g.sheet.whists[i][1], g.sheet.whists[i][2]]) {
        for (let k = 1; k < arr.length; k++) assert(arr[k] > arr[k - 1], 'sheet entries increase');
      }
    }
    engine.act(g, 0, { type: 'next' });
    return true;
  }

  return false;
}

function runGame(variant, limit) {
  const g = engine.newGame('test01', variant, limit);
  engine.addPlayer(g, 'Anna', 'p1');
  engine.addPlayer(g, 'Boris', 'p2');
  engine.addPlayer(g, 'Vera', 'p3');
  assert(g.phase === 'bidding', 'game starts after 3 players');

  let steps = 0;
  while (g.phase !== 'finished') {
    if (!stepBot(g)) throw new Error('stuck in phase ' + g.phase);
    if (++steps > 200000) throw new Error('game did not terminate');
    if (g.dealNo > 2000) { // safety: force settle via votes
      for (let s = 0; s < 3; s++) if (g.phase !== 'finished') engine.act(g, s, { type: 'endVote' });
    }
  }
  const totals = g.result.totals;
  const sum = totals[0] + totals[1] + totals[2];
  assert(Math.abs(sum) < 0.05, `settlement sums to ~0 (got ${sum})`);
  return { deals: g.dealNo, totals };
}

const GAMES_PER_VARIANT = 40;
for (const variant of ['sochi', 'piter', 'rostov']) {
  let deals = 0;
  for (let i = 0; i < GAMES_PER_VARIANT; i++) {
    deals += runGame(variant, 4).deals;
  }
  console.log(`${variant}: ${GAMES_PER_VARIANT} games OK, avg ${(deals / GAMES_PER_VARIANT).toFixed(1)} deals/game`);
}

// Targeted scenario: half-whist bookkeeping in sochi.
{
  const g = engine.newGame('test02', 'sochi', 10);
  engine.addPlayer(g, 'A', 'p1');
  engine.addPlayer(g, 'B', 'p2');
  engine.addPlayer(g, 'C', 'p3');
  // Deal 1: dealer is seat 0, first hand seat 1. Seat 1 bids 6s, others pass.
  engine.act(g, 1, { type: 'bid', bid: { level: 6, suit: 's' } });
  engine.act(g, 2, { type: 'pass' });
  engine.act(g, 0, { type: 'pass' });
  assert(g.phase === 'discard' && g.declarer === 1, 'seat 1 declares');
  const v = engine.view(g, 1);
  engine.act(g, 1, { type: 'discard', cards: [v.hand[0], v.hand[1]], contract: { level: 6, suit: 's' } });
  assert(g.phase === 'whisting', 'whisting after discard');
  engine.act(g, 2, { type: 'whistDecision', decision: 'pass' });
  const opts = engine.view(g, 0).whisting.options;
  assert(opts.includes('half'), 'half-whist offered in sochi after a pass');
  engine.act(g, 0, { type: 'whistDecision', decision: 'half' });
  assert(g.phase === 'hand_end', 'no play after pass + half-whist');
  assert(g.score.pool[1] === 2, 'declarer pools 2 for a six game');
  assert(g.score.whists[0][1] === 4, 'half-whist yields 4 whists vs a six game');
}

// Targeted scenario: raspasy — the talon card leads the first two tricks.
{
  const g = engine.newGame('test03', 'sochi', 10);
  engine.addPlayer(g, 'A', 'p1');
  engine.addPlayer(g, 'B', 'p2');
  engine.addPlayer(g, 'C', 'p3');
  // All pass -> raspasy. Deal 1: dealer seat 0, first hand seat 1.
  engine.act(g, 1, { type: 'pass' });
  engine.act(g, 2, { type: 'pass' });
  engine.act(g, 0, { type: 'pass' });
  assert(g.phase === 'play' && g.contract.raspas, 'raspasy started');
  // Fix the position: talon leads diamonds then hearts; only seat 2 holds diamonds.
  g.talon = ['d7', 'h8'];
  g.hands = [
    ['s14', 's13', 's12', 's11', 's10', 's9', 's8', 's7', 'c14', 'c13'], // seat 0: no diamonds
    ['h14', 'h13', 'h12', 'h11', 'h10', 'h9', 'h7', 'c12', 'c11', 'c10'], // seat 1 (first hand): no diamonds
    ['d14', 'd13', 'd12', 'd11', 'd10', 'd9', 'd8', 'c9', 'c8', 'c7'],    // seat 2: all the diamonds
  ];
  // Leader (seat 1) is void in diamonds -> may lead anything.
  assert(engine.view(g, 1).play.legal.length === 10, 'void leader may lead any card');
  engine.act(g, 1, { type: 'play', card: 'h14' });
  // Seat 2 must still follow the TALON suit (diamonds), not the leader's hearts.
  const legal2 = engine.view(g, 2).play.legal;
  assert(legal2.length === 7 && legal2.every((c) => c[0] === 'd'), 'followers must follow the talon suit');
  engine.act(g, 2, { type: 'play', card: 'd9' });
  engine.act(g, 0, { type: 'play', card: 's7' });
  // The only diamond wins the trick even though h14 outranks it.
  assert(g.play.tricks[2] === 1 && g.play.lastTrick.winner === 2, 'highest card of the talon suit takes the trick');
  // Trick 2: talon leads hearts; winner of trick 1 (seat 2) has none -> any card.
  assert(g.play.turn === 2, 'trick winner leads next');
  engine.act(g, 2, { type: 'play', card: 'c9' });
  const legal0 = engine.view(g, 0).play.legal;
  assert(legal0.length === 9, 'seat 0 void in hearts plays anything');
  engine.act(g, 0, { type: 'play', card: 'c14' });
  const legal1 = engine.view(g, 1).play.legal;
  assert(legal1.every((c) => c[0] === 'h') && legal1.length === 6, 'talon suit still binds on trick 2');
  engine.act(g, 1, { type: 'play', card: 'h7' });
  assert(g.play.lastTrick.winner === 1, 'h7 takes trick 2 as the only card of the talon suit');
  // Trick 3: normal rules — the led card sets the suit again.
  engine.act(g, 1, { type: 'play', card: 'c10' });
  const legal2b = engine.view(g, 2).play.legal;
  assert(legal2b.every((c) => c[0] === 'c'), 'after two tricks the actual lead binds');
}

console.log(`All good — ${assertions} assertions passed.`);
