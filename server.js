require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const admin = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 8080;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

/* PT Exchange API */
const PT_API_URL = 'https://ptexchange-api.vercel.app/pay/jetton';
const PT_API_KEY = process.env.PT_API_KEY || 'ptx_78745a589719acd033b2b094accee468e072779a10b997be';

/* Firebase Admin */
function parseSA() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT || '';
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) {
    try { return JSON.parse(raw.replace(/\\n/g, '\n')); } catch (e2) { return null; }
  }
}
let db = null, rtdb = null;
try {
  const sa = parseSA();
  if (sa) {
    admin.initializeApp({
      credential: admin.credential.cert(sa),
      databaseURL: process.env.RTDB_URL || "https://notcoinbot-9f734-default-rtdb.firebaseio.com"
    });
    db = admin.firestore();
    rtdb = admin.database();
    console.log('✅ Firebase Admin ready');
  } else {
    console.warn('⚠️ FIREBASE_SERVICE_ACCOUNT missing');
  }
} catch (e) {
  console.error('Firebase init error:', e.message);
}

function requireDb(req, res, next) {
  if (!db) return res.status(500).json({ success: false, error: 'Firebase not configured' });
  next();
}

app.get('/', (req, res) => res.json({ status: 'NotSplash Backend Online', time: new Date().toISOString() }));
/* ============================================
   CLAIM — atomic: earned → balance + GH
   NO SIGNATURE CHECK — uses userId from body
   ============================================ */
app.post('/api/claim', requireDb, async (req, res) => {
  try {
    const uid = String(req.body.userId || '');
    if (!uid) return res.status(400).json({ success: false, error: 'No userId' });
    
    let result = null;
    await db.runTransaction(async tx => {
      const ref = db.collection('users').doc(uid);
      const doc = await tx.get(ref);
      if (!doc.exists) throw new Error('User not found');
      const u = doc.data();
      const earned = (u.session && u.session.earned) || 0;
      if (earned <= 0) throw new Error('Nothing to claim');
      const gh = Math.floor(earned * 2);
      tx.update(ref, {
        notBalance: admin.firestore.FieldValue.increment(earned),
        totalMined: admin.firestore.FieldValue.increment(earned),
        ghBalance: admin.firestore.FieldValue.increment(gh),
        'session.earned': 0
      });
      result = { earned, gh };
    });
    console.log('✅ Claim:', uid, result.earned, 'NOT +', result.gh, 'GH');
    res.json({ success: true, amount: result.earned, ghBonus: result.gh });
  } catch (e) {
    console.error('Claim error:', e.message);
    res.status(400).json({ success: false, error: e.message });
  }
});

/* ============================================
   VERIFY TASK — Telegram membership check
   NO SIGNATURE CHECK
   ============================================ */
app.post('/api/verify-task', requireDb, async (req, res) => {
  const channel = String(req.body.channel || '').trim();
  const tgId = Number(req.body.tgId || 0);
  if (!channel || !tgId) return res.status(400).json({ success: false, error: 'Missing data' });
  if (!TELEGRAM_BOT_TOKEN) return res.status(500).json({ success: false, error: 'Bot token missing on server' });
  try {
    const url = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/getChatMember?chat_id=' + encodeURIComponent(channel) + '&user_id=' + tgId;
    const r = await fetch(url);
    const d = await r.json();
    if (d.ok && ['member', 'administrator', 'creator'].indexOf(d.result.status) !== -1) {
      console.log('✅ Task verified:', tgId, channel);
      return res.json({ success: true });    }
    return res.json({ success: false, error: 'Not a member' });
  } catch (e) {
    console.error('Verify error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/* ============================================
   DEPOSIT — save record for admin review
   NO SIGNATURE CHECK
   ============================================ */
app.post('/api/deposit', requireDb, async (req, res) => {
  try {
    const uid = String(req.body.userId || '');
    const amount = Number(req.body.amount);
    const wallet = String(req.body.wallet || '').trim();
    const txHash = String(req.body.txHash || '').trim();
    if (!uid || !amount || !wallet) return res.status(400).json({ success: false, error: 'Missing data' });

    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) return res.status(404).json({ success: false, error: 'User not found' });
    const u = userDoc.data();

    await db.collection('deposits').add({
      userId: uid, tgId: u.tgId, name: u.firstName || u.username || '',
      amount: amount, senderWallet: wallet, txHash: txHash,
      status: 'pending', createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log('✅ Deposit saved:', uid, amount, 'TON');
    res.json({ success: true });
  } catch (e) {
    console.error('Deposit error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

//* ============ FIXED /api/withdraw — replace the old route ============ */
app.post('/api/withdraw', requireDb, async (req, res) => {
  let uid = null, amt = 0, deducted = false, wdRef = null;
  try {
    uid  = String(req.body.userId || '');
    const addr = String(req.body.wallet || '').trim();
    amt  = Number(req.body.amount);
    if (!uid || !addr || addr.length < 10 || !amt)
      return res.status(400).json({ success:false, error:'Invalid request' });

    const doc = await db.collection('users').doc(uid).get();
    if (!doc.exists) return res.status(404).json({ success:false, error:'User not found' });
    const u = doc.data();

    /* SAFE ids — never undefined */
    const tgId   = u.telegramId || u.tgId || null;
    const name   = u.firstName || u.username || '';

    /* settings */
    const sdoc = await db.collection('config').doc('settings').get();
    const s = sdoc.exists ? sdoc.data() : {};
    const reqF = s.reqFriends || 5, reqT = s.reqTasks || 5;
    const maxD = s.maxWithdrawsPerDay || 2, minW = s.minWithdraw || 30, fee = s.wdFee || 10;

    if (s.withdrawalsOpen === false) return res.status(400).json({ success:false, error:'Withdrawals closed' });
    const refCount = (u.referrals && Array.isArray(u.referrals)) ? u.referrals.length : 0;
    if (refCount < reqF) return res.status(400).json({ success:false, error:'Invite '+reqF+' friends first' });
    if ((u.tasksCompleted||0) < reqT) return res.status(400).json({ success:false, error:'Complete '+reqT+' tasks first' });

    const today = new Date().toDateString();
    const todayCount = (u.withdrawalsToday||[]).filter(d=>d===today).length;
    if (todayCount >= maxD) return res.status(400).json({ success:false, error:'Max '+maxD+' withdrawals/day' });

    const isFree = (u.vip||0) === 0;
    if (isFree) { if (amt !== 30) return res.status(400).json({ success:false, error:'Free users withdraw exactly 30 NOT' }); }
    else { if (amt < minW) return res.status(400).json({ success:false, error:'VIP minimum '+minW+' NOT' });
           if (amt > 50)  return res.status(400).json({ success:false, error:'VIP max 50 NOT' }); }
    if (amt + fee > (u.notBalance||0)) return res.status(400).json({ success:false, error:'Insufficient balance' });

    /* STEP 1 — deduct FIRST (so a later failure can refund correctly) */
    const wds = (u.withdrawalsToday||[]).filter(d=>d!==today); wds.push(today);
    await db.collection('users').doc(uid).update({
      notBalance: admin.firestore.FieldValue.increment(-amt),
      wallet: addr,
      withdrawalsToday: wds.slice(-7)
    });
    deducted = true;

    /* STEP 2 — create history record (NO undefined values) */
    wdRef = rtdb.ref('withdrawals/' + uid).push();
    await wdRef.set({
      userId: uid,
      tgId: tgId,
      userName: name,
      amount: amt,
      fee: fee,
      netAmount: amt - fee,
      wallet: addr,
      status: 'pending',
      vipLevel: u.vip || 0,
      createdAt: admin.database.ServerValue.TIMESTAMP
    });

    /* STEP 3 — pay via PT Exchange (your exact format) */
    const payRes = await fetch(PT_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: PT_API_KEY,
        to_address: addr,
        jetton_symbol: 'NOT',
        amount: Math.floor(amt - fee),
        comment: 'NotSplash-' + (tgId || uid)
      })
    });
    const payText = await payRes.text();
    console.log('PT Exchange response:', payRes.status, payText);

    let payData = {};
    try { payData = JSON.parse(payText); } catch(e) { payData = { raw: payText }; }

    /* Check success — PT Exchange returns various formats */
    const paySuccess = payRes.ok && payData.success !== false && !payData.error;
    const txHash = payData.tx_hash || payData.txHash || payData.transaction_hash || payData.id || wdRef.key;
    const payError = payData.error || payData.message || (paySuccess ? null : 'PT Exchange returned status ' + payRes.status);

    if (paySuccess) {
      /* SUCCESS — mark completed */
      await wdRef.update({
        status: 'completed',
        txHash: txHash,
        updatedAt: admin.database.ServerValue.TIMESTAMP
      });
      console.log('✅ Withdraw paid:', amt, 'NOT to', addr, 'tx:', txHash);
      return res.json({
        success: true,
        id: wdRef.key,
        txHash: txHash,
        amount: amt,
        net: amt - fee,
        status: 'completed'
      });
    } else {
      /* FAILED — REFUND user */
      console.error('❌ PT Exchange failed:', payError);
      await db.collection('users').doc(uid).update({
        notBalance: admin.firestore.FieldValue.increment(amt)
      });
      await wdRef.update({
        status: 'failed',
        paymentError: payError,
        updatedAt: admin.database.ServerValue.TIMESTAMP      });
      return res.status(400).json({
        success: false,
        error: 'Payment failed: ' + payError + ' — balance refunded',
        wdId: wdRef.key
      });
    }

  } catch (e) {
    console.error('Withdraw error:', e);
    /* Refund if we deducted but something crashed */
    if (uid && amt > 0 && wdRef) {
      try {
        await db.collection('users').doc(uid).update({
          notBalance: admin.firestore.FieldValue.increment(amt)
        });
        await wdRef.update({ status: 'failed', paymentError: e.message });
        console.log('↩️ Refunded after error:', uid, amt);
      } catch (refundErr) {
        console.error('Refund error:', refundErr);
      }
    }
    res.status(500).json({ success: false, error: e.message });
  }
});

/* ============================================
   ADMIN: Manual approve withdrawal (retry PT Exchange)
   ============================================ */
app.post('/api/admin/approve-withdrawal', requireDb, async (req, res) => {
  try {
    const uid = String(req.body.userId || '');
    const wdId = String(req.body.wdId || '');
    if (!uid || !wdId) return res.status(400).json({ success: false, error: 'Missing userId/wdId' });

    const wdSnap = await rtdb.ref('withdrawals/' + uid + '/' + wdId).once('value');
    const wd = wdSnap.val();
    if (!wd || wd.status !== 'pending') return res.status(400).json({ success: false, error: 'Not pending' });

    const payRes = await fetch(PT_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: PT_API_KEY,
        to_address: wd.wallet,
        jetton_symbol: 'NOT',
        amount: wd.amount,
        comment: 'NotSplash Admin Approval #' + wdId.slice(-6)
      })
    });    let payData = {};
    try { payData = await payRes.json(); } catch(e) {}

    const paySuccess = payRes.ok && payData.success !== false && !payData.error;
    if (paySuccess) {
      const txHash = payData.tx_hash || payData.txHash || payData.id || wdId;
      await rtdb.ref('withdrawals/' + uid + '/' + wdId).update({
        status: 'completed', txHash: txHash,
        updatedAt: admin.database.ServerValue.TIMESTAMP
      });
      res.json({ success: true, txHash: txHash });
    } else {
      throw new Error(payData.error || payData.message || 'PT Exchange failed');
    }
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.listen(PORT, () => console.log('🚀 NotSplash Backend on port ' + PORT));
