/**
 * Servicio de códigos de descuento.
 *
 * Validación pura: dado un código y un importe base, devuelve
 * `{ valid: true, ... }` con los detalles del descuento aplicable,
 * o `{ valid: false, reason }` explicando por qué no se aplica.
 *
 * Sin inicialización perezosa: este servicio no conecta a ningún
 * sistema externo (la DB ya está inicializada en `db.js`). Se
 * mantiene el patrón `initialize*` por simetría con `stripeService`
 * y `emailService` para dejar la puerta abierta a un init
 * asíncrono futuro (caché, precarga, etc.) sin cambiar callers.
 *
 * IMPORTANTE: el `originalAmount` SIEMPRE va en céntimos (entero).
 * Devolvemos importes también en céntimos para evitar sorpresas de
 * punto flotante; el frontend los formatea en su locale.
 */

import * as DiscountCode from "../models/discountCode.js";

let initialized = false;

export const initializeDiscountService = () => {
  initialized = true;
  return true;
};

/** Para tests / health-check. */
export const isDiscountServiceReady = () => initialized;

/**
 * Aplica un porcentaje de descuento sobre un importe en céntimos.
 *
 * - `amountCents >= 0` (no aceptamos importes negativos).
 * - `percent` entre 1 y 100.
 * - Redondeo: HALF_UP al céntimo más cercano (importe final
 *   siempre entero; Stripe rechaza fracciones de céntimo).
 *
 * @returns {Object} `{ original, percent, savings, final }` en céntimos.
 */
export const applyDiscountToAmount = (amountCents, percent) => {
  const base = Math.max(0, Math.round(Number(amountCents) || 0));
  const pct = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  const savings = Math.round((base * pct) / 100);
  const finalAmount = base - savings;
  return {
    original: base,
    percent: pct,
    savings,
    final: finalAmount,
  };
};

/**
 * Valida un código contra la DB y calcula el descuento sobre
 * `baseAmountCents`. No lanza: el caller decide qué status HTTP
 * mandar según `valid` + `reason`.
 *
 * Razones de rechazo (orden de precedencia):
 *  - `empty`       → no llegó nada en el body.
 *  - `not_found`   → no existe en la tabla.
 *  - `inactive`    → existe pero `active = 0`.
 *  - `expired`     → existe y está activo pero `expiresAt < now`.
 *
 * Si `valid` es `true`, devuelve `code`, `description`, `percent`,
 * `expiresAt`, `original`, `savings` y `final` (todo en céntimos).
 */
export const validateDiscountCode = async (rawCode, baseAmountCents) => {
  const code = typeof rawCode === "string" ? rawCode.trim() : "";
  if (!code) {
    return { valid: false, reason: "empty" };
  }

  // Normalizamos a MAYÚSCULAS para que `BODAS10` y `bodas10` sean
  // el mismo cupón (la columna `code` está guardada en MAYÚSCULAS).
  const normalized = code.toUpperCase();

  // Buscamos primero el código en crudo (sin filtrar por vigencia)
  // para distinguir las 3 razones de rechazo y devolver mensajes
  // útiles al admin sin filtrar info al usuario (la UI muestra
  // un único mensaje genérico al usuario final).
  const raw = await DiscountCode.findByCode(normalized);
  if (!raw) return { valid: false, reason: "not_found" };
  if (raw.active !== 1) return { valid: false, reason: "inactive" };
  if (
    raw.expiresAt &&
    new Date(raw.expiresAt).getTime() < Date.now()
  ) {
    return { valid: false, reason: "expired" };
  }

  const calc = applyDiscountToAmount(baseAmountCents, raw.percent);
  return {
    valid: true,
    code: raw.code,
    percent: raw.percent,
    description: raw.description ?? null,
    expiresAt: raw.expiresAt ?? null,
    ...calc,
  };
};