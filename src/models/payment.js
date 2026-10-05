import db from "../db.js";

/**
 * Modelo para la tabla `payments`.
 *
 * Una fila representa un PaymentIntent de Stripe asociado a un usuario.
 * El `status` se sincroniza con Stripe vía el webhook
 * (`payment_intent.succeeded`, `payment_intent.payment_failed`, etc.).
 *
 * Solo guardamos metadatos no sensibles (importe, moneda, método,
 * referencia al PaymentIntent de Stripe). El PCI DSS se delega a Stripe:
 * nunca almacenamos PAN, CVC ni datos de tarjeta.
 */

export const createPayment = async ({
  userId,
  stripePaymentIntentId,
  amount,
  currency,
  status,
  paymentMethod = null,
  clientSecret = null,
  originalAmount = null,
  discountCode = null,
  discountPercent = null,
}) => {
  const result = await db.run(
    `INSERT INTO payments
       (userId, stripePaymentIntentId, amount, currency, status,
        paymentMethod, clientSecret,
        originalAmount, discountCode, discountPercent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      stripePaymentIntentId,
      amount,
      currency,
      status,
      paymentMethod,
      clientSecret,
      originalAmount,
      discountCode,
      discountPercent,
    ],
  );
  return { id: result.lastID, userId, stripePaymentIntentId, status };
};

export const findByPaymentIntentId = async (stripePaymentIntentId) => {
  return await db.get(
    "SELECT * FROM payments WHERE stripePaymentIntentId = ?",
    [stripePaymentIntentId],
  );
};

export const updateStatusByIntentId = async (
  stripePaymentIntentId,
  { status, paymentMethod = null },
) => {
  await db.run(
    `UPDATE payments
       SET status = ?,
           paymentMethod = COALESCE(?, paymentMethod),
           updatedAt = CURRENT_TIMESTAMP
     WHERE stripePaymentIntentId = ?`,
    [status, paymentMethod, stripePaymentIntentId],
  );
};

export const listByUserId = async (userId) => {
  return await db.all(
    `SELECT id, userId, stripePaymentIntentId, amount, currency, status,
            paymentMethod, originalAmount, discountCode, discountPercent,
            createdAt, updatedAt
       FROM payments
      WHERE userId = ?
      ORDER BY createdAt DESC`,
    [userId],
  );
};