// Smoke test del servicio de descuentos. NO toca la DB: solo
// verifica las funciones puras (applyDiscountToAmount) y los
// mensajes de error. Pensado para correr con `node` directamente.

import { applyDiscountToAmount, validateDiscountCode } from '../src/services/discountService.js';

let pass = 0;
let fail = 0;

function check(name, expected, actual) {
  const ok = JSON.stringify(expected) === JSON.stringify(actual);
  if (ok) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name}\n   expected: ${JSON.stringify(expected)}\n   actual:   ${JSON.stringify(actual)}`);
  }
}

// ── applyDiscountToAmount (puro) ─────────────────────────────────
check(
  'applyDiscount: 5900 cents @ 10% → savings 590, final 5310',
  { original: 5900, percent: 10, savings: 590, final: 5310 },
  applyDiscountToAmount(5900, 10),
);

check(
  'applyDiscount: 5900 cents @ 25% → savings 1475, final 4425',
  { original: 5900, percent: 25, savings: 1475, final: 4425 },
  applyDiscountToAmount(5900, 25),
);

check(
  'applyDiscount: 5900 cents @ 100% → final 0',
  { original: 5900, percent: 100, savings: 5900, final: 0 },
  applyDiscountToAmount(5900, 100),
);

check(
  'applyDiscount: 5900 cents @ 0% → sin descuento',
  { original: 5900, percent: 0, savings: 0, final: 5900 },
  applyDiscountToAmount(5900, 0),
);

check(
  'applyDiscount: redondeo HALF_UP (999 @ 33% → 330 savings)',
  { original: 999, percent: 33, savings: 330, final: 669 },
  applyDiscountToAmount(999, 33),
);

check(
  'applyDiscount: amount negativo se trata como 0',
  { original: 0, percent: 50, savings: 0, final: 0 },
  applyDiscountToAmount(-100, 50),
);

check(
  'applyDiscount: percent > 100 se clampa a 100',
  { original: 5900, percent: 100, savings: 5900, final: 0 },
  applyDiscountToAmount(5900, 200),
);

// ── validateDiscountCode sin DB ──────────────────────────────────
// (Los casos `not_found`, `inactive`, `expired` los cubre la integración
// end-to-end con la DB; aquí validamos solo el caso `empty` que no
// necesita tocar la tabla.)
const empty = await validateDiscountCode('', 5900);
check('validate: empty → reason "empty"', { valid: false, reason: 'empty' }, empty);

const ws = await validateDiscountCode('   ', 5900);
check('validate: solo espacios → reason "empty"', { valid: false, reason: 'empty' }, ws);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);