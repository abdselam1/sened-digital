const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

let win = null;
const DATA_FILE = () => path.join(app.getPath('userData'), 'sened-data.json');

// المفتاح المشترك المدمج: ملف builtin-ai.json يُشحن مع نسخة التطبيق الموزّعة (مُستثنى من المستودع العام عبر .gitignore)
// — يجعل كل الزبائن يحصلون على الذكاء الاصطناعي بلا حساب أو تعاقد منهم. يُقرأ مرة واحدة.
let BUILTIN_AI = null;
function builtinAiProvider() {
  if (BUILTIN_AI !== null) return BUILTIN_AI || null;
  try {
    const p = path.join(__dirname, 'builtin-ai.json');
    if (fs.existsSync(p)) {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (cfg && cfg.apiKey && cfg.baseUrl && cfg.model) {
        BUILTIN_AI = { id: 'builtin', name: cfg.name || 'Sened AI', type: cfg.type || 'openai-compatible', baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model, builtin: true };
        return BUILTIN_AI;
      }
    }
  } catch (e) { /* تجاهل */ }
  BUILTIN_AI = false;
  return null;
}
function writeBuiltinAi(cfg) {
  const p = path.join(__dirname, 'builtin-ai.json');
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
  BUILTIN_AI = null; // أعد التحميل في المرة القادمة
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
    aiModel: 'qwen2:latest', anthropicKey: '', theme: 'dark',
    aiProviders: [], activeProviderId: '',
    auth: { enabled: false, username: 'admin', salt: FRESH_AUTH_SALT, passwordHash: hashPass('admin123', FRESH_AUTH_SALT) },
    company: { address: '', rc: '', taxId: '', phone: '', notes: '', logoDataUrl: '' },
    notifications: { lowStock: true, weeklyReport: true, lastWeeklyNotif: '' },
    expenseBudgets: {}, onboardingDismissed: false, currencies: [],
    invoice: { template: 'classic', color: '#C8A45C' },
    expenseCategoryList: ['rent', 'salaries', 'utilities', 'transport', 'maintenance', 'marketing', 'other'],
    productCategoryList: [],
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
          notifications: { ...DEFAULT_DATA.settings.notifications, ...(saved.settings && saved.settings.notifications) },
          license: { ...DEFAULT_DATA.settings.license, ...(saved.settings && saved.settings.license) }
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

// يحمّل نموذج أولاما إلى الذاكرة في الخلفية عند بدء التطبيق (بدل انتظار أول سؤال من المستخدم)
// — تحميل النموذج لأول مرة قد يستغرق 15+ ثانية على أجهزة بلا كرت شاشة مخصص، فتحميله مبكراً
// يجعل أول سؤال فعلي من المستخدم يحصل على سرعة الاستجابة الطبيعية بدل الانتظار الكامل.
function warmUpOllama(model) {
  try {
    const body = JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], stream: false, keep_alive: '30m', options: { num_predict: 1 } });
    const req = http.request({
      hostname: '127.0.0.1', port: 11434, path: '/api/chat', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 60000
    }, res => { res.on('data', () => {}); res.on('end', () => {}); });
    req.on('error', () => {}); // أولاما غير مشغّل — لا بأس، سيُكتشف لاحقاً عادياً عند الاستخدام الفعلي
    req.on('timeout', () => req.destroy());
    req.write(body); req.end();
  } catch (e) { /* تجاهل بصمت */ }
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

// ---------- مزوّد متوافق مع OpenAI (يغطي Groq / Gemini / OpenAI / OpenRouter / DeepSeek بمسار واحد) ----------
// كلها تستخدم نفس صيغة chat/completions مع بث SSE، فتكفي دالة واحدة لعشرات المزودات السحابية.
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
// يعيد قائمة المزودات الفعّالة بالترتيب: النشط أولاً ثم البقية كاحتياطي.
// يدمج الإعدادات القديمة (anthropicKey/aiModel) كمزوّدات ضمنية للتوافق الرجعي.
function resolveProviders(d) {
  const userList = (d.settings.aiProviders || []).filter(p => p.enabled !== false);
  const all = userList.slice();
  // رتّب المزوّد النشط أولاً
  const activeId = d.settings.activeProviderId;
  if (activeId) {
    const idx = all.findIndex(p => p.id === activeId);
    if (idx > 0) { const [active] = all.splice(idx, 1); all.unshift(active); }
  }
  // المفتاح المشترك المدمج كاحتياطي (أو كافتراضي إن لم يضبط الزبون شيئاً)
  const builtin = builtinAiProvider();
  if (builtin) all.push(builtin);
  // توافق رجعي مع الإعدادات القديمة
  if (!all.length) {
    if (d.settings.anthropicKey) all.push({ id: 'legacy-claude', type: 'anthropic', apiKey: d.settings.anthropicKey });
    all.push({ id: 'legacy-ollama', type: 'ollama', model: d.settings.aiModel || 'qwen2:latest' });
  }
  return all;
}

async function callProvider(provider, messages, onChunk) {
  if (provider.type === 'ollama') return askOllama(provider.model || 'qwen2:latest', messages, onChunk);
  if (provider.type === 'anthropic') return askClaude(provider.apiKey, messages, onChunk);
  return askOpenAICompatible(provider, messages, onChunk); // openai-compatible وكل مشتقاته
}

async function askAI(userText, history = [], onChunk, preloadedData, onReset) {
  const d = preloadedData || loadData();
  const messages = [{ role: 'system', content: businessContext(d) }, ...history, { role: 'user', content: userText }];
  const providers = resolveProviders(d);
  let lastErr = null;
  for (const provider of providers) {
    let emittedAny = false;
    try {
      return await callProvider(provider, messages, delta => { emittedAny = true; if (onChunk) onChunk(delta); });
    } catch (e) {
      lastErr = e;
      if (emittedAny && onReset) onReset(); // امسح النص الجزئي قبل تجربة المزوّد التالي
    }
  }
  throw lastErr || new Error('NO_PROVIDER');
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
  } else if (text.startsWith('/claim ')) {
    const code = text.slice(7).trim();
    if (d.settings.license.ownerChatId) {
      reply = '⚠️ هذا البوت مرتبط بالفعل بحساب إدارة.';
    } else if (code === d.settings.license.claimCode) {
      d.settings.license.ownerChatId = String(chatId);
      saveData(d);
      reply = '✓ تم تفعيل صلاحيات الإدارة لهذا الحساب. أرسل /clients لرؤية العملاء.';
    } else {
      reply = '⚠️ رمز غير صحيح.';
    }
  } else if (/^\/(register|clients|lock|unlock|msg)\b/.test(text)) {
    reply = await handleAdminCommand(d, chatId, text);
  } else if (text) {
    try { reply = await askAI(text, [], null, d); }
    catch (e) { reply = '⚠️ الذكاء الاصطناعي غير متاح حالياً. تأكد من تشغيل أولاما على الجهاز.'; }
  }
  if (reply) await tgApi(token, 'sendMessage', { chat_id: chatId, text: reply });
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
  const d = loadData();
  const active = resolveProviders(d)[0];
  // مزوّد سحابي: يكفي وجود مفتاح — لا حاجة لفحص محلي، يُعتبر متاحاً (يتحقق فعلياً عند أول سؤال)
  if (active && active.type !== 'ollama') {
    return { ok: !!active.apiKey, cloud: true, providerName: active.name || active.type };
  }
  return new Promise(resolve => {
    const req = http.get({ hostname: '127.0.0.1', port: 11434, path: '/api/tags', timeout: 3000 }, res => {
      let out = ''; res.on('data', c => out += c);
      res.on('end', () => { try { resolve({ ok: true, models: JSON.parse(out).models.map(m => m.name) }); } catch (e) { resolve({ ok: false }); } });
    });
    req.on('error', () => resolve({ ok: false }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
  });
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
  { command: 'wallets', description: 'أرصدة المحافظ والحسابات' }
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
    if (!cfg || !cfg.apiKey) { // مسح المفتاح
      const p = path.join(__dirname, 'builtin-ai.json');
      if (fs.existsSync(p)) fs.unlinkSync(p);
      BUILTIN_AI = null;
      return { ok: true, cleared: true };
    }
    writeBuiltinAi({ name: cfg.name || 'Sened AI', type: 'openai-compatible', baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model });
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('ai:builtinInfo', () => {
  const b = builtinAiProvider();
  return b ? { present: true, name: b.name, model: b.model } : { present: false };
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
  createWindow();
  takeBackup();
  checkLicenseStatus();
  const d = loadData();
  const active = resolveProviders(d)[0];
  if (active && active.type === 'ollama') warmUpOllama(active.model || 'qwen2:latest');
  setInterval(takeBackup, 60 * 60 * 1000); // نسخة احتياطية إضافية كل ساعة أثناء التشغيل
  setInterval(checkLicenseStatus, 30 * 60 * 1000); // تحقق من حالة الترخيص كل نصف ساعة
});
app.on('window-all-closed', () => { tgBots.forEach(b => { b.running = false; }); app.quit(); });
