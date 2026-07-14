// أداة أدمن بسيطة لإدارة المؤسسات (الأكواد) على الخادم السحابي.
// الاستخدام:
//   node admin.js add "اسم المؤسسة"     → ينشئ مؤسسة ويطبع كودها (سلّمه للمدير)
//   node admin.js list                   → يعرض كل المؤسسات
//   node admin.js disable <code>         → يعطّل مؤسسة (يمنع الاتصال دون حذف بياناتها)
//   node admin.js enable  <code>         → يعيد تفعيلها
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const db = require('./db');

// كود مؤسسة طويل وعشوائي (مفتاح + سرّ). حروف/أرقام واضحة، بلا التباس (بلا 0/O/1/I/l).
function genCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(24);
  let out = '';
  for (let i = 0; i < 24; i++) out += alphabet[bytes[i] % alphabet.length];
  // مجزّأ للقراءة: SNED-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX
  return 'SNED-' + out.match(/.{1,4}/g).join('-');
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'add') {
      const name = rest.join(' ').trim();
      const code = genCode();
      await db.createTenant(code, name || null);
      console.log('\n✅ تم إنشاء المؤسسة:');
      console.log('   الاسم:', name || '(بلا اسم)');
      console.log('   الكود:', code);
      console.log('\n👉 سلّم هذا الكود لمدير المؤسسة ليدخله في كل جهاز.\n');
    } else if (cmd === 'list') {
      const r = await db.pool.query('SELECT code, name, rev, active, created_at FROM tenants ORDER BY created_at');
      if (!r.rows.length) console.log('لا توجد مؤسسات بعد.');
      for (const t of r.rows) {
        console.log(`${t.active ? '🟢' : '🔴'}  ${t.code}  |  ${t.name || '(بلا اسم)'}  |  rev=${t.rev}  |  ${new Date(t.created_at).toISOString().slice(0, 10)}`);
      }
    } else if (cmd === 'disable' || cmd === 'enable') {
      const code = rest[0];
      if (!code) { console.error('حدّد الكود: node admin.js ' + cmd + ' <code>'); process.exit(1); }
      const r = await db.pool.query('UPDATE tenants SET active=$1 WHERE code=$2', [cmd === 'enable', code]);
      console.log(r.rowCount ? `تم ${cmd === 'enable' ? 'تفعيل' : 'تعطيل'} ${code}` : 'لم يُعثر على الكود.');
    } else {
      console.log('الأوامر: add "اسم" | list | disable <code> | enable <code>');
    }
  } catch (e) {
    console.error('خطأ:', e.message);
    process.exitCode = 1;
  } finally {
    await db.pool.end();
  }
}

main();
