-- مخطّط قاعدة PostgreSQL لخادم سند السحابي المركزي (متعدّد المؤسسات)
-- التشغيل: psql "$DATABASE_URL" -f schema.sql   أو   npm run schema

-- المؤسسات: كل صف = عميل/مؤسسة له كود خاص وبياناته معزولة عن غيره
CREATE TABLE IF NOT EXISTS tenants (
  code       TEXT PRIMARY KEY,                     -- كود المؤسسة (طويل عشوائي = مفتاح وسرّ)
  name       TEXT,                                 -- اسم المؤسسة (عرض إداري فقط)
  rev        BIGINT      NOT NULL DEFAULT 0,       -- رقم مراجعة المؤسسة (يقود التزامن)
  active     BOOLEAN     NOT NULL DEFAULT true,    -- تعطيل مؤسسة دون حذف بياناتها
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- كل السجلات لكل المؤسسات، معزولة بعمود tenant. البنية تطابق جدول records المحلي في التطبيق.
CREATE TABLE IF NOT EXISTS records (
  tenant     TEXT        NOT NULL REFERENCES tenants(code) ON DELETE CASCADE,
  collection TEXT        NOT NULL,                 -- products/customers/invoices/… أو '_kv'
  id         TEXT        NOT NULL,                 -- معرّف السجل (أو 'settings'/'counters' لـ _kv)
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted    BOOLEAN     NOT NULL DEFAULT false,   -- الحذف شاهدة (كي ينتشر للأجهزة)
  data       JSONB,                                -- محتوى السجل (JSONB — قوة PostgreSQL)
  PRIMARY KEY (tenant, collection, id)
);

CREATE INDEX IF NOT EXISTS records_tenant_idx     ON records (tenant);
CREATE INDEX IF NOT EXISTS records_tenant_col_idx ON records (tenant, collection);
