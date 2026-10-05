// Test end-to-end con DB: cubrimos todos los caminos del flujo de
// validación de códigos contra la tabla `discount_codes` real.
// Pensado para correr con `node` directamente.

import * as DiscountCode from '../src/models/discountCode.js';
import { validateDiscountCode } from '../src/services/discountService.js';
import db, { initializationPromise } from '../src/db.js';

// Esperar a que `db.js` termine su `initializeTables()` antes de tocar
// tablas. Sin esto, los INSERT compiten con el `CREATE TABLE` y
// fallan con "no such table".
await initializationPromise;

let pass = 0;
let fail = 0;
const testCodes = [];

function check(name, expected, actual) {
  const ok = JSON.stringify(expected) === JSON.stringify(actual);
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}\n   expected: ${JSON.stringify(expected)}\n   actual:   ${JSON.stringify(actual)}`); }
}

async function cleanup() {
  for (const code of testCodes) {
    try { await db.run('DELETE FROM discount_codes WHERE code = ?', [code]); } catch {}
  }
}

async function insertCode(code, opts = {}) {
  testCodes.push(code);
  await db.run(
    `INSERT INTO discount_codes (code, percent, active, description, expiresAt)
     VALUES (?, ?, ?, ?, ?)`,
    [
      code,
      opts.percent ?? 10,
      opts.active ?? 1,
      opts.description ?? null,
      opts.expiresAt ?? null,
    ],
  );
}

try {
  // ── 1. create() valida formato y rango ────────────────────────
  try {
    await DiscountCode.create({ code: '', percent: 10 });
    check('create: rechaza code vacío', true, false);
  } catch (e) {
    check('create: rechaza code vacío', true, /código/i.test(e.message));
  }

  try {
    await DiscountCode.create({ code: 'A', percent: 10 });
    check('create: rechaza code muy corto', true, false);
  } catch (e) {
    check('create: rechaza code muy corto', true, /código/i.test(e.message));
  }

  try {
    await DiscountCode.create({ code: 'TEST', percent: 0 });
    check('create: rechaza percent 0', true, false);
  } catch (e) {
    check('create: rechaza percent 0', true, /porcentaje/i.test(e.message));
  }

  try {
    await DiscountCode.create({ code: 'TEST', percent: 101 });
    check('create: rechaza percent > 100', true, false);
  } catch (e) {
    check('create: rechaza percent > 100', true, /porcentaje/i.test(e.message));
  }

  // ── 2. happy path: código activo y sin expirar ────────────────
  await insertCode('BODAS10', { percent: 30, description: 'Promo lanzamiento' });
  const valid = await validateDiscountCode('bodas10', 5900);
  check('validate: BODAS10 @ 30% sobre 5900',
    {
      valid: true,
      code: 'BODAS10',
      percent: 30,
      description: 'Promo lanzamiento',
      expiresAt: null,
      original: 5900,
      savings: 1770,
      final: 4130,
    },
    valid,
  );

  // Mayúsculas del input: el servicio normaliza
  const lower2 = await validateDiscountCode('bodas10', 5900);
  // (verifica que el segundo también devuelve `valid:true`)
  check('validate: lowercase también es válido', true, lower2.valid === true);

  // ── 3. código inactivo ───────────────────────────────────────
  await insertCode('OLDCODE', { percent: 50, active: 0 });
  const inactive = await validateDiscountCode('OLDCODE', 5900);
  check('validate: código inactivo', { valid: false, reason: 'inactive' }, inactive);

  // ── 4. código expirado ───────────────────────────────────────
  await insertCode('EXPIRED', {
    percent: 50,
    expiresAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
  });
  const expired = await validateDiscountCode('EXPIRED', 5900);
  check('validate: código expirado', { valid: false, reason: 'expired' }, expired);

  // ── 5. código no existente ───────────────────────────────────
  const notFound = await validateDiscountCode('NOEXISTE', 5900);
  check('validate: código inexistente', { valid: false, reason: 'not_found' }, notFound);

  // ── 6. código activo sin expirar (futuro) ────────────────────
  await insertCode('FUTURE', {
    percent: 15,
    expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
  });
  const future = await validateDiscountCode('FUTURE', 5900);
  check('validate: código futuro es válido', true, future.valid === true);
  check('validate: código futuro % correcto', 15, future.percent);

  // ── 7. duplicate code: UNIQUE constraint ──────────────────────
  // Verificamos el comportamiento indirectamente: contamos filas
  // antes y después de un intento de INSERT duplicado. Si la UNIQUE
  // constraint funciona, el segundo INSERT falla y el conteo no
  // cambia. (Tocamos `db.run` directo en vez de `DiscountCode.create`
  // para no contaminar el resultado con la lógica de validación.)
  const before = await DiscountCode.listAll();
  let dupError = null;
  try {
    await db.run(
      `INSERT INTO discount_codes (code, percent) VALUES (?, ?)`,
      ['BODAS10', 99],
    );
  } catch (e) {
    dupError = e;
  }
  const after = await DiscountCode.listAll();
  check(
    'UNIQUE: el segundo INSERT con code repetido falla con SQLITE_CONSTRAINT',
    true,
    dupError !== null && /UNIQUE/i.test(String(dupError.message)),
  );
  check(
    'UNIQUE: el conteo de filas NO aumenta',
    before.length,
    after.length,
  );

  // ── 8. update: cambiar percent ───────────────────────────────
  await insertCode('UPDATE_ME', { percent: 5 });
  const updated = await DiscountCode.update(
    (await DiscountCode.findByCode('UPDATE_ME')).id,
    { percent: 50 },
  );
  check('update: percent actualizado', 50, updated.percent);

  // ── 9. listAll: devuelve los activos e inactivos ─────────────
  const list = await DiscountCode.listAll();
  check('listAll: al menos 5 códigos (5 insertados)', true, list.length >= 5);

  // ── 10. remove ────────────────────────────────────────────────
  await insertCode('REMOVE_ME', { percent: 10 });
  const toRemove = await DiscountCode.findByCode('REMOVE_ME');
  await DiscountCode.remove(toRemove.id);
  const removed = await DiscountCode.findByCode('REMOVE_ME');
  check('remove: borrado deja null', null, removed);

  console.log(`\n${pass} pass, ${fail} fail`);
  await cleanup();
  process.exit(fail > 0 ? 1 : 0);
} catch (err) {
  console.error('Test crashed:', err);
  await cleanup();
  process.exit(2);
}