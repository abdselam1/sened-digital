// اختبار شامل: خادم مضيف بنفس منطق main.js (رمز + أسماء أجهزة) + عميلان + اكتشاف UDP
const http = require('http');
const dgram = require('dgram');
const express = require('express');
const cors = require('cors');

const PORT = 3070, UDP = 3071, TOKEN = '482913';
let store = { customers: [], invoices: [], _rev: 0 };
const sse = new Set();
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('✓', m)) : (fail++, console.log('✗', m)); };

// ===== مضيف مطابق لـ main.js =====
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use((req, res, next) => {
  if (TOKEN && req.get('x-sened-token') !== TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
});
app.get('/ping', (q, r) => r.json({ ok: true, app: 'sened', name: 'جهاز المدير', rev: store._rev, clients: sse.size }));
app.get('/sync', (q, r) => r.json(store));
app.post('/sync', (q, r) => {
  const inc = q.body || {}; inc._rev = (store._rev || 0) + 1; inc._ts = new Date().toISOString();
  store = inc; r.json({ ok: true, rev: inc._rev });
  const msg = `event: update\ndata: ${JSON.stringify(inc)}\n\n`;
  for (const s of sse) { try { s.write(msg); } catch (e) {} }
});
app.get('/events', (q, r) => {
  r.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  r.flushHeaders && r.flushHeaders();
  r.write(`event: hello\ndata: {}\n\n`);
  r._deviceName = decodeURIComponent(q.get('x-sened-device') || '');
  sse.add(r);
  q.on('close', () => sse.delete(r));
});
const srv = http.createServer(app).listen(PORT);

// بثّ UDP مثل startDiscoveryBeacon
const beacon = dgram.createSocket({ type: 'udp4', reuseAddr: true });
beacon.bind(() => { try { beacon.setBroadcast(true); } catch(e){}
  setInterval(() => { const m = Buffer.from(JSON.stringify({ app:'sened', name:'جهاز المدير', ip:'127.0.0.1', port: PORT }));
    beacon.send(m, 0, m.length, UDP, '127.0.0.1'); }, 250); });

const get = (path, headers = {}) => new Promise((res) => {
  http.get({ host: '127.0.0.1', port: PORT, path, headers }, (r) => {
    let b = ''; r.on('data', c => b += c); r.on('end', () => res({ code: r.statusCode, body: b }));
  });
});
const post = (path, data, headers = {}) => new Promise((res) => {
  const rq = http.request({ host: '127.0.0.1', port: PORT, path, method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers } }, (r) => {
    let b = ''; r.on('data', c => b += c); r.on('end', () => res({ code: r.statusCode, body: b }));
  }); rq.write(JSON.stringify(data)); rq.end();
});

(async () => {
  // 1) الحماية: طلب بلا كود اقتران يُرفض
  let r = await get('/ping');
  ok(r.code === 401, 'الحماية: رفض طلب بلا كود اقتران (401)');
  r = await get('/ping', { 'x-sened-token': 'wrong' });
  ok(r.code === 401, 'الحماية: رفض كود خاطئ (401)');
  r = await get('/ping', { 'x-sened-token': TOKEN });
  const ping = JSON.parse(r.body);
  ok(r.code === 200 && ping.ok && ping.name === 'جهاز المدير', 'ping يعمل ويعيد اسم المضيف');

  // 2) عميلان باسمين، أحدهما يرسل تعديلاً والآخر يستقبله لحظياً
  const events = [];
  const connectClient = (name) => new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: PORT, path: '/events',
      headers: { Accept: 'text/event-stream', 'x-sened-token': TOKEN, 'x-sened-device': encodeURIComponent(name) } },
      (res) => { res.setEncoding('utf8');
        let buf = '';
        res.on('data', (c) => { buf += c; let i;
          while ((i = buf.indexOf('\n\n')) !== -1) { const raw = buf.slice(0, i); buf = buf.slice(i + 2);
            if (raw.includes('event: update')) { const d = raw.split('data:')[1]; events.push({ name, data: JSON.parse(d.trim()) }); } }
        });
        setTimeout(resolve, 200); });
  });
  await connectClient('كاشير 1');
  await connectClient('محاسب');
  ok(sse.size === 2, 'اتصال عميلين عبر SSE');
  const names = [...sse].map(s => s._deviceName);
  ok(names.includes('كاشير 1') && names.includes('محاسب'), 'أسماء الأجهزة تصل للمضيف: ' + names.join('، '));

  // 3) تعديل: زبون جديد برقم حساب — يصل للجميع مع رفع المراجعة
  r = await post('/sync', { customers: [{ id: 'c1', accountNo: 'C-0001', name: 'أحمد' }], invoices: [], _rev: store._rev },
    { 'x-sened-token': TOKEN, 'x-sened-device': encodeURIComponent('كاشير 1') });
  ok(r.code === 200 && JSON.parse(r.body).rev === 1, 'المضيف قبل التعديل ورفع المراجعة إلى 1');
  await new Promise(s => setTimeout(s, 300));
  ok(events.length === 2, 'التحديث بُثّ لكلا العميلين لحظياً');
  ok(events.every(e => e.data.customers[0].accountNo === 'C-0001'), 'رقم حساب الزبون C-0001 وصل سليماً');

  // 4) الاكتشاف التلقائي
  const found = new Map();
  const l = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  l.on('message', (b, ri) => { try { const d = JSON.parse(b); if (d.app === 'sened') found.set(d.ip + ':' + d.port, d); } catch(e){} });
  l.bind(UDP);
  await new Promise(s => setTimeout(s, 900));
  const h = [...found.values()][0];
  ok(found.size === 1 && h.name === 'جهاز المدير' && h.port === PORT, 'الاكتشاف التلقائي وجد الخادم بالاسم والعنوان');

  // 5) منطق رقم الحساب (نفس دالة app.js)
  function nextNo(customers) { const mx = customers.reduce((m, c) => { const n = parseInt(String(c.accountNo || '').replace(/^C-/, ''), 10); return Number.isFinite(n) && n > m ? n : m; }, 0); return 'C-' + String(mx + 1).padStart(4, '0'); }
  ok(nextNo([]) === 'C-0001', 'أول رقم حساب: C-0001');
  ok(nextNo([{accountNo:'C-0001'},{accountNo:'C-0007'},{accountNo:''},{}]) === 'C-0008', 'التسلسل يتخطى الفراغات: C-0008');
  ok(nextNo([{accountNo:'C-9999'}]) === 'C-10000', 'تجاوز 4 خانات لا يكسر الترقيم');

  console.log(`\nالنتيجة: ${pass} نجح / ${fail} فشل`);
  process.exit(fail ? 1 : 0);
})();
