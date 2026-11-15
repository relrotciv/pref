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

const sheetSnap = new WeakMap();

function stepBot(g) {
  // Find whose turn it is from a neutral view, then act with that seat's view.
  for (let seat = 0; seat < 3; seat++) {
    const v = engine.view(g, seat);

    // The revealed talon is public: identical for every seat, hidden while
    // bidding, complete once the declarer has taken it, and turned one card
    // per trick on raspasy.
    if (seat === 0) {
      const views = [0, 1, 2, -1].map((s) => JSON.stringify(engine.view(g, s).openTalon));
      assert(views.every((x) => x === views[0]), 'open talon identical for all viewers');
      if (['lobby', 'bidding', 'finished'].includes(v.phase)) {
        assert(v.openTalon === null, 'talon hidden outside the deal play');
      } else if (g.contract && g.contract.raspas) {
        const n = v.phase === 'play' ? Math.min(g.play.done + 1, 2) : 2;
        assert(v.openTalon.length === n, 'raspasy talon revealed card by card');
      } else {
        assert(v.openTalon && v.openTalon.length === 2, 'declarer talon stays open');
      }
    }

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
      // Running totals must be strictly increasing (the mountain may also
      // decrease when a fully closed table burns pool points against it).
      for (const arr of [g.sheet.pool[i], g.sheet.whists[i][0], g.sheet.whists[i][1], g.sheet.whists[i][2]]) {
        for (let k = 1; k < arr.length; k++) assert(arr[k] > arr[k - 1], 'sheet entries increase');
      }
      for (const arr of [g.sheet.gora[i]]) {
        for (let k = 1; k < arr.length; k++) assert(arr[k] !== arr[k - 1], 'mountain entries change');
      }
      assert(S.pool[i] <= g.limit, 'pool never exceeds the limit');
    }
    // One written game is one sheet entry: no band list grows by more than
    // one entry per deal (6 then 7 is written 2.6, not 1.2.3.4.5.6).
    const prev = sheetSnap.get(g);
    if (prev) {
      const lists = (sh) => [...sh.pool, ...sh.gora, ...sh.whists.flat()];
      const a = lists(prev); const b = lists(g.sheet);
      b.forEach((l, k) => assert(l.length - a[k].length <= 1, 'one sheet entry per deal'));
    }
    sheetSnap.set(g, JSON.parse(JSON.stringify(g.sheet)));
    // The log replays into exactly the same sheet while it still holds the
    // whole game (that is how version-1 sheets of saved games are repaired).
    if (g.log.filter((l) => l.includes(' садится за стол')).length === 3) {
      const rebuilt = engine.sheetFromLog(g);
      assert(rebuilt && JSON.stringify(rebuilt) === JSON.stringify(g.sheet), 'sheet rebuilds from log');
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
  // "пас — полвиста": the first defender gets a second word.
  assert(g.phase === 'whisting' && engine.view(g, 2).whisting.options !== null,
    'the word returns to the passer after a half-whist');
  engine.act(g, 2, { type: 'whistDecision', decision: 'pass' });
  assert(g.phase === 'hand_end', 'no play after pass + half-whist confirmed');
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
    ['c12', 'c11', 'c10', 'c8', 'c7', 'h11', 'h10', 'h9', 'h7', 's9'],     // seat 0
    ['s14', 's13', 's12', 's11', 's10', 's8', 's7', 'c14', 'c13', 'h12'],  // seat 1 (first hand): void in diamonds
    ['d14', 'd13', 'd12', 'd11', 'd10', 'd9', 'd8', 'h14', 'h13', 'c9'],   // seat 2: diamonds and top hearts
  ];
  // Leader (seat 1) is void in diamonds -> may lead anything.
  assert(engine.view(g, 1).play.legal.length === 10, 'void leader may lead any card');
  engine.act(g, 1, { type: 'play', card: 's7' });
  // Seat 2 must still follow the TALON suit (diamonds), not the leader's spades.
  const legal2 = engine.view(g, 2).play.legal;
  assert(legal2.length === 7 && legal2.every((c) => c[0] === 'd'), 'followers must follow the talon suit');
  engine.act(g, 2, { type: 'play', card: 'd9' });
  engine.act(g, 0, { type: 'play', card: 'c7' });
  // The only diamond wins the trick even though s7 led.
  assert(g.play.tricks[2] === 1 && g.play.lastTrick.winner === 2, 'highest card of the talon suit takes the trick');
  // Trick 2 still starts from the first hand, not from the trick winner.
  assert(g.play.turn === 1, 'second talon trick starts from the first hand');
  engine.act(g, 1, { type: 'play', card: 'h12' });
  const legal2h = engine.view(g, 2).play.legal;
  assert(legal2h.every((c) => c[0] === 'h') && legal2h.length === 2, 'talon suit binds on trick 2');
  engine.act(g, 2, { type: 'play', card: 'h13' });
  engine.act(g, 0, { type: 'play', card: 'h7' });
  assert(g.play.lastTrick.winner === 2, 'highest heart takes trick 2');
  // Trick 3: the lead returns to the first hand although seat 2 won trick 2.
  assert(g.play.turn === 1, 'third trick led by the first hand, not the trick winner');
  engine.act(g, 1, { type: 'play', card: 'c13' });
  const legal2b = engine.view(g, 2).play.legal;
  assert(legal2b.length === 1 && legal2b[0] === 'c9', 'after two tricks the actual lead binds');
  engine.act(g, 2, { type: 'play', card: 'c9' });
  engine.act(g, 0, { type: 'play', card: 'c8' });
  // From the fourth trick on, the winner leads as usual.
  assert(g.play.lastTrick.winner === 1 && g.play.turn === 1, 'winner leads from trick four');
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
  const snos = [v2.hand[0], v2.hand[1]];
  engine.act(g, 2, { type: 'discard', cards: snos, contract: {} });
  assert(g.phase === 'play' && g.contract.misere, 'misère play starts without whisting');
  // Leader is seat 1 (not the declarer) -> cards are open immediately.
  assert(g.play.misereOpen, 'misère cards open right after the discard');
  const shown = engine.view(g, 0).openHands[2];
  assert(shown, 'defender sees the misère hand before any card');
  // The discard is mixed back in: 12 cards shown, snos not identifiable.
  assert(shown.length === 12 && snos.every((c) => shown.includes(c)),
    'misère hand shown together with the discard');
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
  const vDecl = engine.view(g, 2);
  assert(vDecl.openHands[0] && vDecl.openHands[1],
    'declarer sees all cards once roles are settled');
  blocked = false;
  try { engine.act(g, 1, { type: 'play', card: g.hands[1][0] }); } catch (e) { blocked = true; }
  assert(blocked, 'trusting defender cannot play own cards');
  engine.act(g, 0, { type: 'play', card: vLead.play.legal[0] });
  assert(g.play.trick.length === 1 && g.play.trick[0].seat === 1, 'leader played from partner hand');
}

// Targeted scenario: individual whist responsibility — only the whister who
// missed his own share pays; the claimant's cards open during a claim.
{
  const g = engine.newGame('test09', 'sochi', 10);
  engine.addPlayer(g, 'A', 'p1');
  engine.addPlayer(g, 'B', 'p2');
  engine.addPlayer(g, 'C', 'p3');
  // Deal 1: dealer 0, first hand = seat 1 = declarer.
  engine.act(g, 1, { type: 'bid', bid: { level: 6, suit: 's' } });
  engine.act(g, 2, { type: 'pass' });
  engine.act(g, 0, { type: 'pass' });
  const v1 = engine.view(g, 1);
  engine.act(g, 1, { type: 'discard', cards: [v1.hand[0], v1.hand[1]], contract: { level: 6, suit: 's' } });
  engine.act(g, 2, { type: 'whistDecision', decision: 'whist' });
  engine.act(g, 0, { type: 'whistDecision', decision: 'whist' });
  // Fix the position: whister seat 2 will take exactly his two tricks.
  g.hands = [
    ['c12', 'c11', 'c10', 'c9', 'd14', 'd13', 'd12', 'd11', 'd10', 'd9'], // seat 0 (whister B)
    ['c7', 'c8', 's7', 's8', 's9', 's10', 's11', 's12', 'd7', 'd8'],      // seat 1 (declarer)
    ['c14', 'c13', 'h7', 'h8', 'h9', 'h10', 'h11', 'h12', 'h13', 'h14'],  // seat 2 (whister A)
  ];
  engine.act(g, 1, { type: 'play', card: 'c7' });
  engine.act(g, 2, { type: 'play', card: 'c14' });
  engine.act(g, 0, { type: 'play', card: 'c9' });
  engine.act(g, 2, { type: 'play', card: 'c13' });
  engine.act(g, 0, { type: 'play', card: 'c11' });
  engine.act(g, 1, { type: 'play', card: 'c8' });
  assert(g.play.tricks[2] === 2, 'whister A took his two tricks');
  engine.act(g, 2, { type: 'play', card: 'h7' });
  engine.act(g, 0, { type: 'play', card: 'd9' });   // void in hearts, no trumps
  engine.act(g, 1, { type: 'play', card: 's7' });   // must trump
  assert(g.play.tricks[1] === 1, 'declarer trumped the heart');
  // Declarer claims the rest; his cards open to both defenders.
  engine.act(g, 1, { type: 'claim' });
  assert(engine.view(g, 2).openHands[1] && engine.view(g, 0).openHands[1],
    'claimant cards are open to the defenders');
  assert(!engine.view(g, 1).openHands[1], 'claimant does not list his own hand as open');
  engine.act(g, 2, { type: 'claimReply', agree: true });
  engine.act(g, 0, { type: 'claimReply', agree: true });
  assert(g.phase === 'hand_end', 'claim agreed');
  // Six game made with 8 tricks; whister A (2/2) pays nothing,
  // whister B (0/2) alone goes to the mountain for 2×2=4.
  assert(g.score.pool[1] === 2, 'declarer pools the six game');
  assert(g.score.gora[2] === 0, 'whister who took his share pays nothing');
  assert(g.score.gora[0] === 4, 'only the short whister goes to the mountain');
  assert(g.score.whists[2][1] === 4, 'whister A writes whists for his two tricks');
}

// Targeted scenario: responsible whist with two whisters follows the
// Preferans Code — no mountain when together they took the requirement; on
// 8 and 9 the single required trick is the second whister's.
{
  // Score a played contract directly: declarer seat 1, whisters 2 then 0.
  const score = (level, tricks) => {
    const g = engine.newGame('test11', 'rostov', 20);
    engine.addPlayer(g, 'A', 'p1');
    engine.addPlayer(g, 'B', 'p2');
    engine.addPlayer(g, 'C', 'p3');
    g.declarer = 1;
    g.contract = { level, suit: 's' };
    g.whisting = { order: [2, 0], idx: 2, decisions: { 2: 'whist', 0: 'whist' } };
    g.play = { tricks, done: 10, trick: [] };
    engine._scoreContract(g);
    return g.score;
  };
  let S = score(6, [1, 6, 3]);
  assert(S.gora[0] === 0 && S.gora[2] === 0, 'six: 3+1 meets the requirement, no mountain');
  S = score(7, [2, 8, 0]);
  assert(S.gora[0] === 0 && S.gora[2] === 0, 'seven: 0+2 meets the requirement, no mountain');
  S = score(6, [1, 7, 2]);
  assert(S.gora[0] === 2 && S.gora[2] === 0, 'six: 2+1 — only the whister short of 2 pays');
  S = score(6, [1, 8, 1]);
  assert(S.gora[0] === 2 && S.gora[2] === 2, 'six: 1+1 — both whisters pay one trick each');
  S = score(7, [0, 9, 1]);
  assert(S.gora[0] === 4 && S.gora[2] === 0, 'seven: 1+0 — the whister without his trick pays');
  S = score(8, [0, 10, 0]);
  assert(S.gora[0] === 6 && S.gora[2] === 0, 'eight: the second whister answers for the trick');
  S = score(9, [0, 10, 0]);
  assert(S.gora[0] === 8 && S.gora[2] === 0, 'nine: the second whister answers for the trick');
  S = score(8, [0, 9, 1]);
  assert(S.gora[0] === 0 && S.gora[2] === 0, 'eight: first whister took the trick, no mountain');
}

// Targeted scenario: a closed pool writes into the opponents' pools for whists.
{
  const g = engine.newGame('test10', 'sochi', 2);
  engine.addPlayer(g, 'A', 'p1');
  engine.addPlayer(g, 'B', 'p2');
  engine.addPlayer(g, 'C', 'p3');
  const sixNoPlay = (declarer, order) => {
    // declarer bids 6s in bidding order `order`, others pass; both defenders pass the whist
    for (const s of order) {
      engine.act(g, s, s === declarer ? { type: 'bid', bid: { level: 6, suit: 's' } } : { type: 'pass' });
    }
    const v = engine.view(g, declarer);
    engine.act(g, declarer, { type: 'discard', cards: [v.hand[0], v.hand[1]], contract: { level: 6, suit: 's' } });
    engine.act(g, (declarer + 1) % 3, { type: 'whistDecision', decision: 'pass' });
    engine.act(g, (declarer + 2) % 3, { type: 'whistDecision', decision: 'pass' });
  };
  // Deal 1 (fh seat 1): seat 1 records a six game -> pool 2/2, closed.
  sixNoPlay(1, [1, 2, 0]);
  assert(g.score.pool[1] === 2, 'pool closed at the limit');
  engine.act(g, 0, { type: 'next' });
  // Deal 2 (fh seat 2): seat 1 again -> the two points spread over the
  // emptiest opponents' pools, 10 whists each.
  sixNoPlay(1, [2, 0, 1]);
  assert(g.score.pool[1] === 2, 'own pool stays at the limit');
  assert(g.score.pool[2] === 1 && g.score.pool[0] === 1, 'overflow written into the emptiest pools');
  assert(g.score.whists[1][2] === 10 && g.score.whists[1][0] === 10, '10 whists per point written');
  engine.act(g, 0, { type: 'next' });
  // Deal 3 (fh seat 0): seat 1 once more -> both remaining pools close
  // and the game settles.
  sixNoPlay(1, [0, 1, 2]);
  assert(g.score.pool[0] === 2 && g.score.pool[2] === 2, 'all pools closed by the writer');
  assert(g.score.whists[1][0] === 20 && g.score.whists[1][2] === 20, 'whists on both opponents');
  assert(g.phase === 'finished', 'all pools closed -> the game ends');
}

// Targeted scenario: пас — полвиста — вист (the passer re-whists).
{
  const g = engine.newGame('test11', 'sochi', 10);
  engine.addPlayer(g, 'A', 'p1');
  engine.addPlayer(g, 'B', 'p2');
  engine.addPlayer(g, 'C', 'p3');
  engine.act(g, 1, { type: 'bid', bid: { level: 6, suit: 's' } });
  engine.act(g, 2, { type: 'pass' });
  engine.act(g, 0, { type: 'pass' });
  const v1 = engine.view(g, 1);
  engine.act(g, 1, { type: 'discard', cards: [v1.hand[0], v1.hand[1]], contract: { level: 6, suit: 's' } });
  engine.act(g, 2, { type: 'whistDecision', decision: 'pass' });
  engine.act(g, 0, { type: 'whistDecision', decision: 'half' });
  const vw = engine.view(g, 2).whisting;
  assert(vw.reWhist && vw.turn === 2 && vw.options.join() === 'whist,pass',
    'passer may re-whist over the half-whist');
  engine.act(g, 2, { type: 'whistDecision', decision: 'whist' });
  assert(g.phase === 'lightChoice' && g.lightChoice.whister === 2,
    're-whist makes a lone whister; the half-whist is cancelled');
  assert(g.whisting.decisions[0] === 'pass', 'half-whister becomes a passer');
  assert(g.score.whists[0][1] === 0, 'no half-whist points are written');
}

console.log(`All good — ${assertions} assertions passed.`);
