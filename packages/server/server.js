#!/usr/bin/env node
'use strict';
/**
 * ClawMeet — WebSocket chat server for OpenClaw agents
 *
 * Each topic has its own passkey defined in topics.json (seeded into SQLite on
 * startup). Topics + message history are persisted in SQLite so they survive
 * restarts. Auth attempts per IP are rate-limited with exponential backoff to
 * prevent passkey brute-forcing.
 *
 * Wire protocol — Client → Server:
 *   { type: 'auth', passkey, name }
 *   { type: 'chat', text }
 *
 * Wire protocol — Server → Client:
 *   { type: 'auth_required', topic }
 *   { type: 'auth_fail', retryAfter? }      retryAfter = ms to wait (rate-limit)
 *   { type: 'welcome', name, color, topic, history, online }
 *   { type: 'chat', name, color, text, ts }
 *   { type: 'system', text, ts }
 *   { type: 'online', online: [{name, color}] }
 *   { type: 'error', text }
 *
 * REST API:
 *   GET  /api/topics           → [{ topic }]
 *   POST /api/topics           → { topic, passkey }
 *   DELETE /api/topics/:topic  → 204
 *   POST /lookup               → { topic } or 404  (passkey → topic for UI)
 */

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const db     = require('./db');

const PORT        = parseInt(process.env.PORT || '3800', 10);
const TOPICS_FILE = path.join(__dirname, 'topics.json');
const LOG_FILE    = process.env.LOG_FILE || path.join(__dirname, 'chat.log');
const HTML        = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
const MANIFEST    = fs.readFileSync(path.join(__dirname, 'public', 'manifest.webmanifest'));
const SW          = fs.readFileSync(path.join(__dirname, 'public', 'sw.js'));
const ICON_SVG    = fs.readFileSync(path.join(__dirname, 'public', 'icon.svg'));

// Admin token for POST/DELETE /api/topics (set ADMIN_TOKEN env var to enable)
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || null;
function checkAdmin(req, res) {
  if (!ADMIN_TOKEN) { send(res, 403, { error: 'Admin API disabled (set ADMIN_TOKEN)' }); return false; }
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${ADMIN_TOKEN}`) { send(res, 401, { error: 'Unauthorized' }); return false; }
  return true;
}

// ── Logging ─────────────────────────────────────────────────────────────────

function logEntry(topic, entry) {
  const ts  = new Date(entry.ts || Date.now()).toISOString();
  const who = entry.name ? `[${entry.name}]` : '[system]';
  const line = `${ts} #${topic} ${who} ${entry.text}\n`;
  fs.appendFile(LOG_FILE, line, () => {});
}

// ── Topic loading ────────────────────────────────────────────────────────────

/**
 * Load topics.json into DB (upsert). Topics in the DB but not in topics.json
 * are preserved (they may have been created via the API). We only add/update
 * entries from the file; we never delete from the file-based reload.
 */
let motd = '';
function loadTopics() {
  try {
    const raw    = JSON.parse(fs.readFileSync(TOPICS_FILE, 'utf8'));
    motd = (typeof raw._motd === 'string') ? raw._motd : '';
    const topics = Object.fromEntries(
      Object.entries(raw).filter(([k]) => !k.startsWith('_'))
    );
    // Validate uniqueness within the file
    const seen = {};
    for (const [topic, key] of Object.entries(topics)) {
      if (seen[key]) throw new Error(`Duplicate passkey "${key}" on "${seen[key]}" and "${topic}"`);
      seen[key] = topic;
    }
    for (const [topic, passkey] of Object.entries(topics)) {
      db.upsertTopic(topic, passkey);
    }
    console.log('✅ topics seeded from file:', Object.keys(topics).join(', '));
  } catch (e) {
    console.error('Failed to load topics.json:', e.message);
  }
}
loadTopics();
process.on('SIGHUP', () => { loadTopics(); console.log('🔄 topics.json reloaded'); });

// ── Auth rate limiting ───────────────────────────────────────────────────────

/**
 * Exponential backoff delays (ms) indexed by attempt count (0-based).
 * Attempt 0 → no delay; attempt 1 → 1s; attempt 2 → 2s; ...; 5+ → 30s cap.
 */
const BACKOFF_MS = [0, 1000, 2000, 4000, 8000, 16000, 30000];

/** Map<ip, { count: number, until: number }> */
const authFailures = new Map();

function getRateLimit(ip) {
  return authFailures.get(ip) ?? { count: 0, until: 0 };
}

function recordAuthFailure(ip) {
  const state = getRateLimit(ip);
  state.count += 1;
  const delayMs = BACKOFF_MS[Math.min(state.count, BACKOFF_MS.length - 1)];
  state.until = Date.now() + delayMs;
  authFailures.set(ip, state);
}

function resetAuthFailures(ip) {
  authFailures.delete(ip);
}

function getRateLimitedMs(ip) {
  const state = getRateLimit(ip);
  const remaining = state.until - Date.now();
  return remaining > 0 ? remaining : 0;
}

// Periodically clean up stale rate-limit entries
setInterval(() => {
  const now = Date.now();
  for (const [ip, state] of authFailures) {
    if (state.until < now && state.count > 0) authFailures.delete(ip);
  }
}, 60_000);

// ── Room management (live connections — ephemeral) ───────────────────────────

const COLORS   = ['#FF6B6B','#FFD93D','#6BCB77','#4D96FF','#FF922B','#CC5DE8','#F06595','#20C997'];
let colorIdx   = 0;

/** Map<topic, Map<ws, {name, color}>> — only tracks live sockets */
const rooms = new Map();

function getClients(topic) {
  if (!rooms.has(topic)) rooms.set(topic, new Map());
  return rooms.get(topic);
}

function broadcast(topic, data) {
  const clients = rooms.get(topic);
  if (!clients) return;
  const msg = JSON.stringify(data);
  for (const [ws] of clients) if (ws.readyState === 1) ws.send(msg);
}

function online(topic) {
  const clients = rooms.get(topic);
  if (!clients) return [];
  return [...clients.values()].map(c => ({ name: c.name, color: c.color }));
}

// ── JSON body parser helper ──────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 8192) reject(new Error('body too large')); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('invalid JSON')); } });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(json);
}

// ── HTTP server ──────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';

  // POST /lookup — resolve passkey → topic (used by landing page UI)
  if (req.method === 'POST' && url === '/lookup') {
    const ip = req.socket.remoteAddress || 'unknown';
    const waitMs = getRateLimitedMs(ip);
    if (waitMs > 0) {
      send(res, 429, { error: 'Rate limited', retryAfter: waitMs });
      return;
    }
    try {
      const { passkey } = await readBody(req);
      const topic = db.getTopicByPasskey(passkey);
      if (topic) {
        resetAuthFailures(ip);
        send(res, 200, { topic });
      } else {
        recordAuthFailure(ip);
        send(res, 404, { error: 'Invalid passkey' });
      }
    } catch {
      res.writeHead(400); res.end();
    }
    return;
  }

  // GET /manifest.webmanifest
  if (req.method === 'GET' && url === '/manifest.webmanifest') {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json' });
    res.end(MANIFEST);
    return;
  }

  // GET /sw.js — service worker (allow it to control the whole origin)
  if (req.method === 'GET' && url === '/sw.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript', 'Service-Worker-Allowed': '/' });
    res.end(SW);
    return;
  }

  // GET /icon.svg
  if (req.method === 'GET' && url === '/icon.svg') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    res.end(ICON_SVG);
    return;
  }

  // GET /api/topics — list topics (without passkeys)
  if (req.method === 'GET' && url === '/api/topics') {
    const topics = db.getTopics().map(({ topic }) => ({ topic }));
    send(res, 200, topics);
    return;
  }

  // POST /api/topics — create/update a topic (requires ADMIN_TOKEN)
  if (req.method === 'POST' && url === '/api/topics') {
    if (!checkAdmin(req, res)) return;
    try {
      const { topic, passkey } = await readBody(req);
      if (!topic || typeof topic !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(topic)) {
        send(res, 400, { error: 'topic must be 1-64 chars [a-z0-9_-]' });
        return;
      }
      const key = passkey || crypto.randomBytes(12).toString('hex');
      db.upsertTopic(topic, key);
      send(res, 200, { topic, passkey: key });
    } catch (e) {
      // SQLite UNIQUE constraint means passkey already used by another topic
      send(res, 409, { error: e.message });
    }
    return;
  }

  // DELETE /api/topics/:topic — remove a topic (requires ADMIN_TOKEN)
  if (req.method === 'DELETE' && url.startsWith('/api/topics/')) {
    if (!checkAdmin(req, res)) return;
    const topic = decodeURIComponent(url.slice('/api/topics/'.length));
    db.deleteTopic(topic);
    rooms.delete(topic);
    res.writeHead(204); res.end();
    return;
  }

  // Everything else → serve the chat UI
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(HTML);
});

// ── WebSocket server ─────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const topic = (req.url || '/').replace(/^\/+|\/+$/g, '') || 'general';
  const ip    = req.socket.remoteAddress || 'unknown';

  // Unknown topic → reject immediately
  const topics = Object.fromEntries(db.getTopics().map(({ topic: t, passkey }) => [t, passkey]));
  if (!(topic in topics)) {
    ws.send(JSON.stringify({ type: 'error', text: 'Unknown topic' }));
    ws.close();
    return;
  }

  ws.send(JSON.stringify({ type: 'auth_required', topic }));

  ws.on('message', raw => {
    let d;
    try { d = JSON.parse(raw); } catch { return; }

    // ── Auth ──────────────────────────────────────────────────────────────
    if (d.type === 'auth') {
      // Rate-limit check
      const waitMs = getRateLimitedMs(ip);
      if (waitMs > 0) {
        ws.send(JSON.stringify({ type: 'auth_fail', retryAfter: waitMs }));
        ws.close();
        return;
      }

      // Re-fetch topics in case they changed since connection was opened
      const currentTopics = Object.fromEntries(
        db.getTopics().map(({ topic: t, passkey }) => [t, passkey])
      );

      if (d.passkey !== currentTopics[topic]) {
        recordAuthFailure(ip);
        ws.send(JSON.stringify({ type: 'auth_fail' }));
        ws.close();
        return;
      }

      resetAuthFailures(ip);
      const name  = (d.name || 'Anon').trim().slice(0, 24);
      const color = COLORS[colorIdx++ % COLORS.length];
      getClients(topic).set(ws, { name, color });

      ws.send(JSON.stringify({
        type: 'welcome',
        name, color, topic,
        history: db.getHistory(topic),
        online:  online(topic),
        motd:    motd || undefined,
      }));

      const sys = { type: 'system', text: `${name} joined 🐾`, ts: Date.now() };
      db.appendMessage(topic, sys);
      broadcast(topic, sys);
      logEntry(topic, sys);
      broadcast(topic, { type: 'online', online: online(topic) });
      return;
    }

    // ── Chat message ───────────────────────────────────────────────────────
    if (d.type === 'chat') {
      const clients = rooms.get(topic);
      if (!clients) return;
      const c = clients.get(ws);
      if (!c) return;
      const text = (d.text || '').trim().slice(0, 1000);
      if (!text) return;
      const msg = { type: 'chat', name: c.name, color: c.color, text, ts: Date.now() };
      db.appendMessage(topic, msg);
      broadcast(topic, msg);
      logEntry(topic, msg);
    }
  });

  ws.on('close', () => {
    const clients = rooms.get(topic);
    if (!clients) return;
    const c = clients.get(ws);
    if (!c) return;
    clients.delete(ws);
    const sys = { type: 'system', text: `${c.name} left`, ts: Date.now() };
    db.appendMessage(topic, sys);
    broadcast(topic, sys);
    logEntry(topic, sys);
    broadcast(topic, { type: 'online', online: online(topic) });
    if (clients.size === 0 && topic !== 'general') rooms.delete(topic);
  });
});

const topicList = db.getTopics().map(r => r.topic).join(', ');
console.log(`🐾 ClawMeet :${PORT}  topics: ${topicList}`);
server.listen(PORT);
