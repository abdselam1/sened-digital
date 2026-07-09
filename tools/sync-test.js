// اختبار بروتوكول التزامن عبر الشبكة المحلية (LAN) — بلا Electron.
// يشغّل خادماً مضيفاً (بنفس نقاط النهاية المستخدمة في main.js) وعميلين،
// ويتحقق أن تعديل عميل يصل للعميل الآخر لحظياً عبر SSE مع رفع رقم المراجعة.
// التشغيل: node tools/sync-test.js
const http = require('http');
const express = require('express');
const cors = require('cors');

const PORT = 3060; // منفذ اختبار (غير 3050 لتفادي التعارض)
let store = { products: [], invoices: [], _rev: 0 };
const sseClients = new Set();

function currentRev() { return store._rev || 0; }
function broadcast(str) {
  const msg = `event: update\ndata: ${str}\n\n`;
  for (const res of sseClients) { try { res.write(msg); } catch (e) {} }
}

function startHost() {
  const appSrv = express();
  appSrv.use(cors());
  appSrv.use(express.json({ limit: '50mb' }));
  appSrv.get('/ping', (req, res) => res.json({ ok: true, app: 'sened', rev: currentRev(), clients: sseClients.size }));
  appSrv.get('/sync', (req, res) => res.type('application/json').send(JSON.stringify(store)));
  appSrv.post('/sync', (req, res) => {
    const incoming = req.body || {};
    incoming._rev = currentRev() + 1;
    incoming._ts = new Date().toISOString();
    store = incoming;
    res.json({ ok: true, rev: incoming._rev });
    broadcast(JSON.stringify(incoming));
  });
  appSrv.get('/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    if (res.flushHeaders) res.flushHeaders();
    res.write(`event: hello\ndata: ${JSON.stringify({ rev: currentRev() })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  });
  return new Promise((resolve) => {
    const s = http.createServer(appSrv);
    s.listen(PORT, '127.0.0.1', () => resolve(s));
  });
}

// عميل SSE (نفس منطق التحليل في connectClientStream بـ main.js)
function openClientStream(onUpdate) {
  const req = http.get({ hostname: '127.0.0.1', port: PORT, path: '/events', headers: { Accept: 'text/event-stream' } }, (res) => {
    let buffer = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, idx); buffer = buffer.slice(idx + 2);
        let event = 'message', data = '';
        for (const ln of raw.split('\n')) {
          if (ln.startsWith('event:')) event = ln.slice(6).trim();
          else if (ln.startsWith('data:')) data += ln.slice(5).trim();
        }
        if (event === 'update' && data) onUpdate(JSON.parse(data));
      }
    });
  });
  return req;
}

function post(data) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: PORT, path: '/sync', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(JSON.parse(b)));
    });
    req.on('error', reject);
    req.write(JSON.stringify(data)); req.end();
  });
}

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port: PORT, path }, (res) => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(JSON.parse(b)));
    });
    req.on('error', reject);
  });
}

(async function run() {
  let failed = 0;
  const assert = (cond, msg) => { console.log((cond ? '✓' : '✗ FAIL') + ' ' + msg); if (!cond) failed++; };

  const server = await startHost();

  // 1) فحص الاتصال
  const ping = await get('/ping');
  assert(ping.ok === true && ping.rev === 0, '/ping يعمل ورقم المراجعة الابتدائي 0');

  // 2) العميل (أ) يفتح مجرى SSE وينتظر التحديثات
  let received = null;
  const streamReq = openClientStream((data) => { received = data; });
  await new Promise(r => setTimeout(r, 300)); // مهلة لفتح الاتصال
  assert(sseClients.size === 1, 'العميل (أ) اتصل بمجرى الأحداث (SSE)');

  // 3) التحميل الأولي عبر GET /sync
  const initial = await get('/sync');
  assert(Array.isArray(initial.invoices) && initial.invoices.length === 0, 'التحميل الأولي: لا فواتير بعد');

  // 4) العميل (ب) يرسل فاتورة جديدة عبر POST /sync
  const res = await post({ products: [], invoices: [{ id: 'INV-1', total: 500 }], _rev: 0 });
  assert(res.ok === true && res.rev === 1, 'المضيف قبل التعديل ورفع رقم المراجعة إلى 1');

  // 5) العميل (أ) يستقبل التحديث لحظياً عبر SSE
  await new Promise(r => setTimeout(r, 300));
  assert(received && received.invoices && received.invoices.length === 1 && received.invoices[0].id === 'INV-1',
    'العميل (أ) استقبل الفاتورة الجديدة لحظياً عبر SSE');
  assert(received && received._rev === 1, 'التحديث المبثوث يحمل رقم المراجعة 1');

  // 6) تعديل ثانٍ يرفع المراجعة إلى 2 ويصل أيضاً
  await post({ products: [], invoices: [{ id: 'INV-1', total: 500 }, { id: 'INV-2', total: 200 }], _rev: 1 });
  await new Promise(r => setTimeout(r, 300));
  assert(received.invoices.length === 2 && received._rev === 2, 'تعديل ثانٍ وصل ورقم المراجعة صار 2');

  streamReq.destroy();
  server.close();
  console.log('\n' + (failed === 0 ? 'كل الاختبارات نجحت ✓' : failed + ' اختبار(ات) فشلت ✗'));
  process.exit(failed === 0 ? 0 : 1);
})();
