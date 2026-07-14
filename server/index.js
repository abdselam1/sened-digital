// خادم سند السحابي المركزي — متعدّد المؤسسات، مدعوم بـ PostgreSQL.
// يتكلّم نفس بروتوكول «المضيف» في التطبيق (main.js) بالضبط، لكنه على الإنترنت ومعزول لكل مؤسسة.
//
// المصادقة والعزل: ترويسة x-sened-token = كود المؤسسة (tenant). كل طلب بلا كود صالح يُرفض 401.
// التطبيق (العميل) يرسل هذه الترويسة أصلاً — فلا حاجة لتغيير في العميل سوى توجيهه لهذا الخادم.
'use strict';
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const PORT = Number(process.env.PORT) || 3050;

// عملاء SSE لكل مؤسسة: Map(tenantCode -> Set(res))
const sseByTenant = new Map();
let clientSeq = 0;

function addSseClient(tenant, res) {
  let set = sseByTenant.get(tenant);
  if (!set) { set = new Set(); sseByTenant.set(tenant, set); }
  set.add(res);
}
function removeSseClient(tenant, res) {
  const set = sseByTenant.get(tenant);
  if (set) { set.delete(res); if (!set.size) sseByTenant.delete(tenant); }
}
// يبثّ التغييرات لكل أجهزة مؤسسة واحدة فقط (عزل تام بين المؤسسات)
function broadcastChanges(tenant, applied, rev) {
  const set = sseByTenant.get(tenant);
  if (!set || !set.size) return;
  const proto2 = `event: changes\ndata: ${JSON.stringify({ rev, changes: applied })}\n\n`;
  // عميل قديم (بلا proto2) ينتظر مستنداً كاملاً — نرسله له عند الحاجة فقط (نادر على السحابة)
  for (const res of set) {
    try {
      if (res._proto2) res.write(proto2);
      // للعميل القديم لا نبثّ هنا (سيسحب /sync عند فجوة rev) — تبسيطاً وأماناً
    } catch (e) { /* اتصال مقطوع سيُنظَّف عند close */ }
  }
}

// وسيط المصادقة: يحوّل كود المؤسسة إلى req.tenant، ويرفض غير الصالح.
async function authTenant(req, res, next) {
  try {
    const code = req.get('x-sened-token') || '';
    if (!code) return res.status(401).json({ error: 'missing tenant code' });
    const t = await db.getTenant(code);
    if (!t || !t.active) return res.status(401).json({ error: 'unauthorized' });
    req.tenant = code;
    req.tenantRow = t;
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// فحص اتصال سريع (يطابق /ping في المضيف المحلي)
app.get('/ping', authTenant, async (req, res) => {
  const set = sseByTenant.get(req.tenant);
  res.json({ ok: true, app: 'sened', name: req.tenantRow.name || '', rev: Number(req.tenantRow.rev) || 0, clients: set ? set.size : 0 });
});

// الحالة الكاملة للمؤسسة (تحميل أولي لدى العميل)
app.get('/sync', authTenant, async (req, res) => {
  try { res.json(await db.getDoc(req.tenant)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// استقبال تعديل من عميل: طبّق على المؤسسة، ارفع rev، ابثّ لأجهزتها فقط.
app.post('/sync', authTenant, async (req, res) => {
  try {
    const body = req.body || {};
    const changes = Array.isArray(body.changes) ? body.changes : await db.diffDocToChanges(req.tenant, body);
    const { applied, rev } = await db.applyChanges(req.tenant, changes);
    res.json({ ok: true, rev });
    if (applied.length) broadcastChanges(req.tenant, applied, rev);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// مجرى الأحداث اللحظي (SSE) — معزول لكل مؤسسة
app.get('/events', authTenant, (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  if (res.flushHeaders) res.flushHeaders();
  res._proto2 = req.get('x-sened-proto') === '2';
  res._clientId = ++clientSeq;
  const rev = Number(req.tenantRow.rev) || 0;
  res.write(`event: hello\ndata: ${JSON.stringify({ rev })}\n\n`);
  addSseClient(req.tenant, res);
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);
  req.on('close', () => { clearInterval(hb); removeSseClient(req.tenant, res); });
});

// فحص صحّة عام (بلا كود) — لمراقبة تشغيل الخادم
app.get('/health', (req, res) => res.json({ ok: true, service: 'sened-cloud' }));

app.listen(PORT, () => {
  console.log(`Sened cloud server listening on :${PORT}`);
});
