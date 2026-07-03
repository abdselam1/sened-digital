const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

let win = null;
const DATA_FILE = () => path.join(app.getPath('userData'), 'sened-data.json');

function hashPass(p) { return crypto.createHash('sha256').update(String(p)).digest('hex'); }

// ---------- التخزين ----------
const DEFAULT_DATA = {
  settings: {
    lang: 'ar', businessName: 'سند', currency: 'MRU', telegramToken: '',
    aiModel: 'qwen2:latest', anthropicKey: '', theme: 'dark',
    auth: { enabled: false, username: 'admin', passwordHash: hashPass('admin123') }
  },
  products: [], customers: [], invoices: [], expenses: [],
  purchases: [], suppliers: [], employees: [], shareholders: [], withdrawals: [],
  counters: { invoice: 1, purchase: 1 }
};

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE())) {
      const saved = JSON.parse(fs.readFileSync(DATA_FILE(), 'utf8'));
      return {
        ...DEFAULT_DATA, ...saved,
        settings: { ...DEFAULT_DATA.settings, ...saved.settings, auth: { ...DEFAULT_DATA.settings.auth, ...(saved.settings && saved.settings.auth) } },
        counters: { ...DEFAULT_DATA.counters, ...saved.counters }
      };
    }
  } catch (e) { console.error('load error', e); }
  return JSON.parse(JSON.stringify(DEFAULT_DATA));
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE(), JSON.stringify(data, null, 2), 'utf8');
}

// ---------- أولاما (الذكاء الاصطناعي المحلي) ----------
function askOllama(model, messages) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, messages, stream: false });
    const req = http.request({
      hostname: '127.0.0.1', port: 11434, path: '/api/chat', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 120000
    }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => {
        try { resolve(JSON.parse(out).message.content); }
        catch (e) { reject(new Error('OLLAMA_PARSE')); }
      });
    });
    req.on('error', () => reject(new Error('OLLAMA_OFFLINE')));
    req.on('timeout', () => { req.destroy(); reject(new Error('OLLAMA_TIMEOUT')); });
    req.write(body); req.end();
  });
}

// ---------- Claude API (اختياري إن وُضع مفتاح) ----------
function askClaude(key, messages) {
  return new Promise((resolve, reject) => {
    const system = messages.find(m => m.role === 'system');
    const rest = messages.filter(m => m.role !== 'system');
    const body = JSON.stringify({
      model: 'claude-sonnet-5', max_tokens: 1024,
      system: system ? system.content : undefined, messages: rest
    });
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'x-api-key': key,
        'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body)
      }, timeout: 60000
    }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(out);
          if (j.content && j.content[0]) resolve(j.content[0].text);
          else reject(new Error(j.error ? j.error.message : 'CLAUDE_ERROR'));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

function computeFinancials(d) {
  const totalSales = d.invoices.reduce((s, i) => s + i.total, 0);
  const totalCogs = d.invoices.reduce((s, i) => s + i.items.reduce((ss, it) => ss + (Number(it.cost || 0) * it.qty), 0), 0);
  const totalExpenses = d.expenses.reduce((s, e) => s + Number(e.amount || 0), 0);
  const netProfit = totalSales - totalCogs - totalExpenses;
  const totalPercent = d.shareholders.reduce((s, sh) => s + Number(sh.percent || 0), 0);
  const totalWithdrawals = d.withdrawals.reduce((s, w) => s + Number(w.amount || 0), 0);
  return { totalSales, totalCogs, totalExpenses, netProfit, totalPercent, totalWithdrawals };
}

function businessContext() {
  const d = loadData();
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
- أحدث 5 فواتير: ${d.invoices.slice(-5).map(i => `#${i.number} ${i.customerName || 'زبون'} = ${i.total}`).join(' | ') || 'لا يوجد'}`;
}

async function askAI(userText, history = []) {
  const d = loadData();
  const messages = [{ role: 'system', content: businessContext() }, ...history, { role: 'user', content: userText }];
  if (d.settings.anthropicKey) {
    try { return await askClaude(d.settings.anthropicKey, messages); } catch (e) { /* جرّب أولاما */ }
  }
  return await askOllama(d.settings.aiModel || 'qwen2:latest', messages);
}

// ---------- بوت تلجرام ----------
let tgRunning = false, tgOffset = 0, tgToken = '';

function tgApi(method, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload || {});
    const req = https.request({
      hostname: 'api.telegram.org', path: `/bot${tgToken}/${method}`, method: 'POST',
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

async function tgHandle(msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const d = loadData();
  const c = d.settings.currency;
  let reply = '';
  if (text === '/start') {
    reply = `أهلاً بك في بوت "سند" 🌟\n\nالأوامر:\n/ملخص — ملخص المبيعات\n/منتجات — المخزون\n/فواتير — آخر الفواتير\n/مساهمين — توزيع الأرباح\n/ديون — ديون العملاء\nأو اسألني أي سؤال وسأجيبك بالذكاء الاصطناعي 🤖`;
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
  } else if (text) {
    try { reply = await askAI(text); }
    catch (e) { reply = '⚠️ الذكاء الاصطناعي غير متاح حالياً. تأكد من تشغيل أولاما على الجهاز.'; }
  }
  if (reply) await tgApi('sendMessage', { chat_id: chatId, text: reply });
}

async function tgLoop() {
  while (tgRunning) {
    try {
      const res = await tgApi('getUpdates', { offset: tgOffset, timeout: 50 });
      if (res.ok && res.result) {
        for (const u of res.result) {
          tgOffset = u.update_id + 1;
          if (u.message) tgHandle(u.message).catch(() => {});
        }
      }
      if (win && !win.isDestroyed()) win.webContents.send('tg-status', { running: true });
    } catch (e) {
      if (win && !win.isDestroyed()) win.webContents.send('tg-status', { running: tgRunning, error: e.message });
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// ---------- IPC ----------
ipcMain.handle('data:load', () => loadData());
ipcMain.handle('data:save', (e, data) => { saveData(data); return true; });
ipcMain.handle('ai:ask', async (e, { text, history }) => {
  try { return { ok: true, text: await askAI(text, history || []) }; }
  catch (err) { return { ok: false, error: err.message }; }
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
ipcMain.handle('tg:start', async (e, token) => {
  tgToken = token;
  try {
    const me = await tgApi('getMe');
    if (!me.ok) return { ok: false, error: 'رمز البوت غير صحيح' };
    if (!tgRunning) { tgRunning = true; tgLoop(); }
    return { ok: true, name: me.result.username };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('tg:stop', () => { tgRunning = false; return true; });
ipcMain.handle('app:print', () => { if (win) win.webContents.print({ silent: false, printBackground: true }); return true; });
ipcMain.handle('app:openExternal', (e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });
ipcMain.handle('auth:verify', (e, { username, password }) => {
  const d = loadData();
  return d.settings.auth.username === username && d.settings.auth.passwordHash === hashPass(password);
});
ipcMain.handle('auth:setCredentials', (e, { username, password }) => {
  const d = loadData();
  d.settings.auth.username = username;
  if (password) d.settings.auth.passwordHash = hashPass(password);
  saveData(d);
  return true;
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

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { tgRunning = false; app.quit(); });
