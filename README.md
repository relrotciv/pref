# Preferans — online three-player game

A self-hosted web version of Preferans: one player creates a table, shares the
link, and two more players open it in a browser. No accounts, no logins, no
external services, no npm dependencies — just Node.js.

## Run

```sh
node server.js          # or: npm start
```

Requires Node.js ≥ 18 (macOS and Linux both fine). The server prints its local
and LAN URLs, default port 8080 (`PORT=3000 node server.js` to change it).

Open the URL, choose a convention (Sochi / Piter / Rostov) and the pool limit,
and press **Deal the cards**. Copy the game link and send it to the other two
players. The game starts automatically when three players are seated.

- A player's seat is remembered in their browser (localStorage), so closing the
  tab or losing the connection is harmless — reopening the link resumes the seat.
- To move a seat to another device, open `.../g/<id>?as=<playerId>` there
  (the playerId is in the first device's localStorage under `pref:pid:<id>`).
- Games are also persisted to `data/*.json`, so restarting the server does not
  lose running games.
- `node test.js` runs the engine self-test (120 full random games across all
  three conventions plus targeted scoring checks).

### Playing over the internet

The server binds a plain HTTP port, so for three players in different places
either forward the port on your router, run it on any Linux VPS
(`node server.js` behind nginx/caddy if you want HTTPS), or use something like
Tailscale — any option works, the app is a single ordinary HTTP service.

The interface is in Russian. Card faces are classic English-pattern playing
cards (SVGs from the MIT-licensed [cardsJS](https://github.com/richardschneider/cardsJS)
project, self-hosted in `public/cards/` — no external requests at runtime).

## Game features

- Full deal cycle: bidding (with positional "hold", misère between 8NT and 9♠),
  talon shown openly, declarer's discard and final contract, whisting
  (whist / pass / half-whist), trick play with mandatory follow-suit and
  mandatory trumping when void.
- Raspasy when all three pass; the two talon cards are turned one per trick and
  each acts as the lead of that trick: every player must follow the talon
  card's suit if able, and the trick goes to the highest card of that suit
  (falling back to the first player's suit only if nobody could follow).
- Misère: no whisting; the declarer's cards are open to the defenders after the
  first card is played.
- **Score sheet at any time** — the *Score* button opens a hand-drawn style
  pulya: the classic triangle where each player owns one side, with the
  mountain band nearest the centre (the limit written in the middle), the pool
  band next, and the whist band along the outer edge split per opponent. Entries
  are running dot-separated totals, exactly as recorded on paper. A compact
  totals table with the projected settlement ("if closed now") sits below it.
- **Pool limit** is set when the table is created; the game ends when every
  player's pool reaches it, or earlier if all three players vote to finish
  (button in the score sheet).
- Final settlement: mountain and pool convert to whists at 10 whists per point
  measured against the table average; player-to-player whists net pairwise.
  Totals always sum to zero.

## Conventions implemented

Preferans house rules vary; these are the presets this app uses. All shared
rules: contract values 6/7/8/9/10 → 2/4/6/8/10, misère 10; defenders' required
tricks 4 vs six, 2 vs seven, 1 vs eight and nine, 0 vs ten; a lone whister
plays for both defenders (all defensive tricks and consolation are theirs);
whisters get consolation (contract value per undertrick) when the declarer
fails; if both defenders pass, the contract is recorded without play.

| | **Sochi** | **Piter** | **Rostov** |
|---|---|---|---|
| Whist | Responsible — defenders' shortfall goes to their mountain | Gentleman's — no shortfall penalty | Responsible |
| Raspasy | Flat: 1 per trick | Progressive: 1-2-4-8… (a played contract resets) | Progressive: 1-2-4-8… |
| Failed contract | value × undertricks to the mountain | **doubled** | value × undertricks |
| Half-whist | Allowed vs six and seven after the first defender passes (half the whists, no play) | Not used | Allowed |

The exact conventions in force are always visible in-game under **Rules**.

Deliberate simplifications: no open ("bright") play election for a lone
whister, no "without talon" declarations, and the discard is never revealed.

## Layout

```
server.js       HTTP + SSE server (zero dependencies)
engine.js       game rules, scoring, per-player views
public/         browser client (vanilla HTML/CSS/JS)
public/cards/   card face SVGs (cardsJS, MIT)
test.js         engine self-test
data/           persisted games (created at runtime)
```
