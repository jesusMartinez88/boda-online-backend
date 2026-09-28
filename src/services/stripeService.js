/**
 * Servicio de Stripe.
 *
 * Inicialización perezosa: si no hay STRIPE_SECRET_KEY configurada,
 * el servicio queda deshabilitado y los endpoints de pago devolverán
 * 503 para que el frontend sepa que el modo demo sigue activo.
 *
 * Patrón idéntico a `emailService.js` / `whatsappService.js`.
 */

import Stripe from "stripe";

let stripeClient = null;
let stripeEnabled = false;
let lastInitError = null;

export const initializeStripeService = () => {
  const apiKey = process.env.STRIPE_SECRET_KEY;

  if (!apiKey) {
    console.warn(
      "⚠️ STRIPE_SECRET_KEY not configured. Payment endpoints will be disabled (demo mode).",
    );
    stripeEnabled = false;
    stripeClient = null;
    return null;
  }

  try {
    stripeClient = new Stripe(apiKey, {
      // Fijamos la versión de la API para que upgrades de SDK no rompan
      // payloads firmados por el webhook. Revisar al actualizar.
      apiVersion: "2024-06-20",
      typescript: false,
    });
    stripeEnabled = true;
    console.log("✅ Stripe payment service ready");
    return stripeClient;
  } catch (error) {
    lastInitError = error;
    console.error("❌ Stripe service error:", error.message);
    stripeEnabled = false;
    stripeClient = null;
    return null;
  }
};

export const getStripeClient = () => {
  if (!stripeEnabled || !stripeClient) return null;
  return stripeClient;
};

export const isStripeEnabled = () => stripeEnabled;

export const getPublishableKey = () => {
  const key = process.env.STRIPE_PUBLISHABLE_KEY;
  return key && key.length > 0 ? key : null;
};

/** Importe del "Plan Pareja Completo" en céntimos (59,00 EUR = 5900). */
export const getPaymentAmountCents = () => {
  const raw = process.env.PAYMENT_AMOUNT_CENTS;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return 5900;
};

export const getPaymentCurrency = () => {
  const cur = process.env.PAYMENT_CURRENCY;
  if (cur && /^[a-z]{3}$/i.test(cur)) return cur.toLowerCase();
  return "eur";
};

export const getPaymentDescription = () => {
  return (
    process.env.PAYMENT_DESCRIPTION ||
    "BodasOnline · Plan Pareja Completo (pago único)"
  );
};

export const getStripeInitError = () => lastInitError;