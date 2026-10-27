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
const payxCfg = async () => (await db.doc('private/payx').get()).data() || {};

/* ---------- health ---------- */
app.get('/health', (_, res) => res.json({ ok: true, t: Date.now() }));

/* ---------- PUSH ---------- */
app.post('/api/notify', auth, wrap(async (req, res) => {
  const { kind = 'message', chatId, callId } = req.body || {};
  const uid = req.user.uid;
  const me = (await db.doc(`users/${uid}`).get()).data() || {};
  let targets = [], title = '', body = '', data = {};
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
  const tokens = [], owner = {};
  for (const t of targets) {
    const u = (await db.doc(`users/${t}`).get()).data();
    if (!u || u.banned) continue;
    if (kind !== 'call' && (u.muted || []).includes(chatId)) continue;
    (u.fcmTokens || []).forEach(k => { tokens.push(k); owner[k] = t; });
  }
  if (!tokens.length) return res.json({ sent: 0 });
  const r = await admin.messaging().sendEachForMulticast({
    tokens,
    data: { ...data, title, body: body.slice(0, 160) },
    android: { priority: 'high' },
    webpush: { headers: { Urgency: 'high', TTL: '60' } }
  });
  const dead = [];
  r.responses.forEach((x, i) => {
    if (!x.success && /registration-token-not-registered|invalid-argument|invalid-registration/.test(x.error?.code || '')) dead.push(tokens[i]);
  });
  for (const k of dead) await db.doc(`users/${owner[k]}`).update({ fcmTokens: admin.firestore.FieldValue.arrayRemove(k) }).catch(() => {});
  res.json({ sent: r.successCount, failed: r.failureCount });
}));

/* ---------- PAYMENTS (payX) ---------- */
function payxHeaders(c) {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json' };
  const name = c.authHeader || 'x-api-key';
  if (c.apiKey) { if (name.toLowerCase() === 'authorization') h.Authorization = `Bearer ${c.apiKey}`; else h[name] = c.apiKey; }
  return h;
}
const joinUrl = (b, p) => b.replace(/\/$/, '') + (p.startsWith('/') ? p : '/' + p);
async function callPayx(cfg, method, path, payload) {
  let url = joinUrl(cfg.baseUrl, path);
  const opt = { method, headers: payxHeaders(cfg) };
  if (method === 'GET') { url += (url.includes('?') ? '&' : '?') + new URLSearchParams(payload).toString(); } else opt.body = JSON.stringify(payload);
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
    order_id: orderId, orderId, amount: Number(plan.price), currency: cfg.currency || 'INR',
    customer_name: user.name || 'User', customer_mobile: user.phone, customer_phone: user.phone,
    description: `${plan.name} plan`, note: `${plan.name} plan`,
    redirect_url: cfg.redirectUrl || st.appUrl || '', return_url: cfg.redirectUrl || st.appUrl || '',
    callback_url: cb, webhook_url: cb, metadata: { uid: req.user.uid, planId }
  };
  const r = await callPayx(cfg, 'POST', cfg.createPath || '/api/create-order', payload);
  if (!r.ok) return res.status(502).json({ error: `payX error ${r.status}: ${pick(r.json, ['message', 'error', 'raw']) || ''}` });
  const paymentUrl = pick(r.json, ['payment_url', 'paymentUrl', 'url', 'link', 'checkout_url', 'payment_link', 'data.payment_url', 'data.paymentUrl', 'data.url', 'data.link', 'data.checkout_url']);
  const gatewayId = pick(r.json, ['order_id', 'orderId', 'id', 'data.order_id', 'data.orderId', 'data.id']);
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
  const r = await callPayx(cfg, method, cfg.statusPath || '/api/order-status', q);
  const s = String(pick(r.json, ['status', 'payment_status', 'paymentStatus', 'order_status', 'data.status', 'data.payment_status', 'state']) || '').toLowerCase();
  if (OK.includes(s)) return 'success';
  if (BAD.includes(s)) return 'failed';
  return 'pending';
}
async function activate(orderId) {
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
  if (!cfg.baseUrl) return res.status(400).json({ error: 'Base URL set nahi hai' });
  const t0 = Date.now();
  try {
    const r = await fetch(cfg.baseUrl, { headers: payxHeaders(cfg) });
    res.json({ ok: r.ok, status: r.status, ms: Date.now() - t0, body: (await r.text()).slice(0, 200) });
  } catch (e) { res.status(502).json({ error: 'payX reach nahi hua: ' + e.message }); }
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
  const tokens = []; snap.forEach(d => (d.data()?.fcmTokens || []).forEach(t => tokens.push(t)));
  let sent = 0;
  for (let i = 0; i < tokens.length; i += 500) {
    const r = await admin.messaging().sendEachForMulticast({ tokens: tokens.slice(i, i + 500), data: { kind: 'broadcast', title, body: body || '', tag: 'broadcast' } });
    sent += r.successCount;
  }
  res.json({ sent, tokens: tokens.length });
}));

/* ---------- cleanup (jab server awake ho): expired status + purani calls ---------- */
async function cleanup() {
  try {
    const st = await db.collection('statuses').where('exp', '<', Date.now()).limit(200).get();
    for (const d of st.docs) await d.ref.delete();
    const old = await db.collection('calls').where('cts', '<', Date.now() - 30 * 864e5).limit(200).get();
    for (const d of old.docs) await db.recursiveDelete(d.ref);
  } catch (e) { console.warn('cleanup', e.message); }
}
setInterval(cleanup, 3600e3); setTimeout(cleanup, 15e3);

app.listen(process.env.PORT || 3000, () => console.log('Chatify backend ready'));
