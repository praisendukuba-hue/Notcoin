require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fetch = require('node-fetch');
const admin = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

/* ================= CONFIG ================= */
const PORT = process.env.PORT || 8080;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const PTX_API_KEY = process.env.PTX_API_KEY || '';
const PTX_API_URL = process.env.PTX_API_URL || 'https://ptexchange-api.vercel.app/pay/jetton';
const DEPOSIT_TON_ADDRESS = process.env.DEPOSIT_ADDRESS || 'UQA_NviYLQo64fs2dnE_-ic_JMil6xEKT4tixi0p6ajzGIMU';
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-me-admin-key';
const RTDB_URL = process.env.RTDB_URL || 'https://notcoinbot-9f734-default-rtdb.firebaseio.com';

/* Withdrawal rules (mirror the frontend) */
const MIN_WITHDRAW = 50;
const WD_FEE = 10;
const FREE_MAX_WITHDRAW = 30;   // free users cap
const MAX_WITHDRAWS_PER_DAY = 2;
const REQ_FRIENDS = 5;
const REQ_TASKS = 5;

/* ================= FIREBASE ADMIN ================= */
function parseServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT || '';
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) {
    try { return JSON.parse(raw.replace(/\\n/g, '\n')); } catch (e2) { return null; }
  }
}

let db = null;
let rtdb = null;
try {
  const sa = parseServiceAccount();
  if (sa) {
    admin.initializeApp({ credential: admin.credential.cert(sa), databaseURL: RTDB_URL });
    db = admin.firestore();
    rtdb = admin.database();
    console.log('Firebase Admin ready');
  } else {
    console.warn('FIREBASE_SERVICE_ACCOUNT missing!');
  }
} catch (e) {  console.error('Firebase init error:', e.message);
}

function requireDb(req, res, next) {
  if (!db) return res.status(500).json({ success: false, error: 'Firebase not configured on server' });
  next();
}

/* ================= TELEGRAM INIT-DATA VALIDATION ================= */
function verifyInitData(initData) {
  if (!initData || !TELEGRAM_BOT_TOKEN) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');

    const pairs = [];
    params.forEach(function (value, key) { pairs.push(key + '=' + value); });
    pairs.sort();
    const dataCheckString = pairs.join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(TELEGRAM_BOT_TOKEN).digest();
    const calculated = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (calculated !== hash) return null;

    const authDate = parseInt(params.get('auth_date') || '0', 10);
    if (authDate && (Math.floor(Date.now() / 1000) - authDate) > 86400) return null; // 24h max

    const userRaw = params.get('user');
    if (!userRaw) return null;
    return JSON.parse(userRaw);
  } catch (e) {
    return null;
  }
}

function authTg(req, res, next) {
  const user = verifyInitData(req.headers['x-telegram-init-data'] || '');
  if (!user) return res.status(401).json({ success: false, error: 'Invalid Telegram signature' });
  req.tgUser = user;
  req.uid = 'tg_' + user.id;
  next();
}

function authAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || '';
  if (!key || key !== ADMIN_KEY) return res.status(403).json({ success: false, error: 'Bad admin key' });
  next();
}
/* simple per-user cooldown to block spam/double-spend */
const wdLocks = new Map();

/* ================= ROUTES ================= */

app.get('/', function (req, res) {
  res.json({ status: 'NotSplash Backend Online', time: new Date().toISOString() });
});

app.get('/api/deposit-info', function (req, res) {
  res.json({ tonAddress: DEPOSIT_TON_ADDRESS, qrImage: '' });
});

/* ---- Deposit submission (user) ---- */
app.post('/api/deposit', requireDb, authTg, async function (req, res) {
  try {
    const amount = Number(req.body.amount) || 0;
    const wallet = String(req.body.wallet || '').trim();
    const txHash = String(req.body.txHash || '').trim();
    if (amount <= 0) return res.status(400).json({ success: false, error: 'Invalid amount' });
    if (wallet.length < 10) return res.status(400).json({ success: false, error: 'Invalid sender wallet' });

    await db.collection('deposits').add({
      userId: req.uid, tgId: req.tgUser.id,
      name: req.tgUser.first_name || '', username: req.tgUser.username || '',
      amount: amount, senderWallet: wallet, txHash: txHash,
      status: 'pending', createdAt: Date.now()
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/* ---- Verify channel membership (user) ---- */
app.post('/api/verify-task', requireDb, authTg, async function (req, res) {
  const channel = String(req.body.channel || '').trim();
  if (!channel) return res.status(400).json({ success: false, error: 'No channel provided' });
  if (!TELEGRAM_BOT_TOKEN) return res.status(500).json({ success: false, error: 'Bot token missing on server' });
  try {
    const url = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN +
      '/getChatMember?chat_id=' + encodeURIComponent(channel) + '&user_id=' + req.tgUser.id;
    const r = await fetch(url);
    const data = await r.json();
    if (data.ok && ['member', 'administrator', 'creator'].indexOf(data.result.status) !== -1) {
      return res.json({ success: true });
    }
    return res.json({ success: false, error: 'Not a member yet' });
  } catch (e) {    return res.status(500).json({ success: false, error: e.message });
  }
});

/* ---- Secure claim (atomic transaction — no double claims) ---- */
app.post('/api/claim', requireDb, authTg, async function (req, res) {
  try {
    let result = null;
    await db.runTransaction(async function (tx) {
      const ref = db.collection('users').doc(req.uid);
      const doc = await tx.get(ref);
      if (!doc.exists) throw new Error('User not found');
      const u = doc.data();
      const sess = u.session || {};
      const earned = sess.earned || 0;
      if (earned <= 0) throw new Error('Nothing to claim');
      const ghBonus = Math.floor(earned * 2);
      tx.update(ref, {
        notBalance: admin.firestore.FieldValue.increment(earned),
        totalMined: admin.firestore.FieldValue.increment(earned),
        ghBalance: admin.firestore.FieldValue.increment(ghBonus),
        'session.earned': 0
      });
      result = { earned: earned, ghBonus: ghBonus };
    });
    res.json({ success: true, amount: result.earned, ghBonus: result.ghBonus });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

/* ---- Secure withdraw (rules + PT Exchange, key hidden) ---- */
app.post('/api/withdraw', requireDb, authTg, async function (req, res) {
  const uid = req.uid;
  const amount = Number(req.body.amount);
  const wallet = String(req.body.wallet || '').trim();

  if (!amount || isNaN(amount)) return res.status(400).json({ success: false, error: 'Invalid amount' });
  if (wallet.length < 40 || wallet.length > 64) return res.status(400).json({ success: false, error: 'Invalid TON wallet' });

  const now = Date.now();
  const last = wdLocks.get(uid) || 0;
  if (now - last < 10000) return res.status(429).json({ success: false, error: 'Too fast — wait a moment' });
  wdLocks.set(uid, now);

  let wdRef = null;
  try {
    const userRef = db.collection('users').doc(uid);
    const snap = await userRef.get();
    if (!snap.exists) return res.status(404).json({ success: false, error: 'User not found' });    const u = snap.data();

    /* enforce ALL rules server-side */
    if ((u.referrals || 0) < REQ_FRIENDS) return res.status(400).json({ success: false, error: 'Invite ' + REQ_FRIENDS + ' friends first' });
    if ((u.tasksCompleted || 0) < REQ_TASKS) return res.status(400).json({ success: false, error: 'Complete ' + REQ_TASKS + ' tasks first' });

    const today = new Date().toDateString();
    const todayCount = (u.withdrawalsToday || []).filter(function (d) { return d === today; }).length;
    if (todayCount >= MAX_WITHDRAWS_PER_DAY) return res.status(400).json({ success: false, error: 'Max 2 withdrawals per day' });

    if (amount < MIN_WITHDRAW) return res.status(400).json({ success: false, error: 'Minimum ' + MIN_WITHDRAW + ' NOT' });
    if ((u.vip || 0) === 0 && amount > FREE_MAX_WITHDRAW) return res.status(400).json({ success: false, error: 'Free users max ' + FREE_MAX_WITHDRAW + ' NOT — upgrade to VIP' });
    if (amount + WD_FEE > (u.notBalance || 0)) return res.status(400).json({ success: false, error: 'Insufficient balance' });

    /* create processing record (real-time history) */
    wdRef = rtdb.ref('withdrawals/' + uid).push();
    await wdRef.set({
      userId: uid, tgId: u.tgId, amount: amount, wallet: wallet,
      status: 'processing', vipLevel: u.vip || 0,
      createdAt: admin.database.ServerValue.TIMESTAMP
    });

    /* call PT Exchange (key hidden on server) */
    const ptxRes = await fetch(PTX_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: PTX_API_KEY,
        to_address: wallet,
        jetton_symbol: 'NOT',
        amount: Math.floor(amount - WD_FEE),
        comment: 'NS-' + u.tgId
      })
    });
    let ptx = {};
    try { ptx = await ptxRes.json(); } catch (e) { ptx = {}; }
    if (!ptxRes.ok) throw new Error((ptx && ptx.error) || 'PT Exchange failed');

    /* deduct + record day */
    const keep = (u.withdrawalsToday || []).filter(function (d) { return d !== today; });
    keep.push(today);
    await userRef.update({
      notBalance: admin.firestore.FieldValue.increment(-amount),
      wallet: wallet,
      withdrawalsToday: keep.slice(-7)
    });
    await wdRef.update({ status: 'completed', txHash: ptx.txHash || '' });

    res.json({ success: true, txHash: ptx.txHash || '' });
  } catch (e) {    console.error('Withdraw error:', e.message);
    if (wdRef) { wdRef.update({ status: 'failed', error: String(e.message) }).catch(function () {}); }
    res.status(500).json({ success: false, error: e.message });
  }
});

/* ================= ADMIN ENDPOINTS ================= */

app.get('/api/admin/deposits', requireDb, authAdmin, async function (req, res) {
  const status = req.query.status || 'pending';
  const snap = await db.collection('deposits').where('status', '==', status).orderBy('createdAt', 'desc').limit(100).get();
  const items = [];
  snap.forEach(function (d) { items.push(Object.assign({ id: d.id }, d.data())); });
  res.json({ success: true, items: items });
});

app.post('/api/admin/deposit/approve', requireDb, authAdmin, async function (req, res) {
  try {
    await db.runTransaction(async function (tx) {
      const ref = db.collection('deposits').doc(String(req.body.depositId));
      const doc = await tx.get(ref);
      if (!doc.exists) throw new Error('Deposit not found');
      const dep = doc.data();
      if (dep.status !== 'pending') throw new Error('Already processed');
      tx.update(db.collection('users').doc(dep.userId), {
        tonBalance: admin.firestore.FieldValue.increment(dep.amount)
      });
      tx.update(ref, { status: 'approved', approvedAt: Date.now() });
    });
    res.json({ success: true });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

app.post('/api/admin/deposit/reject', requireDb, authAdmin, async function (req, res) {
  try {
    await db.collection('deposits').doc(String(req.body.depositId)).update({ status: 'rejected', rejectedAt: Date.now() });
    res.json({ success: true });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

app.get('/api/admin/submissions', requireDb, authAdmin, async function (req, res) {
  const status = req.query.status || 'pending';
  const snap = await db.collection('task_submissions').where('status', '==', status).orderBy('createdAt', 'desc').limit(100).get();
  const items = [];
  snap.forEach(function (d) { items.push(Object.assign({ id: d.id }, d.data())); });
  res.json({ success: true, items: items });
});

app.post('/api/admin/submission/approve', requireDb, authAdmin, async function (req, res) {
  try {    await db.runTransaction(async function (tx) {
      const ref = db.collection('task_submissions').doc(String(req.body.submissionId));
      const doc = await tx.get(ref);
      if (!doc.exists) throw new Error('Submission not found');
      const sub = doc.data();
      if (sub.status !== 'pending') throw new Error('Already processed');

      const userRef = db.collection('users').doc(sub.userId);
      const taskField = 'tasks.' + sub.taskId;
      const updates = {};
      updates[taskField] = 'approved';
      updates.tasksCompleted = admin.firestore.FieldValue.increment(1);
      updates.notBalance = admin.firestore.FieldValue.increment(sub.reward || 1);
      updates.ghBalance = admin.firestore.FieldValue.increment(sub.ghReward || 5);
      tx.update(userRef, updates);
      tx.update(ref, { status: 'approved', approvedAt: Date.now() });
    });
    res.json({ success: true });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

app.post('/api/admin/submission/reject', requireDb, authAdmin, async function (req, res) {
  try {
    const ref = db.collection('task_submissions').doc(String(req.body.submissionId));
    const doc = await ref.get();
    if (doc.exists) {
      const sub = doc.data();
      await ref.update({ status: 'rejected', rejectedAt: Date.now() });
      const upd = {};
      upd['tasks.' + sub.taskId] = 'rejected';
      await db.collection('users').doc(sub.userId).update(upd);
    }
    res.json({ success: true });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

/* 404 + error handler */
app.use(function (req, res) { res.status(404).json({ success: false, error: 'Not found' }); });
app.use(function (err, req, res, next) { console.error(err); res.status(500).json({ success: false, error: 'Server error' }); });

app.listen(PORT, function () {
  console.log('NotSplash backend running on port ' + PORT);
});
