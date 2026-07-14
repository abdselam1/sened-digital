// طبقة الوصول لـ PostgreSQL — تجمّع الاتصال + مساعدات المؤسسات والسجلات.
// كل الدوال هنا غير متزامنة (async) لأن مكتبة pg غير متزامنة (بخلاف better-sqlite3 المحلية).
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // بعض المزوّدات السحابية تفرض SSL — فعّله بـ PGSSL=1
  ssl: process.env.PGSSL === '1' ? { rejectUnauthorized: false } : undefined,
  max: Number(process.env.PG_POOL_MAX) || 10
});

// نفس مجموعات السجلات في التطبيق (main.js: RECORD_COLLECTIONS) — لتجميع مستند كامل مطابق.
const RECORD_COLLECTIONS = ['products', 'customers', 'invoices', 'expenses', 'quotes',
  'purchases', 'suppliers', 'employees', 'shareholders', 'withdrawals',
  'wallets', 'walletTx', 'auditLog', 'trash', 'returns'];
const KV_COLLECTION = '_kv';

async function runSchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('schema applied');
}

// ---- المؤسسات ----
async function getTenant(code) {
  if (!code) return null;
  const r = await pool.query('SELECT code, name, rev, active FROM tenants WHERE code=$1', [code]);
  return r.rows[0] || null;
}
async function createTenant(code, name) {
  await pool.query('INSERT INTO tenants(code, name) VALUES($1, $2)', [code, name || null]);
  return { code, name, rev: 0, active: true };
}

// ---- تجميع المستند الكامل لمؤسسة (يطابق شكل getDoc في التطبيق) ----
async function getDoc(tenant) {
  const doc = { settings: {}, counters: {} };
  for (const col of RECORD_COLLECTIONS) doc[col] = [];
  // ترتيب rowid الأصلي = ctid هنا (ترتيب الإدراج) لمطابقة سلوك التطبيق قدر الإمكان
  const r = await pool.query(
    `SELECT collection, id, data FROM records
     WHERE tenant=$1 AND deleted=false ORDER BY ctid`, [tenant]);
  for (const row of r.rows) {
    if (row.collection === KV_COLLECTION) {
      if (row.id === 'settings') doc.settings = row.data || {};
      else if (row.id === 'counters') doc.counters = row.data || {};
      continue;
    }
    if (!doc[row.collection]) doc[row.collection] = [];
    doc[row.collection].push(row.data);
  }
  const byDateDesc = (f) => (a, b) => String((b && b[f]) || '').localeCompare(String((a && a[f]) || ''));
  doc.auditLog.sort(byDateDesc('date'));
  doc.trash.sort(byDateDesc('deletedAt'));
  const t = await getTenant(tenant);
  doc._rev = t ? Number(t.rev) : 0;
  doc._ts = new Date().toISOString();
  return doc;
}

// ---- تطبيق قائمة تغييرات على مؤسسة (معاملة واحدة) ----
// التغيير: {col, id, data|null}. data=null حذفٌ (شاهدة). العدّادات تُدمج بالأكبر.
// يعيد { applied:[...], rev } — applied = ما بدّل شيئاً فعلاً (لبثّه فقط).
async function applyChanges(tenant, changes) {
  changes = Array.isArray(changes) ? changes : [];
  const client = await pool.connect();
  const applied = [];
  try {
    await client.query('BEGIN');
    for (const ch of changes) {
      if (!ch || !ch.col || ch.id === undefined || ch.id === null) continue;
      const col = String(ch.col), id = String(ch.id);

      // العدّادات لا تتراجع أبداً: ادمج بالأكبر لكل مفتاح (يمنع تكرار أرقام الفواتير)
      if (col === KV_COLLECTION && id === 'counters' && ch.data && typeof ch.data === 'object') {
        const cur = await client.query(
          'SELECT data FROM records WHERE tenant=$1 AND collection=$2 AND id=$3', [tenant, col, id]);
        const prev = (cur.rows[0] && cur.rows[0].data) || {};
        const merged = { ...prev };
        for (const k of Object.keys(ch.data)) merged[k] = Math.max(Number(prev[k]) || 0, Number(ch.data[k]) || 0);
        await client.query(
          `INSERT INTO records(tenant,collection,id,updated_at,deleted,data)
           VALUES($1,$2,$3,now(),false,$4)
           ON CONFLICT(tenant,collection,id) DO UPDATE SET updated_at=now(), deleted=false, data=$4`,
          [tenant, col, id, merged]);
        applied.push({ col, id, data: merged });
        continue;
      }

      if (ch.data === null || ch.data === undefined) {
        // حذف = شاهدة (deleted=true, data=null) — فقط إن كان السجل موجوداً وحيّاً
        const r = await client.query(
          `UPDATE records SET deleted=true, data=NULL, updated_at=now()
           WHERE tenant=$1 AND collection=$2 AND id=$3 AND deleted=false`, [tenant, col, id]);
        if (r.rowCount) applied.push({ col, id, data: null });
      } else {
        const r = await client.query(
          `INSERT INTO records(tenant,collection,id,updated_at,deleted,data)
           VALUES($1,$2,$3,now(),false,$4)
           ON CONFLICT(tenant,collection,id)
           DO UPDATE SET updated_at=now(), deleted=false, data=$4
           WHERE records.data IS DISTINCT FROM EXCLUDED.data OR records.deleted=true`,
          [tenant, col, id, ch.data]);
        if (r.rowCount) applied.push({ col, id, data: ch.data });
      }
    }
    let rev;
    if (applied.length) {
      const r = await client.query('UPDATE tenants SET rev = rev + 1 WHERE code=$1 RETURNING rev', [tenant]);
      rev = Number(r.rows[0].rev);
    } else {
      const r = await client.query('SELECT rev FROM tenants WHERE code=$1', [tenant]);
      rev = Number((r.rows[0] && r.rows[0].rev) || 0);
    }
    await client.query('COMMIT');
    return { applied, rev };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// يحوّل مستنداً كاملاً (من عميل قديم قبل 1.1.0) إلى قائمة تغييرات، بالمقارنة مع حالة المؤسسة.
async function diffDocToChanges(tenant, doc) {
  if (!doc || typeof doc !== 'object') return [];
  const current = await getDoc(tenant);
  const changes = [];
  const cols = new Set(RECORD_COLLECTIONS);
  for (const k of Object.keys(doc)) if (Array.isArray(doc[k])) cols.add(k);
  for (const col of cols) {
    const arr = Array.isArray(doc[col]) ? doc[col] : [];
    const curMap = new Map((current[col] || []).map((x) => [String(x && x.id), JSON.stringify(x)]));
    const seen = new Set();
    for (const item of arr) {
      if (!item || typeof item !== 'object' || item.id === undefined) continue;
      const id = String(item.id);
      seen.add(id);
      if (curMap.get(id) !== JSON.stringify(item)) changes.push({ col, id, data: item });
    }
    for (const id of curMap.keys()) if (!seen.has(id)) changes.push({ col, id, data: null });
  }
  if (JSON.stringify(doc.settings || {}) !== JSON.stringify(current.settings || {}))
    changes.push({ col: KV_COLLECTION, id: 'settings', data: doc.settings || {} });
  if (JSON.stringify(doc.counters || {}) !== JSON.stringify(current.counters || {}))
    changes.push({ col: KV_COLLECTION, id: 'counters', data: doc.counters || {} });
  return changes;
}

module.exports = {
  pool, runSchema, getTenant, createTenant, getDoc, applyChanges, diffDocToChanges,
  RECORD_COLLECTIONS, KV_COLLECTION
};
