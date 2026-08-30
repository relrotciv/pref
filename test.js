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

    if (v.phase === 'lightChoice' && v.lightChoice.yours) {
      engine.act(g, seat, { type: 'lightChoice', open: Math.random() < 0.5 });
      return true;
    }

    if (v.phase === 'play' && v.misereRoles && v.misereRoles.yourChoice) {
      engine.act(g, seat, { type: 'misereRole', role: Math.random() < 0.5 ? 'play' : 'trust' });
      return true;
    }

    if (v.phase === 'play' && v.claim && v.claim.yourReply) {
      engine.act(g, seat, { type: 'claimReply', agree: Math.random() < 0.5 });
      return true;
    }

    if (v.phase === 'play' && v.canClaim && Math.random() < 0.03) {
      engine.act(g, seat, { type: 'claim' });
      return true;
    }

    if (v.phase === 'play' && v.play.legal && !g.claim) {
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

// Targeted scenario: light whist — open hands and the whister playing for the passer.
{
  const g = engine.newGame('test04', 'sochi', 10);
  engine.addPlayer(g, 'A', 'p1');
  engine.addPlayer(g, 'B', 'p2');
  engine.addPlayer(g, 'C', 'p3');
  // Seat 1 (first hand) wins 6s, others pass.
  engine.act(g, 1, { type: 'bid', bid: { level: 6, suit: 's' } });
  engine.act(g, 2, { type: 'pass' });
  engine.act(g, 0, { type: 'pass' });
  const v1 = engine.view(g, 1);
  engine.act(g, 1, { type: 'discard', cards: [v1.hand[0], v1.hand[1]], contract: { level: 6, suit: 's' } });
  // Seat 2 whists, seat 0 passes -> lone whister must get the light/dark choice.
  engine.act(g, 2, { type: 'whistDecision', decision: 'whist' });
  engine.act(g, 0, { type: 'whistDecision', decision: 'pass' });
  assert(g.phase === 'lightChoice', 'lone whister chooses light or dark');
  assert(engine.view(g, 2).lightChoice.yours, 'the choice belongs to the whister');
  engine.act(g, 2, { type: 'lightChoice', open: true });
  assert(g.phase === 'play' && g.play.light, 'light whist play started');
  // Both defenders' hands are open to everyone else (declarer included).
  const vd = engine.view(g, 1);
  assert(vd.openHands[2] && vd.openHands[0], 'declarer sees both defenders open');
  // Play until it is the passer's (seat 0) turn, then the whister acts for them.
  for (let i = 0; i < 30 && g.phase === 'play'; i++) {
    if (g.play.turn === 0) {
      const vPasser = engine.view(g, 0);
      assert(vPasser.play.legal === null, 'passer cannot play own cards in light whist');
      const vWhister = engine.view(g, 2);
      assert(vWhister.play.actingFor === 0 && vWhister.play.legal.length > 0,
        'whister acts for the passer');
      engine.act(g, 2, { type: 'play', card: vWhister.play.legal[0] });
    } else {
      const v = engine.view(g, g.play.turn);
      engine.act(g, g.play.turn, { type: 'play', card: v.play.legal[0] });
    }
  }
  assert(g.phase === 'hand_end', 'light whist deal completes');
}

// Targeted scenario: misère opens right after the discard when a defender leads.
{
  const g = engine.newGame('test05', 'sochi', 10);
  engine.addPlayer(g, 'A', 'p1');
  engine.addPlayer(g, 'B', 'p2');
  engine.addPlayer(g, 'C', 'p3');
  // Seat 2 declares misère (first word), others pass. First hand is seat 1.
  engine.act(g, 1, { type: 'pass' });
  engine.act(g, 2, { type: 'bid', bid: { misere: true } });
  engine.act(g, 0, { type: 'pass' });
  assert(g.declarer === 2, 'misère declarer seated');
  const v2 = engine.view(g, 2);
  engine.act(g, 2, { type: 'discard', cards: [v2.hand[0], v2.hand[1]], contract: {} });
  assert(g.phase === 'play' && g.contract.misere, 'misère play starts without whisting');
  // Leader is seat 1 (not the declarer) -> cards are open immediately.
  assert(g.play.misereOpen, 'misère cards open right after the discard');
  assert(engine.view(g, 0).openHands[2], 'defender sees the misère hand before any card');
}

// Targeted scenario: claim ("все мои") — refusal resumes play, agreement scores.
{
  const g = engine.newGame('test06', 'sochi', 10);
  engine.addPlayer(g, 'A', 'p1');
  engine.addPlayer(g, 'B', 'p2');
  engine.addPlayer(g, 'C', 'p3');
  engine.act(g, 1, { type: 'bid', bid: { level: 6, suit: 's' } });
  engine.act(g, 2, { type: 'pass' });
  engine.act(g, 0, { type: 'pass' });
  const v1 = engine.view(g, 1);
  engine.act(g, 1, { type: 'discard', cards: [v1.hand[0], v1.hand[1]], contract: { level: 6, suit: 's' } });
  engine.act(g, 2, { type: 'whistDecision', decision: 'whist' });
  engine.act(g, 0, { type: 'whistDecision', decision: 'whist' });
  assert(g.phase === 'play', 'two whisters -> straight to play');
  // Declarer claims; the first whister declines -> play resumes.
  engine.act(g, 1, { type: 'claim' });
  assert(engine.view(g, 2).claim.yourReply && engine.view(g, 0).claim.yourReply, 'both whisters must reply');
  let blocked = false;
  try { engine.act(g, g.play.turn, { type: 'play', card: g.hands[g.play.turn][0] }); } catch (e) { blocked = true; }
  assert(blocked, 'no cards while a claim is pending');
  engine.act(g, 2, { type: 'claimReply', agree: false });
  assert(g.phase === 'play' && !g.claim, 'refusal resumes play');
  // Claim again; both agree -> declarer takes all 10, whisters get responsible penalty.
  engine.act(g, 1, { type: 'claim' });
  engine.act(g, 2, { type: 'claimReply', agree: true });
  assert(g.phase === 'play', 'waits for the second reply');
  engine.act(g, 0, { type: 'claimReply', agree: true });
  assert(g.phase === 'hand_end', 'claim agreed -> deal scored');
  assert(g.score.pool[1] === 2, 'declarer pools the six game');
  assert(g.score.gora[2] + g.score.gora[0] === 8, 'whisters short 4 tricks -> 8 to the mountain (sochi)');
}

// Targeted scenario: misère claim ("нет взяток").
{
  const g = engine.newGame('test07', 'sochi', 10);
  engine.addPlayer(g, 'A', 'p1');
  engine.addPlayer(g, 'B', 'p2');
  engine.addPlayer(g, 'C', 'p3');
  engine.act(g, 1, { type: 'bid', bid: { misere: true } });
  engine.act(g, 2, { type: 'pass' });
  engine.act(g, 0, { type: 'pass' });
  const v1 = engine.view(g, 1);
  engine.act(g, 1, { type: 'discard', cards: [v1.hand[0], v1.hand[1]], contract: {} });
  assert(g.phase === 'play' && g.contract.misere, 'misère play');
  engine.act(g, 1, { type: 'claim' });
  engine.act(g, 2, { type: 'claimReply', agree: true });
  engine.act(g, 0, { type: 'claimReply', agree: true });
  assert(g.phase === 'hand_end', 'misère claim scored');
  assert(g.score.pool[1] === 10, 'clean misère pools 10');
}

// Targeted scenario: misère leadership — conflict, re-choice, leader plays both hands.
{
  const g = engine.newGame('test08', 'sochi', 10);
  engine.addPlayer(g, 'A', 'p1');
  engine.addPlayer(g, 'B', 'p2');
  engine.addPlayer(g, 'C', 'p3');
  // Seat 2 declares misère; first hand is seat 1 (a defender leads -> open at once).
  engine.act(g, 1, { type: 'pass' });
  engine.act(g, 2, { type: 'bid', bid: { misere: true } });
  engine.act(g, 0, { type: 'pass' });
  const v2 = engine.view(g, 2);
  engine.act(g, 2, { type: 'discard', cards: [v2.hand[0], v2.hand[1]], contract: {} });
  assert(g.play.misereOpen, 'misère open before the first card');
  // Defenders cannot play until the roles are settled.
  assert(engine.view(g, 1).play.legal === null, 'no legal moves before roles are settled');
  let blocked = false;
  try { engine.act(g, 1, { type: 'play', card: g.hands[1][0] }); } catch (e) { blocked = true; }
  assert(blocked, 'leading defender blocked until roles are settled');
  // Both say "играю" -> conflict, choices reset.
  engine.act(g, 1, { type: 'misereRole', role: 'play' });
  engine.act(g, 0, { type: 'misereRole', role: 'play' });
  assert(g.play.mctl.conflict === 'play' && g.play.mctl.leader === null, 'same choice -> conflict');
  assert(engine.view(g, 1).misereRoles.yourChoice, 'defenders choose again after a conflict');
  // Now they split: seat 0 plays, seat 1 trusts.
  engine.act(g, 0, { type: 'misereRole', role: 'play' });
  engine.act(g, 1, { type: 'misereRole', role: 'trust' });
  assert(g.play.mctl.leader === 0 && g.play.mctl.passive === 1, 'leader and passive assigned');
  // It is seat 1's turn; only the leader may act, using seat 1's cards.
  assert(engine.view(g, 1).play.legal === null, 'trusting defender gets no moves');
  const vLead = engine.view(g, 0);
  assert(vLead.play.actingFor === 1 && vLead.play.legal.length > 0, 'leader acts for the partner');
  assert(vLead.openHands[1], 'leader sees the partner cards');
  const vTrust = engine.view(g, 1);
  assert(vTrust.openHands[0] && vTrust.openHands[2], 'trusting defender sees both other hands');
  assert(!engine.view(g, 2).openHands[1] && !engine.view(g, 2).openHands[0],
    'declarer does not see defender cards');
  blocked = false;
  try { engine.act(g, 1, { type: 'play', card: g.hands[1][0] }); } catch (e) { blocked = true; }
  assert(blocked, 'trusting defender cannot play own cards');
  engine.act(g, 0, { type: 'play', card: vLead.play.legal[0] });
  assert(g.play.trick.length === 1 && g.play.trick[0].seat === 1, 'leader played from partner hand');
}

console.log(`All good — ${assertions} assertions passed.`);
