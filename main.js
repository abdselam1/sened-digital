const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

let win = null;
const DATA_FILE = () => path.join(app.getPath('userData'), 'sened-data.json');

// كلمة المرور تُخزَّن كـ sha256(ملح + كلمة المرور)؛ الملح يُولَّد عشوائياً لكل تنصيب.
// ملفات بيانات قديمة (قبل هذا التحديث) لا تحتوي "salt" — نتحقق منها بالنمط القديم غير المملَّح للتوافق.
function hashPass(p, salt) { return crypto.createHash('sha256').update((salt || '') + String(p)).digest('hex'); }
function randomSalt() { return crypto.randomBytes(16).toString('hex'); }

const FRESH_AUTH_SALT = randomSalt();

// ---------- التخزين ----------
const DEFAULT_DATA = {
  settings: {
    lang: 'ar', businessName: 'سند', currency: 'MRU', telegramBots: [],
    aiModel: 'qwen2:latest', anthropicKey: '', theme: 'dark',
    auth: { enabled: false, username: 'admin', salt: FRESH_AUTH_SALT, passwordHash: hashPass('admin123', FRESH_AUTH_SALT) },
    company: { address: '', rc: '', taxId: '', phone: '', notes: '', logoDataUrl: '' },
    notifications: { lowStock: true, weeklyReport: true, lastWeeklyNotif: '' },
    expenseBudgets: {}, onboardingDismissed: false, currencies: []
  },
  products: [], customers: [], invoices: [], expenses: [],
  purchases: [], suppliers: [], employees: [], shareholders: [], withdrawals: [],
  wallets: [], walletTx: [],
  auditLog: [], trash: [], returns: [],
  counters: { invoice: 1, purchase: 1 }
};

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE())) {
      const saved = JSON.parse(fs.readFileSync(DATA_FILE(), 'utf8'));
      const savedAuth = (saved.settings && saved.settings.auth) || null;
      // الملح وبصمة كلمة المرور يجب أن يبقيا زوجاً من نفس المصدر دائماً — لا نخلط ملحاً محفوظاً ببصمة افتراضية أو العكس
      const auth = (savedAuth && savedAuth.passwordHash)
        ? { enabled: !!savedAuth.enabled, username: savedAuth.username || 'admin', salt: savedAuth.salt, passwordHash: savedAuth.passwordHash }
        : { ...DEFAULT_DATA.settings.auth, enabled: !!(savedAuth && savedAuth.enabled), username: (savedAuth && savedAuth.username) || 'admin' };
      return {
        ...DEFAULT_DATA, ...saved,
        settings: {
          ...DEFAULT_DATA.settings, ...saved.settings,
          auth,
          company: { ...DEFAULT_DATA.settings.company, ...(saved.settings && saved.settings.company) },
          notifications: { ...DEFAULT_DATA.settings.notifications, ...(saved.settings && saved.settings.notifications) }
        },
        counters: { ...DEFAULT_DATA.counters, ...saved.counters }
      };
    }
  } catch (e) { console.error('load error', e); }
  return JSON.parse(JSON.stringify(DEFAULT_DATA));
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE(), JSON.stringify(data, null, 2), 'utf8');
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

// ---------- أولاما (الذكاء الاصطناعي المحلي) ----------
// stream:true + num_predict bound + keep_alive: يقلل زمن أول استجابة ويمنع الإطالة غير الضرورية
function askOllama(model, messages, onChunk) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model, messages, stream: true,
      keep_alive: '30m',
      options: { num_predict: 400, temperature: 0.4 }
    });
    const req = http.request({
      hostname: '127.0.0.1', port: 11434, path: '/api/chat', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 120000
    }, res => {
      let full = '';
      readLines(res, line => {
        if (!line.trim()) return;
        try {
          const j = JSON.parse(line);
          const delta = j.message && j.message.content;
          if (delta) { full += delta; if (onChunk) onChunk(delta); }
        } catch (e) { /* سطر غير مكتمل، تجاهله */ }
      });
      res.on('end', () => { full ? resolve(full) : reject(new Error('OLLAMA_PARSE')); });
    });
    req.on('error', () => reject(new Error('OLLAMA_OFFLINE')));
    req.on('timeout', () => { req.destroy(); reject(new Error('OLLAMA_TIMEOUT')); });
    req.write(body); req.end();
  });
}

// ---------- Claude API (اختياري إن وُضع مفتاح) ----------
function askClaude(key, messages, onChunk) {
  return new Promise((resolve, reject) => {
    const system = messages.find(m => m.role === 'system');
    const rest = messages.filter(m => m.role !== 'system');
    const body = JSON.stringify({
      model: 'claude-sonnet-5', max_tokens: 500, stream: true,
      system: system ? system.content : undefined, messages: rest
    });
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'x-api-key': key,
        'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body)
      }, timeout: 60000
    }, res => {
      let full = '', gotError = null;
      readLines(res, line => {
        if (!line.startsWith('data: ')) return;
        try {
          const j = JSON.parse(line.slice(6));
          if (j.type === 'content_block_delta' && j.delta && j.delta.text) {
            full += j.delta.text; if (onChunk) onChunk(j.delta.text);
          } else if (j.type === 'error') { gotError = j.error && j.error.message; }
        } catch (e) { /* سطر غير مكتمل */ }
      });
      res.on('end', () => {
        if (gotError) reject(new Error(gotError));
        else if (full) resolve(full);
        else reject(new Error('CLAUDE_ERROR'));
      });
    });
    req.on('error', reject);
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
  const netProfit = totalSales - totalCogs - totalExpenses;
  const totalPercent = d.shareholders.reduce((s, sh) => s + Number(sh.percent || 0), 0);
  const totalWithdrawals = d.withdrawals.reduce((s, w) => s + Number(w.amount || 0), 0);
  const totalWalletBalance = d.wallets.reduce((s, w) => s + walletBalance(d, w.id), 0);
  return { totalSales, totalCogs, totalExpenses, netProfit, totalPercent, totalWithdrawals, totalWalletBalance };
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
// onReset: يُستدعى إن بدأ Claude ببث نص جزئي ثم فشل، قبل التراجع إلى أولاما — لمسح النص الجزئي من الواجهة بدل دمجه مع رد مختلف.
async function askAI(userText, history = [], onChunk, preloadedData, onReset) {
  const d = preloadedData || loadData();
  const messages = [{ role: 'system', content: businessContext(d) }, ...history, { role: 'user', content: userText }];
  if (d.settings.anthropicKey) {
    let emittedAny = false;
    try {
      return await askClaude(d.settings.anthropicKey, messages, delta => { emittedAny = true; if (onChunk) onChunk(delta); });
    } catch (e) {
      if (emittedAny && onReset) onReset();
    }
  }
  return await askOllama(d.settings.aiModel || 'qwen2:latest', messages, onChunk);
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

async function tgHandle(token, msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const d = loadData();
  const c = d.settings.currency;
  let reply = '';
  if (text === '/start') {
    reply = `أهلاً بك في بوت "سند" 🌟\n\nالأوامر:\n/ملخص — ملخص المبيعات\n/منتجات — المخزون\n/فواتير — آخر الفواتير\n/مساهمين — توزيع الأرباح\n/ديون — ديون العملاء\n/محافظ — أرصدة الحسابات\nأو اسألني أي سؤال وسأجيبك بالذكاء الاصطناعي 🤖`;
  } else if (text === '/ملخص' || text === '/summary') {
    const total = d.invoices.reduce((s, i) => s + i.total, 0);
    const today = new Date().toISOString().slice(0, 10);
    const todayTotal = d.invoices.filter(i => i.date.slice(0, 10) === today).reduce((s, i) => s + i.total, 0);
    reply = `📊 ملخص ${d.settings.businessName}:\n\n💰 إجمالي المبيعات: ${total} ${c}\n📅 مبيعات اليوم: ${todayTotal} ${c}\n🧾 عدد الفواتير: ${d.invoices.length}\n📦 المنتجات: ${d.products.length}\n👥 العملاء: ${d.customers.length}`;
  } else if (text === '/منتجات' || text === '/products') {
    reply = d.products.length
      ? '📦 المخزون:\n\n' + d.products.map(p => `• ${p.name}: ${p.stock} قطعة — ${p.price} ${c}${p.stock <= 3 ? ' ⚠️' : ''}`).join('\n')
      : 'لا توجد منتجات بعد.';
  } else if (text === '/فواتير' || text === '/invoices') {
    reply = d.invoices.length
      ? '🧾 آخر الفواتير:\n\n' + d.invoices.slice(-8).reverse().map(i => `#${i.number} | ${i.customerName || 'زبون'} | ${i.total} ${c} | ${i.date.slice(0, 10)}`).join('\n')
      : 'لا توجد فواتير بعد.';
  } else if (text === '/مساهمين' || text === '/shareholders') {
    const f = computeFinancials(d);
    reply = d.shareholders.length
      ? `📈 توزيع الأرباح (صافي الربح: ${Math.round(f.netProfit)} ${c}):\n\n` + d.shareholders.map(sh => {
          const w = d.withdrawals.filter(x => x.shareholderId === sh.id).reduce((s, x) => s + Number(x.amount), 0);
          const share = f.netProfit * (Number(sh.percent) / 100);
          return `• ${sh.name} (${sh.percent}%): حصة ${Math.round(share)} ${c} — سُحب ${w} ${c} — الصافي المستحق ${Math.round(share - w)} ${c}`;
        }).join('\n')
      : 'لا يوجد مساهمون مسجلون بعد.';
  } else if (text === '/ديون' || text === '/debts') {
    const owing = d.invoices.reduce((s, i) => s + Math.max(0, i.total - (i.paidAmount || 0)), 0);
    const perCustomer = {};
    d.invoices.forEach(i => {
      const rem = Math.max(0, i.total - (i.paidAmount || 0));
      if (rem > 0) perCustomer[i.customerName || 'زبون نقدي'] = (perCustomer[i.customerName || 'زبون نقدي'] || 0) + rem;
    });
    const lines = Object.entries(perCustomer).map(([n, v]) => `• ${n}: ${Math.round(v)} ${c}`).join('\n');
    reply = `💳 إجمالي ديون العملاء: ${Math.round(owing)} ${c}\n\n${lines || 'لا توجد ديون مستحقة'}`;
  } else if (text === '/محافظ' || text === '/wallets') {
    reply = d.wallets.length
      ? '🏦 المحافظ والحسابات:\n\n' + d.wallets.map(w => `• ${w.name} (${w.type}): ${Math.round(walletBalance(d, w.id))} ${c}`).join('\n')
      : 'لا توجد محافظ مسجلة بعد.';
  } else if (text) {
    try { reply = await askAI(text, [], null, d); }
    catch (e) { reply = '⚠️ الذكاء الاصطناعي غير متاح حالياً. تأكد من تشغيل أولاما على الجهاز.'; }
  }
  if (reply) await tgApi(token, 'sendMessage', { chat_id: chatId, text: reply });
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
ipcMain.handle('data:load', () => loadData());
ipcMain.handle('data:save', (e, data) => { saveData(data); return true; });
ipcMain.handle('ai:ask', async (e, { text, history }) => {
  try {
    const full = await askAI(
      text, history || [],
      delta => { if (!e.sender.isDestroyed()) e.sender.send('ai:chunk', delta); },
      undefined,
      () => { if (!e.sender.isDestroyed()) e.sender.send('ai:reset'); }
    );
    return { ok: true, text: full };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('ai:check', async () => {
  return new Promise(resolve => {
    const req = http.get({ hostname: '127.0.0.1', port: 11434, path: '/api/tags', timeout: 3000 }, res => {
      let out = ''; res.on('data', c => out += c);
      res.on('end', () => { try { resolve({ ok: true, models: JSON.parse(out).models.map(m => m.name) }); } catch (e) { resolve({ ok: false }); } });
    });
    req.on('error', () => resolve({ ok: false }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
  });
});
ipcMain.handle('tg:start', async (e, { id, token }) => {
  try {
    const me = await tgApi(token, 'getMe');
    if (!me.ok) return { ok: false, error: 'رمز البوت غير صحيح' };
    const existing = tgBots.get(id);
    tgBots.set(id, { token, running: true, offset: existing ? existing.offset : 0 });
    if (!existing || !existing.running) tgLoop(id);
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
  createWindow();
  takeBackup();
  setInterval(takeBackup, 60 * 60 * 1000); // نسخة احتياطية إضافية كل ساعة أثناء التشغيل
});
app.on('window-all-closed', () => { tgBots.forEach(b => { b.running = false; }); app.quit(); });
