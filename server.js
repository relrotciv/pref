'use strict';

// Preferans web server — zero dependencies, Node.js >= 16.
// Run: node server.js   (PORT env var to change the port, default 8080)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const engine = require('./engine');

const PORT = process.env.PORT || 8080;
const PUBLIC = path.join(__dirname, 'public');
const DATA = path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });

const games = new Map();      // id -> game state
const streams = new Map();    // id -> Set of {playerId, res}

function gameFile(id) { return path.join(DATA, id + '.json'); }

function loadGame(id) {
  if (!/^[a-z0-9]{4,12}$/.test(id)) return null;
  if (games.has(id)) return games.get(id);
  try {
    const g = JSON.parse(fs.readFileSync(gameFile(id), 'utf8'));
    games.set(id, g);
    return g;
  } catch (e) {
    return null;
  }
}

function saveGame(g) {
  fs.writeFile(gameFile(g.id), JSON.stringify(g), (e) => {
    if (e) console.error('save failed:', e.message);
  });
}

function seatOf(g, playerId) {
  return g.players.findIndex((p) => p.id === playerId);
}

function connectedSeats(g) {
  const set = streams.get(g.id);
  const conn = [false, false, false];
  if (set) {
    for (const s of set) {
      const seat = seatOf(g, s.playerId);
      if (seat >= 0) conn[seat] = true;
    }
  }
  return conn;
}

function broadcast(g) {
  const set = streams.get(g.id);
  if (!set) return;
  const conn = connectedSeats(g);
  for (const s of set) {
    const v = engine.view(g, seatOf(g, s.playerId), conn);
    try {
      s.res.write(`data: ${JSON.stringify(v)}\n\n`);
    } catch (e) { /* dropped connection; cleaned up on close */ }
  }
}

function randId(len) {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 64 * 1024) { reject(new Error('Body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function serveStatic(res, file, cacheControl) {
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  fs.readFile(full, (e, buf) => {
    if (e) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
      // App files must revalidate so UI updates reach every browser;
      // card images are immutable and may be cached for a day.
      'Cache-Control': cacheControl || 'no-cache',
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    // --- API ---------------------------------------------------------------
    if (req.method === 'POST' && p === '/api/game') {
      const body = await readBody(req);
      const id = randId(6);
      const g = engine.newGame(id, body.variant, body.limit);
      games.set(id, g);
      saveGame(g);
      sendJSON(res, 200, { id });
      return;
    }

    const apiMatch = p.match(/^\/api\/game\/([a-z0-9]+)\/(join|action|events)$/);
    if (apiMatch) {
      const g = loadGame(apiMatch[1]);
      if (!g) { sendJSON(res, 404, { error: 'Игра не найдена' }); return; }
      const cmd = apiMatch[2];

      if (cmd === 'join' && req.method === 'POST') {
        const body = await readBody(req);
        // Reconnect: an existing playerId keeps its seat.
        if (body.playerId) {
          const seat = seatOf(g, body.playerId);
          if (seat >= 0) { sendJSON(res, 200, { playerId: body.playerId, seat }); return; }
        }
        const playerId = crypto.randomBytes(12).toString('hex');
        const seat = engine.addPlayer(g, body.name, playerId);
        saveGame(g);
        broadcast(g);
        sendJSON(res, 200, { playerId, seat });
        return;
      }

      if (cmd === 'action' && req.method === 'POST') {
        const body = await readBody(req);
        const seat = seatOf(g, body.playerId);
        engine.act(g, seat, body.action);
        saveGame(g);
        broadcast(g);
        sendJSON(res, 200, { ok: true });
        return;
      }

      if (cmd === 'events' && req.method === 'GET') {
        const playerId = url.searchParams.get('playerId') || '';
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        });
        let set = streams.get(g.id);
        if (!set) { set = new Set(); streams.set(g.id, set); }
        const client = { playerId, res };
        set.add(client);
        const heartbeat = setInterval(() => {
          try { res.write(': ping\n\n'); } catch (e) { /* ignore */ }
        }, 25000);
        req.on('close', () => {
          clearInterval(heartbeat);
          set.delete(client);
          broadcast(g); // update connection indicators
        });
        broadcast(g); // includes the fresh client
        return;
      }
    }

    // --- Pages & static ----------------------------------------------------
    if (req.method === 'GET') {
      if (p === '/' || /^\/g\/[a-z0-9]+$/.test(p)) { serveStatic(res, 'index.html'); return; }
      if (p === '/app.js' || p === '/style.css') { serveStatic(res, p.slice(1)); return; }
      if (/^\/cards\/(10|[789JQKA])[SHDC]\.svg$/.test(p)) {
        serveStatic(res, p.slice(1), 'public, max-age=86400');
        return;
      }
    }

    res.writeHead(404); res.end('Not found');
  } catch (e) {
    if (e.expected) sendJSON(res, 400, { error: e.message });
    else {
      console.error(e);
      sendJSON(res, 500, { error: 'Ошибка сервера' });
    }
  }
});

server.listen(PORT, () => {
  console.log(`Preferans server running:`);
  console.log(`  local:   http://localhost:${PORT}`);
  const nets = require('os').networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`  network: http://${net.address}:${PORT}`);
      }
    }
  }
});
