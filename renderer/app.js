/* ====== سند — منطق التطبيق ====== */
let DB = null;
let T = I18N.ar;
let chatHistory = [];

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// نستخدم en-US دائماً لضمان أرقام غربية (0123..) في كل مكان، بلا أرقام هندية مهما كانت لغة الواجهة
const fmt = n => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
const cur = () => DB.settings.currency || 'MRU';
const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// وضع المتصفح (بدون Electron) — للمعاينة فقط
const bridge = window.sened || {
  loadData: async () => JSON.parse(localStorage.getItem('sened') || 'null') || {
    settings: {
      lang: 'ar', businessName: 'سند', currency: 'MRU', telegramBots: [], groqKey: '', theme: 'dark',
      auth: { enabled: false, username: 'admin', passwordHash: '' },
      company: { address: '', rc: '', taxId: '', phone: '', notes: '', logoDataUrl: '' },
      notifications: { lowStock: true, weeklyReport: true, lastWeeklyNotif: '' },
      expenseBudgets: {}, onboardingDismissed: false, currencies: [],
      invoice: { template: 'classic', color: '#C8A45C' },
      expenseCategoryList: ['rent', 'salaries', 'utilities', 'transport', 'maintenance', 'marketing', 'other'],
      productCategoryList: [],
      license: { deviceId: 'browser-preview', gistId: '', gistToken: '', ownerChatId: '', claimCode: '', locked: false, message: '', lastCheck: '' }
    },
    products: [], customers: [], invoices: [], expenses: [], quotes: [],
    purchases: [], suppliers: [], employees: [], shareholders: [], withdrawals: [],
    wallets: [], walletTx: [],
    auditLog: [], trash: [], returns: [],
    counters: { invoice: 1, purchase: 1, quote: 1 }
  },
  saveData: async d => localStorage.setItem('sened', JSON.stringify(d)),
  askAI: async () => ({ ok: false, error: 'BROWSER' }),
  checkAI: async () => ({ ok: false }),
  tgStart: async () => ({ ok: false, error: 'BROWSER' }),
  tgStop: async () => true,
  print: async () => window.print(),
  exportPdf: async () => ({ ok: false, error: 'BROWSER' }),
  openBackupsFolder: async () => false,
  onTgStatus: () => {},
  onAiChunk: () => {},
  onAiReset: () => {},
  authVerify: async () => ({ role: 'manager', name: 'admin' }),
  authSetCredentials: async () => true,
  authHashPassword: async (p) => ({ salt: 'browser', hash: p }),
  licenseCheckNow: async () => true,
  licenseRegenClaimCode: async () => 'BROWSER',
  licenseCreateGist: async () => ({ ok: false, error: 'BROWSER' }),
  onLicenseStatus: () => {},
  aiSetBuiltinKey: async () => ({ ok: false, error: 'BROWSER' }),
  aiBuiltinInfo: async () => ({ present: false }),
  activationStatus: async () => ({ required: false }),
  activationVerify: async () => ({ ok: true }),
  activationSetDevCode: async () => ({ ok: true }),
  activationHasDevCode: async () => ({ hasCode: false }),
  appFlavor: async () => 'full',
  cashierIp: async () => '127.0.0.1',
  onSyncUpdated: () => {},
  deviceRoleGet: async () => JSON.parse(localStorage.getItem('sened-devrole') || 'null') || { role: null, boundAt: '' },
  deviceRoleSet: async (role) => { const v = { role, boundAt: new Date().toISOString() }; localStorage.setItem('sened-devrole', JSON.stringify(v)); return v; },
  deviceRoleClear: async () => { const v = { role: null, boundAt: '' }; localStorage.setItem('sened-devrole', JSON.stringify(v)); return v; },
  lanGetConfig: async () => ({ role: 'off', hostIp: '', port: 3050, token: '', deviceName: '' }),
  lanSetConfig: async () => ({ ok: true }),
  lanStatus: async () => ({ role: 'off', hostIp: '', port: 3050, myIp: '127.0.0.1', deviceName: '', token: '', serverRunning: false, connectedClients: 0, clientNames: [], clientConnected: false, rev: 0 }),
  lanTest: async () => ({ ok: false, error: 'BROWSER' }),
  lanDiscover: async () => [],
  onSyncPostFailed: () => {},
  uiPrefsGet: async () => JSON.parse(localStorage.getItem('sened-uiprefs') || 'null') || { lang: '', theme: '' },
  uiPrefsSet: async (p) => {
    const next = JSON.parse(localStorage.getItem('sened-uiprefs') || 'null') || { lang: '', theme: '' };
    ['lang', 'theme'].forEach(k => { if (p && p[k] !== undefined) next[k] = p[k]; });
    localStorage.setItem('sened-uiprefs', JSON.stringify(next));
    return next;
  }
};

// تفضيلات العرض المحلية لهذا الجهاز (لغة/سمة) — تُخزَّن محلياً (ui-prefs.json) خارج البيانات
// المزامَنة، وإلا لقلب تغييرُ المحاسب للغة واجهاتِ كل الأجهزة. فارغة = استعمل المشترك (توافق رجعي).
let UI_PREFS = { lang: '', theme: '' };
const effLang = () => UI_PREFS.lang || DB.settings.lang || 'ar';
const effTheme = () => UI_PREFS.theme || DB.settings.theme || 'dark';

// ---------- الترجمة ----------

function applyLang() {
  const lang = effLang();
  T = I18N[lang] || I18N.ar;
  document.documentElement.lang = lang;
  document.documentElement.dir = T.dir;
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = T[el.dataset.i18n] || el.dataset.i18n; });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = T[el.dataset.i18nPh] || ''; });
  $('brandName').textContent = DB.settings.businessName || T.appName;
  applyThemeLabel();
  document.querySelectorAll('.lang-switch button').forEach(b => b.classList.toggle('active', b.dataset.lang === lang));
}

// أزرار اللغة العلوية تغيّر لغة هذا الجهاز فقط (تفضيل محلي) — لا تمسّ الإعداد المشترك المزامَن
async function switchLanguage(lang) {
  if (effLang() === lang) return;
  UI_PREFS.lang = lang;
  try { await bridge.uiPrefsSet({ lang }); } catch (e) {}
  applyLang();
  renderAll();
  checkAI();
}

// ---------- المظهر (ليلي/نهاري) — تفضيل محلي لهذا الجهاز مثل اللغة ----------
function applyTheme() {
  document.documentElement.setAttribute('data-theme', effTheme() === 'light' ? 'light' : 'dark');
  applyThemeLabel();
}
function applyThemeLabel() {
  const isLight = effTheme() === 'light';
  $('themeLabel').textContent = isLight ? T.themeLight : T.themeDark;
  $('themeBtn').querySelector('.ic').textContent = isLight ? '☀' : '☾';
}
async function toggleTheme() {
  UI_PREFS.theme = effTheme() === 'light' ? 'dark' : 'light';
  try { await bridge.uiPrefsSet({ theme: UI_PREFS.theme }); } catch (e) {}
  applyTheme();
}

async function persist() { await bridge.saveData(DB); }

function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

// ---------- الدخول والقفل والصلاحيات ----------
let currentRole = 'manager', currentUserName = 'admin';
let APP_FLAVOR = 'full'; // 'admin' | 'cashier' | 'full' — تُقرأ من نكهة النسخة الموزّعة
// قفل دور الجهاز: يُقرأ من الملف المحلي device-role.json عند الإقلاع.
// null = الجهاز غير مربوط بعد؛ أول دخول بدور تشغيلي يربطه. المدير يتجاوز القفل دائماً.
let deviceBoundRole = null;
const PERMS = {
  manager: null, // null = كل الصفحات
  // صفحة «الاتصال بالشبكة» (network) متاحة لكل الأدوار: بدونها لا يستطيع المحاسب/الكاشير ربط جهازه بالخادم
  accountant: ['dashboard', 'invoices', 'quotations', 'purchases', 'products', 'customers', 'suppliers', 'debts', 'wallets', 'expenses', 'reports', 'assistant', 'network'],
  cashier: ['dashboard', 'invoices', 'quotations', 'products', 'customers', 'network']
};
// الصفحة التي يُوجَّه إليها كل دور فور الدخول (الكاشير يبدأ من الفواتير مباشرةً)
const LANDING = { manager: 'dashboard', accountant: 'dashboard', cashier: 'invoices' };
// الاسم المترجَم للدور (يُستخدم في الرسائل ولوحة قفل الجهاز)
function roleName(r) { return T['role' + r.charAt(0).toUpperCase() + r.slice(1)] || r; }

function applyPermissions() {
  const allowed = PERMS[currentRole];
  document.querySelectorAll('.nav-item').forEach(item => {
    const page = item.dataset.page;
    item.style.display = (allowed && !allowed.includes(page)) ? 'none' : '';
  });
  const label = $('currentUserLabel');
  if (label) label.textContent = `${currentUserName} — ${T['role' + currentRole.charAt(0).toUpperCase() + currentRole.slice(1)] || currentRole}`;
  applyLanHostOptionVisibility();
  // إن كانت الصفحة الحالية غير مسموحة، ارجع للوحة التحكم
  const activePage = document.querySelector('.page.active');
  if (activePage && allowed && !allowed.includes(activePage.id.replace('page-', ''))) goPage('dashboard');
}

// خيار «الخادم الرئيسي (المضيف)» حكر على المدير — غير المدير يرى فقط: بدون شبكة / جهاز متصل.
// الإخفاء هنا للعرض، والفرض الفعلي عند نقطة الحفظ في saveLanConfig.
function applyLanHostOptionVisibility() {
  const sel = $('lanRoleSelect');
  if (!sel) return;
  const hostOpt = sel.querySelector('option[value="host"]');
  if (hostOpt) {
    const isManager = currentRole === 'manager';
    hostOpt.hidden = !isManager;
    hostOpt.disabled = !isManager;
    if (!isManager && sel.value === 'host') { sel.value = 'off'; onLanRoleChange(); }
  }
}

async function doLogin() {
  const u = $('loginUser').value.trim();
  const p = $('loginPass').value;
  const res = await bridge.authVerify(u, p);
  if (!res) { $('loginError').textContent = T.wrongLogin; return; }

  let role = res.role || 'manager';
  if (APP_FLAVOR === 'cashier') role = 'cashier'; // نسخة الكاشير لا ترفع الصلاحية أبداً

  // قفل دور الجهاز: إن كان الجهاز مربوطاً بدور، لا يُقبل الدخول بدور مختلف.
  // المدير وحده يتجاوز القفل (ليتمكن من الإدارة وإعادة تعيين الجهاز).
  if (deviceBoundRole && role !== deviceBoundRole && role !== 'manager') {
    $('loginError').textContent = (T.deviceRoleLocked || '').replace('{role}', roleName(deviceBoundRole));
    return;
  }

  currentRole = role; currentUserName = res.name || u;

  // ربط الجهاز عند أول دخول بدور تشغيلي (محاسب/كاشير) فيبقى مقفلاً عليه دائماً.
  // دخول المدير لا يربط الجهاز — يبقى المدير متنقلاً حراً ويعيّن الأجهزة يدوياً.
  if (!deviceBoundRole && role !== 'manager') {
    deviceBoundRole = role;
    await bridge.deviceRoleSet(role);
  }

  $('loginScreen').classList.remove('open');
  $('loginError').textContent = '';
  $('appShell').classList.remove('hidden');
  await startApp();
  applyPermissions();
  goPage(LANDING[currentRole] || 'dashboard');
}

function lockApp() {
  $('lockPass').value = ''; $('lockError').textContent = '';
  $('lockScreen').classList.add('open');
}

async function doUnlock() {
  const p = $('lockPass').value;
  const res = await bridge.authVerify(currentUserName, p);
  if (res) { $('lockScreen').classList.remove('open'); }
  else { $('lockError').textContent = T.wrongLogin; }
}

function logoutApp() {
  currentRole = 'manager'; currentUserName = 'admin';
  $('appShell').classList.add('hidden');
  if (DB.settings.auth && DB.settings.auth.enabled) {
    $('loginUser').value = ''; $('loginPass').value = ''; $('loginError').textContent = '';
    $('loginScreen').classList.add('open');
  } else {
    location.reload();
  }
}

// ---------- التنقل ----------
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    const allowed = PERMS[currentRole];
    if (allowed && !allowed.includes(item.dataset.page)) { toast(T.accessDenied); return; }
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    item.classList.add('active');
    $('page-' + item.dataset.page).classList.add('active');
    renderAll();
    // صفحة الاتصال بالشبكة: حدّث حالة اللوحة عند كل فتح (العنوان، الحالة، الأجهزة المتصلة)
    if (item.dataset.page === 'network') refreshLanUI();
  });
});

// ---------- النوافذ ----------
function openModal(html) { $('modalBox').innerHTML = html; $('modalBg').classList.add('open'); }
function closeModal() { $('modalBg').classList.remove('open'); }
$('modalBg').addEventListener('click', e => { if (e.target === $('modalBg')) closeModal(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if ($('cmdkBg').classList.contains('open')) closeCmdk();
    else if ($('modalBg').classList.contains('open')) closeModal();
    else if ($('lockScreen').classList.contains('open')) { /* لا يُغلق بدون كلمة مرور */ }
    return;
  }
  // Ctrl+K / Ctrl+F: لوحة الأوامر والبحث الشامل
  if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K' || e.key === 'f' || e.key === 'F')) {
    e.preventDefault(); openCmdk(); return;
  }
  // Ctrl+Shift+U: مفتاح نجاة المدير — إدخال كود المطوّر لفكّ قفل دور الجهاز من أي واجهة (حتى بلا تسجيل دخول)
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'u' || e.key === 'U')) {
    e.preventDefault(); openDeviceUnlock(); return;
  }
  // Ctrl+N: فاتورة جديدة سريعة
  if ((e.ctrlKey || e.metaKey) && (e.key === 'n' || e.key === 'N')) {
    e.preventDefault();
    if (!$('modalBg').classList.contains('open') && !$('cmdkBg').classList.contains('open')) openInvoiceModal();
    return;
  }
  // Ctrl+S: حفظ النافذة المفتوحة حالياً
  if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
    e.preventDefault();
    const btn = document.querySelector('#modalBox .btn-gold');
    if (btn) btn.click();
    return;
  }
  // Alt+1..9: التنقل بين صفحات الشريط الجانبي
  if (e.altKey && /^[1-9]$/.test(e.key)) {
    const items = document.querySelectorAll('.nav-item');
    const idx = Number(e.key) - 1;
    if (items[idx]) { e.preventDefault(); items[idx].click(); }
  }
});

// ---------- لوحة الأوامر والبحث الشامل (Ctrl+K) ----------
let cmdkItems = [], cmdkActive = 0;
function cmdkActionList() {
  const all = [
    { page: 'invoices', icon: '▤', label: T.newInvoice, action: () => { closeCmdk(); openInvoiceModal(); } },
    { page: 'quotations', icon: '◧', label: T.newQuotation, action: () => { closeCmdk(); goPage('quotations'); openQuoteModal(); } },
    { page: 'purchases', icon: '⇩', label: T.newPurchase, action: () => { closeCmdk(); goPage('purchases'); openPurchaseModal(); } },
    { page: 'products', icon: '▣', label: T.addProduct, action: () => { closeCmdk(); goPage('products'); openProductModal(); } },
    { page: 'customers', icon: '◉', label: T.addCustomer, action: () => { closeCmdk(); goPage('customers'); openCustomerModal(); } },
    { page: 'suppliers', icon: '◎', label: T.addSupplier, action: () => { closeCmdk(); goPage('suppliers'); openSupplierModal(); } },
    { page: 'employees', icon: '◈', label: T.addEmployee, action: () => { closeCmdk(); goPage('employees'); openEmployeeModal(); } },
    { page: 'shareholders', icon: '◇', label: T.addShareholder, action: () => { closeCmdk(); goPage('shareholders'); openShareholderModal(); } },
    { page: 'wallets', icon: '◆', label: T.addWallet, action: () => { closeCmdk(); goPage('wallets'); openWalletModal(); } },
    { page: 'expenses', icon: '▽', label: T.addExpense, action: () => { closeCmdk(); goPage('expenses'); openExpenseModal(); } },
    { page: 'assistant', icon: '✦', label: T.assistant, action: () => { closeCmdk(); goPage('assistant'); } },
    { page: 'network', icon: '⇌', label: T.networkPage, action: () => { closeCmdk(); goPage('network'); } },
    { page: 'settings', icon: '⚙', label: T.settings, action: () => { closeCmdk(); goPage('settings'); } },
    { page: null, icon: '▦', label: T.calculator, action: () => { closeCmdk(); openCalculator(); } },
    { page: 'dashboard', icon: '◈', label: T.dashboard, action: () => { closeCmdk(); goPage('dashboard'); } }
  ];
  const allowed = PERMS[currentRole];
  return allowed ? all.filter(a => !a.page || allowed.includes(a.page)) : all;
}

function goPage(page) {
  const item = document.querySelector(`.nav-item[data-page="${page}"]`);
  if (item) item.click();
}

function openCmdk() {
  $('cmdkBg').classList.add('open');
  $('cmdkInput').value = '';
  cmdkRender('');
  setTimeout(() => $('cmdkInput').focus(), 20);
}
function closeCmdk() { $('cmdkBg').classList.remove('open'); }

function cmdkRender(query) {
  const q = query.trim().toLowerCase();
  let html = '';
  cmdkItems = [];

  if (!q) {
    html += `<div class="cmdk-group">${T.cmdkActions}</div>`;
    cmdkActionList().forEach(a => { cmdkItems.push(a); });
  } else {
    const allowed = PERMS[currentRole];
    const canSee = page => !allowed || allowed.includes(page);
    const dataResults = [];
    if (canSee('products')) DB.products.forEach(p => { if (p.name.toLowerCase().includes(q)) dataResults.push({ icon: '▣', label: p.name, sub: `${T.products} · ${fmt(p.price)} ${cur()}`, action: () => { closeCmdk(); goPage('products'); $('prodSearch').value = p.name; renderProducts(); } }); });
    if (canSee('customers')) DB.customers.forEach(c => { if (c.name.toLowerCase().includes(q) || (c.phone || '').includes(q) || (c.accountNo || '').toLowerCase().includes(q)) dataResults.push({ icon: '◉', label: c.accountNo ? `${c.name} (${c.accountNo})` : c.name, sub: T.customers, action: () => { closeCmdk(); goPage('customers'); $('custSearch').value = c.name; renderCustomers(); } }); });
    if (canSee('suppliers')) DB.suppliers.forEach(s => { if (s.name.toLowerCase().includes(q)) dataResults.push({ icon: '◎', label: s.name, sub: T.suppliers, action: () => { closeCmdk(); goPage('suppliers'); } }); });
    if (canSee('invoices')) DB.invoices.forEach(i => { if (String(i.number).includes(q) || (i.customerName || '').toLowerCase().includes(q)) dataResults.push({ icon: '▤', label: `#${i.number} — ${i.customerName || T.walkIn}`, sub: `${fmt(i.total)} ${cur()}`, action: () => { closeCmdk(); goPage('invoices'); } }); });
    if (canSee('employees')) DB.employees.forEach(e => { if (e.name.toLowerCase().includes(q)) dataResults.push({ icon: '◈', label: e.name, sub: T.employees, action: () => { closeCmdk(); goPage('employees'); } }); });
    if (canSee('shareholders')) DB.shareholders.forEach(s => { if (s.name.toLowerCase().includes(q)) dataResults.push({ icon: '◇', label: s.name, sub: T.shareholders, action: () => { closeCmdk(); goPage('shareholders'); } }); });
    if (canSee('wallets')) DB.wallets.forEach(w => { if (w.name.toLowerCase().includes(q)) dataResults.push({ icon: '◆', label: w.name, sub: T.wallets, action: () => { closeCmdk(); goPage('wallets'); } }); });
    const actionMatches = cmdkActionList().filter(a => a.label.toLowerCase().includes(q));

    if (dataResults.length) { html += `<div class="cmdk-group">${T.cmdkResults}</div>`; dataResults.slice(0, 20).forEach(r => cmdkItems.push(r)); }
    if (actionMatches.length) { html += `<div class="cmdk-group">${T.cmdkActions}</div>`; actionMatches.forEach(a => cmdkItems.push(a)); }
    if (!dataResults.length && !actionMatches.length) html = `<div class="empty">${T.cmdkNoResults}</div>`;
  }

  cmdkActive = 0;
  $('cmdkResults').innerHTML = html + cmdkItems.map((it, ix) => `
    <div class="cmdk-item${ix === 0 ? ' active' : ''}" data-ix="${ix}">
      <span class="cmdk-ic">${it.icon}</span><span>${esc(it.label)}</span>${it.sub ? `<span class="cmdk-sub">${esc(it.sub)}</span>` : ''}
    </div>`).join('');
  $('cmdkResults').querySelectorAll('.cmdk-item').forEach(el => {
    el.addEventListener('click', () => cmdkItems[Number(el.dataset.ix)].action());
    el.addEventListener('mouseenter', () => cmdkSetActive(Number(el.dataset.ix)));
  });
}

function cmdkSetActive(ix) {
  cmdkActive = ix;
  $('cmdkResults').querySelectorAll('.cmdk-item').forEach((el, i) => el.classList.toggle('active', i === ix));
}

$('cmdkInput').addEventListener('input', () => cmdkRender($('cmdkInput').value));
$('cmdkInput').addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') { e.preventDefault(); cmdkSetActive(Math.min(cmdkActive + 1, cmdkItems.length - 1)); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); cmdkSetActive(Math.max(cmdkActive - 1, 0)); }
  else if (e.key === 'Enter') { e.preventDefault(); if (cmdkItems[cmdkActive]) cmdkItems[cmdkActive].action(); }
});
$('cmdkBg').addEventListener('click', e => { if (e.target === $('cmdkBg')) closeCmdk(); });

// ---------- تأثير التموّج عند الضغط على الأزرار ----------
document.addEventListener('click', e => {
  const btn = e.target.closest('.btn');
  if (!btn) return;
  const r = btn.getBoundingClientRect();
  const ripple = document.createElement('span');
  const size = Math.max(r.width, r.height) * 1.4;
  ripple.className = 'btn-ripple';
  ripple.style.width = ripple.style.height = size + 'px';
  ripple.style.left = (e.clientX - r.left - size / 2) + 'px';
  ripple.style.top = (e.clientY - r.top - size / 2) + 'px';
  btn.appendChild(ripple);
  ripple.addEventListener('animationend', () => ripple.remove());
});

// ---------- عدّاد الأرقام المتحرك ----------
function animateCounters(containerId) {
  document.querySelectorAll(`#${containerId} .c-value[data-val]`).forEach(el => {
    const target = parseFloat(el.dataset.val) || 0;
    const suffix = el.dataset.suffix || '';
    const start = performance.now();
    const dur = 650;
    (function step(now) {
      const p = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt(target * eased) + suffix;
      if (p < 1) requestAnimationFrame(step);
      else el.textContent = fmt(target) + suffix;
    })(start);
  });
}

// ---------- الحسابات المالية ----------
function financials() {
  const totalSales = DB.invoices.reduce((s, i) => s + i.total, 0);
  const totalCogs = DB.invoices.reduce((s, i) => s + i.items.reduce((ss, it) => ss + (Number(it.cost || 0) * it.qty), 0), 0);
  const totalExpenses = DB.expenses.reduce((s, e) => s + Number(e.amount || 0), 0);
  const grossProfit = totalSales - totalCogs;
  const netProfit = grossProfit - totalExpenses;
  const custDebt = DB.invoices.reduce((s, i) => s + Math.max(0, i.total - (i.paidAmount || 0)), 0);
  const supDebt = DB.purchases.reduce((s, p) => s + Math.max(0, p.total - (p.paidAmount || 0)), 0);
  const totalPercent = DB.shareholders.reduce((s, sh) => s + Number(sh.percent || 0), 0);
  const totalWalletBalance = DB.wallets.reduce((s, w) => s + walletBalance(w.id), 0);
  return { totalSales, totalCogs, totalExpenses, grossProfit, netProfit, custDebt, supDebt, totalPercent, totalWalletBalance };
}

function walletBalance(walletId) {
  return DB.walletTx.reduce((bal, t) => {
    if (t.type === 'deposit' && t.walletId === walletId) return bal + Number(t.amount);
    if (t.type === 'withdraw' && t.walletId === walletId) return bal - Number(t.amount);
    if (t.type === 'transfer') {
      if (t.walletId === walletId) return bal - Number(t.amount);
      if (t.toWalletId === walletId) return bal + Number(t.amount);
    }
    return bal;
  }, 0);
}

// ---------- الباركود (Code 39) ----------
const CODE39_PATTERNS = {
  '0': '000110100', '1': '100100001', '2': '001100001', '3': '101100000', '4': '000110001',
  '5': '100110000', '6': '001110000', '7': '000100101', '8': '100100100', '9': '001100100',
  'A': '100001001', 'B': '001001001', 'C': '101001000', 'D': '000011001', 'E': '100011000',
  'F': '001011000', 'G': '000001101', 'H': '100001100', 'I': '001001100', 'J': '000011100',
  'K': '100000011', 'L': '001000011', 'M': '101000010', 'N': '000010011', 'O': '100010010',
  'P': '001010010', 'Q': '000000111', 'R': '100000110', 'S': '001000110', 'T': '000010110',
  'U': '110000001', 'V': '011000001', 'W': '111000000', 'X': '010010001', 'Y': '110010000',
  'Z': '011010000', '-': '010000101', '.': '110000100', ' ': '011000100', '$': '010101000',
  '/': '010100010', '+': '010001010', '%': '000101010', '*': '010010100'
};

function code39Svg(text, opts) {
  const o = Object.assign({ narrow: 2, wide: 5, height: 60, quiet: 10 }, opts || {});
  const clean = ('*' + String(text).toUpperCase().replace(/[^0-9A-Z\-. $/+%]/g, '') + '*');
  let x = o.quiet;
  const bars = [];
  for (let ci = 0; ci < clean.length; ci++) {
    const pattern = CODE39_PATTERNS[clean[ci]];
    if (!pattern) continue;
    for (let i = 0; i < pattern.length; i++) {
      const isBar = i % 2 === 0;
      const w = pattern[i] === '1' ? o.wide : o.narrow;
      if (isBar) bars.push(`<rect x="${x}" y="0" width="${w}" height="${o.height}" fill="#000"/>`);
      x += w;
    }
    x += o.narrow; // فاصل بين الأحرف
  }
  const totalW = x + o.quiet;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${o.height}" viewBox="0 0 ${totalW} ${o.height}">${bars.join('')}</svg>`;
}

// ---------- آلة حاسبة سريعة ----------
function openCalculator() {
  openModal(`<h3>${T.calculator}</h3>
    <input id="calcDisplay" readonly style="font-size:1.8rem;text-align:end;font-family:monospace;margin-bottom:14px" value="0">
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px">
      ${['7','8','9','÷','4','5','6','×','1','2','3','−','0','.','=','+'].map(k => `<button class="btn ${'+−×÷='.includes(k) ? 'btn-gold' : 'btn-ghost'}" onclick="calcPress('${k}')">${k}</button>`).join('')}
      <button class="btn btn-ghost" style="grid-column:span 2" onclick="calcPress('BACK')">⌫</button>
      <button class="btn btn-danger" style="grid-column:span 2" onclick="calcPress('C')">C</button>
    </div>`);
}
let calcExpr = '';
function calcPress(k) {
  if (k === 'C') { calcExpr = ''; }
  else if (k === 'BACK') { calcExpr = calcExpr.slice(0, -1); }
  else if (k === '=') {
    try { calcExpr = String(Function('"use strict";return (' + calcExpr.replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-') + ')')()); }
    catch (e) { calcExpr = ''; }
  } else calcExpr += k;
  $('calcDisplay').value = calcExpr || '0';
}

function printBarcode(id) {
  const p = DB.products.find(x => x.id === id);
  if (!p || !p.barcode) return;
  $('print-area').innerHTML = `
    <div style="text-align:center;padding:30px">
      <div style="font-weight:900;font-size:1.1rem;margin-bottom:10px">${esc(p.name)}</div>
      ${code39Svg(p.barcode)}
      <div style="margin-top:6px;font-family:monospace;letter-spacing:2px">${esc(p.barcode)}</div>
      <div style="margin-top:4px">${fmt(p.price)} ${cur()}</div>
    </div>`;
  bridge.print();
}

// ---------- سجل التدقيق وسلة المحذوفات ----------
function logAudit(action, entityType, label) {
  DB.auditLog = DB.auditLog || [];
  // اسم الجهاز (إن ضُبط في إعدادات الشبكة) يُلحق بالمستخدم ليعرف المدير من أي جهاز تمّت العملية
  const who = lanDeviceName ? `${currentUserName} @ ${lanDeviceName}` : currentUserName;
  DB.auditLog.unshift({ id: uid('al'), action, entityType, label: label || '', user: who, device: lanDeviceName || '', date: new Date().toISOString() });
  if (DB.auditLog.length > 500) DB.auditLog.length = 500;
}

async function softDelete(arrayName, id, entityType, extra) {
  if (!confirm(T.confirmDelete)) return false;
  const idx = DB[arrayName].findIndex(x => x.id === id);
  if (idx === -1) return false;
  const [item] = DB[arrayName].splice(idx, 1);
  const bundle = { item };
  if (extra) Object.assign(bundle, extra(item));
  DB.trash = DB.trash || [];
  const label = item.name || (item.number ? '#' + item.number : '');
  DB.trash.unshift({ id: uid('tr'), arrayName, entityType, bundle, label, deletedAt: new Date().toISOString(), deletedBy: currentUserName });
  logAudit('delete', entityType, label);
  await persist(); renderAll();
  toast(T.movedToTrash);
  return true;
}

async function restoreTrash(trashId) {
  const idx = DB.trash.findIndex(t => t.id === trashId);
  if (idx === -1) return;
  const entry = DB.trash[idx];
  DB[entry.arrayName].push(entry.bundle.item);
  if (entry.bundle.withdrawals) DB.withdrawals.push(...entry.bundle.withdrawals);
  if (entry.bundle.walletTx) DB.walletTx.push(...entry.bundle.walletTx);
  DB.trash.splice(idx, 1);
  logAudit('restore', entry.entityType || entry.arrayName, entry.label);
  await persist(); renderAll(); renderTrash();
  toast(T.restored);
}

async function emptyTrash() {
  if (!DB.trash.length || !confirm(T.confirmDelete)) return;
  DB.trash = [];
  await persist(); renderTrash();
}

function renderAuditLog() {
  const rows = (DB.auditLog || []).slice(0, 100);
  const el = $('auditLogTable');
  if (!el) return;
  el.innerHTML = `<thead><tr><th>${T.date}</th><th>${T.currentUser}</th><th>${T.actions}</th><th>${T.name}</th></tr></thead><tbody>` +
    (rows.length ? rows.map(a => `<tr><td>${a.date.slice(0, 19).replace('T', ' ')}</td><td>${esc(a.user)}</td><td>${esc(a.action)} — ${esc(a.entityType)}</td><td>${esc(a.label)}</td></tr>`).join('') : `<tr><td colspan="4" class="empty">${T.auditNoData}</td></tr>`) + '</tbody>';
}

function renderTrash() {
  const rows = DB.trash || [];
  const el = $('trashTable');
  if (!el) return;
  el.innerHTML = `<thead><tr><th>${T.date}</th><th>${T.name}</th><th>${T.actions}</th></tr></thead><tbody>` +
    (rows.length ? rows.map(t => `<tr><td>${t.deletedAt.slice(0, 19).replace('T', ' ')}</td><td>${esc(t.label)}</td><td><button class="btn btn-gold btn-sm" onclick="restoreTrash('${t.id}')">${T.restore}</button></td></tr>`).join('') : `<tr><td colspan="3" class="empty">${T.noData}</td></tr>`) + '</tbody>';
}

function statusOf(total, paid) {
  if (paid >= total) return 'paid';
  if (paid > 0) return 'partial';
  return 'credit';
}
function statusBadge(st) {
  const cls = st === 'paid' ? '' : st === 'partial' ? 'warn' : 'low';
  return `<span class="badge ${cls}">${T[st]}</span>`;
}
function isLow(p) { return Number(p.stock) <= Number(p.threshold ?? 3); }

// ---------- لوحة التحكم ----------
function renderOnboarding() {
  const el = $('onboardingBanner');
  if (!el) return;
  const isFresh = !DB.products.length && !DB.customers.length && !DB.invoices.length;
  if (!isFresh || DB.settings.onboardingDismissed) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="onboard-panel">
    <h3>${T.welcomeTitle}</h3>
    <p class="muted">${T.welcomeBody}</p>
    <div class="onboard-steps">
      <button class="btn btn-gold" onclick="openProductModal()">${T.stepAddProduct}</button>
      <button class="btn btn-ghost" onclick="goPage('settings')">${T.stepCompanyInfo}</button>
      <button class="btn btn-ghost" onclick="openCustomerModal()">${T.stepAddCustomer}</button>
    </div>
    <button class="btn btn-sm" style="margin-top:12px;background:transparent;color:var(--text-muted)" onclick="dismissOnboarding()">${T.dismissOnboarding}</button>
  </div>`;
}

async function dismissOnboarding() {
  DB.settings.onboardingDismissed = true;
  await persist(); renderOnboarding();
}

function renderDashboard() {
  renderOnboarding();
  const today = new Date().toISOString().slice(0, 10);
  const todaySales = DB.invoices.filter(i => i.date.slice(0, 10) === today).reduce((s, i) => s + i.total, 0);
  const f = financials();
  const low = DB.products.filter(isLow).length;
  const expiring = DB.products.filter(isExpiringSoon).length;
  const isCashier = currentRole === 'cashier';
  const cards = [
    `<div class="card"><div class="c-label">${T.todaySales}</div><div class="c-value" data-val="${todaySales}">0</div><div class="c-sub">${cur()}</div></div>`,
    `<div class="card"><div class="c-label">${T.totalSales}</div><div class="c-value" data-val="${f.totalSales}">0</div><div class="c-sub">${cur()}</div></div>`
  ];
  if (!isCashier) {
    cards.push(`<div class="card emerald"><div class="c-label">${T.netProfit}</div><div class="c-value" data-val="${f.netProfit}">0</div><div class="c-sub">${cur()}</div></div>`);
    cards.push(`<div class="card"><div class="c-label">${T.customerDebts}</div><div class="c-value" data-val="${f.custDebt}">0</div><div class="c-sub">${cur()}</div></div>`);
    cards.push(`<div class="card"><div class="c-label">${T.totalBalance}</div><div class="c-value" data-val="${f.totalWalletBalance}">0</div><div class="c-sub">${cur()}</div></div>`);
  }
  cards.push(`<div class="card ${low ? '' : 'emerald'}"><div class="c-label">${T.lowStock}</div><div class="c-value" data-val="${low}">0</div></div>`);
  if (expiring) cards.push(`<div class="card"><div class="c-label">${T.expiringSoon}</div><div class="c-value" data-val="${expiring}">0</div></div>`);
  $('dashCards').innerHTML = cards.join('');
  animateCounters('dashCards');
  checkLowStockNotif();
  const rows = DB.invoices.slice(-6).reverse();
  $('dashInvTable').innerHTML = rows.length
    ? `<thead><tr><th>${T.invoiceNo}</th><th>${T.customer}</th><th>${T.total}</th><th>${T.status}</th><th>${T.date}</th></tr></thead><tbody>` +
      rows.map(i => `<tr><td>#${i.number}</td><td>${esc(i.customerName) || T.walkIn}</td><td><span class="badge">${fmt(i.total)} ${cur()}</span></td><td>${statusBadge(i.status)}</td><td>${i.date.slice(0, 10)}</td></tr>`).join('') + '</tbody>'
    : `<tbody><tr><td class="empty">${T.noData}</td></tr></tbody>`;
}

// ---------- المنتجات ----------
function isExpiringSoon(p) {
  if (!p.expiryDate) return false;
  const days = (new Date(p.expiryDate) - new Date()) / 86400000;
  return days <= 30;
}

function renderProducts() {
  const q = ($('prodSearch').value || '').toLowerCase();
  const list = DB.products.filter(p => !q || p.name.toLowerCase().includes(q) || (p.category || '').toLowerCase().includes(q) || (p.barcode || '').includes(q));
  $('prodTable').innerHTML = `<thead><tr><th>${T.name}</th><th>${T.category}</th><th>${T.price}</th><th>${T.cost}</th><th>${T.stock}</th><th>${T.expiryDate}</th><th>${T.actions}</th></tr></thead><tbody>` +
    (list.length ? list.map(p => `<tr>
      <td><b>${esc(p.name)}</b></td><td>${esc(p.category) || '—'}</td>
      <td>${fmt(p.price)} ${cur()}</td><td>${fmt(p.cost)} ${cur()}</td>
      <td><span class="badge ${isLow(p) ? 'low' : ''}">${p.stock}</span></td>
      <td>${p.expiryDate ? `<span class="badge ${isExpiringSoon(p) ? 'low' : ''}">${p.expiryDate}</span>` : '—'}</td>
      <td><button class="btn btn-ghost btn-sm" onclick="openProductModal('${p.id}')">${T.edit}</button>
          ${p.barcode ? `<button class="btn btn-ghost btn-sm" onclick="printBarcode('${p.id}')">${T.printBarcode}</button>` : ''}
          <button class="btn btn-danger btn-sm" onclick="delProduct('${p.id}')">${T.delete}</button></td>
    </tr>`).join('') : `<tr><td colspan="7" class="empty">${T.noData}</td></tr>`) + '</tbody>';
}

function openProductModal(id) {
  const p = DB.products.find(x => x.id === id) || { name: '', category: '', price: '', cost: '', stock: '', threshold: 3, barcode: '', expiryDate: '', batchNo: '' };
  openModal(`<h3>${id ? T.editProduct : T.addProduct}</h3>
    <div class="field"><label>${T.name}</label><input id="mName" value="${esc(p.name)}"></div>
    <div class="grid2">
      <div class="field"><label>${T.category}</label><input id="mCat" value="${esc(p.category)}" list="mCatList">
        <datalist id="mCatList">${(DB.settings.productCategoryList || []).map(c => `<option value="${esc(c)}">`).join('')}</datalist>
      </div>
      <div class="field"><label>${T.stock}</label><input id="mStock" type="number" min="0" value="${p.stock}"></div>
      <div class="field"><label>${T.price}</label><input id="mPrice" type="number" min="0" value="${p.price}" oninput="updateMarginHint()"></div>
      <div class="field"><label>${T.cost}</label><input id="mCost" type="number" min="0" value="${p.cost}" oninput="updateMarginHint()"></div>
    </div>
    <p class="muted" id="marginHint" style="margin:-6px 0 12px"></p>
    <div class="grid2">
      <div class="field"><label>${T.threshold}</label><input id="mThreshold" type="number" min="0" value="${p.threshold ?? 3}"></div>
      <div class="field"><label>${T.barcode}</label><input id="mBarcode" value="${esc(p.barcode || '')}"></div>
    </div>
    <div class="grid2">
      <div class="field"><label>${T.expiryDate}</label><input id="mExpiry" type="date" value="${p.expiryDate || ''}"></div>
      <div class="field"><label>${T.batchNo}</label><input id="mBatch" value="${esc(p.batchNo || '')}"></div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal()">${T.cancel}</button>
      <button class="btn btn-gold" onclick="saveProduct('${id || ''}')">${T.save}</button>
    </div>`);
  updateMarginHint();
}

function updateMarginHint() {
  const price = Number(($('mPrice') || {}).value || 0);
  const cost = Number(($('mCost') || {}).value || 0);
  const hint = $('marginHint');
  if (!hint) return;
  if (!price) { hint.textContent = ''; return; }
  const profit = price - cost;
  const margin = price > 0 ? (profit / price * 100) : 0;
  hint.innerHTML = `${T.profitMargin}: <b style="color:${margin < 0 ? '#e08886' : 'var(--gold-light)'}">${fmt(profit)} ${cur()} (${fmt(margin)}%)</b>`;
}

async function saveProduct(id) {
  const obj = { name: $('mName').value.trim(), category: $('mCat').value.trim(), price: Number($('mPrice').value || 0), cost: Number($('mCost').value || 0), stock: Number($('mStock').value || 0), threshold: Number($('mThreshold').value || 3), barcode: $('mBarcode').value.trim(), expiryDate: $('mExpiry').value, batchNo: $('mBatch').value.trim() };
  if (!obj.name) return;
  if (obj.category) {
    DB.settings.productCategoryList = DB.settings.productCategoryList || [];
    if (!DB.settings.productCategoryList.includes(obj.category)) DB.settings.productCategoryList.push(obj.category);
  }
  if (id) Object.assign(DB.products.find(x => x.id === id), obj);
  else DB.products.push({ id: uid('p'), ...obj });
  logAudit(id ? 'update' : 'create', T.products, obj.name);
  await persist(); closeModal(); renderAll(); toast(T.saved);
}

async function delProduct(id) { await softDelete('products', id, T.products); }

// ---------- العملاء ----------
// رقم حساب الزبون (Numéro de compte): متسلسل بصيغة C-0001، يتولّد تلقائياً ولا يتكرر
function nextCustomerAccountNo() {
  const max = DB.customers.reduce((m, c) => {
    const n = parseInt(String(c.accountNo || '').replace(/^C-/, ''), 10);
    return Number.isFinite(n) && n > m ? n : m;
  }, 0);
  return 'C-' + String(max + 1).padStart(4, '0');
}

function renderCustomers() {
  const q = ($('custSearch').value || '').toLowerCase();
  const list = DB.customers.filter(c => !q || c.name.toLowerCase().includes(q) || (c.phone || '').includes(q) || (c.accountNo || '').toLowerCase().includes(q));
  $('custTable').innerHTML = `<thead><tr><th>${T.accountNo}</th><th>${T.name}</th><th>${T.phone}</th><th>${T.address}</th><th>${T.debt}</th><th>${T.actions}</th></tr></thead><tbody>` +
    (list.length ? list.map(c => {
      const debt = DB.invoices.filter(i => i.customerId === c.id).reduce((s, i) => s + Math.max(0, i.total - (i.paidAmount || 0)), 0);
      return `<tr>
      <td dir="ltr"><span class="badge">${esc(c.accountNo) || '—'}</span></td>
      <td><b>${esc(c.name)}</b></td><td dir="ltr">${esc(c.phone) || '—'}</td><td>${esc(c.address) || '—'}</td>
      <td>${debt > 0 ? `<span class="badge low">${fmt(debt)} ${cur()}</span>` : '—'}</td>
      <td><button class="btn btn-ghost btn-sm" onclick="openCustomerModal('${c.id}')">${T.edit}</button>
          <button class="btn btn-danger btn-sm" onclick="delCustomer('${c.id}')">${T.delete}</button></td>
    </tr>`; }).join('') : `<tr><td colspan="6" class="empty">${T.noData}</td></tr>`) + '</tbody>';
}

function openCustomerModal(id) {
  const c = DB.customers.find(x => x.id === id) || { name: '', phone: '', address: '', accountNo: '' };
  const accNo = id ? (c.accountNo || '—') : nextCustomerAccountNo();
  openModal(`<h3>${id ? T.editCustomer : T.addCustomer}</h3>
    <p class="muted" style="margin:0 0 10px">${T.accountNo}: <b dir="ltr" style="color:var(--gold)">${esc(accNo)}</b></p>
    <div class="field"><label>${T.name}</label><input id="mName" value="${esc(c.name)}"></div>
    <div class="grid2">
      <div class="field"><label>${T.phone}</label><input id="mPhone" value="${esc(c.phone)}"></div>
      <div class="field"><label>${T.address}</label><input id="mAddr" value="${esc(c.address)}"></div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal()">${T.cancel}</button>
      <button class="btn btn-gold" onclick="saveCustomer('${id || ''}')">${T.save}</button>
    </div>`);
}

async function saveCustomer(id) {
  const obj = { name: $('mName').value.trim(), phone: $('mPhone').value.trim(), address: $('mAddr').value.trim() };
  if (!obj.name) return;
  if (id) {
    const c = DB.customers.find(x => x.id === id);
    Object.assign(c, obj);
    if (!c.accountNo) c.accountNo = nextCustomerAccountNo(); // ترقيم الزبائن القدامى عند أول تعديل
  } else DB.customers.push({ id: uid('c'), accountNo: nextCustomerAccountNo(), ...obj });
  logAudit(id ? 'update' : 'create', T.customers, obj.name);
  await persist(); closeModal(); renderAll(); toast(T.saved);
}

async function delCustomer(id) { await softDelete('customers', id, T.customers); }

// ---------- الموردون ----------
function renderSuppliers() {
  const list = DB.suppliers;
  $('supTable').innerHTML = `<thead><tr><th>${T.name}</th><th>${T.company}</th><th>${T.phone}</th><th>${T.debt}</th><th>${T.actions}</th></tr></thead><tbody>` +
    (list.length ? list.map(s => {
      const debt = DB.purchases.filter(p => p.supplierId === s.id).reduce((sum, p) => sum + Math.max(0, p.total - (p.paidAmount || 0)), 0);
      return `<tr>
      <td><b>${esc(s.name)}</b></td><td>${esc(s.company) || '—'}</td><td dir="ltr">${esc(s.phone) || '—'}</td>
      <td>${debt > 0 ? `<span class="badge warn">${fmt(debt)} ${cur()}</span>` : '—'}</td>
      <td><button class="btn btn-ghost btn-sm" onclick="openSupplierModal('${s.id}')">${T.edit}</button>
          <button class="btn btn-danger btn-sm" onclick="delSupplier('${s.id}')">${T.delete}</button></td>
    </tr>`; }).join('') : `<tr><td colspan="5" class="empty">${T.noData}</td></tr>`) + '</tbody>';
}

function openSupplierModal(id) {
  const s = DB.suppliers.find(x => x.id === id) || { name: '', company: '', phone: '', address: '' };
  openModal(`<h3>${id ? T.editSupplier : T.addSupplier}</h3>
    <div class="field"><label>${T.name}</label><input id="mName" value="${esc(s.name)}"></div>
    <div class="grid2">
      <div class="field"><label>${T.company}</label><input id="mCompany" value="${esc(s.company)}"></div>
      <div class="field"><label>${T.phone}</label><input id="mPhone" value="${esc(s.phone)}"></div>
    </div>
    <div class="field"><label>${T.address}</label><input id="mAddr" value="${esc(s.address)}"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal()">${T.cancel}</button>
      <button class="btn btn-gold" onclick="saveSupplier('${id || ''}')">${T.save}</button>
    </div>`);
}

async function saveSupplier(id) {
  const obj = { name: $('mName').value.trim(), company: $('mCompany').value.trim(), phone: $('mPhone').value.trim(), address: $('mAddr').value.trim() };
  if (!obj.name) return;
  if (id) Object.assign(DB.suppliers.find(x => x.id === id), obj);
  else DB.suppliers.push({ id: uid('s'), ...obj });
  logAudit(id ? 'update' : 'create', T.suppliers, obj.name);
  await persist(); closeModal(); renderAll(); toast(T.saved);
}

async function delSupplier(id) { await softDelete('suppliers', id, T.suppliers); }

// ---------- الفواتير (المبيعات) ----------
function renderInvoices() {
  const rows = DB.invoices.slice().reverse();
  $('invTable').innerHTML = `<thead><tr><th>${T.invoiceNo}</th><th>${T.customer}</th><th>${T.total}</th><th>${T.remaining}</th><th>${T.status}</th><th>${T.date}</th><th>${T.actions}</th></tr></thead><tbody>` +
    (rows.length ? rows.map(i => {
      const remaining = Math.max(0, i.total - (i.paidAmount || 0));
      return `<tr>
      <td>#${i.number}</td><td>${esc(i.customerName) || T.walkIn}</td>
      <td><span class="badge">${fmt(i.total)} ${cur()}</span></td>
      <td>${remaining > 0 ? fmt(remaining) + ' ' + cur() : '—'}</td>
      <td>${statusBadge(i.status)}</td><td>${i.date.slice(0, 10)}</td>
      <td>
        ${remaining > 0 ? `<button class="btn btn-ghost btn-sm" onclick="openCollectModal('invoice','${i.id}')">${T.collectPayment}</button>` : ''}
        <button class="btn btn-ghost btn-sm" onclick="previewInvoice('${i.id}')">${T.preview}</button>
        <button class="btn btn-ghost btn-sm" onclick="openReturnModal('${i.id}')">${T.returnInvoice}</button>
        <button class="btn btn-danger btn-sm" onclick="delInvoice('${i.id}')">${T.delete}</button>
      </td>
    </tr>`; }).join('') : `<tr><td colspan="7" class="empty">${T.noData}</td></tr>`) + '</tbody>';
}

let invLines = [];
function openInvoiceModal() {
  if (!DB.products.length) { toast(T.noData + ' — ' + T.addProduct); return; }
  invLines = [{ productId: DB.products[0].id, qty: 1, price: DB.products[0].price }];
  openModal(`<h3>${T.newInvoice} #${DB.counters.invoice}</h3>
    <div class="field"><label>${T.customer}</label>
      <select id="mCust"><option value="">${T.walkIn}</option>${DB.customers.map(c => `<option value="${c.id}">${esc(c.name)}${c.accountNo ? ' — ' + esc(c.accountNo) : ''}</option>`).join('')}</select>
    </div>
    <div class="field"><input id="mBarcodeScan" placeholder="${T.scanBarcode}" onkeydown="if(event.key==='Enter'){event.preventDefault();scanBarcodeAdd(this.value);this.value='';}"></div>
    <div id="invLines"></div>
    <button class="btn btn-ghost btn-sm" onclick="addInvLine()">+ ${T.addLine}</button>
    <p class="muted" style="margin-top:12px">${T.subtotal}: <span id="invSubtotal">0</span> ${cur()}</p>
    <div class="grid2">
      <div class="field"><label>${T.discount}</label><input id="mDiscount" type="number" min="0" placeholder="0" oninput="drawInvLines()"></div>

    </div>
    <h3>${T.grandTotal}: <span id="invTotal">0</span> ${cur()}</h3>
    <div class="grid2" style="margin-top:10px">
      <div class="field"><label>${T.paidAmount}</label><input id="mPaid" type="number" min="0" placeholder="0"></div>
      <div class="field" style="align-self:end"><button type="button" class="btn btn-ghost btn-sm" onclick="$('mPaid').value=invGrandTotal()">${T.payFull}</button></div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal()">${T.cancel}</button>
      <button class="btn btn-gold" onclick="saveInvoice()">${T.saveInvoice}</button>
    </div>`);
  drawInvLines();
  $('mPaid').value = invGrandTotal();
}

function drawInvLines() {
  $('invLines').innerHTML = invLines.map((l, ix) => `
    <div style="display:grid;grid-template-columns:2fr 1fr 1.2fr auto;gap:8px;margin-bottom:8px">
      <select onchange="onInvProductChange(${ix}, this.value)">
        ${DB.products.map(p => `<option value="${p.id}" ${p.id === l.productId ? 'selected' : ''}>${esc(p.name)} (${p.stock})</option>`).join('')}
      </select>
      <input type="number" min="1" value="${l.qty}" onchange="invLines[${ix}].qty=Number(this.value)||1;drawInvLines()" title="${T.qty}">
      <input type="number" min="0" step="0.01" value="${lineUnitPrice(l)}" onchange="invLines[${ix}].price=Number(this.value)||0;drawInvLines()" title="${T.price}">
      <button class="btn btn-danger btn-sm" onclick="invLines.splice(${ix},1);drawInvLines()">✕</button>
    </div>`).join('');
  $('invSubtotal').textContent = fmt(invSubtotal());
  const newTotal = invGrandTotal();
  $('invTotal').textContent = fmt(newTotal);
  
  // تحديث المبلغ المدفوع تلقائياً ليكون مساوياً للإجمالي لتفادي الديون الخاطئة
  // يتم ذلك فقط إذا كان العنصر موجوداً في الواجهة
  const paidInput = $('mPaid');
  if (paidInput) {
      paidInput.value = newTotal;
  }
}

// سعر الوحدة للسطر: السعر المُعدّل يدوياً إن وُجد، وإلا سعر المنتج الافتراضي
function lineUnitPrice(l) {
  if (l.price != null && l.price !== '') return l.price;
  const p = DB.products.find(x => x.id === l.productId);
  return p ? p.price : 0;
}

// عند تغيير المنتج، أعد ضبط السعر لسعر المنتج الجديد (يبقى قابلاً للتعديل يدوياً)
function onInvProductChange(ix, productId) {
  invLines[ix].productId = productId;
  const p = DB.products.find(x => x.id === productId);
  invLines[ix].price = p ? p.price : 0;
  drawInvLines();
}

function invSubtotal() {
  return invLines.reduce((s, l) => s + lineUnitPrice(l) * l.qty, 0);
}

function invGrandTotal() {
  const discount = Math.max(0, Number(($('mDiscount') || {}).value || 0));
  const taxPct = 0;
  const afterDiscount = Math.max(0, invSubtotal() - discount);
  return afterDiscount * (1 + taxPct / 100);
}

function addInvLine() { const p = DB.products[0]; invLines.push({ productId: p.id, qty: 1, price: p.price }); drawInvLines(); }

function scanBarcodeAdd(code) {
  code = code.trim();
  if (!code) return;
  const p = DB.products.find(x => x.barcode && x.barcode === code);
  if (!p) { toast(T.barcodeNotFound); return; }
  const line = invLines.find(l => l.productId === p.id);
  if (line) line.qty += 1;
  else invLines.push({ productId: p.id, qty: 1, price: p.price });
  drawInvLines();
}

async function saveInvoice() {
  if (!invLines.length) return;
  for (const l of invLines) {
    const p = DB.products.find(x => x.id === l.productId);
    if (p && l.qty > Number(p.stock)) { toast(`${T.stockError}: ${p.name}`); return; }
  }
  const custId = $('mCust').value;
  const cust = DB.customers.find(c => c.id === custId);
  const items = invLines.map(l => {
    const p = DB.products.find(x => x.id === l.productId);
    const unit = lineUnitPrice(l);
    return { name: p.name, price: unit, cost: p.cost, qty: l.qty, total: unit * l.qty };
  });
  invLines.forEach(l => {
    const p = DB.products.find(x => x.id === l.productId);
    if (p) p.stock = Math.max(0, Number(p.stock) - l.qty);
  });
  const subtotal = invSubtotal();
  const discount = Math.max(0, Number($('mDiscount').value || 0));
  const taxPercent = 0;
  const total = invGrandTotal();
  const paidAmount = Math.min(total, Math.max(0, Number($('mPaid').value || 0)));
  const invNumber = DB.counters.invoice++;
  DB.invoices.push({
    id: uid('i'), number: invNumber,
    customerId: custId, customerName: cust ? cust.name : '',
    items, subtotal, discount, taxPercent, total, paidAmount, status: statusOf(total, paidAmount), date: new Date().toISOString()
  });
  logAudit('create', T.invoices, `#${invNumber}`);
  await persist(); closeModal(); renderAll(); toast(T.invoiceSaved);
}

async function delInvoice(id) { await softDelete('invoices', id, T.invoices); }

// ---------- مرتجعات المبيعات ----------
function openReturnModal(invoiceId) {
  const inv = DB.invoices.find(i => i.id === invoiceId);
  if (!inv) return;
  const returnable = inv.items.filter(it => it.qty > 0);
  if (!returnable.length) { toast(T.nothingToReturn); return; }
  openModal(`<h3>${T.returnInvoice} — #${inv.number}</h3>
    <div id="returnLines">
      ${returnable.map((it, ix) => `
        <div class="grid3" style="margin-bottom:8px;align-items:center">
          <span>${esc(it.name)}</span>
          <span class="muted">${T.remainingQty}: ${it.qty}</span>
          <input type="number" min="0" max="${it.qty}" placeholder="0" id="mReturnQty${ix}">
        </div>`).join('')}
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal()">${T.cancel}</button>
      <button class="btn btn-gold" onclick="processReturn('${invoiceId}')">${T.processReturn}</button>
    </div>`);
}

async function processReturn(invoiceId) {
  const inv = DB.invoices.find(i => i.id === invoiceId);
  if (!inv) return;
  const returnable = inv.items.filter(it => it.qty > 0);
  const returnedItems = [];
  returnable.forEach((it, ix) => {
    const qty = Math.min(it.qty, Math.max(0, Number(($('mReturnQty' + ix) || {}).value || 0)));
    if (qty <= 0) return;
    const unitPrice = it.total / (it.qty + 0); // سعر الوحدة الأصلي قبل الخصم من هذا السطر
    const returnedTotal = unitPrice * qty;
    it.qty -= qty; it.total -= returnedTotal;
    returnedItems.push({ name: it.name, qty, total: returnedTotal });
    const p = DB.products.find(x => x.name === it.name);
    if (p) p.stock = Number(p.stock) + qty;
  });
  if (!returnedItems.length) { toast(T.nothingToReturn); return; }
  inv.items = inv.items.filter(it => it.qty > 0);
  inv.subtotal = inv.items.reduce((s, it) => s + it.total, 0);
  const afterDiscount = Math.max(0, inv.subtotal - (inv.discount || 0));
  inv.total = afterDiscount * (1 + (inv.taxPercent || 0) / 100);
  inv.paidAmount = Math.min(inv.paidAmount || 0, inv.total);
  inv.status = statusOf(inv.total, inv.paidAmount);
  DB.returns = DB.returns || [];
  const returnedTotalSum = returnedItems.reduce((s, r) => s + r.total, 0);
  DB.returns.unshift({ id: uid('rt'), invoiceId, invoiceNumber: inv.number, items: returnedItems, total: returnedTotalSum, date: new Date().toISOString(), user: currentUserName });
  logAudit('return', T.invoices, `#${inv.number} (${fmt(returnedTotalSum)} ${cur()})`);
  await persist(); closeModal(); renderAll(); toast(T.returnDone);
}

function buildInvoiceHtml(inv, kind) {
  kind = kind || 'invoice';
  const remaining = kind === 'invoice' ? Math.max(0, inv.total - (inv.paidAmount || 0)) : 0;
  const co = DB.settings.company || {};
  const invSettings = DB.settings.invoice || { template: 'classic', color: '#C8A45C' };
  const tpl = invSettings.template || 'classic';
  const color = invSettings.color || '#C8A45C';
  const logo = co.logoDataUrl ? `<img src="${co.logoDataUrl}" class="inv-logo">` : '';
  const infoLines = [co.address, co.phone, co.rc ? `${T.companyRC}: ${co.rc}` : '', co.taxId ? `${T.companyTaxId}: ${co.taxId}` : ''].filter(Boolean);
  const subtotal = inv.subtotal ?? inv.total;
  const discount = inv.discount || 0;
  const taxPercent = 0;
  const noLabel = kind === 'quote' ? T.quoteNo : T.invoiceNo;
  return `
    <div class="inv-doc tpl-${tpl}" style="--inv-accent:${color}">
      <div class="inv-head">
        ${logo}
        <div class="inv-brand">${esc(DB.settings.businessName || 'سند')}</div>
        ${infoLines.length ? `<div class="inv-company-info">${infoLines.map(esc).join('<br>')}</div>` : ''}
      </div>
      <div class="inv-meta"><span>${noLabel}: #${inv.number}</span><span>${T.date}: ${inv.date.slice(0, 10)}</span><span>${T.customer}: ${esc(inv.customerName) || T.walkIn}</span></div>
      <table><thead><tr><th>${T.product}</th><th>${T.price}</th><th>${T.qty}</th><th>${T.total}</th></tr></thead>
      <tbody>${inv.items.map(it => `<tr><td>${esc(it.name)}</td><td>${fmt(it.price)}</td><td>${it.qty}</td><td>${fmt(it.total)}</td></tr>`).join('')}</tbody></table>
      <div class="inv-totals-box">
        ${discount || taxPercent ? `<div class="inv-row"><span>${T.subtotal}</span><span>${fmt(subtotal)} ${cur()}</span></div>` : ''}
        ${discount ? `<div class="inv-row"><span>${T.discount}</span><span>-${fmt(discount)} ${cur()}</span></div>` : ''}
        
        <div class="inv-total">${T.grandTotal}: ${fmt(inv.total)} ${cur()}</div>
        ${remaining > 0 ? `<div class="inv-total inv-remaining">${T.remaining}: ${fmt(remaining)} ${cur()}</div>` : ''}
      </div>
      ${kind === 'quote' ? `<div class="inv-company-info" style="margin-top:10px;text-align:center">${T.quoteValidNote}</div>` : ''}
      ${co.notes ? `<div class="inv-company-info" style="margin-top:10px">${esc(co.notes)}</div>` : ''}
      <div class="inv-thanks">${T.thanks} ✦ ${esc(DB.settings.businessName || 'سند')}</div>
    </div>`;
}

function printInvoice(id) {
  const inv = DB.invoices.find(i => i.id === id);
  if (!inv) return;
  $('print-area').innerHTML = buildInvoiceHtml(inv);
  bridge.print();
}

async function exportInvoicePdf(id) {
  const inv = DB.invoices.find(i => i.id === id);
  if (!inv) return;
  $('print-area').innerHTML = buildInvoiceHtml(inv);
  const res = await bridge.exportPdf(`فاتورة-${inv.number}.pdf`);
  if (res.ok) toast(T.pdfExported);
  else if (!res.canceled) toast('⚠️ ' + (res.error || T.aiOffline));
}

function previewInvoice(id, kind) {
  kind = kind || 'invoice';
  const list = kind === 'quote' ? DB.quotes : DB.invoices;
  const doc = (list || []).find(x => x.id === id);
  if (!doc) return;
  const printFn = kind === 'quote' ? 'printQuote' : 'printInvoice';
  const pdfFn = kind === 'quote' ? 'exportQuotePdf' : 'exportInvoicePdf';
  openModal(`<div class="inv-preview-modal">${buildInvoiceHtml(doc, kind)}</div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal()">${T.cancel}</button>
      <button class="btn btn-ghost" onclick="${printFn}('${id}')">${T.print}</button>
      <button class="btn btn-gold" onclick="${pdfFn}('${id}')">${T.savePdf}</button>
    </div>`);
}

// ---------- عروض الأسعار (لا تؤثر على المخزون ولا تُحتسب كبيع) ----------
function renderQuotes() {
  const rows = (DB.quotes || []).slice().reverse();
  const el = $('quoteTable');
  if (!el) return;
  el.innerHTML = `<thead><tr><th>${T.quoteNo}</th><th>${T.customer}</th><th>${T.total}</th><th>${T.date}</th><th>${T.actions}</th></tr></thead><tbody>` +
    (rows.length ? rows.map(q => `<tr>
      <td>#${q.number}</td><td>${esc(q.customerName) || T.walkIn}</td>
      <td><span class="badge">${fmt(q.total)} ${cur()}</span></td><td>${q.date.slice(0, 10)}</td>
      <td>
        <button class="btn btn-ghost btn-sm" onclick="previewInvoice('${q.id}','quote')">${T.preview}</button>
        <button class="btn btn-ghost btn-sm" onclick="convertQuoteToInvoice('${q.id}')">${T.convertToInvoice}</button>
        <button class="btn btn-danger btn-sm" onclick="delQuote('${q.id}')">${T.delete}</button>
      </td>
    </tr>`).join('') : `<tr><td colspan="5" class="empty">${T.noData}</td></tr>`) + '</tbody>';
}

let quoteLines = [];
function openQuoteModal() {
  if (!DB.products.length) { toast(T.noData + ' — ' + T.addProduct); return; }
  quoteLines = [{ productId: DB.products[0].id, qty: 1, price: DB.products[0].price }];
  openModal(`<h3>${T.newQuotation} #${DB.counters.quote}</h3>
    <div class="field"><label>${T.customer}</label>
      <select id="mQCust"><option value="">${T.walkIn}</option>${DB.customers.map(c => `<option value="${c.id}">${esc(c.name)}${c.accountNo ? ' — ' + esc(c.accountNo) : ''}</option>`).join('')}</select>
    </div>
    <div id="quoteLinesBox"></div>
    <button class="btn btn-ghost btn-sm" onclick="addQuoteLine()">+ ${T.addLine}</button>
    <p class="muted" style="margin-top:12px">${T.subtotal}: <span id="quoteSubtotal">0</span> ${cur()}</p>
    <div class="grid2">
      <div class="field"><label>${T.discount}</label><input id="mQDiscount" type="number" min="0" placeholder="0" oninput="drawQuoteLines()"></div>

    </div>
    <h3>${T.grandTotal}: <span id="quoteTotal">0</span> ${cur()}</h3>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal()">${T.cancel}</button>
      <button class="btn btn-gold" onclick="saveQuote()">${T.saveInvoice}</button>
    </div>`);
  drawQuoteLines();
}

function drawQuoteLines() {
  $('quoteLinesBox').innerHTML = quoteLines.map((l, ix) => `
    <div style="display:grid;grid-template-columns:2fr 1fr 1.2fr auto;gap:8px;margin-bottom:8px">
      <select onchange="quoteLines[${ix}].productId=this.value; quoteLines[${ix}].price = DB.products.find(x=>x.id===this.value)?.price||0; drawQuoteLines()">
        ${DB.products.map(p => `<option value="${p.id}" ${p.id === l.productId ? 'selected' : ''}>${esc(p.name)} — ${fmt(p.price)}</option>`).join('')}
      </select>
      <input type="number" min="1" value="${l.qty}" onchange="quoteLines[${ix}].qty=Number(this.value)||1;drawQuoteLines()">
      <input type="number" min="0" step="0.01" value="${l.price != null ? l.price : DB.products.find(x=>x.id===l.productId)?.price||0}" onchange="quoteLines[${ix}].price=Number(this.value)||0;drawQuoteLines()">
      <button class="btn btn-danger btn-sm" onclick="quoteLines.splice(${ix},1);drawQuoteLines()">✕</button>
    </div>`).join('');
  $('quoteSubtotal').textContent = fmt(quoteSubtotal());
  $('quoteTotal').textContent = fmt(quoteGrandTotal());
}

function quoteSubtotal() {
  return quoteLines.reduce((s, l) => {
    const price = l.price != null ? l.price : (DB.products.find(x => x.id === l.productId)?.price || 0);
    return s + (price * l.qty);
  }, 0);
}

function quoteGrandTotal() {
  const discount = Math.max(0, Number(($('mQDiscount') || {}).value || 0));
  const taxPct = 0;
  const afterDiscount = Math.max(0, quoteSubtotal() - discount);
  return afterDiscount * (1 + taxPct / 100);
}

function addQuoteLine() { quoteLines.push({ productId: DB.products[0].id, qty: 1, price: DB.products[0].price }); drawQuoteLines(); }

async function saveQuote() {
  if (!quoteLines.length) return;
  const custId = $('mQCust').value;
  const cust = DB.customers.find(c => c.id === custId);
  const items = quoteLines.map(l => {
    const p = DB.products.find(x => x.id === l.productId);
    const price = l.price != null ? l.price : p.price;
    return { name: p.name, price: price, cost: p.cost, qty: l.qty, total: price * l.qty };
  });
  const subtotal = quoteSubtotal();
  const discount = Math.max(0, Number($('mQDiscount').value || 0));
  const taxPercent = 0;
  const total = quoteGrandTotal();
  DB.quotes = DB.quotes || [];
  const quoteNumber = DB.counters.quote++;
  DB.quotes.push({
    id: uid('q'), number: quoteNumber,
    customerId: custId, customerName: cust ? cust.name : '',
    items, subtotal, discount, taxPercent, total, date: new Date().toISOString()
  });
  logAudit('create', T.quotation, `#${quoteNumber}`);
  await persist(); closeModal(); renderAll(); toast(T.saved);
}

async function delQuote(id) { await softDelete('quotes', id, T.quotation); }

function printQuote(id) {
  const q = (DB.quotes || []).find(x => x.id === id);
  if (!q) return;
  $('print-area').innerHTML = buildInvoiceHtml(q, 'quote');
  bridge.print();
}

async function exportQuotePdf(id) {
  const q = (DB.quotes || []).find(x => x.id === id);
  if (!q) return;
  $('print-area').innerHTML = buildInvoiceHtml(q, 'quote');
  const res = await bridge.exportPdf(`عرض-سعر-${q.number}.pdf`);
  if (res.ok) toast(T.pdfExported);
  else if (!res.canceled) toast('⚠️ ' + (res.error || T.aiOffline));
}

async function convertQuoteToInvoice(id) {
  const q = (DB.quotes || []).find(x => x.id === id);
  if (!q) return;
  for (const it of q.items) {
    const p = DB.products.find(x => x.name === it.name);
    if (p && it.qty > Number(p.stock)) { toast(`${T.stockError}: ${it.name}`); return; }
  }
  q.items.forEach(it => {
    const p = DB.products.find(x => x.name === it.name);
    if (p) p.stock = Math.max(0, Number(p.stock) - it.qty);
  });
  const invNumber = DB.counters.invoice++;
  DB.invoices.push({
    id: uid('i'), number: invNumber,
    customerId: q.customerId, customerName: q.customerName,
    items: q.items, subtotal: q.subtotal, discount: q.discount, taxPercent: q.taxPercent,
    total: q.total, paidAmount: 0, status: statusOf(q.total, 0), date: new Date().toISOString()
  });
  logAudit('create', T.invoices, `#${invNumber} (${T.convertToInvoice})`);
  await persist(); renderAll(); toast(T.invoiceSaved);
}

// ---------- المشتريات ----------
function renderPurchases() {
  const rows = DB.purchases.slice().reverse();
  $('purTable').innerHTML = `<thead><tr><th>${T.purchaseNo}</th><th>${T.supplier}</th><th>${T.total}</th><th>${T.remaining}</th><th>${T.status}</th><th>${T.date}</th><th>${T.actions}</th></tr></thead><tbody>` +
    (rows.length ? rows.map(p => {
      const remaining = Math.max(0, p.total - (p.paidAmount || 0));
      return `<tr>
      <td>#${p.number}</td><td>${esc(p.supplierName) || '—'}</td>
      <td><span class="badge">${fmt(p.total)} ${cur()}</span></td>
      <td>${remaining > 0 ? fmt(remaining) + ' ' + cur() : '—'}</td>
      <td>${statusBadge(p.status)}</td><td>${p.date.slice(0, 10)}</td>
      <td>
        ${remaining > 0 ? `<button class="btn btn-ghost btn-sm" onclick="openCollectModal('purchase','${p.id}')">${T.collectPayment}</button>` : ''}
        <button class="btn btn-danger btn-sm" onclick="delPurchase('${p.id}')">${T.delete}</button>
      </td>
    </tr>`; }).join('') : `<tr><td colspan="7" class="empty">${T.noData}</td></tr>`) + '</tbody>';
}

let purLines = [];
function openPurchaseModal() {
  if (!DB.products.length) { toast(T.noData + ' — ' + T.addProduct); return; }
  purLines = [{ productId: DB.products[0].id, qty: 1, cost: DB.products[0].cost || 0 }];
  openModal(`<h3>${T.newPurchase} #${DB.counters.purchase}</h3>
    <div class="field"><label>${T.supplier}</label>
      <select id="mSup"><option value="">—</option>${DB.suppliers.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>
    </div>
    <div id="purLines"></div>
    <button class="btn btn-ghost btn-sm" onclick="addPurLine()">+ ${T.addLine}</button>
    <h3 style="margin-top:16px">${T.grandTotal}: <span id="purTotal">0</span> ${cur()}</h3>
    <div class="grid2" style="margin-top:10px">
      <div class="field"><label>${T.paidAmount}</label><input id="mPurPaid" type="number" min="0" placeholder="0"></div>
      <div class="field" style="align-self:end"><button type="button" class="btn btn-ghost btn-sm" onclick="$('mPurPaid').value=purTotal()">${T.payFull}</button></div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal()">${T.cancel}</button>
      <button class="btn btn-gold" onclick="savePurchase()">${T.save}</button>
    </div>`);
  drawPurLines();
  $('mPurPaid').value = purTotal();
}

function drawPurLines() {
  $('purLines').innerHTML = purLines.map((l, ix) => `
    <div class="grid3" style="margin-bottom:8px">
      <select onchange="const p=DB.products.find(x=>x.id===this.value);purLines[${ix}].productId=this.value;purLines[${ix}].cost=p.cost;drawPurLines()">
        ${DB.products.map(p => `<option value="${p.id}" ${p.id === l.productId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
      </select>
      <input type="number" min="1" value="${l.qty}" onchange="purLines[${ix}].qty=Number(this.value)||1;drawPurLines()" title="${T.qty}">
      <input type="number" min="0" value="${l.cost}" onchange="purLines[${ix}].cost=Number(this.value)||0;drawPurLines()" title="${T.unitCost}">
    </div>`).join('');
  $('purTotal').textContent = fmt(purTotal());
}

function purTotal() { return purLines.reduce((s, l) => s + l.cost * l.qty, 0); }
function addPurLine() { purLines.push({ productId: DB.products[0].id, qty: 1, cost: DB.products[0].cost || 0 }); drawPurLines(); }

async function savePurchase() {
  if (!purLines.length) return;
  const supId = $('mSup').value;
  const sup = DB.suppliers.find(s => s.id === supId);
  const items = purLines.map(l => {
    const p = DB.products.find(x => x.id === l.productId);
    return { name: p.name, cost: l.cost, qty: l.qty, total: l.cost * l.qty };
  });
  purLines.forEach(l => {
    const p = DB.products.find(x => x.id === l.productId);
    if (p) { p.stock = Number(p.stock) + l.qty; p.cost = l.cost; }
  });
  const total = purTotal();
  const paidAmount = Math.min(total, Math.max(0, Number($('mPurPaid').value || 0)));
  const purNumber = DB.counters.purchase++;
  DB.purchases.push({
    id: uid('pu'), number: purNumber,
    supplierId: supId, supplierName: sup ? sup.name : '',
    items, total, paidAmount, status: statusOf(total, paidAmount), date: new Date().toISOString()
  });
  logAudit('create', T.purchases, `#${purNumber}`);
  await persist(); closeModal(); renderAll(); toast(T.saved);
}

async function delPurchase(id) { await softDelete('purchases', id, T.purchases); }

// ---------- تسديد الديون (فواتير/مشتريات) ----------
function openCollectModal(kind, id) {
  const rec = kind === 'invoice' ? DB.invoices.find(x => x.id === id) : DB.purchases.find(x => x.id === id);
  if (!rec) return;
  const remaining = Math.max(0, rec.total - (rec.paidAmount || 0));
  openModal(`<h3>${T.collectPayment}</h3>
    <p class="muted">${T.remaining}: <b style="color:var(--gold-light)">${fmt(remaining)} ${cur()}</b></p>
    <div class="field" style="margin-top:12px"><label>${T.amount}</label><input id="mCollect" type="number" min="0" value="${remaining}"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal()">${T.cancel}</button>
      <button class="btn btn-gold" onclick="doCollect('${kind}','${id}')">${T.save}</button>
    </div>`);
}

async function doCollect(kind, id) {
  const amount = Math.max(0, Number($('mCollect').value || 0));
  if (!amount) return;
  const list = kind === 'invoice' ? DB.invoices : DB.purchases;
  const rec = list.find(x => x.id === id);
  rec.paidAmount = Math.min(rec.total, (rec.paidAmount || 0) + amount);
  rec.status = statusOf(rec.total, rec.paidAmount);
  await persist(); closeModal(); renderAll(); toast(T.saved);
}

// ---------- الديون (نظرة عامة) ----------
function renderDebts() {
  const f = financials();
  $('debtCards').innerHTML = `
    <div class="card"><div class="c-label">${T.customerDebts}</div><div class="c-value">${fmt(f.custDebt)}</div><div class="c-sub">${cur()}</div></div>
    <div class="card"><div class="c-label">${T.supplierDebts}</div><div class="c-value">${fmt(f.supDebt)}</div><div class="c-sub">${cur()}</div></div>`;
  const custRows = DB.invoices.filter(i => i.total - (i.paidAmount || 0) > 0).slice().reverse();
  $('custDebtTable').innerHTML = `<thead><tr><th>${T.invoiceNo}</th><th>${T.customer}</th><th>${T.total}</th><th>${T.remaining}</th><th>${T.actions}</th></tr></thead><tbody>` +
    (custRows.length ? custRows.map(i => `<tr>
      <td>#${i.number}</td><td>${esc(i.customerName) || T.walkIn}</td><td>${fmt(i.total)} ${cur()}</td>
      <td><span class="badge low">${fmt(i.total - (i.paidAmount || 0))} ${cur()}</span></td>
      <td><button class="btn btn-ghost btn-sm" onclick="openCollectModal('invoice','${i.id}')">${T.collectPayment}</button></td>
    </tr>`).join('') : `<tr><td colspan="5" class="empty">${T.noData}</td></tr>`) + '</tbody>';
  const supRows = DB.purchases.filter(p => p.total - (p.paidAmount || 0) > 0).slice().reverse();
  $('supDebtTable').innerHTML = `<thead><tr><th>${T.purchaseNo}</th><th>${T.supplier}</th><th>${T.total}</th><th>${T.remaining}</th><th>${T.actions}</th></tr></thead><tbody>` +
    (supRows.length ? supRows.map(p => `<tr>
      <td>#${p.number}</td><td>${esc(p.supplierName) || '—'}</td><td>${fmt(p.total)} ${cur()}</td>
      <td><span class="badge warn">${fmt(p.total - (p.paidAmount || 0))} ${cur()}</span></td>
      <td><button class="btn btn-ghost btn-sm" onclick="openCollectModal('purchase','${p.id}')">${T.collectPayment}</button></td>
    </tr>`).join('') : `<tr><td colspan="5" class="empty">${T.noData}</td></tr>`) + '</tbody>';
}

// ---------- الموظفون ----------
function renderEmployees() {
  const list = DB.employees;
  $('empTable').innerHTML = `<thead><tr><th>${T.name}</th><th>${T.role}</th><th>${T.salary}</th><th>${T.phone}</th><th>${T.actions}</th></tr></thead><tbody>` +
    (list.length ? list.map(e => `<tr>
      <td><b>${esc(e.name)}</b></td><td>${esc(e.role) || '—'}</td><td>${fmt(e.salary)} ${cur()}</td><td dir="ltr">${esc(e.phone) || '—'}</td>
      <td><button class="btn btn-gold btn-sm" onclick="paySalary('${e.id}')">${T.paySalary}</button>
          <button class="btn btn-ghost btn-sm" onclick="openEmployeeModal('${e.id}')">${T.edit}</button>
          <button class="btn btn-danger btn-sm" onclick="delEmployee('${e.id}')">${T.delete}</button></td>
    </tr>`).join('') : `<tr><td colspan="5" class="empty">${T.noData}</td></tr>`) + '</tbody>';
}

function openEmployeeModal(id) {
  const e = DB.employees.find(x => x.id === id) || { name: '', role: '', salary: '', phone: '', username: '', accessRole: 'cashier' };
  const hasLogin = !!e.username;
  openModal(`<h3>${id ? T.editEmployee : T.addEmployee}</h3>
    <div class="field"><label>${T.name}</label><input id="mName" value="${esc(e.name)}"></div>
    <div class="grid2">
      <div class="field"><label>${T.role}</label><input id="mRole" value="${esc(e.role)}"></div>
      <div class="field"><label>${T.salary}</label><input id="mSalary" type="number" min="0" value="${e.salary}"></div>
    </div>
    <div class="field"><label>${T.phone}</label><input id="mPhone" value="${esc(e.phone)}"></div>
    <label class="switch-row" style="margin:10px 0"><input type="checkbox" id="mHasLogin" ${hasLogin ? 'checked' : ''} onchange="$('mLoginFields').style.display=this.checked?'block':'none'"><span data-i18n="enableEmployeeLogin">${T.enableEmployeeLogin}</span></label>
    <div id="mLoginFields" style="display:${hasLogin ? 'block' : 'none'}">
      <div class="grid2">
        <div class="field"><label>${T.username}</label><input id="mUsername" value="${esc(e.username || '')}"></div>
        <div class="field"><label>${T.accessRole}</label>
          <select id="mAccessRole">
            <option value="cashier" ${e.accessRole === 'cashier' ? 'selected' : ''}>${T.roleCashier}</option>
            <option value="accountant" ${e.accessRole === 'accountant' ? 'selected' : ''}>${T.roleAccountant}</option>
            <option value="manager" ${e.accessRole === 'manager' ? 'selected' : ''}>${T.roleManager}</option>
          </select>
        </div>
      </div>
      <div class="field"><label>${T.password}</label><input id="mEmpPass" type="password" placeholder="${hasLogin ? '••••••••' : ''}"></div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal()">${T.cancel}</button>
      <button class="btn btn-gold" onclick="saveEmployee('${id || ''}')">${T.save}</button>
    </div>`);
}

async function saveEmployee(id) {
  const obj = { name: $('mName').value.trim(), role: $('mRole').value.trim(), salary: Number($('mSalary').value || 0), phone: $('mPhone').value.trim() };
  if (!obj.name) return;
  const existing = DB.employees.find(x => x.id === id);
  if ($('mHasLogin').checked) {
    obj.username = $('mUsername').value.trim();
    obj.accessRole = $('mAccessRole').value;
    const newPass = $('mEmpPass').value;
    if (newPass) { const { salt, hash } = await bridge.authHashPassword(newPass); obj.salt = salt; obj.passwordHash = hash; }
    else if (existing) { obj.salt = existing.salt; obj.passwordHash = existing.passwordHash; }
  } else {
    obj.username = ''; obj.accessRole = ''; obj.salt = ''; obj.passwordHash = '';
  }
  if (id) Object.assign(existing, obj);
  else DB.employees.push({ id: uid('e'), ...obj });
  logAudit(id ? 'update' : 'create', T.employees, obj.name);
  await persist(); closeModal(); renderAll(); toast(T.saved);
}

async function delEmployee(id) { await softDelete('employees', id, T.employees); }

async function paySalary(id) {
  const e = DB.employees.find(x => x.id === id);
  if (!e || !confirm(`${T.paySalary}: ${e.name} — ${fmt(e.salary)} ${cur()} ?`)) return;
  DB.expenses.push({ id: uid('ex'), desc: `${T.salaryOf} ${e.name}`, amount: e.salary, date: new Date().toISOString(), category: 'salaries', employeeId: e.id });
  logAudit('create', T.expenses, `${T.salaryOf} ${e.name}`);
  await persist(); renderAll(); toast(T.saved);
}

// ---------- المساهمون وتوزيع الأرباح ----------
function renderShareholders() {
  const f = financials();
  const pctClass = f.totalPercent > 100 ? 'low' : f.totalPercent === 100 ? '' : 'warn';
  const pctMsg = f.totalPercent > 100 ? T.percentWarn : f.totalPercent === 100 ? T.percentOk : `${T.percentLeft}: ${fmt(100 - f.totalPercent)}%`;
  const totalCapital = DB.shareholders.reduce((s, sh) => s + Number(sh.capital || 0), 0);
  $('shCards').innerHTML = `
    <div class="card"><div class="c-label">${T.profitBase}</div><div class="c-value">${fmt(f.netProfit)}</div><div class="c-sub">${cur()}</div></div>
    <div class="card"><div class="c-label">${T.capital}</div><div class="c-value">${fmt(totalCapital)}</div><div class="c-sub">${cur()}</div></div>
    <div class="card ${pctClass === '' ? 'emerald' : ''}"><div class="c-label">${T.totalPercent}</div><div class="c-value">${fmt(f.totalPercent)}%</div><div class="c-sub badge ${pctClass}" style="margin-top:4px">${pctMsg}</div></div>`;
  $('shProfitBase').textContent = `${T.profitBase}: ${fmt(f.netProfit)} ${cur()}`;
  $('shTable').innerHTML = `<thead><tr><th>${T.name}</th><th>${T.percent}</th><th>${T.capital}</th><th>${T.profitShare}</th><th>${T.withdrawals}</th><th>${T.netDue}</th><th>${T.actions}</th></tr></thead><tbody>` +
    (DB.shareholders.length ? DB.shareholders.map(sh => {
      const w = DB.withdrawals.filter(x => x.shareholderId === sh.id).reduce((s, x) => s + Number(x.amount), 0);
      const share = f.netProfit * (Number(sh.percent) / 100);
      const net = share - w;
      return `<tr>
      <td><b>${esc(sh.name)}</b>${sh.note ? `<div class="muted">${esc(sh.note)}</div>` : ''}</td>
      <td><span class="badge">${fmt(sh.percent)}%</span></td>
      <td>${fmt(sh.capital)} ${cur()}</td>
      <td><span class="badge ${share >= 0 ? '' : 'low'}">${fmt(share)} ${cur()}</span></td>
      <td>${fmt(w)} ${cur()}</td>
      <td><span class="badge ${net >= 0 ? 'warn' : 'low'}">${fmt(net)} ${cur()}</span></td>
      <td>
        <button class="btn btn-ghost btn-sm" onclick="openWithdrawalModal('${sh.id}')">${T.addWithdrawal}</button>
        <button class="btn btn-ghost btn-sm" onclick="openShareholderModal('${sh.id}')">${T.edit}</button>
        <button class="btn btn-danger btn-sm" onclick="delShareholder('${sh.id}')">${T.delete}</button>
      </td>
    </tr>`; }).join('') : `<tr><td colspan="7" class="empty">${T.noData}</td></tr>`) + '</tbody>';
}

function openShareholderModal(id) {
  const sh = DB.shareholders.find(x => x.id === id) || { name: '', percent: '', capital: '', note: '' };
  const otherTotal = DB.shareholders.filter(x => x.id !== id).reduce((s, x) => s + Number(x.percent || 0), 0);
  openModal(`<h3>${id ? T.editShareholder : T.addShareholder}</h3>
    <div class="field"><label>${T.name}</label><input id="mName" value="${esc(sh.name)}"></div>
    <div class="grid2">
      <div class="field"><label>${T.percent}</label><input id="mPercent" type="number" min="0" max="100" step="0.01" value="${sh.percent}"></div>
      <div class="field"><label>${T.capital}</label><input id="mCapital" type="number" min="0" value="${sh.capital}"></div>
    </div>
    <div class="field"><label>${T.note}</label><input id="mNote" value="${esc(sh.note || '')}"></div>
    <p class="muted">${T.percentLeft}: ${fmt(Math.max(0, 100 - otherTotal))}%</p>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal()">${T.cancel}</button>
      <button class="btn btn-gold" onclick="saveShareholder('${id || ''}')">${T.save}</button>
    </div>`);
}

async function saveShareholder(id) {
  const obj = { name: $('mName').value.trim(), percent: Number($('mPercent').value || 0), capital: Number($('mCapital').value || 0), note: $('mNote').value.trim() };
  if (!obj.name) return;
  if (id) Object.assign(DB.shareholders.find(x => x.id === id), obj);
  else DB.shareholders.push({ id: uid('sh'), ...obj });
  logAudit(id ? 'update' : 'create', T.shareholders, obj.name);
  await persist(); closeModal(); renderAll();
  const total = DB.shareholders.reduce((s, x) => s + Number(x.percent || 0), 0);
  toast(total > 100 ? T.percentWarn : T.saved);
}

async function delShareholder(id) {
  await softDelete('shareholders', id, T.shareholders, () => {
    const related = DB.withdrawals.filter(w => w.shareholderId === id);
    DB.withdrawals = DB.withdrawals.filter(w => w.shareholderId !== id);
    return { withdrawals: related };
  });
}

function openWithdrawalModal(shareholderId) {
  const sh = DB.shareholders.find(x => x.id === shareholderId);
  if (!sh) return;
  openModal(`<h3>${T.addWithdrawal} — ${esc(sh.name)}</h3>
    <div class="field"><label>${T.amount}</label><input id="mWAmount" type="number" min="0"></div>
    <div class="field"><label>${T.note}</label><input id="mWNote"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal()">${T.cancel}</button>
      <button class="btn btn-gold" onclick="saveWithdrawal('${shareholderId}')">${T.save}</button>
    </div>`);
}

async function saveWithdrawal(shareholderId) {
  const amount = Number($('mWAmount').value || 0);
  if (!amount) return;
  DB.withdrawals.push({ id: uid('w'), shareholderId, amount, note: $('mWNote').value.trim(), date: new Date().toISOString() });
  await persist(); closeModal(); renderAll(); toast(T.saved);
}

// ---------- المحافظ والحسابات ----------
function renderWallets() {
  $('walletCards').innerHTML = DB.wallets.length ? DB.wallets.map(w => {
    const bal = walletBalance(w.id);
    return `<div class="card"><div class="c-label">${esc(w.name)} <span class="muted">(${T[w.type] || w.type})</span></div>
      <div class="c-value ${bal < 0 ? 'low-text' : ''}">${fmt(bal)}</div><div class="c-sub">${cur()}</div>
      <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn btn-ghost btn-sm" onclick="openWalletTxModal('${w.id}')">+ ${T.addTransaction}</button>
        <button class="btn btn-ghost btn-sm" onclick="openWalletModal('${w.id}')">${T.edit}</button>
        <button class="btn btn-danger btn-sm" onclick="delWallet('${w.id}')">${T.delete}</button>
      </div></div>`;
  }).join('') : `<div class="empty">${T.noData}</div>`;

  const rows = DB.walletTx.slice().reverse().slice(0, 50);
  $('walletTxTable').innerHTML = `<thead><tr><th>${T.date}</th><th>${T.walletName}</th><th>${T.description}</th><th>${T.amount}</th><th>${T.actions}</th></tr></thead><tbody>` +
    (rows.length ? rows.map(t => {
      const w = DB.wallets.find(x => x.id === t.walletId);
      const label = t.type === 'transfer'
        ? `${T.transfer} → ${esc((DB.wallets.find(x => x.id === t.toWalletId) || {}).name || '')}`
        : T[t.type];
      const sign = t.type === 'deposit' ? '+' : '-';
      return `<tr>
      <td>${t.date.slice(0, 10)}</td><td>${esc(w ? w.name : '—')}</td>
      <td>${label}${t.note ? ` — ${esc(t.note)}` : ''}</td>
      <td><span class="badge ${t.type === 'deposit' ? '' : 'warn'}">${sign}${fmt(t.amount)} ${cur()}</span></td>
      <td><button class="btn btn-danger btn-sm" onclick="delWalletTx('${t.id}')">${T.delete}</button></td>
    </tr>`; }).join('') : `<tr><td colspan="5" class="empty">${T.noData}</td></tr>`) + '</tbody>';
}

function openWalletModal(id) {
  const w = DB.wallets.find(x => x.id === id) || { name: '', type: 'cash' };
  openModal(`<h3>${id ? T.editWallet : T.addWallet}</h3>
    <div class="field"><label>${T.walletName}</label><input id="mName" value="${esc(w.name)}"></div>
    <div class="field"><label>${T.walletType}</label>
      <select id="mType">
        <option value="cash" ${w.type === 'cash' ? 'selected' : ''}>${T.cash}</option>
        <option value="bank" ${w.type === 'bank' ? 'selected' : ''}>${T.bank}</option>
        <option value="mobileMoney" ${w.type === 'mobileMoney' ? 'selected' : ''}>${T.mobileMoney}</option>
        <option value="other" ${w.type === 'other' ? 'selected' : ''}>${T.other}</option>
      </select>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal()">${T.cancel}</button>
      <button class="btn btn-gold" onclick="saveWallet('${id || ''}')">${T.save}</button>
    </div>`);
}

async function saveWallet(id) {
  const obj = { name: $('mName').value.trim(), type: $('mType').value };
  if (!obj.name) return;
  if (id) Object.assign(DB.wallets.find(x => x.id === id), obj);
  else DB.wallets.push({ id: uid('wl'), ...obj });
  logAudit(id ? 'update' : 'create', T.wallets, obj.name);
  await persist(); closeModal(); renderAll(); toast(T.saved);
}

async function delWallet(id) {
  await softDelete('wallets', id, T.wallets, () => {
    const related = DB.walletTx.filter(t => t.walletId === id || t.toWalletId === id);
    DB.walletTx = DB.walletTx.filter(t => t.walletId !== id && t.toWalletId !== id);
    return { walletTx: related };
  });
}

function openWalletTxModal(walletId) {
  openModal(`<h3>${T.addTransaction}</h3>
    <div class="field"><label>${T.walletType}</label>
      <select id="mTxType" onchange="$('toWalletField').style.display=this.value==='transfer'?'block':'none'">
        <option value="deposit">${T.deposit}</option>
        <option value="withdraw">${T.withdraw}</option>
        <option value="transfer">${T.transfer}</option>
      </select>
    </div>
    <div class="field" id="toWalletField" style="display:none"><label>${T.toWallet}</label>
      <select id="mToWallet">${DB.wallets.filter(w => w.id !== walletId).map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select>
    </div>
    <div class="field"><label>${T.amount}</label><input id="mTxAmount" type="number" min="0"></div>
    <div class="field"><label>${T.note}</label><input id="mTxNote"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal()">${T.cancel}</button>
      <button class="btn btn-gold" onclick="saveWalletTx('${walletId}')">${T.save}</button>
    </div>`);
}

async function saveWalletTx(walletId) {
  const amount = Number($('mTxAmount').value || 0);
  if (!amount) return;
  const type = $('mTxType').value;
  if (type !== 'deposit') {
    const projected = walletBalance(walletId) - amount;
    if (projected < 0 && !confirm(`${T.overdraftWarn}: ${fmt(projected)} ${cur()}`)) return;
  }
  const tx = { id: uid('wt'), walletId, type, amount, note: $('mTxNote').value.trim(), date: new Date().toISOString() };
  if (type === 'transfer') tx.toWalletId = $('mToWallet').value;
  DB.walletTx.push(tx);
  await persist(); closeModal(); renderAll(); toast(T.saved);
}

async function delWalletTx(id) { await softDelete('walletTx', id, T.transactions); }

// ---------- المصاريف ----------
function expenseCategoryList() {
  if (!DB.settings.expenseCategoryList || !DB.settings.expenseCategoryList.length) {
    DB.settings.expenseCategoryList = ['rent', 'salaries', 'utilities', 'transport', 'maintenance', 'marketing', 'other'];
  }
  return DB.settings.expenseCategoryList;
}
function catLabel(cat) { return T['cat' + (cat || 'other').charAt(0).toUpperCase() + (cat || 'other').slice(1)] || cat || T.catOther; }

function categorySelectHtml(id) {
  const list = expenseCategoryList();
  return `<select id="${id}" onchange="handleCategorySelectChange('${id}')">
    ${list.map(c => `<option value="${c}">${catLabel(c)}</option>`).join('')}
    <option value="__new__">+ ${T.addCategory}</option>
  </select>
  <div id="${id}_newRow" class="hidden grid3" style="margin-top:8px">
    <input id="${id}_newInput" placeholder="${T.newCategoryName}">
    <button type="button" class="btn btn-gold btn-sm" onclick="confirmNewCategory('${id}')">${T.save}</button>
    <button type="button" class="btn btn-ghost btn-sm" onclick="cancelNewCategory('${id}')">${T.cancel}</button>
  </div>`;
}

// إضافة فئة جديدة تتم داخل نفس النافذة المنبثقة (بدون فتح نافذة أخرى فتفقد بيانات النموذج الحالي)
function handleCategorySelectChange(selectId) {
  const sel = $(selectId);
  if (sel && sel.value === '__new__') {
    $(selectId + '_newRow').classList.remove('hidden');
    $(selectId + '_newInput').focus();
  }
}

function cancelNewCategory(selectId) {
  $(selectId).value = expenseCategoryList()[0];
  $(selectId + '_newRow').classList.add('hidden');
}

async function confirmNewCategory(selectId) {
  const name = $(selectId + '_newInput').value.trim();
  if (!name) return;
  const list = expenseCategoryList();
  if (!list.includes(name)) list.push(name);
  await persist();
  const sel = $(selectId);
  sel.innerHTML = list.map(c => `<option value="${c}">${catLabel(c)}</option>`).join('') + `<option value="__new__">+ ${T.addCategory}</option>`;
  sel.value = name;
  $(selectId + '_newRow').classList.add('hidden');
}

function renderExpenses() {
  const rows = DB.expenses.slice().reverse();
  $('expTable').innerHTML = `<thead><tr><th>${T.description}</th><th>${T.expenseCategory}</th><th>${T.amount}</th><th>${T.date}</th><th>${T.actions}</th></tr></thead><tbody>` +
    (rows.length ? rows.map(e => `<tr>
      <td>${esc(e.desc)}</td><td><span class="badge">${catLabel(e.category)}</span></td>
      <td><span class="badge warn">${fmt(e.amount)} ${cur()}</span>${e.originalCurrency && e.originalCurrency !== cur() ? `<div class="muted">${fmt(e.originalAmount)} ${e.originalCurrency}</div>` : ''}</td>
      <td>${e.date.slice(0, 10)}</td>
      <td><button class="btn btn-danger btn-sm" onclick="delExpense('${e.id}')">${T.delete}</button></td>
    </tr>`).join('') : `<tr><td colspan="5" class="empty">${T.noData}</td></tr>`) + '</tbody>';

  const budgets = (DB.settings.expenseBudgets) || {};
  const thisMonth = new Date().toISOString().slice(0, 7);
  const spentByCat = {};
  DB.expenses.filter(e => e.date.slice(0, 7) === thisMonth).forEach(e => { spentByCat[e.category || 'other'] = (spentByCat[e.category || 'other'] || 0) + Number(e.amount); });
  const withBudget = expenseCategoryList().filter(c => budgets[c] > 0);
  const el = $('budgetCards');
  if (el) {
    el.innerHTML = withBudget.length ? withBudget.map(c => {
      const spent = spentByCat[c] || 0; const limit = budgets[c]; const over = spent > limit;
      return `<div class="card"><div class="c-label">${catLabel(c)}</div><div class="c-value ${over ? 'low-text' : ''}">${fmt(spent)}</div><div class="c-sub">/ ${fmt(limit)} ${cur()}${over ? ' — ⚠️ ' + T.budgetExceeded : ''}</div></div>`;
    }).join('') : '';
  }
}

function openExpenseModal() {
  const currencies = DB.settings.currencies || [];
  openModal(`<h3>${T.addExpense}</h3>
    <div class="field"><label>${T.description}</label><input id="mDesc"></div>
    <div class="grid2">
      <div class="field"><label>${T.originalAmount}</label><input id="mAmount" type="number" min="0" oninput="updateExpensePreview()"></div>
      <div class="field"><label>${T.expenseCategory}</label>
        ${categorySelectHtml('mCategory')}
      </div>
    </div>
    ${currencies.length ? `
    <div class="field"><label>${T.expenseCurrency}</label>
      <select id="mExpCurrency" onchange="updateExpensePreview()">
        <option value="${cur()}">${cur()} (${T.baseCurrency})</option>
        ${currencies.map(c => `<option value="${c.code}">${c.code}</option>`).join('')}
      </select>
    </div>
    <p class="muted" id="expPreview"></p>` : ''}
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal()">${T.cancel}</button>
      <button class="btn btn-gold" onclick="saveExpense()">${T.save}</button>
    </div>`);
}

function updateExpensePreview() {
  const preview = $('expPreview');
  if (!preview) return;
  const amount = Number($('mAmount').value || 0);
  const code = $('mExpCurrency').value;
  if (code === cur()) { preview.textContent = ''; return; }
  const rate = ((DB.settings.currencies || []).find(c => c.code === code) || {}).rate || 0;
  preview.textContent = `${T.convertedTo} ${cur()}: ${fmt(amount * rate)} ${cur()}`;
}

async function saveExpense() {
  const desc = $('mDesc').value.trim(), inputAmount = Number($('mAmount').value || 0), category = $('mCategory').value;
  if (!desc || !inputAmount) return;
  const curField = $('mExpCurrency');
  const code = curField ? curField.value : cur();
  let amount = inputAmount, originalAmount = null, originalCurrency = null;
  if (code !== cur()) {
    const rate = ((DB.settings.currencies || []).find(c => c.code === code) || {}).rate || 0;
    amount = inputAmount * rate;
    originalAmount = inputAmount; originalCurrency = code;
  }
  DB.expenses.push({ id: uid('ex'), desc, amount, originalAmount, originalCurrency, category, date: new Date().toISOString() });
  logAudit('create', T.expenses, desc);
  await persist(); closeModal(); renderAll(); toast(T.saved);
}

async function delExpense(id) { await softDelete('expenses', id, T.expenses); }

// ---------- التقارير ----------
function renderReports() {
  const f = financials();
  const thisMonth = new Date().toISOString().slice(0, 7);
  const lastMonthDate = new Date(); lastMonthDate.setMonth(lastMonthDate.getMonth() - 1);
  const lastMonth = lastMonthDate.toISOString().slice(0, 7);
  const thisMonthSales = DB.invoices.filter(i => i.date.slice(0, 7) === thisMonth).reduce((s, i) => s + i.total, 0);
  const lastMonthSales = DB.invoices.filter(i => i.date.slice(0, 7) === lastMonth).reduce((s, i) => s + i.total, 0);
  const growth = lastMonthSales > 0 ? ((thisMonthSales - lastMonthSales) / lastMonthSales * 100) : (thisMonthSales > 0 ? 100 : 0);
  $('repCards').innerHTML = `
    <div class="card"><div class="c-label">${T.totalSales}</div><div class="c-value" data-val="${f.totalSales}">0</div><div class="c-sub">${cur()}</div></div>
    <div class="card"><div class="c-label">${T.cogs}</div><div class="c-value" data-val="${f.totalCogs}">0</div><div class="c-sub">${cur()}</div></div>
    <div class="card"><div class="c-label">${T.grossProfit}</div><div class="c-value" data-val="${f.grossProfit}">0</div><div class="c-sub">${cur()}</div></div>
    <div class="card"><div class="c-label">${T.expenses}</div><div class="c-value" data-val="${f.totalExpenses}">0</div><div class="c-sub">${cur()}</div></div>
    <div class="card emerald"><div class="c-label">${T.netProfit}</div><div class="c-value" data-val="${f.netProfit}">0</div><div class="c-sub">${cur()}</div></div>
    <div class="card ${growth >= 0 ? 'emerald' : ''}"><div class="c-label">${T.growthVsLastMonth}</div><div class="c-value ${growth < 0 ? 'low-text' : ''}">${growth >= 0 ? '+' : ''}${fmt(growth)}%</div></div>`;
  animateCounters('repCards');

  const months = [];
  for (let k = 5; k >= 0; k--) {
    const d = new Date(); d.setMonth(d.getMonth() - k);
    months.push(d.toISOString().slice(0, 7));
  }
  const sums = months.map(m => DB.invoices.filter(i => i.date.slice(0, 7) === m).reduce((s, i) => s + i.total, 0));
  const mx = Math.max(...sums, 1);
  $('repBars').innerHTML = months.map((m, ix) => `
    <div class="bar-col"><div class="bar-val">${fmt(sums[ix])}</div>
    <div class="bar" style="height:${Math.round(sums[ix] / mx * 150)}px"></div>
    <div class="bar-lbl">${m}</div></div>`).join('');

  const tally = {};
  DB.invoices.forEach(i => i.items.forEach(it => { tally[it.name] = (tally[it.name] || 0) + it.qty; }));
  const top = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const tmx = Math.max(...top.map(t => t[1]), 1);
  $('repTop').innerHTML = top.length ? top.map(([name, q]) => `
    <div class="bar-col"><div class="bar-val">${q}</div>
    <div class="bar" style="height:${Math.round(q / tmx * 150)}px"></div>
    <div class="bar-lbl">${esc(name)}</div></div>`).join('') : `<div class="empty">${T.noData}</div>`;

  // هامش الربح لكل منتج
  const perProduct = {};
  DB.invoices.forEach(i => i.items.forEach(it => {
    const p = perProduct[it.name] || (perProduct[it.name] = { revenue: 0, cost: 0, qty: 0 });
    p.revenue += it.total; p.cost += Number(it.cost || 0) * it.qty; p.qty += it.qty;
  }));
  const marginRows = Object.entries(perProduct).map(([name, v]) => ({ name, ...v, profit: v.revenue - v.cost, margin: v.revenue > 0 ? (v.revenue - v.cost) / v.revenue * 100 : 0 })).sort((a, b) => b.profit - a.profit).slice(0, 10);
  $('repMargin').innerHTML = `<thead><tr><th>${T.product}</th><th>${T.qty}</th><th>${T.totalSales}</th><th>${T.netProfit}</th><th>${T.margin}</th></tr></thead><tbody>` +
    (marginRows.length ? marginRows.map(r => `<tr><td>${esc(r.name)}</td><td>${r.qty}</td><td>${fmt(r.revenue)} ${cur()}</td><td>${fmt(r.profit)} ${cur()}</td><td><span class="badge ${r.margin < 0 ? 'low' : ''}">${fmt(r.margin)}%</span></td></tr>`).join('') : `<tr><td colspan="5" class="empty">${T.noData}</td></tr>`) + '</tbody>';

  // أفضل العملاء إنفاقاً
  const perCustomer = {};
  DB.invoices.forEach(i => { const name = i.customerName || T.walkIn; perCustomer[name] = (perCustomer[name] || 0) + i.total; });
  const topCustomers = Object.entries(perCustomer).sort((a, b) => b[1] - a[1]).slice(0, 10);
  $('repTopCustomers').innerHTML = `<thead><tr><th>${T.customer}</th><th>${T.totalSales}</th></tr></thead><tbody>` +
    (topCustomers.length ? topCustomers.map(([name, total]) => `<tr><td>${esc(name)}</td><td><span class="badge">${fmt(total)} ${cur()}</span></td></tr>`).join('') : `<tr><td colspan="2" class="empty">${T.noData}</td></tr>`) + '</tbody>';
}

async function exportReportPdf() {
  const f = financials();
  const tally = {};
  DB.invoices.forEach(i => i.items.forEach(it => { tally[it.name] = (tally[it.name] || 0) + it.qty; }));
  const top = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const invSettings = DB.settings.invoice || { template: 'classic', color: '#C8A45C' };
  $('print-area').innerHTML = `
    <div class="inv-doc tpl-${invSettings.template || 'classic'}" style="--inv-accent:${invSettings.color || '#C8A45C'}">
      <div class="inv-head">
        <div class="inv-brand">${esc(DB.settings.businessName || 'سند')} — ${T.reports}</div>
        <div class="inv-company-info">${T.date}: ${new Date().toISOString().slice(0, 10)}</div>
      </div>
      <table><tbody>
        <tr><td>${T.totalSales}</td><td>${fmt(f.totalSales)} ${cur()}</td></tr>
        <tr><td>${T.cogs}</td><td>${fmt(f.totalCogs)} ${cur()}</td></tr>
        <tr><td>${T.grossProfit}</td><td>${fmt(f.grossProfit)} ${cur()}</td></tr>
        <tr><td>${T.expenses}</td><td>${fmt(f.totalExpenses)} ${cur()}</td></tr>
        <tr><td><b>${T.netProfit}</b></td><td><b>${fmt(f.netProfit)} ${cur()}</b></td></tr>
      </tbody></table>
      <h3 style="margin:16px 0 8px;color:var(--inv-accent)">${T.topProducts}</h3>
      <table><thead><tr><th>${T.product}</th><th>${T.qty}</th></tr></thead>
      <tbody>${top.length ? top.map(([name, q]) => `<tr><td>${esc(name)}</td><td>${q}</td></tr>`).join('') : `<tr><td colspan="2">${T.noData}</td></tr>`}</tbody></table>
      <div class="inv-thanks">${esc(DB.settings.businessName || 'سند')}</div>
    </div>`;
  const res = await bridge.exportPdf(`تقرير-${new Date().toISOString().slice(0, 10)}.pdf`);
  if (res.ok) toast(T.pdfExported);
  else if (!res.canceled) toast('⚠️ ' + (res.error || T.aiOffline));
}

// ---------- المساعد الذكي ----------
function addMsg(text, who) {
  const div = document.createElement('div');
  div.className = 'msg ' + who;
  div.textContent = text;
  $('chatLog').appendChild(div);
  $('chatLog').scrollTop = $('chatLog').scrollHeight;
  return div;
}

let streamDiv = null;
let chatPending = false;
bridge.onAiChunk(delta => {
  if (!streamDiv) return;
  if (streamDiv.classList.contains('thinking')) { streamDiv.classList.remove('thinking'); streamDiv.textContent = ''; }
  streamDiv.textContent += delta;
  $('chatLog').scrollTop = $('chatLog').scrollHeight;
});
bridge.onAiReset(() => {
  // فشل المزود الأول بعد أن بدأ ببث نص جزئي؛ نمسحه قبل أن يبدأ المزود الاحتياطي حتى لا يختلط الردّان
  if (streamDiv) { streamDiv.classList.add('thinking'); streamDiv.textContent = T.aiThinking; }
});

async function sendChat() {
  if (chatPending) return; // يمنع تضارب الردود عند إرسال أكثر من رسالة قبل اكتمال السابقة
  const inp = $('chatInput');
  const text = inp.value.trim();
  if (!text) return;
  chatPending = true;
  inp.disabled = true;
  inp.value = '';
  addMsg(text, 'user');
  streamDiv = addMsg(T.aiThinking, 'bot thinking');
  const res = await bridge.askAI(text, chatHistory.slice(-8));
  if (res.ok) {
    streamDiv.classList.remove('thinking');
    streamDiv.textContent = res.text;
    chatHistory.push({ role: 'user', content: text }, { role: 'assistant', content: res.text });
  } else {
    streamDiv.classList.remove('thinking');
    streamDiv.textContent = '⚠️ ' + T.aiOffline;
  }
  streamDiv = null;
  chatPending = false;
  inp.disabled = false;
  inp.focus();
}

async function checkAI() {
  const r = await bridge.checkAI();
  $('aiDot').className = 'dot' + (r.ok ? ' on' : '');
  $('aiStatus').textContent = r.ok ? T.aiOnline : T.aiOffline;
}

// ---------- تلجرام (خانات متعددة) ----------
const tgSlotStatus = {}; // botId -> {running, error, name}

function renderTelegramBots() {
  const bots = DB.settings.telegramBots || [];
  const el = $('tgBotsList');
  if (!el) return;
  el.innerHTML = bots.length ? bots.map(b => {
    const st = tgSlotStatus[b.id] || {};
    const badgeClass = st.running ? '' : (st.error ? 'low' : 'warn');
    const badgeText = st.running ? `${T.tgRunning}${st.name ? ' — @' + st.name : ''}` : (st.error ? '⚠️ ' + st.error : T.tgStopped);
    return `<div class="panel">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
        <div><b>${esc(b.name)}</b> <span class="badge ${badgeClass}" id="tgBadge_${b.id}">${badgeText}</span></div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-gold btn-sm" onclick="startBotSlot('${b.id}')">${T.tgStart}</button>
          <button class="btn btn-ghost btn-sm" onclick="stopBotSlot('${b.id}')">${T.tgStop}</button>
          <button class="btn btn-ghost btn-sm" onclick="openTelegramBotModal('${b.id}')">${T.edit}</button>
          <button class="btn btn-danger btn-sm" onclick="delTelegramBot('${b.id}')">${T.delete}</button>
        </div>
      </div>
    </div>`;
  }).join('') : `<div class="empty">${T.noData}</div>`;
}

function openTelegramBotModal(id) {
  const b = (DB.settings.telegramBots || []).find(x => x.id === id) || { name: '', token: '' };
  openModal(`<h3>${id ? T.editBot : T.addBot}</h3>
    <div class="field"><label>${T.botName}</label><input id="mBotName" value="${esc(b.name)}"></div>
    <div class="field"><label>${T.tgToken}</label><input id="mBotToken" value="${esc(b.token)}" placeholder="123456789:AAF..."></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal()">${T.cancel}</button>
      <button class="btn btn-gold" onclick="saveTelegramBot('${id || ''}')">${T.save}</button>
    </div>`);
}

async function saveTelegramBot(id) {
  const name = $('mBotName').value.trim(), token = $('mBotToken').value.trim();
  if (!name || !token) return;
  DB.settings.telegramBots = DB.settings.telegramBots || [];
  if (id) Object.assign(DB.settings.telegramBots.find(b => b.id === id), { name, token });
  else DB.settings.telegramBots.push({ id: uid('tg'), name, token });
  await persist(); closeModal(); renderTelegramBots(); toast(T.saved);
}

async function delTelegramBot(id) {
  if (!confirm(T.confirmDelete)) return;
  await bridge.tgStop(id);
  DB.settings.telegramBots = (DB.settings.telegramBots || []).filter(b => b.id !== id);
  delete tgSlotStatus[id];
  await persist(); renderTelegramBots();
}

async function startBotSlot(id) {
  const b = (DB.settings.telegramBots || []).find(x => x.id === id);
  if (!b) return;
  tgSlotStatus[id] = { running: false };
  renderTelegramBots();
  const r = await bridge.tgStart(id, b.token);
  tgSlotStatus[id] = r.ok ? { running: true, name: r.name } : { running: false, error: r.error };
  renderTelegramBots();
}

async function stopBotSlot(id) {
  await bridge.tgStop(id);
  tgSlotStatus[id] = { running: false };
  renderTelegramBots();
}

// ---------- الإعدادات ----------
function fillSettings() {
  $('setLang').value = DB.settings.lang;
  $('setCurrency').value = DB.settings.currency;
  $('setBiz').value = DB.settings.businessName;
  $('setAuthEnabled').checked = !!(DB.settings.auth && DB.settings.auth.enabled);
  $('setUsername').value = (DB.settings.auth && DB.settings.auth.username) || 'admin';
  $('setNewPass').value = '';
  const co = DB.settings.company || {};
  $('setAddress').value = co.address || '';
  $('setPhone').value = co.phone || '';
  $('setRC').value = co.rc || '';
  $('setCompanyNotes').value = co.notes || '';
  updateLogoPreview(co.logoDataUrl || '');
  if ($('setGroqKey')) $('setGroqKey').value = DB.settings.groqKey || '';
  const nf = DB.settings.notifications || {};
  $('setNotifLowStock').checked = nf.lowStock !== false;
  $('setNotifWeekly').checked = nf.weeklyReport !== false;
  fillBudgetInputs();
  renderCurrenciesList();
  fillLicensePanel();
  const iv = DB.settings.invoice || { template: 'classic', color: '#C8A45C' };
  $('setInvTemplate').value = iv.template || 'classic';
  $('setInvColor').value = iv.color || '#C8A45C';
  updateInvoiceDesignPreview();

  // قسم التزامن عبر الشبكة المحلية (LAN)
  refreshLanUI();
  // قسم قفل دور الجهاز
  refreshDeviceRoleUI();
}

// ---------- التزامن عبر الشبكة المحلية (LAN) ----------
// إعداد الشبكة محلي لكل جهاز (يُقرأ عبر IPC) ولا يُخزَّن ضمن بيانات التطبيق المزامَنة.
let lanDeviceName = ''; // اسم هذا الجهاز على الشبكة — يُستخدم أيضاً في سجل النشاط
async function refreshLanUI() {
  try {
    const cfg = await bridge.lanGetConfig();
    lanDeviceName = cfg.deviceName || '';
    const st = await bridge.lanStatus();
    updateSyncBadge(cfg, st);
    if (!$('lanRoleSelect')) return;
    $('lanRoleSelect').value = cfg.role || 'off';
    applyLanHostOptionVisibility();
    if ($('lanHostIp')) $('lanHostIp').value = cfg.hostIp || '';
    if ($('lanDeviceName')) $('lanDeviceName').value = cfg.deviceName || '';
    // كود الاقتران: العميل يكتبه؛ المضيف يراه معروضاً (يتولّد تلقائياً عند الحفظ)
    if ($('lanToken') && cfg.role === 'client') $('lanToken').value = cfg.token || '';
    if ($('lanPairCodeShow')) $('lanPairCodeShow').textContent = (cfg.role === 'host' && cfg.token) ? cfg.token : '—';
    onLanRoleChange();
    if ($('lanMyAddress')) {
      const ip = st.myIp && st.myIp !== '127.0.0.1' ? st.myIp : null;
      $('lanMyAddress').textContent = ip ? `${ip}:${st.port}` : (T.lanNoNetwork || '—');
    }
    if ($('lanClientCount')) $('lanClientCount').textContent = st.connectedClients || 0;
    // أسماء الأجهزة المتصلة بالمضيف — ليعرف المدير مَن معه على الشبكة
    if ($('lanClientNames')) $('lanClientNames').textContent = (st.clientNames && st.clientNames.length) ? '— ' + st.clientNames.map(esc).join('، ') : '';
    if ($('lanClientStatus') && cfg.role === 'client') {
      $('lanClientStatus').textContent = st.clientConnected ? ('✓ ' + (T.lanConnected || '')) : ('… ' + (T.lanConnecting || ''));
      $('lanClientStatus').style.color = st.clientConnected ? 'var(--gold)' : 'var(--muted)';
    }
  } catch (e) { /* الواجهة قد تُفتح قبل جاهزية الجسر */ }
}

// مؤشر حالة التزامن الدائم في الشريط الجانبي (أخضر = متزامن، أحمر = انقطع)
function updateSyncBadge(cfg, st) {
  const badge = $('syncBadge'); if (!badge) return;
  if (!cfg || cfg.role === 'off') { badge.style.display = 'none'; return; }
  badge.style.display = '';
  const dot = $('syncDot'), txt = $('syncStatusText');
  if (cfg.role === 'host') {
    const ok = !!st.serverRunning;
    dot.style.background = ok ? '#3ecf6f' : '#e05555';
    txt.textContent = ok ? `${T.syncHostOn || ''} (${st.connectedClients || 0})` : (T.syncHostOff || '');
  } else {
    const ok = !!st.clientConnected;
    dot.style.background = ok ? '#3ecf6f' : '#e05555';
    txt.textContent = ok ? (T.syncConnected || '') : (T.syncOffline || '');
  }
}

function onLanRoleChange() {
  const role = $('lanRoleSelect') ? $('lanRoleSelect').value : 'off';
  if ($('lanHostBox')) $('lanHostBox').style.display = role === 'host' ? 'block' : 'none';
  if ($('lanClientBox')) $('lanClientBox').style.display = role === 'client' ? 'block' : 'none';
  // اسم الجهاز يظهر لأي دور شبكي (مضيف أو متصل) ليعرف الجميع بعضهم
  if ($('lanNameBox')) $('lanNameBox').style.display = role === 'off' ? 'none' : 'block';
}

async function saveLanConfig() {
  const role = $('lanRoleSelect').value;
  // فرض الصلاحية عند نقطة الحفظ (لا إخفاء CSS فقط): وضع المضيف حكر على المدير
  if (role === 'host' && currentRole !== 'manager') { toast(T.accessDenied); return; }
  const hostIp = $('lanHostIp') ? $('lanHostIp').value.trim() : '';
  const deviceName = $('lanDeviceName') ? $('lanDeviceName').value.trim() : '';
  // المضيف يحتفظ بكوده الحالي (يتولّد في العملية الرئيسية إن كان فارغاً)؛ العميل يرسل ما كتبه
  const cur = await bridge.lanGetConfig();
  const token = role === 'host' ? (cur.token || '') : ($('lanToken') ? $('lanToken').value.trim() : '');
  await bridge.lanSetConfig({ role, hostIp, token, deviceName });
  toast(T.saved);
  if (role === 'client' && hostIp) { DB = await bridge.loadData(); renderAll(); }
  setTimeout(refreshLanUI, 500);
}

// البحث التلقائي عن خادم سند على الشبكة (بلا إدخال IP): يعرض الخوادم الموجودة بأسمائها
async function discoverLanHosts() {
  const list = $('lanDiscoveryList'), btn = $('lanDiscoverBtn');
  if (!list) return;
  if (btn) btn.disabled = true;
  list.innerHTML = `<p class="muted">… ${T.lanDiscovering || ''}</p>`;
  try {
    const hosts = await bridge.lanDiscover();
    if (!hosts.length) {
      list.innerHTML = `<p class="muted">${T.lanDiscoverNone || ''}</p>`;
    } else {
      list.innerHTML = hosts.map(h =>
        `<button class="btn btn-ghost" style="width:100%;margin-top:6px;justify-content:space-between;display:flex"
           onclick="pickDiscoveredHost('${esc(h.ip)}')">
           <span>◈ ${esc(h.name) || (T.lanRoleHost || '')}</span><span dir="ltr" class="muted">${esc(h.ip)}</span>
         </button>`).join('');
    }
  } catch (e) { list.innerHTML = `<p class="muted">${T.lanDiscoverNone || ''}</p>`; }
  if (btn) btn.disabled = false;
}

function pickDiscoveredHost(ip) {
  if ($('lanHostIp')) $('lanHostIp').value = ip;
  testLanHost(); // اختبار فوري بعد الاختيار
}

// ---------- قفل دور الجهاز (إدارة المدير فقط) ----------
// يعرض الدور المربوط حالياً على هذا الجهاز، ويتيح للمدير إعادة تعيينه أو فكّه.
async function refreshDeviceRoleUI() {
  if (!$('deviceRoleSelect')) return;
  try {
    const cur = (await bridge.deviceRoleGet()).role;
    deviceBoundRole = cur;
    $('deviceRoleCurrent').textContent = cur ? roleName(cur) : (T.deviceRoleNone || '—');
    $('deviceRoleSelect').value = cur || '';
  } catch (e) { /* الجسر قد لا يكون جاهزاً بعد */ }
}

async function saveDeviceRole() {
  if (currentRole !== 'manager') { toast(T.accessDenied); return; }
  const val = $('deviceRoleSelect').value;
  const res = val ? await bridge.deviceRoleSet(val) : await bridge.deviceRoleClear();
  deviceBoundRole = res.role;
  toast(T.saved);
  refreshDeviceRoleUI();
}

async function clearDeviceRole() {
  if (currentRole !== 'manager') { toast(T.accessDenied); return; }
  const res = await bridge.deviceRoleClear();
  deviceBoundRole = res.role;
  toast(T.saved);
  refreshDeviceRoleUI();
}

async function testLanHost() {
  const ip = $('lanHostIp') ? $('lanHostIp').value.trim() : '';
  if (!ip) return;
  const token = $('lanToken') ? $('lanToken').value.trim() : '';
  if ($('lanClientStatus')) { $('lanClientStatus').textContent = '… ' + (T.lanTesting || ''); $('lanClientStatus').style.color = 'var(--muted)'; }
  const r = await bridge.lanTest(ip, undefined, token);
  if ($('lanClientStatus')) {
    const msg = r.ok ? ('✓ ' + (T.lanReachable || ''))
      : (r.error === 'unauthorized'
        ? (token ? ('✗ ' + (T.lanTokenWrong || '')) : ('🔑 ' + (T.lanNeedCode || '')))
        : ('✗ ' + (T.lanUnreachable || '')));
    $('lanClientStatus').textContent = msg;
    $('lanClientStatus').style.color = r.ok ? 'var(--gold)' : '#e0607a';
  }
}

function sampleInvoiceForPreview() {
  return {
    number: 1024, date: new Date().toISOString(), customerName: T.walkIn,
    items: [
      { name: T.product + ' 1', price: 500, qty: 2, total: 1000 },
      { name: T.product + ' 2', price: 300, qty: 1, total: 300 }
    ],
    subtotal: 1300, discount: 100, taxPercent: 5, total: 1260, paidAmount: 1260
  };
}

function updateInvoiceDesignPreview() {
  const el = $('invDesignPreview');
  if (!el) return;
  const prevSettings = DB.settings.invoice;
  DB.settings.invoice = { template: $('setInvTemplate').value, color: $('setInvColor').value };
  el.innerHTML = `<div class="inv-preview-modal" style="max-height:340px">${buildInvoiceHtml(sampleInvoiceForPreview())}</div>`;
  DB.settings.invoice = prevSettings;
}

async function saveInvoiceDesign() {
  DB.settings.invoice = { template: $('setInvTemplate').value, color: $('setInvColor').value };
  await persist();
  toast(T.saved);
}

function fillLicensePanel() {
  const lic = DB.settings.license || {};
  if ($('licDeviceId')) $('licDeviceId').value = lic.deviceId || '';
  if (!$('licAdminActive')) return;
  if (lic.gistId) {
    $('licAdminSetup').classList.add('hidden');
    $('licAdminActive').classList.remove('hidden');
    $('licGistIdLabel').textContent = `${T.licenseSystemActive} ${lic.gistId}`;
    $('licClaimCode').textContent = lic.ownerChatId ? '••••••••' : (lic.claimCode || '');
  } else {
    $('licAdminSetup').classList.remove('hidden');
    $('licAdminActive').classList.add('hidden');
  }
}

function copyDeviceId() {
  const id = DB.settings.license && DB.settings.license.deviceId;
  if (!id) return;
  navigator.clipboard.writeText(id).then(() => toast(T.copied));
}

function applyLicenseLock(locked, message) {
  if (locked) {
    $('licenseLockMsg').textContent = message || T.lockedBody;
    $('licenseLockScreen').classList.add('open');
  } else {
    $('licenseLockScreen').classList.remove('open');
  }
}

// ---------- مفتاح نجاة المدير: فكّ قفل دور الجهاز بكود المطوّر من أي واجهة ----------
// يعالج حالة: جهاز بلا تسجيل دخول ومربوط بدور محاسب/كاشير، فلا يصل صاحبه للإعدادات لإعادة التعيين.
function openDeviceUnlock() {
  openModal(`<h3>${T.devUnlockTitle}</h3>
    <p class="muted">${T.devUnlockBody}</p>
    <div class="field" style="margin-top:12px"><input id="devUnlockInput" type="password" onkeydown="if(event.key==='Enter')submitDeviceUnlock()" autocomplete="off"></div>
    <div class="auth-error" id="devUnlockError"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal()">${T.cancel}</button>
      <button class="btn btn-gold" onclick="submitDeviceUnlock()">${T.deviceRoleClear}</button>
    </div>`);
  setTimeout(() => { if ($('devUnlockInput')) $('devUnlockInput').focus(); }, 20);
}

async function submitDeviceUnlock() {
  const code = $('devUnlockInput').value;
  const res = await bridge.activationVerify(code); // يتحقق من كود المطوّر (لا يغيّر شيئاً إن كان خطأً)
  if (res && res.ok) {
    await bridge.deviceRoleClear();
    deviceBoundRole = null;
    closeModal();
    toast(T.saved);
    setTimeout(() => location.reload(), 400);
  } else {
    if ($('devUnlockError')) $('devUnlockError').textContent = T.devUnlockWrong;
  }
}

// ---------- تفعيل المطوّر (كود لمرة واحدة على الجهاز) ----------
async function doActivate() {
  const code = $('activationCodeInput').value;
  const res = await bridge.activationVerify(code);
  if (res.ok) {
    $('activationScreen').classList.remove('open');
    $('activationError').textContent = '';
    await bootAfterActivation();
  } else {
    $('activationError').textContent = T.activationWrong;
  }
}

function renderCurrenciesList() {
  const list = DB.settings.currencies || [];
  const el = $('currenciesList');
  if (!el) return;
  el.innerHTML = list.length ? list.map((c, ix) => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border-subtle)">
      <span><b>${esc(c.code)}</b> = ${fmt(c.rate)} ${cur()}</span>
      <button class="btn btn-danger btn-sm" onclick="delCurrency(${ix})">${T.delete}</button>
    </div>`).join('') : `<p class="muted">${T.noData}</p>`;
}

async function addCurrency() {
  const code = $('newCurCode').value.trim().toUpperCase();
  const rate = Number($('newCurRate').value || 0);
  if (!code || !rate) return;
  DB.settings.currencies = DB.settings.currencies || [];
  DB.settings.currencies.push({ code, rate });
  $('newCurCode').value = ''; $('newCurRate').value = '';
  await persist(); renderCurrenciesList(); toast(T.saved);
}

async function delCurrency(ix) {
  DB.settings.currencies.splice(ix, 1);
  await persist(); renderCurrenciesList();
}

function fillBudgetInputs() {
  const budgets = DB.settings.expenseBudgets || {};
  $('budgetInputs').innerHTML = expenseCategoryList().map(c => `
    <div class="field"><label>${catLabel(c)}</label><input type="number" min="0" placeholder="0" id="mBudget_${esc(c)}" value="${budgets[c] || ''}"></div>
  `).join('');
}

async function saveBudgets() {
  DB.settings.expenseBudgets = {};
  expenseCategoryList().forEach(c => {
    const v = Number(($('mBudget_' + c) || {}).value || 0);
    if (v > 0) DB.settings.expenseBudgets[c] = v;
  });
  await persist(); renderAll(); toast(T.saved);
}

async function saveSettings() {
  DB.settings.lang = $('setLang').value;
  DB.settings.currency = $('setCurrency').value.trim() || 'MRU';
  DB.settings.businessName = $('setBiz').value.trim() || 'سند';
  DB.settings.company = {
    address: $('setAddress').value.trim(), phone: $('setPhone').value.trim(),
    rc: $('setRC').value.trim(),
    notes: $('setCompanyNotes').value.trim(), logoDataUrl: (DB.settings.company && DB.settings.company.logoDataUrl) || ''
  };
  DB.settings.notifications = { ...DB.settings.notifications, lowStock: $('setNotifLowStock').checked, weeklyReport: $('setNotifWeekly').checked };
  await persist(); applyLang(); renderAll(); checkAI(); toast(T.saved);
}

// مفتاح ذكاء اصطناعي خاص بالزبون: إن ضُبط، يتقدّم على المفتاح المشترك المدمج (activeGroqKey في main.js)
async function saveAiKey() {
  DB.settings.groqKey = $('setGroqKey').value.trim();
  await persist(); checkAI(); toast(T.saved);
}

function updateLogoPreview(dataUrl) {
  const img = $('logoPreview');
  if (dataUrl) { img.src = dataUrl; img.style.display = 'block'; }
  else { img.style.display = 'none'; }
}

function onLogoFileChange(ev) {
  const file = ev.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    DB.settings.company = DB.settings.company || {};
    DB.settings.company.logoDataUrl = reader.result;
    updateLogoPreview(reader.result);
    await persist(); toast(T.saved);
  };
  reader.readAsDataURL(file);
}

async function removeCompanyLogo() {
  if (DB.settings.company) DB.settings.company.logoDataUrl = '';
  updateLogoPreview('');
  await persist(); toast(T.saved);
}

async function saveSecurity() {
  DB.settings.auth.enabled = $('setAuthEnabled').checked;
  DB.settings.auth.username = $('setUsername').value.trim() || 'admin';
  await persist();
  const newPass = $('setNewPass').value;
  if (newPass) await bridge.authSetCredentials(DB.settings.auth.username, newPass);
  else await bridge.authSetCredentials(DB.settings.auth.username, null);
  $('setNewPass').value = '';
  toast(T.saved);
}

function exportData() {
  const blob = new Blob([JSON.stringify(DB, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sened-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
}

function importData() {
  const f = $('importFile');
  f.onchange = () => {
    const file = f.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        DB = JSON.parse(reader.result);
        await persist(); applyLang(); applyTheme(); renderAll(); toast(T.saved);
      } catch (e) { alert('ملف غير صالح'); }
    };
    reader.readAsText(file);
  };
  f.click();
}

// ---------- تصدير CSV ----------
function downloadCsv(filename, rows) {
  const csv = rows.map(r => r.map(c => {
    const s = String(c ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  toast(T.csvExported);
}

function exportProductsCsv() {
  const rows = [[T.name, T.category, T.price, T.cost, T.stock, T.threshold]];
  DB.products.forEach(p => rows.push([p.name, p.category, p.price, p.cost, p.stock, p.threshold ?? 3]));
  downloadCsv(`sened-products-${new Date().toISOString().slice(0, 10)}.csv`, rows);
}

function exportInvoicesCsv() {
  const rows = [[T.invoiceNo, T.customer, T.subtotal, T.discount, T.taxPercent, T.total, T.paidAmount, T.status, T.date]];
  DB.invoices.forEach(i => rows.push([i.number, i.customerName || T.walkIn, i.subtotal ?? i.total, i.discount || 0, i.taxPercent || 0, i.total, i.paidAmount || 0, T[i.status], i.date.slice(0, 10)]));
  downloadCsv(`sened-invoices-${new Date().toISOString().slice(0, 10)}.csv`, rows);
}

function exportReportCsv() {
  const f = financials();
  const rows = [
    [T.totalSales, f.totalSales], [T.cogs, f.totalCogs], [T.grossProfit, f.grossProfit],
    [T.expenses, f.totalExpenses], [T.netProfit, f.netProfit], [T.customerDebts, f.custDebt], [T.supplierDebts, f.supDebt],
    [], [T.topProducts]
  ];
  const tally = {};
  DB.invoices.forEach(i => i.items.forEach(it => { tally[it.name] = (tally[it.name] || 0) + it.qty; }));
  Object.entries(tally).sort((a, b) => b[1] - a[1]).forEach(([name, q]) => rows.push([name, q]));
  downloadCsv(`sened-report-${new Date().toISOString().slice(0, 10)}.csv`, rows);
}

// ---------- الإشعارات ----------
let notifiedLowStockIds = new Set();
function notify(title, body) {
  try {
    if (Notification.permission === 'granted') new Notification(title, { body });
    else if (Notification.permission !== 'denied') Notification.requestPermission().then(p => { if (p === 'granted') new Notification(title, { body }); });
  } catch (e) { /* بيئة لا تدعم الإشعارات */ }
}

function checkLowStockNotif() {
  if (!(DB.settings.notifications && DB.settings.notifications.lowStock !== false)) return;
  const low = DB.products.filter(isLow);
  const fresh = low.filter(p => !notifiedLowStockIds.has(p.id));
  if (fresh.length) {
    notify(DB.settings.businessName || T.appName, `⚠️ ${T.lowStock}: ${fresh.map(p => p.name).join('، ')}`);
    fresh.forEach(p => notifiedLowStockIds.add(p.id));
  }
  const lowIds = new Set(low.map(p => p.id));
  notifiedLowStockIds.forEach(id => { if (!lowIds.has(id)) notifiedLowStockIds.delete(id); });
}

async function checkWeeklyReportNotif() {
  if (!(DB.settings.notifications && DB.settings.notifications.weeklyReport !== false)) return;
  const now = new Date();
  const weekKey = `${now.getFullYear()}-W${String(Math.ceil((((now - new Date(now.getFullYear(), 0, 1)) / 86400000) + new Date(now.getFullYear(), 0, 1).getDay() + 1) / 7)).padStart(2, '0')}`;
  if (DB.settings.notifications.lastWeeklyNotif === weekKey) return;
  const weekAgo = new Date(now.getTime() - 7 * 86400000).toISOString();
  const weekSales = DB.invoices.filter(i => i.date >= weekAgo).reduce((s, i) => s + i.total, 0);
  notify(DB.settings.businessName || T.appName, `📊 ${T.weeklySummary}: ${fmt(weekSales)} ${cur()}`);
  DB.settings.notifications.lastWeeklyNotif = weekKey;
  await persist();
}

// ---------- الجسيمات الذهبية ----------
function initParticles() {
  const cv = $('particles-canvas'), ctx = cv.getContext('2d');
  let W, H, pts = [];
  const resize = () => {
    W = cv.width = innerWidth; H = cv.height = innerHeight;
    pts = Array.from({ length: 55 }, () => ({
      x: Math.random() * W, y: Math.random() * H,
      r: Math.random() * 1.8 + 0.4,
      vx: (Math.random() - .5) * .35, vy: (Math.random() - .5) * .35,
      o: Math.random() * .6 + .15
    }));
  };
  resize(); addEventListener('resize', resize);
  (function loop() {
    ctx.clearRect(0, 0, W, H);
    for (const p of pts) {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > W) p.vx *= -1;
      if (p.y < 0 || p.y > H) p.vy *= -1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(200,164,92,${p.o})`;
      ctx.fill();
    }
    requestAnimationFrame(loop);
  })();
}

// ---------- التشغيل ----------
function renderAll() {
  renderDashboard(); renderProducts(); renderCustomers(); renderSuppliers();
  renderInvoices(); renderQuotes(); renderPurchases(); renderDebts(); renderEmployees();
  renderShareholders(); renderWallets(); renderExpenses(); renderReports();
  renderAuditLog(); renderTrash(); renderTelegramBots();
}

async function startApp() {
  renderAll();
  checkAI();
  setInterval(checkAI, 30000);
  checkWeeklyReportNotif();
  addMsg(T.aiWelcome, 'bot');
  bridge.onTgStatus(s => {
    tgSlotStatus[s.id] = { running: s.running && !s.error, error: s.error };
    renderTelegramBots();
  });
  if (window.sened) {
    (DB.settings.telegramBots || []).forEach(b => startBotSlot(b.id));
  }
}

// يُستدعى بعد اجتياز بوابة التفعيل: يقرر بين شاشة الدخول أو فتح التطبيق مباشرة
async function bootAfterActivation() {
  bridge.onLicenseStatus(s => applyLicenseLock(s.locked, s.message));
  const lic = DB.settings.license || {};
  if (lic.locked) applyLicenseLock(true, lic.message);

  // نسخة الكاشير: تبدأ مباشرةً بصلاحية كاشير مقيّدة، بلا شاشة دخول ولا إمكانية رفع الصلاحية
  if (APP_FLAVOR === 'cashier') {
    currentRole = 'cashier'; currentUserName = T.roleCashier || 'كاشير';
    $('appShell').classList.remove('hidden');
    await startApp();
    applyPermissions();
    return;
  }

  if (DB.settings.auth && DB.settings.auth.enabled) {
    $('loginUser').value = DB.settings.auth.username || '';
    $('loginScreen').classList.add('open');
  } else {
    // بلا شاشة دخول: إن كان الجهاز مربوطاً بدور تشغيلي نلتزم به فلا يظهر إلا واجهته.
    if (deviceBoundRole) { currentRole = deviceBoundRole; currentUserName = roleName(deviceBoundRole); }
    $('appShell').classList.remove('hidden');
    await startApp();
    applyPermissions();
    goPage(LANDING[currentRole] || 'dashboard');
  }
}

// التحديث اللحظي: يُستدعى عندما يبثّ المضيف تغييراً (أو يتصل/ينفصل جهاز).
// نعيد تحميل البيانات ونرسم الصفحة، مع تجنّب مقاطعة نافذة منبثقة مفتوحة.
let _syncBusy = false;
async function onRemoteSync() {
  if (_syncBusy) return;
  _syncBusy = true;
  try {
    DB = await bridge.loadData();
    const modalOpen = $('modalBg') && $('modalBg').classList.contains('open');
    if (!modalOpen) renderAll();
    refreshLanUI();
  } catch (e) { /* تجاهل */ } finally { _syncBusy = false; }
}

(async function init() {
  DB = await bridge.loadData();
  APP_FLAVOR = await bridge.appFlavor();
  deviceBoundRole = (await bridge.deviceRoleGet()).role;
  // تفضيلات العرض المحلية (لغة/سمة هذا الجهاز): إن لم توجد يُستعمل الإعداد المشترك
  try { const p = await bridge.uiPrefsGet(); UI_PREFS = { lang: p.lang || '', theme: p.theme || '' }; } catch (e) {}
  bridge.onSyncUpdated(onRemoteSync);
  // تنبيه واضح عند فشل وصول تعديل للخادم (بدل الفشل الصامت في السجل فقط)
  bridge.onSyncPostFailed(() => toast(T.syncPostFailed));
  // مؤشر التزامن في الشريط الجانبي: تحديث دوري خفيف حتى خارج صفحة الإعدادات
  setInterval(async () => {
    try { const cfg = await bridge.lanGetConfig(); lanDeviceName = cfg.deviceName || ''; updateSyncBadge(cfg, await bridge.lanStatus()); } catch (e) {}
  }, 5000);
  applyLang();
  applyTheme();
  fillSettings();
  initParticles();
  setTimeout(() => $('preloader').classList.add('hidden'), 1200);

  // بوابة التفعيل: إن كان هذا الجهاز يحتاج كود المطوّر (كود مدمج موجود ولم يُفعَّل بعد) نعرض شاشة التفعيل ونوقف حتى إدخاله
  const act = await bridge.activationStatus();
  if (act.required) { $('activationScreen').classList.add('open'); return; }
  await bootAfterActivation();
})();
