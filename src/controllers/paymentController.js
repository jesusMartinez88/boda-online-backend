import * as Payment from "../models/payment.js";
import * as User from "../models/user.js";
import {
  getStripeClient,
  isStripeEnabled,
  getPublishableKey,
  getPaymentAmountCents,
  getPaymentCurrency,
  getPaymentDescription,
} from "../services/stripeService.js";
import { resolveDiscountForPayment } from "./discountController.js";
import { sendPaymentReceivedEmail } from "../services/emailService.js";
import { logError, logWarn } from "../utils/logger.js";

/**
 * GET /api/payments/config
 *
 * Devuelve la publishable key y flags de habilitación para que el
 * frontend sepa si debe mostrar el checkout real o el modo demo.
 *
 * Público (sin JWT) para que el `PaymentService` la pueda leer
 * antes incluso de que el usuario haya iniciado sesión. No expone
 * nada sensible: la clave publishable está diseñada para vivir en
 * el navegador.
 */
export const getConfig = async (req, res) => {
  res.json({
    success: true,
    enabled: isStripeEnabled(),
    publishableKey: getPublishableKey(),
    amount: getPaymentAmountCents(),
    currency: getPaymentCurrency(),
    description: getPaymentDescription(),
  });
};

/**
 * POST /api/payments/create-intent
 *
 * Crea un PaymentIntent de Stripe para el usuario autenticado.
 * Devuelve `clientSecret` para que el frontend monte el
 * Payment Element.
 *
 * Si ya existe un intent "abierto" (requires_payment_method /
 * requires_confirmation / requires_action) para este usuario, lo
 * reutilizamos para evitar acumular intents basura en Stripe.
 */
export const createIntent = async (req, res) => {
  if (!isStripeEnabled()) {
    return res.status(503).json({
      success: false,
      message:
        "El pago no está configurado en este momento. Inténtalo más tarde.",
    });
  }

  const stripe = getStripeClient();
  const userId = req.user?.id;
  const username = req.user?.username;

  if (!userId) {
    return res.status(401).json({
      success: false,
      message: "Usuario no autenticado.",
    });
  }

  const baseAmount = getPaymentAmountCents();
  const currency = getPaymentCurrency();
  const description = getPaymentDescription();

  // ── Validación opcional del código de descuento ─────────────────
  // El frontend manda el código tal cual lo escribió el usuario. La
  // validación SIEMPRE se hace en backend (no fiarnos del cliente).
  // Si viene vacío, simplemente no hay descuento.
  const body = req.body ?? {};
  const rawCode = typeof body.discountCode === "string" ? body.discountCode : "";
  const discountResult = rawCode
    ? await resolveDiscountForPayment(rawCode, baseAmount)
    : { valid: false, reason: "empty" };

  if (!discountResult.valid && rawCode) {
    // El usuario mandó un código que no es válido → no creamos el
    // intent. Devolvemos 200 + `valid:false` para que la UI pueda
    // mostrar el error sin tratar el caso como error de transporte.
    return res.json({
      success: true,
      valid: false,
      reason: discountResult.reason,
      message:
        "El código de descuento no es válido, está inactivo o ha expirado.",
    });
  }

  const appliedDiscount = discountResult.valid
    ? {
        code: discountResult.code,
        percent: discountResult.percent,
        originalAmountCents: discountResult.original,
        savingsCents: discountResult.savings,
        finalAmountCents: discountResult.final,
      }
    : null;

  const amount = appliedDiscount ? appliedDiscount.finalAmountCents : baseAmount;

  try {
    // Reutilizar un intent pendiente reciente del mismo usuario SOLO
    // cuando no hay código de descuento aplicado. Si hay código,
    // siempre creamos uno nuevo para que el importe cobrado refleje
    // exactamente el descuento actual (evitamos reutilizar un intent
    // antiguo con un importe que ya no corresponde).
    let reusable = null;
    if (!appliedDiscount) {
      const recent = await Payment.listByUserId(userId);
      reusable = recent.find(
        (p) =>
          p.status === "requires_payment_method" ||
          p.status === "requires_confirmation" ||
          p.status === "requires_action",
      );

      if (reusable) {
        try {
          const live = await stripe.paymentIntents.retrieve(
            reusable.stripePaymentIntentId,
          );
          if (
            live &&
            live.client_secret &&
            (live.status === "requires_payment_method" ||
              live.status === "requires_confirmation" ||
              live.status === "requires_action")
          ) {
            return res.json({
              success: true,
              clientSecret: live.client_secret,
              paymentIntentId: live.id,
              amount: live.amount,
              currency: live.currency,
              originalAmountCents: appliedDiscount?.originalAmountCents ?? baseAmount,
              discount: appliedDiscount,
              reused: true,
            });
          }
        } catch (retrieveErr) {
          // Si no se puede recuperar (intent borrado, etc.) seguimos y
          // creamos uno nuevo. No es bloqueante.
          logWarn(
            `[payment] No se pudo reutilizar el intent ${reusable.stripePaymentIntentId}: ${retrieveErr.message}`,
          );
        }
      }
    }

    const intent = await stripe.paymentIntents.create({
      amount,
      currency,
      description,
      // Solo tarjeta por ahora. PayPal se añadirá cuando se habilite
      // como payment method en el dashboard de Stripe (es un cambio
      // de una línea + activación en producción).
      payment_method_types: ["card"],
      metadata: {
        userId: String(userId),
        username: username || "",
        source: "register",
        // Guardamos el código en metadata para que el webhook pueda
        // auditarlo aunque se haya borrado de la tabla `discount_codes`.
        discountCode: appliedDiscount?.code ?? "",
        discountPercent: appliedDiscount ? String(appliedDiscount.percent) : "",
      },
      automatic_payment_methods: { enabled: false },
    });

    await Payment.createPayment({
      userId,
      stripePaymentIntentId: intent.id,
      amount: intent.amount,
      currency: intent.currency,
      status: intent.status,
      paymentMethod: null,
      clientSecret: intent.client_secret,
      originalAmount: appliedDiscount?.originalAmountCents ?? null,
      discountCode: appliedDiscount?.code ?? null,
      discountPercent: appliedDiscount?.percent ?? null,
    });

    return res.json({
      success: true,
      valid: true,
      clientSecret: intent.client_secret,
      paymentIntentId: intent.id,
      amount: intent.amount,
      currency: intent.currency,
      originalAmountCents: appliedDiscount?.originalAmountCents ?? baseAmount,
      discount: appliedDiscount,
      reused: false,
    });
  } catch (error) {
    logError("Error creating Stripe PaymentIntent", error);
    return res.status(500).json({
      success: false,
      message: "No pudimos iniciar el pago. Inténtalo de nuevo.",
    });
  }
};

/**
 * POST /api/payments/create-checkout-session
 *
 * Crea una Stripe Checkout Session (UI mode `hosted_page`, flujo
 * "redirigir al cliente a la página de pago de Stripe") para el
 * usuario autenticado y devuelve la URL a la que el frontend debe
 * enviarlo con `window.location.href`.
 *
 * Esta ruta NO sustituye al flujo de PaymentIntents ya existente
 * (`POST /api/payments/create-intent`); ambos coexisten y comparten
 * el mismo cliente de Stripe (`stripeService.js`).
 *
 * Los parámetros de la sesión están definidos por el Checkout Studio
 * de Stripe (ver `STRIPE_INTEGRATION_TODO.md` en la raíz del repo):
 *   - `fixed_by_ui`: bloque superior, copiados literalmente.
 *   - `sample_only`: mode / line_items / success_url / cancel_url
 *     son placeholders que el usuario debe revisar antes de salir a
 *     producción.
 *
 * Notas:
 *  - El producto es un cargo único (Plan Pareja Completo), así que
 *    `mode = "payment"`. Por la regla "Only include
 *    `payment_method_collection` when mode is `"subscription"`"
 *    del task de integración, ese parámetro se omite en este flujo.
 *  - SDK Stripe `^22.6.2` ≥ 21.0.0 ⇒ `ui_mode: "hosted_page"`.
 */
export const createCheckoutSession = async (req, res) => {
  if (!isStripeEnabled()) {
    return res.status(503).json({
      success: false,
      message:
        "El pago no está configurado en este momento. Inténtalo más tarde.",
    });
  }

  const stripe = getStripeClient();
  const userId = req.user?.id;
  const username = req.user?.username;

  if (!userId) {
    return res.status(401).json({
      success: false,
      message: "Usuario no autenticado.",
    });
  }

  try {
    // Base pública del frontend. Preferimos `DOMAIN` si está definido
    // (dominio de producción); caemos a `ORIGIN_URL` (que el backend
    // ya usa para CORS) y, en última instancia, al dev server de Angular.
    const baseUrl =
      process.env.DOMAIN || process.env.ORIGIN_URL || "http://localhost:4200";

    const sessionParams = {
      // --- Parámetros configurados en Checkout Studio (fixed_by_ui) ---
      ui_mode: "hosted_page",
      billing_address_collection: "auto",
      phone_number_collection: { enabled: false },
      automatic_tax: { enabled: false },
      allow_promotion_codes: true,
      submit_type: "auto",
      integration_identifier: "hosted_web_0001",
      origin_context: "web",

      // --- Parámetros de muestra (sample_only) — ver TODO.md ---
      mode: "payment",
      line_items: [
        {
          price: "price_1UKfgDFmKdwVE0OEt16M0M4Z",
          quantity: 1,
        },
      ],
      success_url: `${baseUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/payment/cancel`,

      // --- Metadata para reconciliar el pago en el webhook ---
      metadata: {
        userId: String(userId),
        username: username || "",
        source: "register",
      },
    };

    const session = await stripe.checkout.sessions.create(sessionParams);

    return res.json({
      success: true,
      url: session.url,
      sessionId: session.id,
    });
  } catch (error) {
    logError("Error creating Stripe Checkout Session", error);
    return res.status(500).json({
      success: false,
      message: "No pudimos iniciar el pago. Inténtalo de nuevo.",
    });
  }
};

/**
 * GET /api/payments/me
 *
 * Devuelve el historial de pagos del usuario autenticado.
 * Útil para mostrar al usuario el estado de su suscripción
 * y para reintentar si el webhook se retrasó.
 */
export const listMine = async (req, res) => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  try {
    const payments = await Payment.listByUserId(userId);
    const user = await User.findById(userId);
    res.json({
      success: true,
      paid: !!user?.paidAt,
      paidAt: user?.paidAt ?? null,
      payments,
    });
  } catch (error) {
    logError("Error listing user payments", error);
    res
      .status(500)
      .json({ success: false, message: "Error al listar los pagos." });
  }
};

/**
 * POST /api/payments/webhook
 *
 * Endpoint público al que Stripe envía eventos (firma verificada).
 * Se monta con `express.json({ verify })` en `app.js` para tener
 * acceso al cuerpo crudo (`req.rawBody`) y validar la firma.
 *
 * Eventos que gestionamos:
 *   - payment_intent.succeeded         → marcamos paidAt + actualizamos status
 *   - payment_intent.processing        → actualizamos status
 *   - payment_intent.payment_failed    → actualizamos status (sin activar)
 *   - payment_intent.canceled          → actualizamos status
 */
export const webhook = async (req, res) => {
  if (!isStripeEnabled()) {
    return res.status(503).send("Stripe disabled");
  }

  const stripe = getStripeClient();
  const sig = req.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    logError(
      "[payment] STRIPE_WEBHOOK_SECRET not configured. Rejecting webhook.",
    );
    return res.status(500).send("Webhook misconfigured");
  }

  let event;
  try {
    // `req.rawBody` es un Buffer capturado por el middleware global
    // `express.json({ verify })` (necesitamos los bytes crudos para
    // validar la firma HMAC-SHA256 de Stripe).
    if (!Buffer.isBuffer(req.rawBody)) {
      throw new Error("Missing raw body for webhook verification");
    }
    event = stripe.webhooks.constructEvent(req.rawBody, sig, webhookSecret);
  } catch (err) {
    logError(`[payment] Webhook signature verification failed: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case "payment_intent.succeeded": {
        const intent = event.data.object;
        const userId = Number(intent.metadata?.userId);
        const method =
          intent.payment_method_types?.[0] ||
          intent.charges?.data?.[0]?.payment_method_details?.type ||
          null;

        await Payment.updateStatusByIntentId(intent.id, {
          status: intent.status,
          paymentMethod: method,
        });

        if (Number.isFinite(userId) && userId > 0) {
          const paidAtIso = new Date().toISOString();
          await User.updateUser(userId, { paidAt: paidAtIso });
          console.log(
            `✅ Pago confirmado para userId=${userId} (intent=${intent.id}, amount=${intent.amount} ${intent.currency})`,
          );

          // Email de confirmación al cliente. Fire-and-forget: si falla,
          // no rompemos el webhook. `paidAt` ya quedó marcado arriba.
          try {
            const user = await User.findById(userId);
            if (user?.email) {
              await sendPaymentReceivedEmail({
                to: user.email,
                username: user.username,
                amount: intent.amount,
                currency: intent.currency,
                paymentIntentId: intent.id,
              });
            } else {
              console.log(
                `[payment] Usuario ${userId} sin email: se omite el correo de confirmación.`,
              );
            }
          } catch (emailErr) {
            logError(
              "[payment] No se pudo enviar el email de pago recibido",
              emailErr,
            );
          }
        } else {
          logWarn(
            `[payment] payment_intent.succeeded sin userId en metadata (intent=${intent.id})`,
          );
        }
        break;
      }

      case "payment_intent.processing":
      case "payment_intent.canceled":
      case "payment_intent.payment_failed": {
        const intent = event.data.object;
        await Payment.updateStatusByIntentId(intent.id, {
          status: intent.status,
          paymentMethod:
            intent.payment_method_types?.[0] ||
            intent.charges?.data?.[0]?.payment_method_details?.type ||
            null,
        });
        break;
      }

      default:
        // Ignoramos silenciosamente el resto de eventos.
        break;
    }
  } catch (err) {
    logError(`[payment] Error handling webhook event ${event.type}`, err);
    // Devolvemos 200 igualmente: Stripe reintentará si devolvemos
    // error, pero el problema está en nuestra lógica, no en la entrega.
    // Lo logueamos y seguimos para evitar loops de reintento.
  }

  res.json({ received: true });
};
