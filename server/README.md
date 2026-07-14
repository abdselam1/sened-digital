# خادم سند السحابي المركزي (PostgreSQL)

خادم تزامن **متعدّد المؤسسات** لتطبيق «سند». يتكلّم نفس بروتوكول «المضيف» في التطبيق
(`/ping`, `/sync`, `/events`)، لكنه على الإنترنت، مدعوم بـ PostgreSQL، ويعزل بيانات كل
مؤسسة حسب **كودها**. راجع `../PLAN-CLOUD-POSTGRES.md` للتصميم الكامل.

## المكوّنات
| الملف | الدور |
|------|------|
| `index.js` | خادم Express: نقاط `/ping /sync /events`، مصادقة بكود المؤسسة، بثّ SSE معزول لكل مؤسسة. |
| `db.js` | طبقة PostgreSQL: تجميع المستند، تطبيق التغييرات (دمج العدّادات + حذف شاهدة)، المؤسسات. |
| `schema.sql` | جدولا `tenants` و `records` (JSONB). |
| `admin.js` | إنشاء/عرض/تعطيل أكواد المؤسسات. |
| `.env.example` | نموذج الإعداد. |

## التشغيل محلياً (للتجربة)
```bash
cd server
npm install
cp .env.example .env         # ثم عدّل DATABASE_URL
npm run schema               # ينشئ الجداول
node admin.js add "مؤسسة تجريبية"   # يطبع كود المؤسسة — انسخه
npm start                    # الخادم يعمل على PORT (افتراضياً 3050)
```

### فحص سريع بلا التطبيق
```bash
# استبدل CODE بكود المؤسسة الذي طبعه admin.js
curl -H "x-sened-token: CODE" http://localhost:3050/ping
curl -H "x-sened-token: CODE" http://localhost:3050/sync
curl -H "x-sened-token: CODE" -H "Content-Type: application/json" \
     -d '{"changes":[{"col":"customers","id":"c1","data":{"id":"c1","name":"زبون تجريبي"}}]}' \
     http://localhost:3050/sync
curl -H "x-sened-token: CODE" http://localhost:3050/sync   # يجب أن يظهر الزبون
```

## النشر على الإنترنت (إنتاج)
1. خادم Linux (VPS) + نطاق (مثلاً `sync.yourdomain.com`).
2. ثبّت PostgreSQL، أنشئ قاعدة، اضبط `DATABASE_URL` في `.env` (وفعّل `PGSSL=1` إن لزم).
3. `npm install && npm run schema`.
4. شغّل الخادم دائماً عبر `pm2` أو `systemd`.
5. ضع **Caddy** أو **Nginx** أمامه ليضيف **HTTPS** على المنفذ 443 (شرط أساسي — التطبيق يجب أن يتصل عبر https).
6. لكل مؤسسة جديدة: `node admin.js add "اسم المؤسسة"` → سلّم الكود لمديرها.

## ملاحظات أمان
- كود المؤسسة = مفتاح وسرّ معاً؛ لا تنشره. من يملكه يصل لبيانات المؤسسة.
- استخدم HTTPS دائماً في الإنتاج (وإلا سافر الكود والبيانات بنصّ صريح).
- `.env` لا يُرفع إلى GitHub (مذكور في `.gitignore`).
- كل مؤسسة معزولة تماماً: الاستعلامات كلها مقيّدة بـ `tenant`.

## الحالة
أساس عامل ومطابق للبروتوكول. الناقص (يُنفَّذ مع المالك):
- تغييرات جهة التطبيق لتوجيهه لهذا الخادم عبر https + شاشة إدخال الكود (البند 5 في الخطة).
- تحسينات إنتاجية اختيارية: تحديد معدّل الطلبات (rate-limit)، سجلّات، نسخ احتياطي دوري لـ PostgreSQL.
