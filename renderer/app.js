/* ====== سند — منطق التطبيق ====== */
let DB = null;
let T = I18N.ar;
let chatHistory = [];

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => Number(n || 0).toLocaleString(T === I18N.ar ? 'ar-EG' : 'fr-FR', { maximumFractionDigits: 2 });
const cur = () => DB.settings.currency || 'MRU';
const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// وضع المتصفح (بدون Electron) — للمعاينة فقط
const bridge = window.sened || {
  loadData: async () => JSON.parse(localStorage.getItem('sened') || 'null') || {
    settings: {
      lang: 'ar', businessName: 'سند', currency: 'MRU', telegramToken: '', aiModel: 'qwen2:latest', anthropicKey: '', theme: 'dark',
      auth: { enabled: false, username: 'admin', passwordHash: '' },
      company: { address: '', rc: '', taxId: '', phone: '', notes: '', logoDataUrl: '' },
      notifications: { lowStock: true, weeklyReport: true, lastWeeklyNotif: '' }
    },
    products: [], customers: [], invoices: [], expenses: [],
    purchases: [], suppliers: [], employees: [], shareholders: [], withdrawals: [],
    wallets: [], walletTx: [],
    counters: { invoice: 1, purchase: 1 }
  },
  saveData: async d => localStorage.setItem('sened', JSON.stringify(d)),
  askAI: async () => ({ ok: false, error: 'BROWSER' }),
  checkAI: async () => ({ ok: false }),
  tgStart: async () => ({ ok: false, error: 'BROWSER' }),
  tgStop: async () => true,
  print: async () => window.print(),
  onTgStatus: () => {},
  authVerify: async () => true,
  authSetCredentials: async () => true
};

// ---------- الترجمة ----------
function applyLang() {
  T = I18N[DB.settings.lang] || I18N.ar;
  document.documentElement.lang = DB.settings.lang;
  document.documentElement.dir = T.dir;
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = T[el.dataset.i18n] || el.dataset.i18n; });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = T[el.dataset.i18nPh] || ''; });
  $('brandName').textContent = DB.settings.businessName || T.appName;
  applyThemeLabel();
}

// ---------- المظهر (ليلي/نهاري) ----------
function applyTheme() {
  document.documentElement.setAttribute('data-theme', DB.settings.theme === 'light' ? 'light' : 'dark');
  applyThemeLabel();
}
function applyThemeLabel() {
  const isLight = DB.settings.theme === 'light';
  $('themeLabel').textContent = isLight ? T.themeLight : T.themeDark;
  $('themeBtn').querySelector('.ic').textContent = isLight ? '☀' : '☾';
}
async function toggleTheme() {
  DB.settings.theme = DB.settings.theme === 'light' ? 'dark' : 'light';
  await persist(); applyTheme();
}

async function persist() { await bridge.saveData(DB); }

function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

// ---------- الدخول والقفل ----------
async function doLogin() {
  const u = $('loginUser').value.trim();
  const p = $('loginPass').value;
  const ok = await bridge.authVerify(u, p);
  if (ok) {
    $('loginScreen').classList.remove('open');
    $('loginError').textContent = '';
    $('appShell').classList.remove('hidden');
    await startApp();
  } else {
    $('loginError').textContent = T.wrongLogin;
  }
}

function lockApp() {
  $('lockPass').value = ''; $('lockError').textContent = '';
  $('lockScreen').classList.add('open');
}

async function doUnlock() {
  const p = $('lockPass').value;
  const ok = await bridge.authVerify(DB.settings.auth.username, p);
  if (ok) { $('lockScreen').classList.remove('open'); }
  else { $('lockError').textContent = T.wrongLogin; }
}

// ---------- التنقل ----------
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    item.classList.add('active');
    $('page-' + item.dataset.page).classList.add('active');
    renderAll();
  });
});

// ---------- النوافذ ----------
function openModal(html) { $('modalBox').innerHTML = html; $('modalBg').classList.add('open'); }
function closeModal() { $('modalBg').classList.remove('open'); }
$('modalBg').addEventListener('click', e => { if (e.target === $('modalBg')) closeModal(); });

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
function renderDashboard() {
  const today = new Date().toISOString().slice(0, 10);
  const todaySales = DB.invoices.filter(i => i.date.slice(0, 10) === today).reduce((s, i) => s + i.total, 0);
  const f = financials();
  const low = DB.products.filter(isLow).length;
  $('dashCards').innerHTML = `
    <div class="card"><div class="c-label">${T.todaySales}</div><div class="c-value">${fmt(todaySales)}</div><div class="c-sub">${cur()}</div></div>
    <div class="card"><div class="c-label">${T.totalSales}</div><div class="c-value">${fmt(f.totalSales)}</div><div class="c-sub">${cur()}</div></div>
    <div class="card emerald"><div class="c-label">${T.netProfit}</div><div class="c-value">${fmt(f.netProfit)}</div><div class="c-sub">${cur()}</div></div>
    <div class="card"><div class="c-label">${T.customerDebts}</div><div class="c-value">${fmt(f.custDebt)}</div><div class="c-sub">${cur()}</div></div>
    <div class="card"><div class="c-label">${T.totalBalance}</div><div class="c-value">${fmt(f.totalWalletBalance)}</div><div class="c-sub">${cur()}</div></div>
    <div class="card ${low ? '' : 'emerald'}"><div class="c-label">${T.lowStock}</div><div class="c-value">${low}</div></div>`;
  checkLowStockNotif();
  const rows = DB.invoices.slice(-6).reverse();
  $('dashInvTable').innerHTML = rows.length
    ? `<thead><tr><th>${T.invoiceNo}</th><th>${T.customer}</th><th>${T.total}</th><th>${T.status}</th><th>${T.date}</th></tr></thead><tbody>` +
      rows.map(i => `<tr><td>#${i.number}</td><td>${esc(i.customerName) || T.walkIn}</td><td><span class="badge">${fmt(i.total)} ${cur()}</span></td><td>${statusBadge(i.status)}</td><td>${i.date.slice(0, 10)}</td></tr>`).join('') + '</tbody>'
    : `<tbody><tr><td class="empty">${T.noData}</td></tr></tbody>`;
}

// ---------- المنتجات ----------
function renderProducts() {
  const q = ($('prodSearch').value || '').toLowerCase();
  const list = DB.products.filter(p => !q || p.name.toLowerCase().includes(q) || (p.category || '').toLowerCase().includes(q));
  $('prodTable').innerHTML = `<thead><tr><th>${T.name}</th><th>${T.category}</th><th>${T.price}</th><th>${T.cost}</th><th>${T.stock}</th><th>${T.actions}</th></tr></thead><tbody>` +
    (list.length ? list.map(p => `<tr>
      <td><b>${esc(p.name)}</b></td><td>${esc(p.category) || '—'}</td>
      <td>${fmt(p.price)} ${cur()}</td><td>${fmt(p.cost)} ${cur()}</td>
      <td><span class="badge ${isLow(p) ? 'low' : ''}">${p.stock}</span></td>
      <td><button class="btn btn-ghost btn-sm" onclick="openProductModal('${p.id}')">${T.edit}</button>
          <button class="btn btn-danger btn-sm" onclick="delProduct('${p.id}')">${T.delete}</button></td>
    </tr>`).join('') : `<tr><td colspan="6" class="empty">${T.noData}</td></tr>`) + '</tbody>';
}

function openProductModal(id) {
  const p = DB.products.find(x => x.id === id) || { name: '', category: '', price: '', cost: '', stock: '', threshold: 3 };
  openModal(`<h3>${id ? T.editProduct : T.addProduct}</h3>
    <div class="field"><label>${T.name}</label><input id="mName" value="${esc(p.name)}"></div>
    <div class="grid2">
      <div class="field"><label>${T.category}</label><input id="mCat" value="${esc(p.category)}"></div>
      <div class="field"><label>${T.stock}</label><input id="mStock" type="number" value="${p.stock}"></div>
      <div class="field"><label>${T.price}</label><input id="mPrice" type="number" value="${p.price}"></div>
      <div class="field"><label>${T.cost}</label><input id="mCost" type="number" value="${p.cost}"></div>
    </div>
    <div class="field"><label>${T.threshold}</label><input id="mThreshold" type="number" value="${p.threshold ?? 3}"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal()">${T.cancel}</button>
      <button class="btn btn-gold" onclick="saveProduct('${id || ''}')">${T.save}</button>
    </div>`);
}

async function saveProduct(id) {
  const obj = { name: $('mName').value.trim(), category: $('mCat').value.trim(), price: Number($('mPrice').value || 0), cost: Number($('mCost').value || 0), stock: Number($('mStock').value || 0), threshold: Number($('mThreshold').value || 3) };
  if (!obj.name) return;
  if (id) Object.assign(DB.products.find(x => x.id === id), obj);
  else DB.products.push({ id: uid('p'), ...obj });
  await persist(); closeModal(); renderAll(); toast(T.saved);
}

async function delProduct(id) {
  if (!confirm(T.confirmDelete)) return;
  DB.products = DB.products.filter(p => p.id !== id);
  await persist(); renderAll();
}

// ---------- العملاء ----------
function renderCustomers() {
  const q = ($('custSearch').value || '').toLowerCase();
  const list = DB.customers.filter(c => !q || c.name.toLowerCase().includes(q) || (c.phone || '').includes(q));
  $('custTable').innerHTML = `<thead><tr><th>${T.name}</th><th>${T.phone}</th><th>${T.address}</th><th>${T.debt}</th><th>${T.actions}</th></tr></thead><tbody>` +
    (list.length ? list.map(c => {
      const debt = DB.invoices.filter(i => i.customerId === c.id).reduce((s, i) => s + Math.max(0, i.total - (i.paidAmount || 0)), 0);
      return `<tr>
      <td><b>${esc(c.name)}</b></td><td dir="ltr">${esc(c.phone) || '—'}</td><td>${esc(c.address) || '—'}</td>
      <td>${debt > 0 ? `<span class="badge low">${fmt(debt)} ${cur()}</span>` : '—'}</td>
      <td><button class="btn btn-ghost btn-sm" onclick="openCustomerModal('${c.id}')">${T.edit}</button>
          <button class="btn btn-danger btn-sm" onclick="delCustomer('${c.id}')">${T.delete}</button></td>
    </tr>`; }).join('') : `<tr><td colspan="5" class="empty">${T.noData}</td></tr>`) + '</tbody>';
}

function openCustomerModal(id) {
  const c = DB.customers.find(x => x.id === id) || { name: '', phone: '', address: '' };
  openModal(`<h3>${id ? T.editCustomer : T.addCustomer}</h3>
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
  if (id) Object.assign(DB.customers.find(x => x.id === id), obj);
  else DB.customers.push({ id: uid('c'), ...obj });
  await persist(); closeModal(); renderAll(); toast(T.saved);
}

async function delCustomer(id) {
  if (!confirm(T.confirmDelete)) return;
  DB.customers = DB.customers.filter(c => c.id !== id);
  await persist(); renderAll();
}

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
  await persist(); closeModal(); renderAll(); toast(T.saved);
}

async function delSupplier(id) {
  if (!confirm(T.confirmDelete)) return;
  DB.suppliers = DB.suppliers.filter(s => s.id !== id);
  await persist(); renderAll();
}

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
        <button class="btn btn-ghost btn-sm" onclick="printInvoice('${i.id}')">${T.print}</button>
        <button class="btn btn-danger btn-sm" onclick="delInvoice('${i.id}')">${T.delete}</button>
      </td>
    </tr>`; }).join('') : `<tr><td colspan="7" class="empty">${T.noData}</td></tr>`) + '</tbody>';
}

let invLines = [];
function openInvoiceModal() {
  if (!DB.products.length) { toast(T.noData + ' — ' + T.addProduct); return; }
  invLines = [{ productId: DB.products[0].id, qty: 1 }];
  openModal(`<h3>${T.newInvoice} #${DB.counters.invoice}</h3>
    <div class="field"><label>${T.customer}</label>
      <select id="mCust"><option value="">${T.walkIn}</option>${DB.customers.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
    </div>
    <div id="invLines"></div>
    <button class="btn btn-ghost btn-sm" onclick="addInvLine()">+ ${T.addLine}</button>
    <p class="muted" style="margin-top:12px">${T.subtotal}: <span id="invSubtotal">0</span> ${cur()}</p>
    <div class="grid2">
      <div class="field"><label>${T.discount}</label><input id="mDiscount" type="number" value="0" oninput="drawInvLines()"></div>
      <div class="field"><label>${T.taxPercent}</label><input id="mTax" type="number" value="0" oninput="drawInvLines()"></div>
    </div>
    <h3>${T.grandTotal}: <span id="invTotal">0</span> ${cur()}</h3>
    <div class="grid2" style="margin-top:10px">
      <div class="field"><label>${T.paidAmount}</label><input id="mPaid" type="number" value="0"></div>
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
    <div class="grid3" style="margin-bottom:8px">
      <select onchange="invLines[${ix}].productId=this.value;drawInvLines()">
        ${DB.products.map(p => `<option value="${p.id}" ${p.id === l.productId ? 'selected' : ''}>${esc(p.name)} — ${fmt(p.price)} (${p.stock})</option>`).join('')}
      </select>
      <input type="number" min="1" value="${l.qty}" onchange="invLines[${ix}].qty=Number(this.value)||1;drawInvLines()">
      <button class="btn btn-danger btn-sm" onclick="invLines.splice(${ix},1);drawInvLines()">✕</button>
    </div>`).join('');
  $('invSubtotal').textContent = fmt(invSubtotal());
  $('invTotal').textContent = fmt(invGrandTotal());
}

function invSubtotal() {
  return invLines.reduce((s, l) => {
    const p = DB.products.find(x => x.id === l.productId);
    return s + (p ? p.price * l.qty : 0);
  }, 0);
}

function invGrandTotal() {
  const discount = Math.max(0, Number(($('mDiscount') || {}).value || 0));
  const taxPct = Math.max(0, Number(($('mTax') || {}).value || 0));
  const afterDiscount = Math.max(0, invSubtotal() - discount);
  return afterDiscount * (1 + taxPct / 100);
}

function addInvLine() { invLines.push({ productId: DB.products[0].id, qty: 1 }); drawInvLines(); }

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
    return { name: p.name, price: p.price, cost: p.cost, qty: l.qty, total: p.price * l.qty };
  });
  invLines.forEach(l => {
    const p = DB.products.find(x => x.id === l.productId);
    if (p) p.stock = Math.max(0, Number(p.stock) - l.qty);
  });
  const subtotal = invSubtotal();
  const discount = Math.max(0, Number($('mDiscount').value || 0));
  const taxPercent = Math.max(0, Number($('mTax').value || 0));
  const total = invGrandTotal();
  const paidAmount = Math.min(total, Math.max(0, Number($('mPaid').value || 0)));
  DB.invoices.push({
    id: uid('i'), number: DB.counters.invoice++,
    customerId: custId, customerName: cust ? cust.name : '',
    items, subtotal, discount, taxPercent, total, paidAmount, status: statusOf(total, paidAmount), date: new Date().toISOString()
  });
  await persist(); closeModal(); renderAll(); toast(T.invoiceSaved);
}

async function delInvoice(id) {
  if (!confirm(T.confirmDelete)) return;
  DB.invoices = DB.invoices.filter(i => i.id !== id);
  await persist(); renderAll();
}

function printInvoice(id) {
  const inv = DB.invoices.find(i => i.id === id);
  if (!inv) return;
  const remaining = Math.max(0, inv.total - (inv.paidAmount || 0));
  const co = DB.settings.company || {};
  const logo = co.logoDataUrl
    ? `<img src="${co.logoDataUrl}" style="height:52px;object-fit:contain">`
    : '';
  const infoLines = [co.address, co.phone, co.rc ? `${T.companyRC}: ${co.rc}` : '', co.taxId ? `${T.companyTaxId}: ${co.taxId}` : ''].filter(Boolean);
  const subtotal = inv.subtotal ?? inv.total;
  const discount = inv.discount || 0;
  const taxPercent = inv.taxPercent || 0;
  $('print-area').innerHTML = `
    <div class="inv-head">
      <div>
        ${logo}
        <div class="inv-brand">${esc(DB.settings.businessName || 'سند')}</div>
        ${infoLines.length ? `<div class="inv-company-info">${infoLines.map(esc).join('<br>')}</div>` : ''}
      </div>
      <div class="inv-meta">${T.invoiceNo}: #${inv.number}<br>${T.date}: ${inv.date.slice(0, 10)}<br>${T.customer}: ${esc(inv.customerName) || T.walkIn}</div>
    </div>
    <table><thead><tr><th>${T.product}</th><th>${T.price}</th><th>${T.qty}</th><th>${T.total}</th></tr></thead>
    <tbody>${inv.items.map(it => `<tr><td>${esc(it.name)}</td><td>${fmt(it.price)}</td><td>${it.qty}</td><td>${fmt(it.total)}</td></tr>`).join('')}</tbody></table>
    <div class="inv-totals-box">
      ${discount || taxPercent ? `<div class="inv-row"><span>${T.subtotal}</span><span>${fmt(subtotal)} ${cur()}</span></div>` : ''}
      ${discount ? `<div class="inv-row"><span>${T.discount}</span><span>-${fmt(discount)} ${cur()}</span></div>` : ''}
      ${taxPercent ? `<div class="inv-row"><span>${T.taxPercent}</span><span>${fmt(taxPercent)}%</span></div>` : ''}
      <div class="inv-total">${T.grandTotal}: ${fmt(inv.total)} ${cur()}</div>
      ${remaining > 0 ? `<div class="inv-total" style="color:#c0504d">${T.remaining}: ${fmt(remaining)} ${cur()}</div>` : ''}
    </div>
    ${co.notes ? `<div class="inv-company-info" style="margin-top:10px">${esc(co.notes)}</div>` : ''}
    <div class="inv-thanks">${T.thanks} ✦ ${esc(DB.settings.businessName || 'سند')}</div>
    <div class="inv-dev-credit">${T.developerCredit}</div>`;
  bridge.print();
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
      <div class="field"><label>${T.paidAmount}</label><input id="mPurPaid" type="number" value="0"></div>
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
  DB.purchases.push({
    id: uid('pu'), number: DB.counters.purchase++,
    supplierId: supId, supplierName: sup ? sup.name : '',
    items, total, paidAmount, status: statusOf(total, paidAmount), date: new Date().toISOString()
  });
  await persist(); closeModal(); renderAll(); toast(T.saved);
}

async function delPurchase(id) {
  if (!confirm(T.confirmDelete)) return;
  DB.purchases = DB.purchases.filter(p => p.id !== id);
  await persist(); renderAll();
}

// ---------- تسديد الديون (فواتير/مشتريات) ----------
function openCollectModal(kind, id) {
  const rec = kind === 'invoice' ? DB.invoices.find(x => x.id === id) : DB.purchases.find(x => x.id === id);
  if (!rec) return;
  const remaining = Math.max(0, rec.total - (rec.paidAmount || 0));
  openModal(`<h3>${T.collectPayment}</h3>
    <p class="muted">${T.remaining}: <b style="color:var(--gold-light)">${fmt(remaining)} ${cur()}</b></p>
    <div class="field" style="margin-top:12px"><label>${T.amount}</label><input id="mCollect" type="number" value="${remaining}"></div>
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
  const e = DB.employees.find(x => x.id === id) || { name: '', role: '', salary: '', phone: '' };
  openModal(`<h3>${id ? T.editEmployee : T.addEmployee}</h3>
    <div class="field"><label>${T.name}</label><input id="mName" value="${esc(e.name)}"></div>
    <div class="grid2">
      <div class="field"><label>${T.role}</label><input id="mRole" value="${esc(e.role)}"></div>
      <div class="field"><label>${T.salary}</label><input id="mSalary" type="number" value="${e.salary}"></div>
    </div>
    <div class="field"><label>${T.phone}</label><input id="mPhone" value="${esc(e.phone)}"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal()">${T.cancel}</button>
      <button class="btn btn-gold" onclick="saveEmployee('${id || ''}')">${T.save}</button>
    </div>`);
}

async function saveEmployee(id) {
  const obj = { name: $('mName').value.trim(), role: $('mRole').value.trim(), salary: Number($('mSalary').value || 0), phone: $('mPhone').value.trim() };
  if (!obj.name) return;
  if (id) Object.assign(DB.employees.find(x => x.id === id), obj);
  else DB.employees.push({ id: uid('e'), ...obj });
  await persist(); closeModal(); renderAll(); toast(T.saved);
}

async function delEmployee(id) {
  if (!confirm(T.confirmDelete)) return;
  DB.employees = DB.employees.filter(e => e.id !== id);
  await persist(); renderAll();
}

async function paySalary(id) {
  const e = DB.employees.find(x => x.id === id);
  if (!e || !confirm(`${T.paySalary}: ${e.name} — ${fmt(e.salary)} ${cur()} ?`)) return;
  DB.expenses.push({ id: uid('ex'), desc: `${T.salaryOf} ${e.name}`, amount: e.salary, date: new Date().toISOString(), category: 'راتب', employeeId: e.id });
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
      <div class="field"><label>${T.percent}</label><input id="mPercent" type="number" step="0.01" value="${sh.percent}"></div>
      <div class="field"><label>${T.capital}</label><input id="mCapital" type="number" value="${sh.capital}"></div>
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
  await persist(); closeModal(); renderAll();
  const total = DB.shareholders.reduce((s, x) => s + Number(x.percent || 0), 0);
  toast(total > 100 ? T.percentWarn : T.saved);
}

async function delShareholder(id) {
  if (!confirm(T.confirmDelete)) return;
  DB.shareholders = DB.shareholders.filter(s => s.id !== id);
  DB.withdrawals = DB.withdrawals.filter(w => w.shareholderId !== id);
  await persist(); renderAll();
}

function openWithdrawalModal(shareholderId) {
  const sh = DB.shareholders.find(x => x.id === shareholderId);
  if (!sh) return;
  openModal(`<h3>${T.addWithdrawal} — ${esc(sh.name)}</h3>
    <div class="field"><label>${T.amount}</label><input id="mWAmount" type="number"></div>
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
  await persist(); closeModal(); renderAll(); toast(T.saved);
}

async function delWallet(id) {
  if (!confirm(T.confirmDelete)) return;
  DB.wallets = DB.wallets.filter(w => w.id !== id);
  DB.walletTx = DB.walletTx.filter(t => t.walletId !== id && t.toWalletId !== id);
  await persist(); renderAll();
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
    <div class="field"><label>${T.amount}</label><input id="mTxAmount" type="number"></div>
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
  const tx = { id: uid('wt'), walletId, type, amount, note: $('mTxNote').value.trim(), date: new Date().toISOString() };
  if (type === 'transfer') tx.toWalletId = $('mToWallet').value;
  DB.walletTx.push(tx);
  await persist(); closeModal(); renderAll(); toast(T.saved);
}

async function delWalletTx(id) {
  if (!confirm(T.confirmDelete)) return;
  DB.walletTx = DB.walletTx.filter(t => t.id !== id);
  await persist(); renderAll();
}

// ---------- المصاريف ----------
function renderExpenses() {
  const rows = DB.expenses.slice().reverse();
  $('expTable').innerHTML = `<thead><tr><th>${T.description}</th><th>${T.amount}</th><th>${T.date}</th><th>${T.actions}</th></tr></thead><tbody>` +
    (rows.length ? rows.map(e => `<tr>
      <td>${esc(e.desc)}</td><td><span class="badge warn">${fmt(e.amount)} ${cur()}</span></td><td>${e.date.slice(0, 10)}</td>
      <td><button class="btn btn-danger btn-sm" onclick="delExpense('${e.id}')">${T.delete}</button></td>
    </tr>`).join('') : `<tr><td colspan="4" class="empty">${T.noData}</td></tr>`) + '</tbody>';
}

function openExpenseModal() {
  openModal(`<h3>${T.addExpense}</h3>
    <div class="field"><label>${T.description}</label><input id="mDesc"></div>
    <div class="field"><label>${T.amount}</label><input id="mAmount" type="number"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal()">${T.cancel}</button>
      <button class="btn btn-gold" onclick="saveExpense()">${T.save}</button>
    </div>`);
}

async function saveExpense() {
  const desc = $('mDesc').value.trim(), amount = Number($('mAmount').value || 0);
  if (!desc || !amount) return;
  DB.expenses.push({ id: uid('ex'), desc, amount, date: new Date().toISOString() });
  await persist(); closeModal(); renderAll(); toast(T.saved);
}

async function delExpense(id) {
  if (!confirm(T.confirmDelete)) return;
  DB.expenses = DB.expenses.filter(e => e.id !== id);
  await persist(); renderAll();
}

// ---------- التقارير ----------
function renderReports() {
  const f = financials();
  $('repCards').innerHTML = `
    <div class="card"><div class="c-label">${T.totalSales}</div><div class="c-value">${fmt(f.totalSales)}</div><div class="c-sub">${cur()}</div></div>
    <div class="card"><div class="c-label">${T.cogs}</div><div class="c-value">${fmt(f.totalCogs)}</div><div class="c-sub">${cur()}</div></div>
    <div class="card"><div class="c-label">${T.grossProfit}</div><div class="c-value">${fmt(f.grossProfit)}</div><div class="c-sub">${cur()}</div></div>
    <div class="card"><div class="c-label">${T.expenses}</div><div class="c-value">${fmt(f.totalExpenses)}</div><div class="c-sub">${cur()}</div></div>
    <div class="card emerald"><div class="c-label">${T.netProfit}</div><div class="c-value">${fmt(f.netProfit)}</div><div class="c-sub">${cur()}</div></div>`;

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

async function sendChat() {
  const inp = $('chatInput');
  const text = inp.value.trim();
  if (!text) return;
  inp.value = '';
  addMsg(text, 'user');
  const think = addMsg(T.aiThinking, 'bot thinking');
  const res = await bridge.askAI(text, chatHistory.slice(-8));
  think.remove();
  if (res.ok) {
    addMsg(res.text, 'bot');
    chatHistory.push({ role: 'user', content: text }, { role: 'assistant', content: res.text });
  } else {
    addMsg('⚠️ ' + T.aiOffline, 'bot');
  }
}

async function checkAI() {
  const r = await bridge.checkAI();
  $('aiDot').className = 'dot' + (r.ok ? ' on' : '');
  $('aiStatus').textContent = r.ok ? T.aiOnline : T.aiOffline;
  fillModelSelect(r.ok ? r.models : []);
}

function fillModelSelect(models) {
  const sel = $('setModelSelect');
  if (!sel) return;
  const current = DB.settings.aiModel || 'qwen2:latest';
  const list = models && models.length ? models : (current ? [current] : []);
  sel.innerHTML = list.map(m => `<option value="${esc(m)}" ${m === current ? 'selected' : ''}>${esc(m)}</option>`).join('')
    + `<option value="__custom__" ${!list.includes(current) ? 'selected' : ''}>${T.customModel}</option>`;
  onModelSelectChange();
}

function onModelSelectChange() {
  const isCustom = $('setModelSelect').value === '__custom__';
  $('setModel').style.display = isCustom ? 'block' : 'none';
  if (!isCustom) $('setModel').value = $('setModelSelect').value;
}

// ---------- تلجرام ----------
async function startBot() {
  const token = $('tgToken').value.trim();
  if (!token) return;
  $('tgState').textContent = '...';
  const r = await bridge.tgStart(token);
  if (r.ok) {
    DB.settings.telegramToken = token; await persist();
    $('tgState').textContent = `${T.tgRunning} — @${r.name}`;
    $('tgState').className = 'badge';
    toast(T.tgRunning);
  } else {
    $('tgState').textContent = '⚠️ ' + (r.error || ''); $('tgState').className = 'badge low';
  }
}

async function stopBot() {
  await bridge.tgStop();
  $('tgState').textContent = T.tgStopped; $('tgState').className = 'badge warn';
}

// ---------- الإعدادات ----------
function fillSettings() {
  $('setLang').value = DB.settings.lang;
  $('setCurrency').value = DB.settings.currency;
  $('setBiz').value = DB.settings.businessName;
  $('setModel').value = DB.settings.aiModel || 'qwen2:latest';
  fillModelSelect([]);
  $('setKey').value = DB.settings.anthropicKey || '';
  $('tgToken').value = DB.settings.telegramToken || '';
  $('tgState').textContent = T.tgStopped;
  $('setAuthEnabled').checked = !!(DB.settings.auth && DB.settings.auth.enabled);
  $('setUsername').value = (DB.settings.auth && DB.settings.auth.username) || 'admin';
  $('setNewPass').value = '';
  const co = DB.settings.company || {};
  $('setAddress').value = co.address || '';
  $('setPhone').value = co.phone || '';
  $('setRC').value = co.rc || '';
  $('setTaxId').value = co.taxId || '';
  $('setCompanyNotes').value = co.notes || '';
  updateLogoPreview(co.logoDataUrl || '');
  const nf = DB.settings.notifications || {};
  $('setNotifLowStock').checked = nf.lowStock !== false;
  $('setNotifWeekly').checked = nf.weeklyReport !== false;
}

async function saveSettings() {
  DB.settings.lang = $('setLang').value;
  DB.settings.currency = $('setCurrency').value.trim() || 'MRU';
  DB.settings.businessName = $('setBiz').value.trim() || 'سند';
  DB.settings.aiModel = $('setModel').value.trim() || 'qwen2:latest';
  DB.settings.anthropicKey = $('setKey').value.trim();
  DB.settings.company = {
    address: $('setAddress').value.trim(), phone: $('setPhone').value.trim(),
    rc: $('setRC').value.trim(), taxId: $('setTaxId').value.trim(),
    notes: $('setCompanyNotes').value.trim(), logoDataUrl: (DB.settings.company && DB.settings.company.logoDataUrl) || ''
  };
  DB.settings.notifications = { ...DB.settings.notifications, lowStock: $('setNotifLowStock').checked, weeklyReport: $('setNotifWeekly').checked };
  await persist(); applyLang(); renderAll(); checkAI(); toast(T.saved);
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
  renderInvoices(); renderPurchases(); renderDebts(); renderEmployees();
  renderShareholders(); renderWallets(); renderExpenses(); renderReports();
}

async function startApp() {
  renderAll();
  checkAI();
  setInterval(checkAI, 30000);
  checkWeeklyReportNotif();
  addMsg(T.aiWelcome, 'bot');
  bridge.onTgStatus(s => {
    if (s.running && !s.error) { $('tgState').textContent = T.tgRunning; $('tgState').className = 'badge'; }
  });
  if (DB.settings.telegramToken && window.sened) {
    bridge.tgStart(DB.settings.telegramToken).then(r => {
      if (r.ok) { $('tgState').textContent = `${T.tgRunning} — @${r.name}`; $('tgState').className = 'badge'; }
    });
  }
}

(async function init() {
  DB = await bridge.loadData();
  applyLang();
  applyTheme();
  fillSettings();
  initParticles();

  if (DB.settings.auth && DB.settings.auth.enabled) {
    $('loginUser').value = DB.settings.auth.username || '';
    $('loginScreen').classList.add('open');
  } else {
    $('appShell').classList.remove('hidden');
    await startApp();
  }
  setTimeout(() => $('preloader').classList.add('hidden'), 1200);
})();
