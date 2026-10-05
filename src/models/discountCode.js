import db from "../db.js";

/**
 * Modelo para la tabla `discount_codes`.
 *
 * Códigos de descuento para el Plan Pareja Completo. Cada fila
 * representa un cupón (porcentaje entre 1 y 100) con su estado
 * (`active`), una expiración opcional y una descripción libre.
 *
 * Notas:
 *  - `code` SIEMPRE en MAYÚSCULAS y sin espacios. El servicio
 *    (`discountService`) normaliza antes de consultar.
 *  - `expiresAt = NULL` significa que no expira.
 *  - No hay FK a `users`: los códigos son globales.
 */

export const normalizeCode = (raw) => {
  if (typeof raw !== "string") return "";
  return raw.trim().toUpperCase();
};

/**
 * Busca un código activo y vigente (no expirado). Devuelve `null`
 * si no existe, está inactivo o ha expirado.
 *
 * IMPORTANTE: el `code` ya debe estar normalizado (MAYÚSCULAS).
 * Usa `normalizeCode()` antes de llamar si viene del exterior.
 */
export const findActiveByCode = async (code) => {
  const normalized = normalizeCode(code);
  if (!normalized) return null;

  const candidate = await db.get(
    "SELECT * FROM discount_codes WHERE code = ?",
    [normalized],
  );
  if (!candidate) return null;
  if (candidate.active !== 1) return null;

  // expiresAt puede ser NULL (sin expiración) o un ISO datetime.
  if (candidate.expiresAt) {
    const expiry = new Date(candidate.expiresAt);
    if (Number.isFinite(expiry.getTime()) && expiry.getTime() < Date.now()) {
      return null;
    }
  }

  return candidate;
};

/** Devuelve el código sin chequear vigencia (uso interno/admin). */
export const findByCode = async (code) => {
  const normalized = normalizeCode(code);
  if (!normalized) return null;
  // `db.get` devuelve `undefined` cuando no hay fila; lo
  // normalizamos a `null` para que el caller pueda usar `=== null`
  // sin sorpresas (consistente con `findActiveByCode`).
  const row = await db.get("SELECT * FROM discount_codes WHERE code = ?", [
    normalized,
  ]);
  return row ?? null;
};

/** Lista todos los códigos (admin). Más recientes primero. */
export const listAll = async () => {
  return await db.all(
    `SELECT id, code, percent, active, description, expiresAt, createdAt, updatedAt
       FROM discount_codes
      ORDER BY createdAt DESC`,
  );
};

/**
 * Crea un código nuevo. Valida formato y rango antes de tocar la DB.
 * Lanza con `Error` si algo no cuadra (el caller decide HTTP 400).
 */
export const create = async ({ code, percent, description = null, expiresAt = null }) => {
  const normalized = normalizeCode(code);
  if (!normalized) throw new Error("El código no puede estar vacío.");
  if (!/^[A-Z0-9_-]{2,40}$/.test(normalized)) {
    throw new Error(
      "El código solo puede tener letras, números, guiones y subrayados (2-40).",
    );
  }
  const pct = Number(percent);
  if (!Number.isInteger(pct) || pct <= 0 || pct > 100) {
    throw new Error("El porcentaje debe ser un entero entre 1 y 100.");
  }

  const result = await db.run(
    `INSERT INTO discount_codes (code, percent, active, description, expiresAt)
     VALUES (?, ?, 1, ?, ?)`,
    [normalized, pct, description, expiresAt],
  );
  return { id: result.lastID, code: normalized, percent: pct, active: 1 };
};

export const update = async (id, { percent, active, description, expiresAt }) => {
  const updates = [];
  const params = [];
  if (percent !== undefined) {
    const pct = Number(percent);
    if (!Number.isInteger(pct) || pct <= 0 || pct > 100) {
      throw new Error("El porcentaje debe ser un entero entre 1 y 100.");
    }
    updates.push("percent = ?");
    params.push(pct);
  }
  if (active !== undefined) {
    updates.push("active = ?");
    params.push(active ? 1 : 0);
  }
  if (description !== undefined) {
    updates.push("description = ?");
    params.push(description);
  }
  if (expiresAt !== undefined) {
    updates.push("expiresAt = ?");
    params.push(expiresAt);
  }
  if (updates.length === 0) return await findById(id);

  updates.push("updatedAt = CURRENT_TIMESTAMP");
  params.push(id);
  await db.run(
    `UPDATE discount_codes SET ${updates.join(", ")} WHERE id = ?`,
    params,
  );
  return await findById(id);
};

export const findById = async (id) => {
  const row = await db.get("SELECT * FROM discount_codes WHERE id = ?", [id]);
  return row ?? null;
};

export const remove = async (id) => {
  await db.run("DELETE FROM discount_codes WHERE id = ?", [id]);
};