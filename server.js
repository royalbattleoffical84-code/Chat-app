// Chatify backend: payX payment flow + FCM push + admin helpers.
// Deploy: Render (Web Service, free). Env: FIREBASE_SERVICE_ACCOUNT (JSON string), PUBLIC_URL (e.g. https://your-chat-backend.onrender.com)
import express from 'express';
import cors from 'cors';
import admin from 'firebase-admin';

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');

const app = express();
app.use(cors({ origin: process.env.ALLOWED_ORIGIN ? process.env.ALLOWED_ORIGIN.split(',') : true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

/* ---------- helpers ---------- */
async function auth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) throw new Error('no token');
    req.user = await admin.auth().verifyIdToken(h.slice(7));
    next();
  } catch { res.status(401).json({ error: 'Unauthorized' }); }
}
async function adminOnly(req, res, next) {
  const d = await db.doc(`users/${req.user.uid}`).get();
  if (d.data()?.role !== 'admin') return res.status(403).json({ error: 'Sirf admin' });
  next();
}
const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: e.message || 'Server error' }); });
const pick = (o, paths) => {
  for (const p of paths) {
    let v = o; for (const k of p.split('.')) v = v?.[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
};
const settings = async () => (await db.doc('settings/app').get()).data() || {};
// Sab kuch pehle se set hai - admin ko sirf apiKey daalni hoti hai. Admin panel ke Advanced me override kar sakte hain.
const PAYX_DEF = { baseUrl: 'https://payx-q1nn.onrender.com', authHeader: 'X-PayX-Key', createPath: '/api/v1/orders', statusPath: '/api/v1/orders/:id', statusMethod: 'GET', currency: 'INR' };
const payxCfg = async () => {
  const d = (await db.doc('private/payx').get()).data() || {};
  return { ...PAYX_DEF, ...Object.fromEntries(Object.entries(d).filter(([, v]) => v !== '' && v != null)) };
};

/* ---------- health ---------- */
app.get('/health', (_, res) => res.json({ ok: true, t: Date.now() }));

/* ---------- LIVE STREAM (Android APK ke liye, Firebase library ke bina) ----------
   APK ki background service /api/stream (SSE) kholti hai; message/call/broadcast aate hi yaha se turant push hota hai. */
const streams = new Map(); // uid -> Set(res)
function streamPush(uids, payload) {
  const line = `event: push\ndata: ${JSON.stringify(payload)}\n\n`;
  let n = 0;
  const send = set => set && set.forEach(r => { try { r.write(line); n++; } catch { } });
  if (uids === null) streams.forEach(send); else uids.forEach(u => send(streams.get(u)));
  return n;
}
app.get('/api/stream', auth, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  const uid = req.user.uid;
  if (!streams.has(uid)) streams.set(uid, new Set());
  streams.get(uid).add(res);
  res.write('event: hello\ndata: {}\n\n');
  const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch { } }, 20000);
  req.on('close', () => { clearInterval(hb); const s = streams.get(uid); if (s) { s.delete(res); if (!s.size) streams.delete(uid); } });
});

/* ---------- PUSH ---------- */
// web tokens: data-only (service worker notification dikhata hai). native (Android APK) tokens: notification payload, high priority + channel.
async function pushAll({ web = [], nat = [], uids = [], title, body, data = {}, kind = 'message' }) {
  const live = uids === null ? streamPush(null, { title, body, ...data, kind: data.kind || kind }) : streamPush(uids, { title, body, ...data, kind: data.kind || kind });
  const str = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]));
  const dead = []; let sent = 0, failed = 0;
  const collect = (r, toks) => r.responses.forEach((x, i) => {
    if (!x.success && /registration-token-not-registered|invalid-argument|invalid-registration/.test(x.error?.code || '')) dead.push(toks[i]);
  });
  for (let i = 0; i < web.length; i += 500) {
    const toks = web.slice(i, i + 500);
    const r = await admin.messaging().sendEachForMulticast({ tokens: toks, data: str({ ...data, title, body }), android: { priority: 'high' }, webpush: { headers: { Urgency: 'high', TTL: '60' } } });
    sent += r.successCount; failed += r.failureCount; collect(r, toks);
  }
  for (let i = 0; i < nat.length; i += 500) {
    const toks = nat.slice(i, i + 500);
    const r = await admin.messaging().sendEachForMulticast({
      tokens: toks, notification: { title, body }, data: str({ ...data, title, body }),
      android: { priority: 'high', ttl: kind === 'call' ? 45000 : 86400000, notification: { channelId: kind === 'call' ? 'calls' : 'messages', tag: data.tag || undefined, sound: 'default', defaultVibrateTimings: true, visibility: 'public', notificationCount: 1 } }
    });
    sent += r.successCount; failed += r.failureCount; collect(r, toks);
  }
  if (dead.length) {
    const users = await db.collection('users').where('fcmTokens', 'array-contains-any', dead.slice(0, 10)).get().catch(() => ({ docs: [] }));
    const users2 = await db.collection('users').where('nativeTokens', 'array-contains-any', dead.slice(0, 10)).get().catch(() => ({ docs: [] }));
    for (const d of [...users.docs, ...users2.docs]) await d.ref.update({ fcmTokens: admin.firestore.FieldValue.arrayRemove(...dead), nativeTokens: admin.firestore.FieldValue.arrayRemove(...dead) }).catch(() => { });
  }
  return { sent: sent + live, failed, live };
}
app.post('/api/notify', auth, wrap(async (req, res) => {
  const { kind = 'message', chatId, callId } = req.body || {};
  const uid = req.user.uid;
  const me = (await db.doc(`users/${uid}`).get()).data() || {};
  let targets = [], title = '', body = '', data = {};
  if (kind === 'callend') {
    const c = (await db.doc(`calls/${callId}`).get()).data();
    if (!c || c.from !== uid) return res.status(403).json({ error: 'Invalid call' });
    streamPush([c.to], { kind: 'callend', callId, tag: callId });
    return res.json({ ok: true });
  }
  if (kind === 'call') {
    const c = (await db.doc(`calls/${callId}`).get()).data();
    if (!c || c.from !== uid) return res.status(403).json({ error: 'Invalid call' });
    targets = [c.to]; title = me.name || 'Call';
    body = c.type === 'video' ? '📹 Incoming video call' : '📞 Incoming voice call';
    data = { kind: 'call', callId, tag: callId };
  } else {
    const chat = (await db.doc(`chats/${chatId}`).get()).data();
    if (!chat || !chat.members.includes(uid)) return res.status(403).json({ error: 'Invalid chat' });
    const lm = chat.lastMessage || {};
    targets = chat.members.filter(m => m !== uid);
    title = chat.isGroup ? chat.name : (me.name || 'Message');
    body = (chat.isGroup ? `${me.name}: ` : '') + (lm.text || 'Naya message');
    data = { kind: 'message', chatId, tag: chatId };
  }
  const web = [], nat = [], uids = [];
  for (const t of targets) {
    const u = (await db.doc(`users/${t}`).get()).data();
    if (!u || u.banned) continue;
    if (kind !== 'call' && (u.muted || []).includes(chatId)) continue;
    if ((u.blocked || []).includes(uid)) continue;
    uids.push(t);
    (u.fcmTokens || []).forEach(k => web.push(k));
    (u.nativeTokens || []).forEach(k => nat.push(k));
  }
  const out = await pushAll({ web, nat, uids, title, body: body.slice(0, 160), data, kind });
  res.json(out);
}));

// Notification ke "Decline" button se (app khole bina) call reject
app.post('/api/call/decline', auth, wrap(async (req, res) => {
  const ref = db.doc(`calls/${String(req.body.callId || '')}`);
  const c = (await ref.get()).data();
  if (!c || c.to !== req.user.uid) return res.status(403).json({ error: 'Invalid call' });
  if (c.status === 'ringing') await ref.update({ status: 'rejected' });
  res.json({ ok: true });
}));

/* ---------- PAYMENTS (payX) ---------- */
function payxHeaders(c) {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json' };
  const name = c.authHeader || 'x-api-key';
  if (c.apiKey) { if (name.toLowerCase() === 'authorization') h.Authorization = `Bearer ${c.apiKey}`; else h[name] = c.apiKey; }
  return h;
}
const joinUrl = (b, p) => b.replace(/\/$/, '') + (p.startsWith('/') ? p : '/' + p);
async function callPayx(cfg, method, path, payload, vars) {
  const hasVar = /:id|:orderId|\{id\}|\{orderId\}/.test(path);
  if (hasVar && vars && vars.id) path = path.replace(/:orderId|:id|\{orderId\}|\{id\}/g, encodeURIComponent(vars.id));
  let url = joinUrl(cfg.baseUrl, path);
  const opt = { method, headers: payxHeaders(cfg) };
  if (method === 'GET' && hasVar) { /* id path me hai */ } else if (method === 'GET') { url += (url.includes('?') ? '&' : '?') + new URLSearchParams(payload).toString(); } else opt.body = JSON.stringify(payload);
  const r = await fetch(url, opt);
  const txt = await r.text(); let j = {}; try { j = JSON.parse(txt); } catch { j = { raw: txt.slice(0, 300) }; }
  return { ok: r.ok, status: r.status, json: j };
}

app.post('/api/pay/create', auth, wrap(async (req, res) => {
  const { planId } = req.body || {};
  const st = await settings();
  const plan = (st.plans || []).find(p => p.id === planId && p.active !== false);
  if (!plan) return res.status(400).json({ error: 'Plan nahi mila' });
  const cfg = await payxCfg();
  if (!cfg.baseUrl || !cfg.apiKey) return res.status(400).json({ error: 'Payment gateway abhi configure nahi hai (admin ko batao)' });
  const user = (await db.doc(`users/${req.user.uid}`).get()).data() || {};
  const orderId = 'ORD' + Date.now() + Math.random().toString(36).slice(2, 6).toUpperCase();
  const cb = `${PUBLIC_URL}/api/pay/webhook${cfg.webhookSecret ? '?secret=' + encodeURIComponent(cfg.webhookSecret) : ''}`;
  const payload = {
    amount: Number(plan.price), reference: orderId, note: `${plan.name} plan`, redirectUrl: cfg.redirectUrl || st.appUrl || '',
    order_id: orderId, orderId, currency: cfg.currency || 'INR',
    customer_name: user.name || 'User', customer_mobile: user.phone, customer_phone: user.phone,
    description: `${plan.name} plan`, note: `${plan.name} plan`,
    redirect_url: cfg.redirectUrl || st.appUrl || '', return_url: cfg.redirectUrl || st.appUrl || '',
    callback_url: cb, webhook_url: cb, metadata: { uid: req.user.uid, planId }
  };
  const r = await callPayx(cfg, 'POST', cfg.createPath, payload);
  if (!r.ok) return res.status(502).json({ error: `payX error ${r.status}: ${pick(r.json, ['message', 'error', 'detail', 'raw']) || JSON.stringify(r.json).slice(0, 200)}` });
  const paymentUrl = pick(r.json, ['order.checkoutUrl', 'checkoutUrl', 'payment_url', 'paymentUrl', 'url', 'link', 'checkout_url', 'payment_link', 'data.payment_url', 'data.paymentUrl', 'data.url', 'data.link', 'data.checkout_url']);
  const gatewayId = pick(r.json, ['order.id', 'order_id', 'orderId', 'id', 'data.order_id', 'data.orderId', 'data.id']);
  if (!paymentUrl) return res.status(502).json({ error: 'payX ne payment URL nahi diya. Admin panel me create path / response check karo.' });
  await db.doc(`payments/${orderId}`).set({
    uid: req.user.uid, planId, planName: plan.name, amount: Number(plan.price), status: 'pending',
    gatewayOrderId: gatewayId || null, paymentUrl, createdAt: admin.firestore.FieldValue.serverTimestamp(), cts: Date.now()
  });
  res.json({ orderId, paymentUrl });
}));

const OK = ['success', 'paid', 'completed', 'captured', 'successful', 'complete', 'txn_success', 'credit'];
const BAD = ['failed', 'failure', 'cancelled', 'canceled', 'expired', 'rejected', 'declined'];
async function checkPayx(orderId, order, cfg) {
  const q = { order_id: order.gatewayOrderId || orderId, orderId: order.gatewayOrderId || orderId };
  const method = (cfg.statusMethod || 'GET').toUpperCase();
  const r = await callPayx(cfg, method, cfg.statusPath, q, { id: order.gatewayOrderId || orderId });
  const s = String(pick(r.json, ['order.status', 'status', 'payment_status', 'paymentStatus', 'order_status', 'data.status', 'data.payment_status', 'state']) || '').toLowerCase();
  const amt = pick(r.json, ['order.amount', 'amount', 'data.amount']);
  if (OK.includes(s)) { if (amt != null && order.amount != null && Number(amt) !== Number(order.amount)) { console.warn('PayX amount mismatch', orderId); return 'pending'; } return 'success'; }
  if (BAD.includes(s)) return 'failed';
  return 'pending';
}
async function activate(orderId) {
  const r = await activateTx(orderId);
  if (r === 'activated') {
    const p = (await db.doc(`payments/${orderId}`).get()).data() || {};
    pushUser(p.uid, 'Premium active ✔', `${p.planName || 'Plan'} activate ho gaya`, { kind: 'broadcast', tag: 'pay' }).catch(() => { });
    pushAdmins('New payment', `${p.planName || 'Plan'} • ₹${p.amount || ''} • ${p.phone || p.uid || ''}`).catch(() => { });
  }
  return r;
}
async function pushUser(uid, title, body, data = {}) {
  if (!uid) return;
  const u = (await db.doc(`users/${uid}`).get()).data() || {};
  return pushAll({ web: u.fcmTokens || [], nat: u.nativeTokens || [], uids: [uid], title, body, data });
}
async function pushAdmins(title, body) {
  const s = await db.collection('users').where('role', '==', 'admin').get();
  const web = [], nat = [], uids = []; s.forEach(d => { uids.push(d.id); const u = d.data(); (u.fcmTokens || []).forEach(t => web.push(t)); (u.nativeTokens || []).forEach(t => nat.push(t)); });
  return pushAll({ web, nat, uids, title, body, data: { kind: 'broadcast', tag: 'admin' } });
}
async function activateTx(orderId) {
  const ref = db.doc(`payments/${orderId}`);
  return db.runTransaction(async tx => {
    const p = await tx.get(ref); const o = p.data();
    if (!o) throw new Error('Order nahi mila');
    if (o.status === 'success') return 'already';
    const uref = db.doc(`users/${o.uid}`); const u = (await tx.get(uref)).data() || {};
    const plan = ((await settings()).plans || []).find(x => x.id === o.planId) || {};
    const now = Date.now(); const base = Math.max(now, u.premium?.until || 0);
    const days = Number(plan.days || 30);
    tx.update(uref, { premium: { planId: o.planId, planName: o.planName, until: base + days * 864e5, blueTick: !!plan.blueTick, fileLimitMB: plan.fileLimitMB || 25, maxPins: plan.maxPins || 6, orderId } });
    tx.update(ref, { status: 'success', paidAt: now });
    return 'activated';
  });
}
app.get('/api/pay/status', auth, wrap(async (req, res) => {
  const orderId = String(req.query.orderId || '');
  const snap = await db.doc(`payments/${orderId}`).get(); const o = snap.data();
  if (!o || o.uid !== req.user.uid) return res.status(404).json({ error: 'Order nahi mila' });
  if (o.status !== 'pending') return res.json({ status: o.status });
  const cfg = await payxCfg(); let st = 'pending';
  try { st = await checkPayx(orderId, o, cfg); } catch (e) { console.warn('status check', e.message); }
  if (st === 'success') await activate(orderId);
  else if (st === 'failed') await snap.ref.update({ status: 'failed' });
  res.json({ status: st });
}));
// payX is URL par webhook/callback bhejega. Hum kabhi sirf webhook par bharosa nahi karte: payX se status dobara verify karte hain.
app.all('/api/pay/webhook', wrap(async (req, res) => {
  const b = { ...req.query, ...req.body };
  const gid = pick(b, ['order_id', 'orderId', 'id', 'data.order_id']);
  if (!gid) return res.status(400).json({ error: 'order id missing' });
  let q = await db.collection('payments').where(gid.startsWith('ORD') ? 'gatewayOrderId' : 'gatewayOrderId', '==', gid).limit(1).get();
  let doc0 = q.docs[0] || await db.doc(`payments/${gid}`).get();
  if (!doc0 || !doc0.exists) return res.status(404).json({ error: 'order not found' });
  const orderId = doc0.id, o = doc0.data();
  if (o.status === 'success') return res.json({ ok: true });
  const cfg = await payxCfg();
  let st = 'pending';
  if (cfg.webhookSecret && b.secret === cfg.webhookSecret && OK.includes(String(b.status || '').toLowerCase())) st = 'success';
  else { try { st = await checkPayx(orderId, o, cfg); } catch { } }
  if (st === 'success') await activate(orderId);
  else if (st === 'failed') await doc0.ref.update({ status: 'failed' });
  res.json({ ok: true, status: st });
}));
app.post('/api/pay/test', auth, adminOnly, wrap(async (req, res) => {
  const cfg = await payxCfg();
  if (!cfg.apiKey) return res.status(400).json({ error: 'Pehle PayX API key daalo' });
  const t0 = Date.now();
  try {
    const r = await callPayx(cfg, (cfg.statusMethod || 'GET').toUpperCase(), cfg.statusPath, { order_id: 'TEST' }, { id: 'TEST' });
    const ms = Date.now() - t0;
    // 401/403 = key ya header galat. 404/400/422 = server tak pahunch gaye, key sahi (order TEST hai hi nahi).
    const auth = (r.status === 401 || r.status === 403) ? 'bad' : (r.status >= 500 ? 'unknown' : 'ok');
    res.json({ ok: auth === 'ok', auth, status: r.status, ms, body: JSON.stringify(r.json).slice(0, 200) });
  } catch (e) { res.status(502).json({ error: 'PayX reach nahi hua (server so raha ho sakta hai, 1 min baad try karo): ' + e.message }); }
}));
app.post('/api/admin/activate', auth, adminOnly, wrap(async (req, res) => res.json({ result: await activate(String(req.body.orderId)) })));

/* ---------- ADMIN helpers ---------- */
app.post('/api/admin/reset-password', auth, adminOnly, wrap(async (req, res) => {
  const { uid, newPassword } = req.body || {};
  if (!uid || String(newPassword || '').length < 6) return res.status(400).json({ error: 'uid aur 6+ char password do' });
  await admin.auth().updateUser(uid, { password: newPassword }); res.json({ ok: true });
}));
app.post('/api/admin/delete-user', auth, adminOnly, wrap(async (req, res) => {
  const { uid } = req.body || {};
  if (!uid || uid === req.user.uid) return res.status(400).json({ error: 'Apne aap ko delete nahi kar sakte' });
  await admin.auth().deleteUser(uid).catch(() => { });
  await db.recursiveDelete(db.doc(`users/${uid}`)); res.json({ ok: true });
}));
app.post('/api/admin/broadcast', auth, adminOnly, wrap(async (req, res) => {
  const { title, body, uid } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title do' });
  const snap = uid ? [await db.doc(`users/${uid}`).get()] : (await db.collection('users').get()).docs;
  const web = [], nat = []; snap.forEach(d => { const u = d.data() || {}; (u.fcmTokens || []).forEach(t => web.push(t)); (u.nativeTokens || []).forEach(t => nat.push(t)); });
  const r = await pushAll({ web, nat, uids: uid ? [uid] : null, title, body: body || '', data: { kind: 'broadcast', tag: 'broadcast' }, kind: 'message' });
  res.json({ sent: r.sent, tokens: web.length + nat.length + r.live });
}));

/* ---------- cleanup (jab server awake ho): expired status + purani calls ---------- */
async function cleanup() {
  try {
    const st = await db.collection('statuses').where('exp', '<', Date.now()).limit(200).get();
    for (const d of st.docs) { const x = d.data(); if (x.fid) await db.recursiveDelete(db.doc(`files/${x.fid}`)).catch(() => { }); await d.ref.delete(); }
    const old = await db.collection('calls').where('cts', '<', Date.now() - 30 * 864e5).limit(200).get();
    for (const d of old.docs) await db.recursiveDelete(d.ref);
  } catch (e) { console.warn('cleanup', e.message); }
}
setInterval(cleanup, 3600e3); setTimeout(cleanup, 15e3);

app.listen(process.env.PORT || 3000, () => console.log('Chatify backend ready'));
