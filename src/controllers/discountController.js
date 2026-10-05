import * as DiscountCode from "../models/discountCode.js";
import {
  validateDiscountCode,
  applyDiscountToAmount,
} from "../services/discountService.js";
import {
  getPaymentAmountCents,
  getPaymentCurrency,
} from "../services/stripeService.js";
import { logError } from "../utils/logger.js";

/**
 * POST /api/payments/validate-discount
 *
 * Body: `{ code: string, amountCents?: number }`
 *
 * Endpoint pensado para que el frontend muestre el descuento al
 * usuario ANTES de crear el PaymentIntent. Si el usuario no envía
 * `amountCents`, usamos el precio base configurado en
 * `getPaymentAmountCents()`.
 *
 * Respuestas:
 *  - 200 con `{ success: true, valid: true, ... }` si es válido.
 *  - 200 con `{ success: true, valid: false, reason }` si no lo es
 *    (rechazo no es un 4xx porque es un input esperado, no un error).
 *  - 400 si falta `code`.
 *  - 500 si la DB falla.
 *
 * Auth: requiere JWT (es un usuario identificado; no filtramos
 * información de cupones a anónimos). El admin usa los endpoints
 * específicos de `/api/admin/discount-codes`.
 */
export const validate = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const body = req.body ?? {};
    const rawCode = body.code;
    const requestedAmount = Number(body.amountCents);
    const baseAmountCents =
      Number.isFinite(requestedAmount) && requestedAmount > 0
        ? Math.round(requestedAmount)
        : getPaymentAmountCents();

    if (typeof rawCode !== "string" || rawCode.trim() === "") {
      return res.status(400).json({
        success: false,
        message: "Falta el código de descuento.",
      });
    }

    const result = await validateDiscountCode(rawCode, baseAmountCents);

    if (!result.valid) {
      // Devolvemos 200 con `valid:false` para que el frontend
      // pueda mostrar el mensaje sin tratar el caso como error
      // de transporte. `reason` es internal (para logs/admin).
      return res.json({
        success: true,
        valid: false,
        reason: result.reason,
        message:
          "El código no es válido, está inactivo o ha expirado. Compruébalo e inténtalo de nuevo.",
      });
    }

    return res.json({
      success: true,
      valid: true,
      code: result.code,
      percent: result.percent,
      description: result.description,
      expiresAt: result.expiresAt,
      currency: getPaymentCurrency(),
      originalAmountCents: result.original,
      savingsCents: result.savings,
      finalAmountCents: result.final,
    });
  } catch (err) {
    logError("[discount] validate failed", err);
    return res.status(500).json({
      success: false,
      message: "No pudimos comprobar el código. Inténtalo de nuevo.",
    });
  }
};

// ───────────────────────── ADMIN CRUD ─────────────────────────

/**
 * GET /api/admin/discount-codes
 * Lista todos los códigos (activos y desactivados).
 */
export const list = async (req, res) => {
  try {
    const rows = await DiscountCode.listAll();
    return res.json({ success: true, codes: rows });
  } catch (err) {
    logError("[discount] list failed", err);
    return res.status(500).json({ success: false, message: "Error al listar." });
  }
};

/**
 * POST /api/admin/discount-codes
 * Body: `{ code, percent, description?, expiresAt? }`
 */
export const create = async (req, res) => {
  try {
    const { code, percent, description = null, expiresAt = null } = req.body ?? {};
    const created = await DiscountCode.create({ code, percent, description, expiresAt });
    return res.json({ success: true, code: created });
  } catch (err) {
    if (
      err.message?.includes("UNIQUE") ||
      err.message?.toLowerCase().includes("unique")
    ) {
      return res.status(409).json({
        success: false,
        message: "Ya existe un código con ese texto.",
      });
    }
    if (
      err.message?.includes("porcentaje") ||
      err.message?.includes("código")
    ) {
      return res.status(400).json({ success: false, message: err.message });
    }
    logError("[discount] create failed", err);
    return res.status(500).json({ success: false, message: "Error al crear." });
  }
};

/**
 * PATCH /api/admin/discount-codes/:id
 * Body: `{ percent?, active?, description?, expiresAt? }`
 * Todos los campos son opcionales; solo se aplican los enviados.
 */
export const update = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: "ID inválido." });
    }
    const updated = await DiscountCode.update(id, req.body ?? {});
    if (!updated) {
      return res
        .status(404)
        .json({ success: false, message: "Código no encontrado." });
    }
    return res.json({ success: true, code: updated });
  } catch (err) {
    if (
      err.message?.includes("porcentaje") ||
      err.message?.includes("código")
    ) {
      return res.status(400).json({ success: false, message: err.message });
    }
    logError("[discount] update failed", err);
    return res.status(500).json({ success: false, message: "Error al actualizar." });
  }
};

/**
 * DELETE /api/admin/discount-codes/:id
 */
export const remove = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: "ID inválido." });
    }
    await DiscountCode.remove(id);
    return res.json({ success: true });
  } catch (err) {
    logError("[discount] remove failed", err);
    return res.status(500).json({ success: false, message: "Error al eliminar." });
  }
};

/**
 * Helper exportado para uso desde `paymentController.createIntent`.
 * No es una ruta, es una función que aplica la misma validación
 * que `/validate-discount` pero sin tocar `req/res`.
 */
export const resolveDiscountForPayment = async (rawCode, baseAmountCents) => {
  return await validateDiscountCode(rawCode, baseAmountCents);
};

/** Re-export para el frontend si lo necesita (admin). */
export { applyDiscountToAmount };