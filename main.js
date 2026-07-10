const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const os = require('os');

function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of (nets[name] || [])) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

// ==========================================================================
//  التزامن عبر الشبكة المحلية (LAN Sync)
//  النموذج: جهاز واحد "مضيف" (host) يشغّل خادم HTTP + SSE ويملك النسخة المرجعية.
//  الأجهزة الأخرى "عملاء" (client) يتصلون به: يسحبون الحالة أولاً ثم يستقبلون
//  التحديثات لحظياً عبر SSE، ويرسلون تعديلاتهم عبر POST فيخزّنها المضيف ويبثّها.
//  إعداد الشبكة محلي لكل جهاز (lan-config.json) ولا يدخل أبداً ضمن بيانات التطبيق
//  المزامَنة، وإلا لانتشر عنوان/دور جهاز واحد إلى بقية الأجهزة.
// ==========================================================================
const SYNC_PORT_DEFAULT = 3050;
const DISCOVERY_PORT = 3051; // منفذ UDP للاكتشاف التلقائي للخادم على الشبكة المحلية
const LAN_FILE = () => path.join(app.getPath('userData'), 'lan-config.json');

function readLanConfig() {
  try {
    if (fs.existsSync(LAN_FILE())) {
      const c = JSON.parse(fs.readFileSync(LAN_FILE(), 'utf8')) || {};
      return {
        role: c.role || 'off', hostIp: c.hostIp || '', port: Number(c.port) || SYNC_PORT_DEFAULT,
        token: c.token || '', deviceName: c.deviceName || '', lastHostIp: c.lastHostIp || ''
      };
    }
  } catch (e) { console.error('lan config read error', e.message); }
  return { role: 'off', hostIp: '', port: SYNC_PORT_DEFAULT, token: '', deviceName: '', lastHostIp: '' };
}
function writeLanConfig(patch) {
  const next = { ...readLanConfig(), ...patch };
  fs.writeFileSync(LAN_FILE(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

// ==========================================================================
//  الاكتشاف التلقائي (UDP Discovery) — بلا إدخال IP يدوياً
//  المضيف يبثّ وجوده (اسمه وعنوانه) كل ثانيتين على منفذ UDP 3051 بثّاً عامّاً،
//  والأجهزة الأخرى تستمع فتعرض «تم العثور على خادم سند» وتتصل بضغطة واحدة.
//  لو تغيّر IP المضيف (إعادة تشغيل الراوتر) يكفي إعادة البحث — لا حفظ يدوي.
// ==========================================================================
const dgram = require('dgram');
let discoveryTimer = null;   // مؤقّت البثّ في وضع المضيف
let beaconSocket = null;     // مقبس UDP المرسِل

function startDiscoveryBeacon() {
  stopDiscoveryBeacon();
  try {
    beaconSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    beaconSocket.on('error', (e) => console.error('discovery beacon error:', e.message));
    beaconSocket.bind(() => {
      try { beaconSocket.setBroadcast(true); } catch (e) {}
      const send = () => {
        const cfg = readLanConfig();
        if (cfg.role !== 'host' || !beaconSocket) return;
        const msg = Buffer.from(JSON.stringify({
          app: 'sened', name: cfg.deviceName || 'Sened', ip: getLocalIp(), port: cfg.port
        }));
        try { beaconSocket.send(msg, 0, msg.length, DISCOVERY_PORT, '255.255.255.255'); } catch (e) {}
      };
      send();
      discoveryTimer = setInterval(send, 2000);
    });
  } catch (err) { console.error('discovery beacon failed:', err.message); }
}

function stopDiscoveryBeacon() {
  if (discoveryTimer) { clearInterval(discoveryTimer); discoveryTimer = null; }
  if (beaconSocket) { try { beaconSocket.close(); } catch (e) {} beaconSocket = null; }
}

// البحث عن مضيفين: يستمع على منفذ الاكتشاف لثوانٍ قليلة ويعيد قائمة فريدة {name, ip, port}
function discoverHosts(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const found = new Map();
    let sock;
    try { sock = dgram.createSocket({ type: 'udp4', reuseAddr: true }); }
    catch (e) { return resolve([]); }
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      try { sock.close(); } catch (e) {}
      resolve([...found.values()]);
    };
    sock.on('error', finish);
    sock.on('message', (buf, rinfo) => {
      try {
        const d = JSON.parse(buf.toString('utf8'));
        if (d && d.app === 'sened') {
          const ip = d.ip || rinfo.address;
          const port = Number(d.port) || SYNC_PORT_DEFAULT;
          found.set(ip + ':' + port, { name: String(d.name || ''), ip, port });
        }
      } catch (e) { /* رسالة غريبة على المنفذ — تُتجاهل */ }
    });
    try { sock.bind(DISCOVERY_PORT); } catch (e) { return finish(); }
    setTimeout(finish, timeoutMs);
  });
}

// ==========================================================================
//  قفل دور الجهاز (device-role.json) — محلي لكل جهاز مثل lan-config تماماً،
//  ولا يدخل أبداً ضمن بيانات التطبيق المزامَنة (وإلا لانتشر قفل جهاز واحد للبقية).
//  بعد أول دخول بدور تشغيلي (محاسب/كاشير) يُربط الجهاز به فلا يقبل دوراً آخر.
//  المدير وحده يتجاوز القفل ويستطيع إعادة تعيين/مسح ربط الجهاز.
// ==========================================================================
const DEVICE_ROLE_FILE = () => path.join(app.getPath('userData'), 'device-role.json');
const VALID_DEVICE_ROLES = ['manager', 'accountant', 'cashier'];
function readDeviceRole() {
  try {
    if (fs.existsSync(DEVICE_ROLE_FILE())) {
      const c = JSON.parse(fs.readFileSync(DEVICE_ROLE_FILE(), 'utf8')) || {};
      return { role: VALID_DEVICE_ROLES.includes(c.role) ? c.role : null, boundAt: c.boundAt || '' };
    }
  } catch (e) { console.error('device role read error', e.message); }
  return { role: null, boundAt: '' };
}
function writeDeviceRole(role) {
  const next = VALID_DEVICE_ROLES.includes(role)
    ? { role, boundAt: new Date().toISOString() }
    : { role: null, boundAt: '' };
  fs.writeFileSync(DEVICE_ROLE_FILE(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

// ==========================================================================
//  تفضيلات العرض المحلية (ui-prefs.json) — لغة وسمة هذا الجهاز فقط.
//  محلية مثل lan-config تماماً ولا تدخل البيانات المزامَنة: لولا ذلك لقلب تغييرُ
//  المحاسب للغة واجهاتِ كل الأجهزة. القيمة الفارغة = استعمل الإعداد المشترك (توافق رجعي).
// ==========================================================================
const UI_PREFS_FILE = () => path.join(app.getPath('userData'), 'ui-prefs.json');
function readUiPrefs() {
  try {
    if (fs.existsSync(UI_PREFS_FILE())) {
      const c = JSON.parse(fs.readFileSync(UI_PREFS_FILE(), 'utf8')) || {};
      return {
        lang: ['ar', 'fr', 'en'].includes(c.lang) ? c.lang : '',
        theme: ['dark', 'light'].includes(c.theme) ? c.theme : ''
      };
    }
  } catch (e) { console.error('ui prefs read error', e.message); }
  return { lang: '', theme: '' };
}
function writeUiPrefs(patch) {
  // نتجاهل المفاتيح غير المرسَلة (undefined) كي لا تمسح قيمة محفوظة
  const clean = {};
  ['lang', 'theme'].forEach(k => { if (patch && patch[k] !== undefined) clean[k] = patch[k]; });
  const next = { ...readUiPrefs(), ...clean };
  fs.writeFileSync(UI_PREFS_FILE(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

let hostServer = null;        // خادم HTTP في وضع المضيف
let sseClients = new Set();   // اتصالات SSE المفتوحة من الأجهزة العميلة
let clientStream = null;      // اتصال SSE الصادر في وضع العميل
let clientConnected = false;
let clientReconnectTimer = null;
let hostServerError = '';     // سبب فشل تشغيل خادم المضيف ('' = يعمل أو متوقف عمداً) — يُعرض في لوحة الشبكة
let hostIpChangedFrom = '';   // عنوان المضيف في آخر تشغيل إن اختلف عن الحالي (تنبيه «حدّث الأجهزة»)
let clientSeq = 0;            // معرّف تسلسلي لاتصالات SSE (لفصل جهاز بعينه)

// سجل الأجهزة التي اتصلت بهذا المضيف خلال الجلسة: name|ip ← { id, name, ip, connected, lastSeen }
// في الذاكرة فقط (يبدأ فارغاً مع كل تشغيل) — ليس بيانات مزامَنة ولا يُخزَّن في lan-config.json.
let clientRegistry = new Map();
function touchClientRegistry(name, ip) {
  if (!name && !ip) return;
  const key = (name || '') + '|' + (ip || '');
  const cur = clientRegistry.get(key);
  if (cur) { cur.lastSeen = Date.now(); }
  else clientRegistry.set(key, { id: 0, name: name || ip, ip: ip || '', connected: false, lastSeen: Date.now() });
}

// رقم مراجعة الحالة الحالية (يقرأ من الملف المخزَّن)
function currentRev() {
  try {
    if (fs.existsSync(DATA_FILE())) {
      const d = JSON.parse(fs.readFileSync(DATA_FILE(), 'utf8'));
      return (d && d._rev) || 0;
    }
  } catch (e) {}
  return 0;
}

// بثّ الحالة الكاملة لكل الأجهزة العميلة المتصلة (وضع المضيف)
function broadcastToClients(payloadStr) {
  const msg = `event: update\ndata: ${payloadStr}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch (e) { /* اتصال مقطوع؛ يُنظَّف عند حدث close */ }
  }
}

// ==========================================================================
//  طابور إعادة الإرسال (pending-sync.json) — منع ضياع فواتير الانقطاع
//  لو أصدر الكاشير فواتير والخادم متوقف، تُحفَظ محلياً فقط؛ وبدون هذا الطابور
//  كان أول بث من المضيف بعد عودة الاتصال يكتب حالته فوق الملف المحلي فتضيع
//  الفواتير نهائياً بلا تنبيه. الحل: كل POST فاشل يخزّن لقطة الحالة كاملة في
//  ملف محلي يصمد أمام إعادة التشغيل، وتُرسَل للمضيف عند أول اتصال ناجح.
//  الملف محلي لكل جهاز مثل lan-config.json — لا يدخل البيانات المزامَنة أبداً.
// ==========================================================================
const PENDING_SYNC_FILE = () => path.join(app.getPath('userData'), 'pending-sync.json');
function readPendingSync() {
  try {
    if (fs.existsSync(PENDING_SYNC_FILE())) return JSON.parse(fs.readFileSync(PENDING_SYNC_FILE(), 'utf8'));
  } catch (e) { console.error('pending sync read error', e.message); }
  return null;
}
function writePendingSync(data) {
  try { fs.writeFileSync(PENDING_SYNC_FILE(), JSON.stringify(data, null, 2), 'utf8'); }
  catch (e) { console.error('pending sync write error', e.message); }
}
function clearPendingSync() {
  try { if (fs.existsSync(PENDING_SYNC_FILE())) fs.unlinkSync(PENDING_SYNC_FILE()); } catch (e) {}
}

// إرسال الطابور للمضيف: يُستدعى فور نجاح الاتصال وقبل تطبيق أي بث وارد يمحوه.
// إن فشل الإرسال والاتصال ما زال قائماً (حالة نادرة: SSE يعمل وPOST يُرفض)
// يعيد المحاولة كل 5 ثوانٍ — الملف لا يُمسح إلا بوصول حالة أحدث للمضيف.
let pendingFlushTimer = null;
function flushPendingSync() {
  const pending = readPendingSync();
  if (!pending) return;
  postToHost(pending, {
    isPendingFlush: true,
    onFail: () => {
      if (pendingFlushTimer) return;
      pendingFlushTimer = setTimeout(() => {
        pendingFlushTimer = null;
        if (clientConnected) flushPendingSync();
      }, 5000);
    }
  });
}

// إرسال تعديل من العميل إلى المضيف (المضيف يخزّن ويبثّ للجميع)
// عند الفشل لا نكتفي بالسجل: نبلّغ الواجهة (sync:postFailed) لعرض تنبيه واضح للمستخدم،
// وإلا ظنّ المحاسب أن قيده وصل للخادم بينما الاتصال منقطع.
function notifySyncPostFailed() {
  try { if (win && !win.isDestroyed()) win.webContents.send('sync:postFailed'); } catch (e) {}
}
function postToHost(data, opts = {}) {
  const cfg = readLanConfig();
  if (!cfg.hostIp) return;
  let failNotified = false; // الفشل قد يصل من أكثر من حدث (timeout ثم error) — تنبيه واحد يكفي
  const fail = (msg) => {
    if (failNotified) return;
    failNotified = true;
    console.error('post to host error:', msg);
    // الحالة لم تصل للمضيف: تُحفَظ في طابور إعادة الإرسال كي لا يمحوها أول بث بعد
    // عودة الاتصال. (إعادة إرسال طابور قائم لا تعيد كتابته كي لا تدهس حفظاً أحدث)
    if (!opts.isPendingFlush) writePendingSync(data);
    notifySyncPostFailed();
    if (opts.onFail) opts.onFail(msg);
  };
  try {
    const req = http.request({
      hostname: cfg.hostIp, port: cfg.port, path: '/sync', method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'x-sened-token': cfg.token || '',
        'x-sened-device': encodeURIComponent(cfg.deviceName || '')
      }, timeout: 5000
    }, (res) => {
      // رفض المضيف (401 رمز خاطئ / خطأ خادم) فشلٌ أيضاً وإن نجح الاتصال شبكياً
      if (res.statusCode !== 200) fail('http ' + res.statusCode);
      // وصلت حالة أحدث للمضيف — أي طابور سابق أصبح متجاوَزاً (آخر إرسال يفوز)
      else clearPendingSync();
      res.resume();
    });
    req.on('error', (e) => fail(e.message));
    req.on('timeout', () => { req.destroy(); fail('timeout'); });
    req.write(JSON.stringify(data));
    req.end();
  } catch (err) { fail(err.message); }
}

function startHostServer() {
  try {
    const cfg = readLanConfig();
    const express = require('express');
    const cors = require('cors');
    const srvApp = express();
    srvApp.use(cors());
    srvApp.use(express.json({ limit: '50mb' }));

    // حماية اختيارية برمز مشترك: إن ضُبط رمز على المضيف، يُرفض أي طلب لا يحمله في ترويسة x-sened-token.
    // هكذا لا يستطيع أي جهاز غريب على نفس الشبكة قراءة البيانات أو تعديلها ولو عرف عنوان المضيف.
    srvApp.use((req, res, next) => {
      const tok = readLanConfig().token;
      if (tok && req.get('x-sened-token') !== tok) return res.status(401).json({ error: 'unauthorized' });
      next();
    });

    // فحص اتصال سريع للأجهزة العميلة — يعيد أيضاً اسم جهاز المضيف ليعرفه العميل
    srvApp.get('/ping', (req, res) => {
      res.json({ ok: true, app: 'sened', name: readLanConfig().deviceName || '', rev: currentRev(), clients: sseClients.size });
    });

    // الحالة الكاملة الحالية (تحميل أولي لدى العميل)
    srvApp.get('/sync', (req, res) => {
      try {
        if (fs.existsSync(DATA_FILE())) res.type('application/json').send(fs.readFileSync(DATA_FILE(), 'utf8'));
        else res.json({});
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // العميل يرسل تعديلاً: المضيف مصدر الحقيقة — يخزّن، يرفع رقم المراجعة، يبثّ للجميع
    srvApp.post('/sync', (req, res) => {
      try {
        const incoming = req.body || {};
        incoming._rev = currentRev() + 1;
        incoming._ts = new Date().toISOString();
        const str = JSON.stringify(incoming, null, 2);
        fs.writeFileSync(DATA_FILE(), str, 'utf8');
        res.json({ ok: true, rev: incoming._rev });
        // تحديث «آخر ظهور» للجهاز المرسِل في جدول الأجهزة المتصلة
        touchClientRegistry(decodeURIComponent(req.get('x-sened-device') || ''), (req.socket.remoteAddress || '').replace('::ffff:', ''));
        broadcastToClients(JSON.stringify(incoming));
        if (win) win.webContents.send('sync:updated');
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // مجرى الأحداث اللحظي (Server-Sent Events): يبقى مفتوحاً ويستقبل البثّ
    srvApp.get('/events', (req, res) => {
      res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });
      if (res.flushHeaders) res.flushHeaders();
      res.write(`event: hello\ndata: ${JSON.stringify({ rev: currentRev() })}\n\n`);
      // اسم الجهاز العميل (من ترويسة x-sened-device) ليعرف المدير مَن المتصل
      const clientIp = (req.socket.remoteAddress || '').replace('::ffff:', '');
      res._deviceName = decodeURIComponent(req.get('x-sened-device') || '') || clientIp;
      res._clientId = ++clientSeq;
      // تسجيل الجهاز في جدول «الأجهزة المتصلة» (اسم — حالة — آخر ظهور)
      const regKey = res._deviceName + '|' + clientIp;
      res._regKey = regKey;
      clientRegistry.set(regKey, { id: res._clientId, name: res._deviceName, ip: clientIp, connected: true, lastSeen: Date.now() });
      sseClients.add(res);
      if (win) win.webContents.send('sync:updated'); // تحديث عدّاد الأجهزة المتصلة في الواجهة
      const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);
      req.on('close', () => {
        clearInterval(hb); sseClients.delete(res);
        const entry = clientRegistry.get(regKey);
        if (entry && entry.id === res._clientId) { entry.connected = false; entry.lastSeen = Date.now(); }
        if (win) win.webContents.send('sync:updated');
      });
    });

    hostServer = http.createServer(srvApp);
    hostServerError = '';
    // فشل التشغيل (أشهره: المنفذ محجوز EADDRINUSE) يجب أن يظهر للمدير في لوحة الشبكة، لا في console فقط
    hostServer.on('error', (e) => {
      console.error('Host server error:', e.message);
      hostServerError = (e && e.code === 'EADDRINUSE') ? 'EADDRINUSE' : (e.message || 'error');
      try { hostServer.close(); } catch (e2) {}
      hostServer = null;
      if (win) win.webContents.send('sync:updated');
    });
    hostServer.listen(cfg.port, '0.0.0.0', () => {
      console.log(`Sened host server listening on ${getLocalIp()}:${cfg.port}`);
      hostServerError = '';
      // تنبيه تغيّر العنوان: قارن IP الحالي بآخر تشغيل (محفوظ محلياً في lan-config.json)
      const ip = getLocalIp();
      if (ip && ip !== '127.0.0.1') {
        if (cfg.lastHostIp && cfg.lastHostIp !== ip) hostIpChangedFrom = cfg.lastHostIp;
        if (cfg.lastHostIp !== ip) writeLanConfig({ lastHostIp: ip });
      }
      if (win) win.webContents.send('sync:updated');
    });
    startDiscoveryBeacon(); // يبثّ وجود الخادم على الشبكة ليكتشفه بقية الأجهزة تلقائياً
  } catch (err) {
    console.error('Failed to start host server:', err.message);
    hostServerError = err.message || 'error';
  }
}

function stopHostServer() {
  stopDiscoveryBeacon();
  for (const res of sseClients) { try { res.end(); } catch (e) {} }
  sseClients.clear();
  if (hostServer) { try { hostServer.close(); } catch (e) {} hostServer = null; }
}

function stopClientSync() {
  clientConnected = false;
  if (clientReconnectTimer) { clearTimeout(clientReconnectTimer); clientReconnectTimer = null; }
  if (pendingFlushTimer) { clearTimeout(pendingFlushTimer); pendingFlushTimer = null; }
  if (clientStream) { try { clientStream.destroy(); } catch (e) {} clientStream = null; }
}

function scheduleClientReconnect() {
  if (clientReconnectTimer) return;
  clientReconnectTimer = setTimeout(() => { clientReconnectTimer = null; connectClientStream(); }, 3000);
}

// وضع العميل: يفتح مجرى SSE ويطبّق كل تحديث يبثّه المضيف على الملف المحلي
function connectClientStream() {
  const cfg = readLanConfig();
  if (cfg.role !== 'client' || !cfg.hostIp) return;
  const req = http.get(
    {
      hostname: cfg.hostIp, port: cfg.port, path: '/events',
      headers: { Accept: 'text/event-stream', 'x-sened-token': cfg.token || '', 'x-sened-device': encodeURIComponent(cfg.deviceName || '') }
    },
    (res) => {
      if (res.statusCode !== 200) { res.resume(); clientConnected = false; scheduleClientReconnect(); return; }
      clientConnected = true;
      // أول اتصال ناجح: أرسل أي حالة محلية لم تصل أثناء الانقطاع (فواتير الكاشير)
      // قبل تطبيق أي بث وارد من المضيف يكتب فوقها — وإلا ضاعت بلا تنبيه.
      flushPendingSync();
      if (win) win.webContents.send('sync:updated'); // تحديث مؤشر الاتصال
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
            try {
              const parsed = JSON.parse(data);
              fs.writeFileSync(DATA_FILE(), JSON.stringify(parsed, null, 2), 'utf8');
              if (win) win.webContents.send('sync:updated');
            } catch (e) { console.error('client apply error:', e.message); }
          }
        }
      });
      res.on('end', () => { clientConnected = false; if (win) win.webContents.send('sync:updated'); scheduleClientReconnect(); });
      res.on('error', () => { clientConnected = false; scheduleClientReconnect(); });
    }
  );
  clientStream = req;
  req.on('error', () => { clientConnected = false; scheduleClientReconnect(); });
}

// سحب الحالة الكاملة من المضيف (وعد بمهلة قصيرة) — يُستخدم عند التحميل الأولي للعميل
function pullFromHost() {
  return new Promise((resolve) => {
    const cfg = readLanConfig();
    if (cfg.role !== 'client' || !cfg.hostIp) return resolve(null);
    const req = http.get({ hostname: cfg.hostIp, port: cfg.port, path: '/sync', timeout: 2500, headers: { 'x-sened-token': cfg.token || '' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => body += c);
      res.on('end', () => {
        try { const parsed = JSON.parse(body); resolve(parsed && Object.keys(parsed).length ? parsed : null); }
        catch (e) { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

// تطبيق وضع الشبكة الحالي: يوقف أي خادم/اتصال سابق ثم يشغّل ما يناسب الدور
function applyLanMode() {
  const cfg = readLanConfig();
  stopHostServer();
  stopClientSync();
  if (cfg.role === 'host') startHostServer();
  else if (cfg.role === 'client' && cfg.hostIp) connectClientStream();
}


let win = null;
const DATA_FILE = () => path.join(app.getPath('userData'), 'sened-data.json');

// إعدادات مدمجة (builtin-ai.json) تُشحن مع نسخة التطبيق الموزّعة، مُستثناة من المستودع العام عبر .gitignore.
// تحمل: مفتاح Groq المشترك (apiKey) + كود تفعيل المطوّر (activationCode). لا يُرفع أيٌّ منهما للمستودع العام.
let BUILTIN_CFG = null;
function readBuiltinConfig() {
  if (BUILTIN_CFG) return BUILTIN_CFG;
  try {
    const p = path.join(__dirname, 'builtin-ai.json');
    if (fs.existsSync(p)) { BUILTIN_CFG = JSON.parse(fs.readFileSync(p, 'utf8')) || {}; return BUILTIN_CFG; }
  } catch (e) { /* تجاهل */ }
  BUILTIN_CFG = {};
  return BUILTIN_CFG;
}
function writeBuiltinConfig(patch) {
  const p = path.join(__dirname, 'builtin-ai.json');
  const next = { ...readBuiltinConfig(), ...patch };
  fs.writeFileSync(p, JSON.stringify(next, null, 2), 'utf8');
  BUILTIN_CFG = null; // أعد التحميل في المرة القادمة
}
// نكهة النسخة الموزّعة: 'admin' (كل الصلاحيات) أو 'cashier' (كاشير فقط). الافتراضي 'full' لنسخة التطوير.
function appFlavor() { return readBuiltinConfig().flavor || 'full'; }

// المفتاح المشترك للذكاء الاصطناعي يُخزَّن **مموَّهاً** (XOR + Base64) في builtin-ai.json تحت `apiKeyEnc`
// حتى لا يظهر كنص صريح ولا تلتقطه ماسحات الأسرار في المستودعات. هذا تمويهٌ ضد الرؤية المباشرة فقط
// (وليس تشفيراً قوياً — المفتاح المشترك مجاني ومقصود توزيعه على الزبائن). الحماية الحقيقية = مستودع خاص.
const AI_OBF_KEY = 'sened::builtin::v1';
function xorB64(buf) {
  const k = Buffer.from(AI_OBF_KEY, 'utf8');
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ k[i % k.length];
  return out;
}
function deobfuscate(b64) {
  try { return xorB64(Buffer.from(String(b64), 'base64')).toString('utf8'); } catch (e) { return ''; }
}
function obfuscate(str) { return xorB64(Buffer.from(String(str), 'utf8')).toString('base64'); }

// المفتاح الفعّال المدمج: النص الصريح إن وُجد (نسخة تطوير)، وإلا فكّ تمويه apiKeyEnc.
function builtinApiKey() {
  const cfg = readBuiltinConfig();
  return cfg.apiKey || (cfg.apiKeyEnc ? deobfuscate(cfg.apiKeyEnc) : '');
}
function builtinAiProvider() {
  const cfg = readBuiltinConfig();
  const key = builtinApiKey();
  if (key) return { id: 'builtin', name: cfg.name || 'Sened AI', type: 'openai-compatible', baseUrl: cfg.baseUrl || 'https://api.groq.com/openai/v1', apiKey: key, model: cfg.model || 'llama-3.3-70b-versatile', builtin: true };
  return null;
}
// كود التفعيل الرسمي المدمج في التطبيق (مفتاح المطوّر). يظل مطلوباً على كل جهاز حتى لو
// حُذف ملف builtin-ai.json أو عُدِّل، فالتطبيق لا يعمل رسمياً إلا بعد التفعيل بهذا الكود.
const OFFICIAL_ACTIVATION_CODE = 'Ab32222206';
// سرّ توقيع حالة التفعيل: يمنع تزوير ملف التفعيل يدوياً (نسخه من جهاز لآخر لا يصلح لأن البصمة تختلف،
// وتحرير الملف يدوياً لا يصلح لأن التوقيع لن يطابق ما لم يُعرف هذا السرّ).
const ACTIVATION_SECRET = 'Sened::activation::v1::b1nd-9f3a7c1e5d20';
function activationSignature(fingerprint) {
  return crypto.createHmac('sha256', ACTIVATION_SECRET).update(String(fingerprint)).digest('hex');
}
function builtinActivationCode() { return readBuiltinConfig().activationCode || OFFICIAL_ACTIVATION_CODE; }

// بصمة الجهاز الفعلية (اسم الجهاز + عناوين الشبكة MAC) — ثابتة على نفس الجهاز، تتغيّر عند النقل لجهاز آخر.
// تُستخدم لربط التفعيل بالجهاز: نسخ التطبيق لجهاز آخر يغيّر البصمة فيُطلب كود المطوّر من جديد.
function machineFingerprint() {
  const os = require('os');
  const macs = Object.values(os.networkInterfaces()).flat()
    .filter(i => i && !i.internal && i.mac && i.mac !== '00:00:00:00:00:00')
    .map(i => i.mac).sort();
  return crypto.createHash('sha256').update(os.hostname() + '|' + macs.join(',')).digest('hex');
}

// كلمة المرور تُخزَّن كـ sha256(ملح + كلمة المرور)؛ الملح يُولَّد عشوائياً لكل تنصيب.
// ملفات بيانات قديمة (قبل هذا التحديث) لا تحتوي "salt" — نتحقق منها بالنمط القديم غير المملَّح للتوافق.
function hashPass(p, salt) { return crypto.createHash('sha256').update((salt || '') + String(p)).digest('hex'); }
function randomSalt() { return crypto.randomBytes(16).toString('hex'); }

const FRESH_AUTH_SALT = randomSalt();

// ---------- التخزين ----------
const DEFAULT_DATA = {
  settings: {
    lang: 'ar', businessName: 'سند', currency: 'MRU', telegramBots: [],
    groqKey: '', theme: 'dark',
    auth: { enabled: false, username: 'admin', salt: FRESH_AUTH_SALT, passwordHash: hashPass('admin123', FRESH_AUTH_SALT) },
    company: { address: '', rc: '', taxId: '', phone: '', notes: '', logoDataUrl: '' },
    notifications: { lowStock: true, weeklyReport: true, lastWeeklyNotif: '' },
    expenseBudgets: {}, onboardingDismissed: false, currencies: [],
    invoice: { template: 'classic', color: '#C8A45C' },
    expenseCategoryList: ['rent', 'salaries', 'utilities', 'transport', 'maintenance', 'marketing', 'other'],
    productCategoryList: [],
    activation: { activated: false, fingerprint: '', at: '' },
    license: {
      deviceId: crypto.randomUUID(),
      gistId: '', gistToken: '', // فارغان دائماً لدى الزبائن — يُملآن فقط في نسخة المطوّر
      ownerChatId: '', claimCode: crypto.randomBytes(4).toString('hex').toUpperCase(),
      locked: false, message: '', lastCheck: ''
    }
  },
  products: [], customers: [], invoices: [], expenses: [], quotes: [],
  purchases: [], suppliers: [], employees: [], shareholders: [], withdrawals: [],
  wallets: [], walletTx: [],
  auditLog: [], trash: [], returns: [],
  counters: { invoice: 1, purchase: 1, quote: 1 }
};

// قراءة متزامنة للملف المحلي فقط (في وضع العميل يبقى محدَّثاً عبر مجرى SSE).
// المتصفح/الواجهة تستخدم loadDataForRenderer التي تسحب من المضيف أولاً عند العميل.
function loadData() {
  let localData = null;
  try {
    if (fs.existsSync(DATA_FILE())) {
      localData = JSON.parse(fs.readFileSync(DATA_FILE(), 'utf8'));
    }
  } catch (e) { console.error('local load error', e); }

  const saved = localData || {};
  const savedAuth = (saved.settings && saved.settings.auth) || null;
  const auth = (savedAuth && savedAuth.passwordHash)
    ? { enabled: !!savedAuth.enabled, username: savedAuth.username || 'admin', salt: savedAuth.salt, passwordHash: savedAuth.passwordHash }
    : { ...DEFAULT_DATA.settings.auth, enabled: !!(savedAuth && savedAuth.enabled), username: (savedAuth && savedAuth.username) || 'admin' };
  
  return {
    ...DEFAULT_DATA, ...saved,
    settings: {
      ...DEFAULT_DATA.settings, ...saved.settings,
      auth,
      company: { ...DEFAULT_DATA.settings.company, ...(saved.settings && saved.settings.company) },
      notifications: { ...DEFAULT_DATA.settings.notifications, ...(saved.settings && saved.settings.notifications) },
      license: { ...DEFAULT_DATA.settings.license, ...(saved.settings && saved.settings.license) }
    },
    counters: { ...DEFAULT_DATA.counters, ...saved.counters }
  };
}

function saveData(data) {
  const lan = readLanConfig();
  // العميل ليس مصدر الحقيقة: يرسل التعديل للمضيف الذي يخزّنه ويبثّه للجميع،
  // ويكتب نسخة محلية مؤقتة يصحّحها البثّ العائد من المضيف.
  if (lan.role === 'client' && lan.hostIp) {
    postToHost(data);
    try { fs.writeFileSync(DATA_FILE(), JSON.stringify(data, null, 2), 'utf8'); } catch (e) {}
    return;
  }
  // المضيف: ارفع رقم المراجعة ثم ابثّ التحديث لحظياً لكل الأجهزة المتصلة.
  if (lan.role === 'host') { data._rev = currentRev() + 1; data._ts = new Date().toISOString(); }
  fs.writeFileSync(DATA_FILE(), JSON.stringify(data, null, 2), 'utf8');
  if (lan.role === 'host') broadcastToClients(JSON.stringify(data));
}

// نسخة الواجهة: عند العميل تسحب أحدث حالة من المضيف قبل العرض ثم تعيد الدمج مع الافتراضات.
async function loadDataForRenderer() {
  const lan = readLanConfig();
  if (lan.role === 'client' && lan.hostIp) {
    const remote = await pullFromHost();
    if (remote) { try { fs.writeFileSync(DATA_FILE(), JSON.stringify(remote, null, 2), 'utf8'); } catch (e) {} }
  }
  return loadData();
}

// ---------- نسخ احتياطي تلقائي مجدول ----------
const BACKUP_DIR = () => path.join(app.getPath('userData'), 'backups');
const MAX_BACKUPS = 30;

function takeBackup() {
  try {
    if (!fs.existsSync(DATA_FILE())) return;
    if (!fs.existsSync(BACKUP_DIR())) fs.mkdirSync(BACKUP_DIR(), { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(DATA_FILE(), path.join(BACKUP_DIR(), `sened-backup-${stamp}.json`));
    const files = fs.readdirSync(BACKUP_DIR()).filter(f => f.startsWith('sened-backup-')).sort();
    while (files.length > MAX_BACKUPS) fs.unlinkSync(path.join(BACKUP_DIR(), files.shift()));
  } catch (e) { console.error('backup error', e); }
}

// ---------- الترخيص والإدارة عن بُعد ----------
// المُعرِّف العام لملف الحالة المشترك (Gist) — ليس سرياً، يُملأ مرة واحدة بعد إنشائه.
// إن تُرك فارغاً، نظام الترخيص معطَّل تماماً بأمان (لا قفل لأي أحد).
const DEFAULT_LICENSE_GIST_ID = '';

function githubApi(token, method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const headers = { 'User-Agent': 'sened-app', 'Accept': 'application/vnd.github+json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (bodyStr) headers['Content-Type'] = 'application/json';
    const req = https.request({ hostname: 'api.github.com', path: apiPath, method, headers, timeout: 15000 }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => { try { resolve(JSON.parse(out)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('GITHUB_TIMEOUT')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function readGistStatus(gistId) {
  const gist = await githubApi(null, 'GET', `/gists/${gistId}`);
  const file = Object.values(gist.files || {})[0];
  if (!file) throw new Error('EMPTY_GIST');
  try { return JSON.parse(file.content); } catch (e) { return { locked: [], names: {}, messages: {} }; }
}

async function writeGistStatus(gistId, token, mutatorFn) {
  const gist = await githubApi(token, 'GET', `/gists/${gistId}`);
  const filename = Object.keys(gist.files || {})[0];
  if (!filename) throw new Error('EMPTY_GIST');
  const data = (() => { try { return JSON.parse(gist.files[filename].content); } catch (e) { return { locked: [], names: {}, messages: {} }; } })();
  mutatorFn(data);
  await githubApi(token, 'PATCH', `/gists/${gistId}`, { files: { [filename]: { content: JSON.stringify(data, null, 2) } } });
  return data;
}

async function checkLicenseStatus() {
  const d = loadData();
  const lic = d.settings.license || {};
  const gistId = lic.gistId || DEFAULT_LICENSE_GIST_ID;
  if (!gistId) return; // النظام غير مفعَّل — لا شيء يحدث
  try {
    const status = await readGistStatus(gistId);
    const locked = (status.locked || []).includes(lic.deviceId);
    const message = (status.messages || {})[lic.deviceId] || '';
    const fresh = loadData();
    fresh.settings.license.locked = locked;
    fresh.settings.license.message = message;
    fresh.settings.license.lastCheck = new Date().toISOString();
    saveData(fresh);
    if (win && !win.isDestroyed()) win.webContents.send('license:status', { locked, message });
  } catch (e) { /* بلا إنترنت أو خطأ مؤقت — نُبقي آخر حالة معروفة، لا عقاب على انقطاع الشبكة */ }
}

// يقرأ استجابة HTTP سطراً سطراً (NDJSON أو SSE)، ويُفرِّغ آخر سطر متبقٍ عند إغلاق
// الاتصال حتى لو وصل بلا "\n" ختامي — وإلا يُفقَد آخر جزء من الرد بصمت.
function readLines(res, onLine) {
  let buf = '';
  res.on('data', chunk => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) onLine(line);
  });
  res.on('end', () => { if (buf.trim()) onLine(buf); });
}

// ---------- المساعد الذكي عبر Groq (سحابي، سريع، مجاني) ----------
// إعدادات Groq الثابتة — المفتاح فقط قابل للتغيير (مشترك مدمج أو خاص بالزبون).
const GROQ = { baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' };

// صيغة chat/completions مع بث SSE (نفس صيغة OpenAI التي يستخدمها Groq).
function askGroq(apiKey, messages, onChunk) {
  const provider = { baseUrl: GROQ.baseUrl, model: GROQ.model, apiKey };
  return askOpenAICompatible(provider, messages, onChunk);
}

function askOpenAICompatible(provider, messages, onChunk) {
  return new Promise((resolve, reject) => {
    let base;
    try { base = new URL(provider.baseUrl); } catch (e) { return reject(new Error('BASE_URL_INVALID')); }
    const apiPath = (base.pathname.replace(/\/$/, '')) + '/chat/completions';
    const body = JSON.stringify({
      model: provider.model, messages, stream: true, max_tokens: 600, temperature: 0.4
    });
    const isHttps = base.protocol === 'https:';
    const lib = isHttps ? https : http;
    const req = lib.request({
      hostname: base.hostname, port: base.port || (isHttps ? 443 : 80), path: apiPath, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${provider.apiKey}`,
        'Content-Length': Buffer.byteLength(body)
      }, timeout: 60000
    }, res => {
      let full = '', gotError = null;
      readLines(res, line => {
        if (!line.startsWith('data: ')) return;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') return;
        try {
          const j = JSON.parse(payload);
          if (j.error) { gotError = j.error.message || 'PROVIDER_ERROR'; return; }
          const delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
          if (delta) { full += delta; if (onChunk) onChunk(delta); }
        } catch (e) { /* سطر غير مكتمل */ }
      });
      res.on('end', () => {
        if (gotError) reject(new Error(gotError));
        else if (full) resolve(full);
        else reject(new Error('PROVIDER_EMPTY'));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('PROVIDER_TIMEOUT')); });
    req.write(body); req.end();
  });
}

function walletBalance(d, walletId) {
  return d.walletTx.reduce((bal, t) => {
    if (t.type === 'deposit' && t.walletId === walletId) return bal + Number(t.amount);
    if (t.type === 'withdraw' && t.walletId === walletId) return bal - Number(t.amount);
    if (t.type === 'transfer') {
      if (t.walletId === walletId) return bal - Number(t.amount);
      if (t.toWalletId === walletId) return bal + Number(t.amount);
    }
    return bal;
  }, 0);
}

function computeFinancials(d) {
  const totalSales = d.invoices.reduce((s, i) => s + i.total, 0);
  const totalCogs = d.invoices.reduce((s, i) => s + i.items.reduce((ss, it) => ss + (Number(it.cost || 0) * it.qty), 0), 0);
  const totalExpenses = d.expenses.reduce((s, e) => s + Number(e.amount || 0), 0);
  const grossProfit = totalSales - totalCogs;
  const netProfit = grossProfit - totalExpenses;
  const totalPercent = d.shareholders.reduce((s, sh) => s + Number(sh.percent || 0), 0);
  const totalWithdrawals = d.withdrawals.reduce((s, w) => s + Number(w.amount || 0), 0);
  const totalWalletBalance = d.wallets.reduce((s, w) => s + walletBalance(d, w.id), 0);
  return { totalSales, totalCogs, totalExpenses, grossProfit, netProfit, totalPercent, totalWithdrawals, totalWalletBalance };
}

function businessContext(d) {
  const f = computeFinancials(d);
  const today = new Date().toISOString().slice(0, 10);
  const todaySales = d.invoices.filter(i => i.date.slice(0, 10) === today).reduce((s, i) => s + i.total, 0);
  const low = d.products.filter(p => Number(p.stock) <= 3).map(p => `${p.name} (${p.stock})`).join(', ') || 'لا شيء';
  const custDebt = d.invoices.reduce((s, i) => s + Math.max(0, i.total - (i.paidAmount || 0)), 0);
  const shareLines = d.shareholders.map(sh => {
    const w = d.withdrawals.filter(x => x.shareholderId === sh.id).reduce((s, x) => s + Number(x.amount), 0);
    const share = f.netProfit * (Number(sh.percent) / 100);
    return `${sh.name}: ${sh.percent}% → حصة ${Math.round(share)} ${d.settings.currency}, سحب ${w}, صافي مستحق ${Math.round(share - w)}`;
  }).join(' | ') || 'لا يوجد مساهمون بعد';
  return `أنت "مساعد سند" الذكي لنظام إدارة ومحاسبة "${d.settings.businessName}". أجب بإيجاز وبنفس لغة السؤال (عربي/فرنسي/إنجليزي).
بيانات النشاط الحالية:
- عدد المنتجات: ${d.products.length} | العملاء: ${d.customers.length} | الموردون: ${d.suppliers.length} | الموظفون: ${d.employees.length}
- إجمالي المبيعات: ${f.totalSales} ${d.settings.currency} | مبيعات اليوم: ${todaySales} | المصاريف: ${f.totalExpenses} | صافي الربح: ${Math.round(f.netProfit)}
- منتجات قاربت على النفاد: ${low}
- ديون العملاء غير المحصّلة: ${Math.round(custDebt)} ${d.settings.currency}
- المساهمون ونسبهم (مجموع النسب ${f.totalPercent}%): ${shareLines}
- المحافظ/الحسابات (الرصيد الإجمالي ${Math.round(f.totalWalletBalance)} ${d.settings.currency}): ${d.wallets.map(w => `${w.name}: ${Math.round(walletBalance(d, w.id))}`).join(' | ') || 'لا توجد محافظ بعد'}
- أحدث 5 فواتير: ${d.invoices.slice(-5).map(i => `#${i.number} ${i.customerName || 'زبون'} = ${i.total}`).join(' | ') || 'لا يوجد'}`;
}

// preloadedData: تمرير بيانات مُحمَّلة مسبقاً (مثلاً من بوت تلجرام) لتفادي قراءة ملف البيانات من القرص مرتين لكل رسالة.
// يعيد مفتاح Groq الفعّال: الخاص بالزبون إن وُجد، وإلا المفتاح المشترك المدمج (builtin-ai.json).
function activeGroqKey(d) {
  if (d.settings.groqKey) return d.settings.groqKey;
  const builtin = builtinAiProvider();
  return builtin ? builtin.apiKey : '';
}

async function askAI(userText, history = [], onChunk, preloadedData) {
  const d = preloadedData || loadData();
  const key = activeGroqKey(d);
  if (!key) throw new Error('AI_NOT_CONFIGURED');
  const messages = [{ role: 'system', content: businessContext(d) }, ...history, { role: 'user', content: userText }];
  return askGroq(key, messages, onChunk);
}

// ---------- بوت تلجرام (خانات متعددة — نفس منطق الأوامر لكل بوت) ----------
const tgBots = new Map(); // botId -> { token, running, offset }

function tgApi(token, method, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload || {});
    const req = https.request({
      hostname: 'api.telegram.org', path: `/bot${token}/${method}`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 65000
    }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => { try { resolve(JSON.parse(out)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('TG_TIMEOUT')); });
    req.write(body); req.end();
  });
}

function escHtml(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])); }

// يولّد PDF لتقرير مختصر عبر نافذة خفية (offscreen) + printToPDF — دون الاعتماد على واجهة المستخدم المرئية.
async function generateReportPdfBuffer(d) {
  const f = computeFinancials(d);
  const c = d.settings.currency;
  const today = new Date().toISOString().slice(0, 10);
  const tally = {};
  d.invoices.forEach(i => i.items.forEach(it => { tally[it.name] = (tally[it.name] || 0) + it.qty; }));
  const top = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const rows = [
    ['إجمالي المبيعات', f.totalSales], ['تكلفة البضاعة', f.totalCogs], ['الربح الإجمالي', f.grossProfit],
    ['المصاريف', f.totalExpenses], ['صافي الربح', f.netProfit]
  ];
  const html = `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><style>
    body{font-family:'Segoe UI',Tahoma,Arial,sans-serif;padding:40px;color:#111}
    h1{color:#C8A45C;border-bottom:3px solid #C8A45C;padding-bottom:10px}
    table{width:100%;border-collapse:collapse;margin:16px 0}
    td,th{border:1px solid #ddd;padding:9px 12px;text-align:start}
    th{background:#C8A45C;color:#000}
    .thanks{text-align:center;color:#666;margin-top:30px;border-top:1px solid #C8A45C;padding-top:12px}
  </style></head><body>
    <h1>${escHtml(d.settings.businessName || 'سند')} — تقرير</h1>
    <p>التاريخ: ${today}</p>
    <table><tbody>${rows.map(([k, v]) => `<tr><td>${escHtml(k)}</td><td>${Math.round(v).toLocaleString('en-US')} ${escHtml(c)}</td></tr>`).join('')}</tbody></table>
    <h3>الأكثر مبيعاً</h3>
    <table><thead><tr><th>المنتج</th><th>الكمية</th></tr></thead><tbody>${top.length ? top.map(([n, q]) => `<tr><td>${escHtml(n)}</td><td>${q}</td></tr>`).join('') : '<tr><td colspan="2">لا يوجد</td></tr>'}</tbody></table>
    <div class="thanks">${escHtml(d.settings.businessName || 'سند')}</div>
  </body></html>`;
  const offscreen = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  try {
    await offscreen.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    const pdf = await offscreen.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
    return pdf;
  } finally { offscreen.destroy(); }
}

// إرسال ملف عبر تلجرام (multipart/form-data يدوي فوق https الخام).
function tgSendDocument(token, chatId, filename, buffer, caption) {
  return new Promise((resolve, reject) => {
    const boundary = '----SenedBoundary' + Date.now();
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n` +
      (caption ? `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n` : '') +
      `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`, 'utf8');
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const body = Buffer.concat([head, buffer, tail]);
    const req = https.request({
      hostname: 'api.telegram.org', path: `/bot${token}/sendDocument`, method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length }, timeout: 60000
    }, res => { let out = ''; res.on('data', c => out += c); res.on('end', () => { try { resolve(JSON.parse(out)); } catch (e) { reject(e); } }); });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('TG_TIMEOUT')); });
    req.write(body); req.end();
  });
}

async function sendReportPdf(token, chatId, d) {
  try {
    const pdf = await generateReportPdfBuffer(d);
    await tgSendDocument(token, chatId, `تقرير-${new Date().toISOString().slice(0, 10)}.pdf`, pdf, `📄 تقرير ${d.settings.businessName || 'سند'}`);
    await tgApi(token, 'sendMessage', { chat_id: chatId, text: 'تم إرسال التقرير ✓', reply_markup: BOT_MENU });
  } catch (e) {
    await tgApi(token, 'sendMessage', { chat_id: chatId, text: '⚠️ تعذّر توليد التقرير: ' + e.message });
  }
}

// قائمة أزرار جاهزة تظهر أسفل رسائل البوت — المستخدم يضغط بدل الكتابة
const BOT_MENU = {
  inline_keyboard: [
    [{ text: '📊 ملخص اليوم', callback_data: 'summary' }, { text: '📦 المخزون', callback_data: 'products' }],
    [{ text: '🧾 آخر الفواتير', callback_data: 'invoices' }, { text: '💳 الديون', callback_data: 'debts' }],
    [{ text: '🏦 المحافظ', callback_data: 'wallets' }, { text: '📈 المساهمون', callback_data: 'shareholders' }],
    [{ text: '📄 تقرير PDF', callback_data: 'pdf' }]
  ]
};

// يبني نص أمر جاهز من مفتاح ثابت (يُستخدم من الأزرار والأوامر النصية معاً)
function botCommandText(cmd, d) {
  const c = d.settings.currency;
  if (cmd === 'summary') {
    const total = d.invoices.reduce((s, i) => s + i.total, 0);
    const today = new Date().toISOString().slice(0, 10);
    const todayTotal = d.invoices.filter(i => i.date.slice(0, 10) === today).reduce((s, i) => s + i.total, 0);
    return `📊 ملخص ${d.settings.businessName}:\n\n💰 إجمالي المبيعات: ${total} ${c}\n📅 مبيعات اليوم: ${todayTotal} ${c}\n🧾 عدد الفواتير: ${d.invoices.length}\n📦 المنتجات: ${d.products.length}\n👥 العملاء: ${d.customers.length}`;
  }
  if (cmd === 'products') {
    return d.products.length
      ? '📦 المخزون:\n\n' + d.products.map(p => `• ${p.name}: ${p.stock} قطعة — ${p.price} ${c}${p.stock <= 3 ? ' ⚠️' : ''}`).join('\n')
      : 'لا توجد منتجات بعد.';
  }
  if (cmd === 'invoices') {
    return d.invoices.length
      ? '🧾 آخر الفواتير:\n\n' + d.invoices.slice(-8).reverse().map(i => `#${i.number} | ${i.customerName || 'زبون'} | ${i.total} ${c} | ${i.date.slice(0, 10)}`).join('\n')
      : 'لا توجد فواتير بعد.';
  }
  if (cmd === 'shareholders') {
    const f = computeFinancials(d);
    return d.shareholders.length
      ? `📈 توزيع الأرباح (صافي الربح: ${Math.round(f.netProfit)} ${c}):\n\n` + d.shareholders.map(sh => {
          const w = d.withdrawals.filter(x => x.shareholderId === sh.id).reduce((s, x) => s + Number(x.amount), 0);
          const share = f.netProfit * (Number(sh.percent) / 100);
          return `• ${sh.name} (${sh.percent}%): حصة ${Math.round(share)} ${c} — سُحب ${w} ${c} — الصافي المستحق ${Math.round(share - w)} ${c}`;
        }).join('\n')
      : 'لا يوجد مساهمون مسجلون بعد.';
  }
  if (cmd === 'debts') {
    const owing = d.invoices.reduce((s, i) => s + Math.max(0, i.total - (i.paidAmount || 0)), 0);
    const perCustomer = {};
    d.invoices.forEach(i => {
      const rem = Math.max(0, i.total - (i.paidAmount || 0));
      if (rem > 0) perCustomer[i.customerName || 'زبون نقدي'] = (perCustomer[i.customerName || 'زبون نقدي'] || 0) + rem;
    });
    const lines = Object.entries(perCustomer).map(([n, v]) => `• ${n}: ${Math.round(v)} ${c}`).join('\n');
    return `💳 إجمالي ديون العملاء: ${Math.round(owing)} ${c}\n\n${lines || 'لا توجد ديون مستحقة'}`;
  }
  if (cmd === 'wallets') {
    return d.wallets.length
      ? '🏦 المحافظ والحسابات:\n\n' + d.wallets.map(w => `• ${w.name} (${w.type}): ${Math.round(walletBalance(d, w.id))} ${c}`).join('\n')
      : 'لا توجد محافظ مسجلة بعد.';
  }
  return null;
}

const CMD_MAP = {
  '/ملخص': 'summary', '/summary': 'summary', '/منتجات': 'products', '/products': 'products',
  '/فواتير': 'invoices', '/invoices': 'invoices', '/مساهمين': 'shareholders', '/shareholders': 'shareholders',
  '/ديون': 'debts', '/debts': 'debts', '/محافظ': 'wallets', '/wallets': 'wallets'
};

async function tgHandle(token, msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const d = loadData();

  if (text === '/start') {
    await tgApi(token, 'sendMessage', { chat_id: chatId, text: `أهلاً بك في بوت "${d.settings.businessName}" 🌟\nاختر من الأزرار أدناه أو اكتب أي سؤال وسيجيبك المساعد الذكي:`, reply_markup: BOT_MENU });
    return;
  }
  if (CMD_MAP[text]) {
    await tgApi(token, 'sendMessage', { chat_id: chatId, text: botCommandText(CMD_MAP[text], d), reply_markup: BOT_MENU });
    return;
  }
  if (text === '/pdf' || text === '/تقرير') { await sendReportPdf(token, chatId, d); return; }
  if (text.startsWith('/claim ')) {
    const code = text.slice(7).trim();
    let reply;
    if (d.settings.license.ownerChatId) reply = '⚠️ هذا البوت مرتبط بالفعل بحساب إدارة.';
    else if (code === d.settings.license.claimCode) { d.settings.license.ownerChatId = String(chatId); saveData(d); reply = '✓ تم تفعيل صلاحيات الإدارة لهذا الحساب. أرسل /clients لرؤية العملاء.'; }
    else reply = '⚠️ رمز غير صحيح.';
    await tgApi(token, 'sendMessage', { chat_id: chatId, text: reply });
    return;
  }
  if (/^\/(register|clients|lock|unlock|msg)\b/.test(text)) {
    const reply = await handleAdminCommand(d, chatId, text);
    if (reply) await tgApi(token, 'sendMessage', { chat_id: chatId, text: reply });
    return;
  }
  if (text) {
    let reply;
    try { reply = await askAI(text, [], null, d); }
    catch (e) { reply = e.message === 'AI_NOT_CONFIGURED' ? '⚠️ المساعد الذكي غير مضبوط بعد (مفتاح Groq).' : '⚠️ المساعد الذكي غير متاح حالياً، تحقق من اتصال الإنترنت.'; }
    await tgApi(token, 'sendMessage', { chat_id: chatId, text: reply, reply_markup: BOT_MENU });
  }
}

// معالجة ضغط أزرار القائمة (callback_query)
async function tgHandleCallback(token, cbq) {
  const chatId = cbq.message && cbq.message.chat && cbq.message.chat.id;
  const data = cbq.data;
  await tgApi(token, 'answerCallbackQuery', { callback_query_id: cbq.id }).catch(() => {});
  if (!chatId) return;
  const d = loadData();
  if (data === 'pdf') { await sendReportPdf(token, chatId, d); return; }
  const reply = botCommandText(data, d);
  if (reply) await tgApi(token, 'sendMessage', { chat_id: chatId, text: reply, reply_markup: BOT_MENU });
}

async function handleAdminCommand(d, chatId, text) {
  const isOwner = d.settings.license.ownerChatId && String(d.settings.license.ownerChatId) === String(chatId);
  if (!isOwner) return '⚠️ هذا الأمر مخصص لحساب الإدارة فقط. استخدم /claim <الرمز> أولاً من إعدادات التطبيق → الترخيص.';
  const gistId = d.settings.license.gistId;
  const gistToken = d.settings.license.gistToken;
  if (!gistId || !gistToken) return '⚠️ لم تُضبط بيانات نظام الترخيص بعد (Gist ID والرمز) من الإعدادات.';

  function resolveId(status, nameOrId) {
    const byName = Object.entries(status.names || {}).find(([id, n]) => n.toLowerCase() === nameOrId.toLowerCase());
    return byName ? byName[0] : nameOrId;
  }

  try {
    if (text.startsWith('/register ')) {
      const parts = text.slice(10).trim().split(/\s+/);
      const deviceId = parts.shift();
      const name = parts.join(' ') || deviceId;
      if (!deviceId) return 'الاستخدام: /register <رقم الجهاز> <اسم الزبون>';
      const status = await writeGistStatus(gistId, gistToken, s => { s.names = s.names || {}; s.names[deviceId] = name; });
      return `✓ سُجِّل "${name}" — الآن لديك ${Object.keys(status.names).length} عميل مسجَّل.`;
    }
    if (text === '/clients') {
      const status = await readGistStatus(gistId);
      const names = status.names || {};
      const locked = status.locked || [];
      if (!Object.keys(names).length) return 'لا يوجد عملاء مسجلون بعد. استخدم /register <رقم الجهاز> <الاسم>.';
      return '👥 العملاء:\n\n' + Object.entries(names).map(([id, name]) => `• ${name}${locked.includes(id) ? ' — 🔒 موقوف' : ' — ✓ نشط'}`).join('\n');
    }
    if (text.startsWith('/lock ')) {
      const nameOrId = text.slice(6).trim();
      const status = await writeGistStatus(gistId, gistToken, s => {
        const id = resolveId(s, nameOrId);
        s.locked = s.locked || [];
        if (!s.locked.includes(id)) s.locked.push(id);
      });
      return `🔒 تم إيقاف "${nameOrId}".`;
    }
    if (text.startsWith('/unlock ')) {
      const nameOrId = text.slice(8).trim();
      await writeGistStatus(gistId, gistToken, s => {
        const id = resolveId(s, nameOrId);
        s.locked = (s.locked || []).filter(x => x !== id);
      });
      return `🔓 تم تفعيل "${nameOrId}" مجدداً.`;
    }
    if (text.startsWith('/msg ')) {
      const rest = text.slice(5).trim();
      const [nameOrId, ...msgParts] = rest.split(/\s+/);
      const message = msgParts.join(' ');
      if (!nameOrId || !message) return 'الاستخدام: /msg <اسم الزبون> <الرسالة>';
      await writeGistStatus(gistId, gistToken, s => {
        const id = resolveId(s, nameOrId);
        s.messages = s.messages || {};
        s.messages[id] = message;
      });
      return `✓ أُرسلت رسالة إلى "${nameOrId}" — ستظهر في تطبيقه عند تحققه القادم.`;
    }
  } catch (err) { return '⚠️ خطأ في الاتصال بنظام الترخيص: ' + err.message; }
  return null;
}

async function tgLoop(botId) {
  const bot = tgBots.get(botId);
  while (bot && bot.running) {
    try {
      const res = await tgApi(bot.token, 'getUpdates', { offset: bot.offset, timeout: 50 });
      if (res.ok && res.result) {
        for (const u of res.result) {
          bot.offset = u.update_id + 1;
          if (u.message) tgHandle(bot.token, u.message).catch(() => {});
          else if (u.callback_query) tgHandleCallback(bot.token, u.callback_query).catch(() => {});
        }
      }
      if (win && !win.isDestroyed()) win.webContents.send('tg-status', { id: botId, running: true });
    } catch (e) {
      if (win && !win.isDestroyed()) win.webContents.send('tg-status', { id: botId, running: bot.running, error: e.message });
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// ---------- IPC ----------
ipcMain.handle('data:load', () => loadDataForRenderer());
ipcMain.handle('data:save', (e, data) => { saveData(data); return true; });
ipcMain.handle('ai:ask', async (e, { text, history }) => {
  try {
    const full = await askAI(
      text, history || [],
      delta => { if (!e.sender.isDestroyed()) e.sender.send('ai:chunk', delta); }
    );
    return { ok: true, text: full };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('ai:check', async () => {
  const d = loadData();
  return { ok: !!activeGroqKey(d), cloud: true };
});
// أسماء الأوامر يجب أن تكون بأحرف إنجليزية صغيرة فقط حسب قواعد تلجرام (a-z0-9_)
// — تظهر بهذا الشكل في قائمة الاقتراحات، لكن الوصف بالعربية، والبوت يقبل أيضاً الاسم العربي المكافئ عند الكتابة اليدوية
const TG_COMMANDS = [
  { command: 'start', description: 'بدء استخدام البوت' },
  { command: 'summary', description: 'ملخص المبيعات اليومي والإجمالي' },
  { command: 'products', description: 'حالة المخزون الحالية' },
  { command: 'invoices', description: 'آخر الفواتير المسجّلة' },
  { command: 'shareholders', description: 'توزيع الأرباح على المساهمين' },
  { command: 'debts', description: 'ديون العملاء غير المحصّلة' },
  { command: 'wallets', description: 'أرصدة المحافظ والحسابات' },
  { command: 'pdf', description: 'إرسال تقرير PDF' }
];

ipcMain.handle('tg:start', async (e, { id, token }) => {
  try {
    const me = await tgApi(token, 'getMe');
    if (!me.ok) return { ok: false, error: 'رمز البوت غير صحيح' };
    const existing = tgBots.get(id);
    tgBots.set(id, { token, running: true, offset: existing ? existing.offset : 0 });
    if (!existing || !existing.running) tgLoop(id);
    tgApi(token, 'setMyCommands', { commands: TG_COMMANDS }).catch(() => {});
    return { ok: true, name: me.result.username };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('tg:stop', (e, { id }) => {
  const bot = tgBots.get(id);
  if (bot) bot.running = false;
  return true;
});
ipcMain.handle('app:print', () => { if (win) win.webContents.print({ silent: false, printBackground: true }); return true; });
ipcMain.handle('app:exportPdf', async (e, suggestedName) => {
  if (!win) return { ok: false };
  try {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'تصدير PDF',
      defaultPath: path.join(app.getPath('documents'), suggestedName || 'export.pdf'),
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    const data = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
    fs.writeFileSync(filePath, data);
    return { ok: true, filePath };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('app:openExternal', (e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });
ipcMain.handle('app:openBackupsFolder', () => { takeBackup(); shell.openPath(BACKUP_DIR()); return true; });
ipcMain.handle('license:checkNow', async () => { await checkLicenseStatus(); return true; });
ipcMain.handle('license:regenClaimCode', () => {
  const d = loadData();
  d.settings.license.claimCode = crypto.randomBytes(4).toString('hex').toUpperCase();
  d.settings.license.ownerChatId = '';
  saveData(d);
  return d.settings.license.claimCode;
});
ipcMain.handle('license:createGist', async (e, token) => {
  try {
    const initial = { locked: [], names: {}, messages: {} };
    const gist = await githubApi(token, 'POST', '/gists', {
      description: 'Sened license status (managed by the app — do not edit manually)',
      public: false,
      files: { 'sened-license-status.json': { content: JSON.stringify(initial, null, 2) } }
    });
    if (!gist.id) return { ok: false, error: gist.message || 'فشل الإنشاء' };
    const d = loadData();
    d.settings.license.gistId = gist.id;
    d.settings.license.gistToken = token;
    saveData(d);
    return { ok: true, gistId: gist.id };
  } catch (err) { return { ok: false, error: err.message }; }
});
// المطوّر فقط: يكتب المفتاح المشترك في builtin-ai.json ليُشحن مع النسخة الموزّعة
ipcMain.handle('ai:setBuiltinKey', async (e, cfg) => {
  try {
    if (!cfg || !cfg.apiKey) { writeBuiltinConfig({ apiKey: '', apiKeyEnc: '' }); return { ok: true, cleared: true }; }
    // يُخزَّن مموَّهاً دائماً (لا نكتب المفتاح صريحاً في الملف المُلتزَم)
    writeBuiltinConfig({ apiKey: '', apiKeyEnc: obfuscate(cfg.apiKey), baseUrl: cfg.baseUrl, model: cfg.model, name: cfg.name || 'Sened AI' });
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('ai:builtinInfo', () => {
  const b = builtinAiProvider();
  return b ? { present: true, name: b.name, model: b.model } : { present: false };
});
// نكهة النسخة: يقرؤها الواجهة لتقييد الكاشير أو فتح كل شيء للمدير
ipcMain.handle('app:flavor', () => appFlavor());
ipcMain.handle('app:cashierIp', () => getLocalIp());
ipcMain.handle('app:setFlavor', (e, flavor) => {
  try { writeBuiltinConfig({ flavor }); return { ok: true }; } catch (err) { return { ok: false, error: err.message }; }
});

// ---------- التزامن عبر الشبكة المحلية (LAN) ----------
ipcMain.handle('deviceRole:get', () => readDeviceRole());
ipcMain.handle('deviceRole:set', (e, role) => writeDeviceRole(role));
ipcMain.handle('deviceRole:clear', () => writeDeviceRole(null));
// تفضيلات العرض المحلية (لغة/سمة هذا الجهاز) — خارج البيانات المزامَنة
ipcMain.handle('uiPrefs:get', () => readUiPrefs());
ipcMain.handle('uiPrefs:set', (e, prefs) => writeUiPrefs({
  lang: ['ar', 'fr', 'en', ''].includes(prefs && prefs.lang) ? prefs.lang : undefined,
  theme: ['dark', 'light', ''].includes(prefs && prefs.theme) ? prefs.theme : undefined
}));
ipcMain.handle('lan:getConfig', () => readLanConfig());
ipcMain.handle('lan:setConfig', (e, cfg) => {
  let token = (cfg.token || '').trim();
  // كود الاقتران: يتولّد تلقائياً على المضيف إن تُرك فارغاً (6 أرقام يعرضها للأجهزة الأخرى)
  if ((cfg.role || 'off') === 'host' && !token) token = String(crypto.randomInt(100000, 999999));
  const port = Math.min(65535, Math.max(1024, Number(cfg.port) || SYNC_PORT_DEFAULT));
  const next = writeLanConfig({
    role: cfg.role || 'off', hostIp: (cfg.hostIp || '').trim(), port,
    token, deviceName: (cfg.deviceName || '').trim().slice(0, 40)
  });
  applyLanMode();
  return { ok: true, config: next, myIp: getLocalIp() };
});
ipcMain.handle('lan:status', () => {
  const cfg = readLanConfig();
  return {
    role: cfg.role, hostIp: cfg.hostIp, port: cfg.port, myIp: getLocalIp(),
    deviceName: cfg.deviceName || '', token: cfg.token || '',
    serverRunning: !!hostServer, connectedClients: sseClients.size,
    clientNames: [...sseClients].map(r => r._deviceName || '').filter(Boolean),
    // جدول إدارة الأجهزة: كل جهاز عرف نفسه لهذا المضيف خلال الجلسة (متصل أو انقطع)
    clients: [...clientRegistry.values()].sort((a, b) => b.lastSeen - a.lastSeen),
    serverError: hostServerError,          // '' أو 'EADDRINUSE' أو رسالة الخطأ
    ipChangedFrom: hostIpChangedFrom,      // IP آخر تشغيل إن اختلف عن الحالي
    clientConnected, rev: currentRev()
  };
});
// توليد كود اقتران جديد (للمضيف): الكود القديم يبطل فوراً وتُفصل الأجهزة المتصلة
// (إعادة اتصالها التلقائي سترفض بـ 401 حتى يُدخَل الكود الجديد فيها)
ipcMain.handle('lan:regenToken', () => {
  const cfg = readLanConfig();
  if (cfg.role !== 'host') return { ok: false, error: 'not host' };
  const token = String(crypto.randomInt(100000, 999999));
  writeLanConfig({ token });
  for (const res of sseClients) { try { res.socket.destroy(); } catch (e2) {} }
  return { ok: true, token };
});
// فصل جهاز متصل بعينه (يغلق اتصال SSE الخاص به). ملاحظة: إن بقي كود الاقتران صالحاً
// سيعيد الجهاز الاتصال تلقائياً خلال ثوانٍ — للفصل النهائي ولّد كوداً جديداً.
ipcMain.handle('lan:kickClient', (e, id) => {
  for (const res of sseClients) {
    if (res._clientId === Number(id)) {
      try { res.socket.destroy(); } catch (e2) { try { res.end(); } catch (e3) {} }
      return { ok: true };
    }
  }
  return { ok: false, error: 'not found' };
});
// البحث عن خوادم سند على الشبكة المحلية (اكتشاف تلقائي عبر UDP)
ipcMain.handle('lan:discover', () => discoverHosts(3000));
ipcMain.handle('lan:test', (e, { ip, port, token }) => new Promise((resolve) => {
  const req = http.get({ hostname: ip, port: port || SYNC_PORT_DEFAULT, path: '/ping', timeout: 2500, headers: { 'x-sened-token': token || '' } }, (res) => {
    let b = ''; res.setEncoding('utf8'); res.on('data', c => b += c);
    res.on('end', () => {
      if (res.statusCode === 401) { resolve({ ok: false, error: 'unauthorized' }); return; }
      if (res.statusCode !== 200) { resolve({ ok: false, error: 'http ' + res.statusCode }); return; }
      try { resolve({ ok: true, info: JSON.parse(b) }); } catch (_) { resolve({ ok: false }); }
    });
  });
  req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
  req.on('error', (err) => resolve({ ok: false, error: err.message }));
}));

// ---------- تفعيل المطوّر - يُخزَّن في مجلد دائم لا يُحذف عند إلغاء التثبيت ----------
// نستخدم %APPDATA%\sened-activation.json بدل userData لأن userData يُحذف عند الإلغاء
function activationFile() {
  return path.join(app.getPath('appData'), 'sened-activation.json');
}
function readActivation() {
  try {
    const f = activationFile();
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch(e) {}
  return {};
}
function writeActivation(data) {
  fs.writeFileSync(activationFile(), JSON.stringify(data, null, 2), 'utf8');
}

ipcMain.handle('activation:setDevCode', (e, code) => {
  try { writeBuiltinConfig({ activationCode: (code || '').trim() }); return { ok: true, hasCode: !!(code || '').trim() }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('activation:hasDevCode', () => ({ hasCode: !!builtinActivationCode() }));
ipcMain.handle('activation:status', () => {
  const devCode = builtinActivationCode();
  if (!devCode) return { required: false };
  const act = readActivation();
  const fp = machineFingerprint();
  // مفعَّل فقط إذا: العلَم مضبوط + البصمة تطابق هذا الجهاز + التوقيع سليم (لم يُزوَّر الملف).
  const activated = !!act.activated && act.fingerprint === fp && act.sig === activationSignature(fp);
  return { required: !activated };
});
ipcMain.handle('activation:verify', (e, code) => {
  const devCode = builtinActivationCode();
  if (!devCode) return { ok: true };
  if ((code || '').trim() !== devCode) return { ok: false };
  const fp = machineFingerprint();
  // نربط التفعيل ببصمة هذا الجهاز ونوقّعه؛ نسخ الملف لجهاز آخر تفشل لأن بصمته مختلفة.
  writeActivation({ activated: true, fingerprint: fp, at: new Date().toISOString(), sig: activationSignature(fp) });
  return { ok: true };
});
ipcMain.handle('auth:verify', (e, { username, password }) => {
  const d = loadData();
  if (d.settings.auth.username === username) {
    const expected = d.settings.auth.salt
      ? hashPass(password, d.settings.auth.salt)
      : hashPass(password); // نمط قديم غير مملّح، لتوافق البيانات المحفوظة سابقاً
    if (d.settings.auth.passwordHash === expected) return { role: 'manager', name: d.settings.auth.username };
  }
  const emp = (d.employees || []).find(x => x.username && x.username === username && x.passwordHash);
  if (emp && emp.passwordHash === hashPass(password, emp.salt)) {
    return { role: emp.accessRole || 'cashier', name: emp.name };
  }
  return false;
});
ipcMain.handle('auth:setCredentials', (e, { username, password }) => {
  const d = loadData();
  d.settings.auth.username = username;
  if (password) {
    d.settings.auth.salt = randomSalt();
    d.settings.auth.passwordHash = hashPass(password, d.settings.auth.salt);
  }
  saveData(d);
  return true;
});
ipcMain.handle('auth:hashPassword', (e, password) => {
  const salt = randomSalt();
  return { salt, hash: hashPass(password, salt) };
});

// ---------- النافذة ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 1000, minHeight: 640,
    backgroundColor: '#080C0A',
    title: 'سند — نظام الإدارة والمحاسبة الذكي',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  applyLanMode();
  createWindow();
  takeBackup();
  checkLicenseStatus();
  setInterval(takeBackup, 60 * 60 * 1000); // نسخة احتياطية إضافية كل ساعة أثناء التشغيل
  setInterval(checkLicenseStatus, 30 * 60 * 1000); // تحقق من حالة الترخيص كل نصف ساعة
});
app.on('window-all-closed', () => { tgBots.forEach(b => { b.running = false; }); app.quit(); });
