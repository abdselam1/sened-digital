// اختبار طابور إعادة الإرسال (pending-sync.json) — بلا Electron.
// السيناريو الأخطر في التطبيق: عميل متصل → يتوقف المضيف → الكاشير يصدر فاتورة
// (تُحفظ محلياً ويفشل إرسالها) → يعود المضيف → يجب أن تصل الفاتورة للمضيف خلال
// ثوانٍ عند أول اتصال ناجح، قبل أن يمحوها أول بث وارد من المضيف.
// منطق العميل هنا منسوخ من main.js (postToHost / flushPendingSync / connectClientStream).
// التشغيل: node tools/pending-sync-test.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const cors = require('cors');

const PORT = 3061; // منفذ اختبار (غير 3050/3060 لتفادي التعارض)

// ---------- المضيف (نفس نقاط النهاية في main.js) ----------
let store = { invoices: [], _rev: 0 };
const sseClients = new Set();
let hostSockets = new Set(); // لتدمير اتصالات keep-alive عند إيقاف المضيف

function currentRev() { return store._rev || 0; }
function broadcast(str) {
  const msg = `event: update\ndata: ${str}\n\n`;
  for (const res of sseClients) { try { res.write(msg); } catch (e) {} }
}

function startHost() {
  const appSrv = express();
  appSrv.use(cors());
  appSrv.use(express.json({ limit: '50mb' }));
  appSrv.get('/ping', (req, res) => res.json({ ok: true, app: 'sened', rev: currentRev() }));
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
    s.on('connection', (sock) => { hostSockets.add(sock); sock.on('close', () => hostSockets.delete(sock)); });
    s.listen(PORT, '127.0.0.1', () => resolve(s));
  });
}

function stopHost(server) {
  return new Promise((resolve) => {
    for (const res of sseClients) { try { res.end(); } catch (e) {} }
    sseClients.clear();
    for (const sock of hostSockets) { try { sock.destroy(); } catch (e) {} }
    hostSockets.clear();
    server.close(() => resolve());
  });
}

// ---------- العميل (نسخة منطق main.js: طابور إعادة الإرسال + المجرى) ----------
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sened-pending-test-'));
const PENDING_SYNC_FILE = () => path.join(tmpDir, 'pending-sync.json');
const CLIENT_DATA_FILE = () => path.join(tmpDir, 'sened-data.json');

function readPendingSync() {
  try {
    if (fs.existsSync(PENDING_SYNC_FILE())) return JSON.parse(fs.readFileSync(PENDING_SYNC_FILE(), 'utf8'));
  } catch (e) {}
  return null;
}
function writePendingSync(data) {
  fs.writeFileSync(PENDING_SYNC_FILE(), JSON.stringify(data, null, 2), 'utf8');
}
function clearPendingSync() {
  try { if (fs.existsSync(PENDING_SYNC_FILE())) fs.unlinkSync(PENDING_SYNC_FILE()); } catch (e) {}
}

// نفس دلالات postToHost في main.js: فشل ⇐ كتابة الطابور، نجاح ⇐ مسحه
function postToHost(data, opts = {}) {
  let failNotified = false;
  const fail = (msg) => {
    if (failNotified) return;
    failNotified = true;
    if (!opts.isPendingFlush) writePendingSync(data);
    if (opts.onFail) opts.onFail(msg);
  };
  try {
    const req = http.request({
      hostname: '127.0.0.1', port: PORT, path: '/sync', method: 'POST',
      headers: { 'Content-Type': 'application/json' }, timeout: 5000
    }, (res) => {
      if (res.statusCode !== 200) fail('http ' + res.statusCode);
      else clearPendingSync();
      res.resume();
    });
    req.on('error', (e) => fail(e.message));
    req.on('timeout', () => { req.destroy(); fail('timeout'); });
    req.write(JSON.stringify(data));
    req.end();
  } catch (err) { fail(err.message); }
}

function flushPendingSync() {
  const pending = readPendingSync();
  if (!pending) return;
  postToHost(pending, { isPendingFlush: true });
}

// نفس منطق connectClientStream: عند نجاح الاتصال يُرسَل الطابور قبل تطبيق أي بث وارد
function connectClientStream() {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: '127.0.0.1', port: PORT, path: '/events', headers: { Accept: 'text/event-stream' } },
      (res) => {
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
        flushPendingSync();
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
            if (event === 'update' && data) {
              // البث الوارد يكتب فوق الملف المحلي (نفس سلوك main.js)
              fs.writeFileSync(CLIENT_DATA_FILE(), JSON.stringify(JSON.parse(data), null, 2), 'utf8');
            }
          }
        });
        resolve(req);
      }
    );
    req.on('error', () => resolve(null));
  });
}

// حفظ محلي على العميل (نفس saveData في وضع العميل): إرسال للمضيف + كتابة محلية
function clientSave(data) {
  postToHost(data);
  fs.writeFileSync(CLIENT_DATA_FILE(), JSON.stringify(data, null, 2), 'utf8');
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async function run() {
  let failed = 0;
  const assert = (cond, msg) => { console.log((cond ? '✓' : '✗ FAIL') + ' ' + msg); if (!cond) failed++; };

  // 1) المضيف يعمل والعميل متصل، فاتورة أولى تصل طبيعياً
  let server = await startHost();
  let stream = await connectClientStream();
  await sleep(200);
  clientSave({ invoices: [{ id: 'INV-1', total: 500 }] });
  await sleep(300);
  assert(store.invoices.length === 1 && store.invoices[0].id === 'INV-1', 'الوضع الطبيعي: الفاتورة الأولى وصلت للمضيف');
  assert(readPendingSync() === null, 'لا طابور معلّق بعد إرسال ناجح');

  // 2) إيقاف المضيف — الكاشير يصدر فاتورة أثناء الانقطاع
  await stopHost(server);
  if (stream) stream.destroy();
  await sleep(200);
  clientSave({ invoices: [{ id: 'INV-1', total: 500 }, { id: 'INV-2', total: 300 }] });
  await sleep(500); // مهلة ليفشل POST (ECONNREFUSED فوري)
  const pending = readPendingSync();
  assert(pending && pending.invoices && pending.invoices.length === 2, 'فشل الإرسال أثناء الانقطاع كتب الحالة في pending-sync.json');
  const localData = JSON.parse(fs.readFileSync(CLIENT_DATA_FILE(), 'utf8'));
  assert(localData.invoices.length === 2, 'الفاتورة الجديدة محفوظة محلياً على العميل');

  // 3) إعادة تشغيل المضيف (بحالته القديمة: فاتورة واحدة فقط) — العميل يعيد الاتصال
  store = { invoices: [{ id: 'INV-1', total: 500 }], _rev: 1 }; // المضيف لا يعرف INV-2
  server = await startHost();
  stream = await connectClientStream();

  // 4) خلال ثوانٍ: الطابور يصل للمضيف قبل أن يمحوه أي بث، وتظهر INV-2 عنده
  await sleep(1500);
  assert(store.invoices.length === 2 && store.invoices.some(i => i.id === 'INV-2'),
    'بعد عودة المضيف: فاتورة الانقطاع (INV-2) وصلت للمضيف خلال ثوانٍ — لا ضياع صامت');
  assert(readPendingSync() === null, 'الطابور مُسح بعد نجاح إعادة الإرسال');
  const localAfter = JSON.parse(fs.readFileSync(CLIENT_DATA_FILE(), 'utf8'));
  assert(localAfter.invoices.length === 2 && localAfter.invoices.some(i => i.id === 'INV-2'),
    'البث العائد من المضيف يحوي الفاتورة — الملف المحلي سليم');

  if (stream) stream.destroy();
  await stopHost(server);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  console.log('\n' + (failed === 0 ? 'كل الاختبارات نجحت ✓' : failed + ' اختبار(ات) فشلت ✗'));
  process.exit(failed === 0 ? 0 : 1);
})();
