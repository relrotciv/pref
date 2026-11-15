# Preferans — online three-player game

A self-hosted web version of Preferans: one player creates a table, shares the
link, and two more players open it in a browser. No accounts, no logins, no
external services, no npm dependencies — just Node.js.

The interface is in Russian. Card faces are classic English-pattern playing
cards (Chris Aguilar's LGPL-licensed Vectorized Playing Cards, via the
[cardsJS](https://github.com/richardschneider/cardsJS) project, self-hosted in
`public/cards/` — no external requests at runtime).

## Installation

The server needs only [Node.js](https://nodejs.org) 18 or newer — there is
nothing else to install (`npm install` is not needed).

### 1. Install Node.js

**macOS**

- With [Homebrew](https://brew.sh): `brew install node`
- Or download the **LTS** installer (`.pkg`) from <https://nodejs.org> and run it.

**Windows**

- In PowerShell: `winget install OpenJS.NodeJS.LTS`
- Or download the **LTS** installer (`.msi`) from <https://nodejs.org> and run it.

Open a *new* PowerShell window afterwards so `node` is on the PATH.

**Linux**

Distribution packages are often too old, so check first:

```sh
node -v        # needs v18 or newer
```

If it is missing or older, install the current LTS with
[nvm](https://github.com/nvm-sh/nvm) (no root needed):

```sh
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
# open a new terminal, then:
nvm install --lts
```

### 2. Get the code

With git (macOS and Linux usually have it; on Windows install it with
`winget install Git.Git`):

```sh
git clone https://github.com/relrotciv/pref.git
cd pref
```

Or download the repository as a ZIP from GitHub (**Code → Download ZIP**),
unpack it and open a terminal in the unpacked folder.

### 3. Start the server

macOS / Linux:

```sh
node server.js              # or: npm start
PORT=3000 node server.js    # a different port
```

Windows (PowerShell):

```powershell
node server.js
$env:PORT=3000; node server.js    # a different port
```

The server prints its local and LAN addresses (default port 8080), e.g.
`http://localhost:8080`. Stop it with **Ctrl+C**; running games are saved to
`data/` and resume after a restart. If macOS or Windows asks whether to allow
incoming network connections for `node`, allow it if you want players on your
local network to connect directly (not needed for the Cloudflare tunnel in step 4).

### 4. Playing over the internet (Cloudflare quick tunnel)

The easiest way to let players in other places connect — no router setup, no
domain, no Cloudflare account — is a free Cloudflare quick tunnel. It gives
your local server a temporary public `https://` address.

**1. Install `cloudflared`** (on the same computer as the server):

- macOS: `brew install cloudflared`
- Windows: `winget install --id Cloudflare.cloudflared`, or the
  `cloudflared-windows-amd64.msi` installer from the
  [cloudflared releases page](https://github.com/cloudflare/cloudflared/releases/latest)
- Debian / Ubuntu:
  ```sh
  curl -LO https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
  sudo dpkg -i cloudflared-linux-amd64.deb
  ```
- Fedora / RHEL:
  ```sh
  sudo rpm -i https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-x86_64.rpm
  ```
  (other architectures and distributions: see the
  [downloads page](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/))

**2. Start the game server** as in step 3 (`node server.js`) and leave it running.

**3. In a second terminal, start the tunnel:**

```sh
cloudflared tunnel --url http://localhost:8080
```

(use your port if you changed it). After a few seconds it prints an address
like `https://some-random-words.trycloudflare.com`.

**4. Open that `trycloudflare.com` address yourself** — not `localhost` — and
create the table there. The game link you copy then points to the public
address, and the other two players can open it from anywhere.

Things to know:

- The address is different every time you start `cloudflared`, and seats are
  remembered per address, so keep the tunnel running for the whole game. If it
  does restart, games are not lost: open the new address with the same
  `/g/<id>` path, using `?as=<playerId>` to reclaim seats (see **Playing** below).
- Quick tunnels are meant for testing and come with
  [no uptime guarantee](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/);
  Cloudflare also says they do not officially support Server-Sent Events,
  which the game uses for live updates. It has worked fine in practice, but if
  moves ever stop appearing for other players, a
  [named tunnel](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/create-local-tunnel/)
  on your own domain (free Cloudflare account) is the permanent alternative.
- Other options work too, since the app is one ordinary HTTP service:
  [Tailscale](https://tailscale.com), or any Linux VPS (behind nginx/caddy for
  HTTPS).

## Playing

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
public/cards/   card face SVGs (Vectorized Playing Cards, LGPL-3.0)
test.js         engine self-test
data/           persisted games (created at runtime)
LICENSE         PolyForm Noncommercial 1.0.0
```

## License

Copyright (c) 2026 Victor Erukhimov. All rights reserved.

Licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE): free to
use, modify and share for any noncommercial purpose (personal use, hobby
games, education, charities and similar). Commercial use requires a separate
license from the author.

The card face artwork in `public/cards/` is not covered by this license. It is
Vectorized Playing Cards 1.3, Copyright 2011 Chris Aguilar, licensed under the
GNU LGPL v3 (obtained via cardsJS, Copyright 2015 Richard Schneider, MIT); see
[`public/cards/NOTICE.txt`](public/cards/NOTICE.txt).

## Acknowledgements

The author is grateful to Maxim Nikulin and Alexander Porshnev for their help
in shaping the user interface and for extensive testing.
