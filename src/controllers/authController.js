import jwt from "jsonwebtoken";
import * as User from "../models/user.js";
import * as Setting from "../models/setting.js";
import db, { initUserDefaults } from "../db.js";
import { logWarn } from "../utils/logger.js";
import {
  sendPasswordResetCodeEmail,
  sendNewUserRegisteredEmail,
} from "../services/emailService.js";
import { isValidEmail } from "../utils/validation.js";

export const login = async (req, res) => {
  const { username, password } = req.body;

  try {
    const user = await User.findByUsername(username);
    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials",
      });
    }

    const isMatch = await User.comparePassword(password, user.password);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials",
      });
    }

    // Best-effort: registrar el último login. Si falla, no bloqueamos el login.
    try {
      await User.updateLastLogin(user.id);
    } catch (err) {
      console.warn("Could not update lastLoginAt:", err.message);
    }

    const token = jwt.sign(
      {
        id: user.id,
        username: user.username,
        role: user.role,
        slug: user.slug,
        paidAt: user.paidAt ?? null,
      },
      process.env.JWT_SECRET,
      { expiresIn: "24h" }
    );

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        slug: user.slug,
        paidAt: user.paidAt ?? null,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error during login",
    });
  }
};

export const register = async (req, res) => {
  const { username, email, password, estimatedGuests } = req.body;

  if (!username || !password) {
    return res.status(400).json({
      success: false,
      message: "Username and password are required",
    });
  }

  if (password.length < 8) {
    return res.status(400).json({
      success: false,
      message: "Password must be at least 8 characters",
    });
  }

  try {
    // Verificar si el username ya existe
    const existing = await User.findByUsername(username);
    if (existing) {
      return res.status(409).json({
        success: false,
        message: "Username already taken",
      });
    }

    // Generar slug único basado en username
    const baseSlug = username
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

    // Asegurar unicidad del slug
    let slug = baseSlug;
    let suffix = 1;
    while (await User.findBySlug(slug)) {
      slug = `${baseSlug}-${suffix++}`;
    }

    const newUser = await User.createUser({ username, email, password, slug });

    // Inicializar settings y categorías por defecto
    await initUserDefaults(newUser.id);

    if (
      estimatedGuests !== undefined &&
      estimatedGuests !== null &&
      estimatedGuests !== ""
    ) {
      const parsed = parseInt(estimatedGuests, 10);
      if (!Number.isNaN(parsed) && parsed >= 0) {
        await Setting.updateSetting(
          "total_estimated_guests",
          String(parsed),
          newUser.id,
        );
      }
    }

    const token = jwt.sign(
      {
        id: newUser.id,
        username: newUser.username,
        role: newUser.role,
        slug: newUser.slug,
        paidAt: null,
      },
      process.env.JWT_SECRET,
      { expiresIn: "24h" }
    );

    // Aviso al admin (fire-and-forget): nunca debe impedir el alta.
    sendNewUserRegisteredEmail({
      newUsername: newUser.username,
      newUserEmail: newUser.email,
      newUserSlug: newUser.slug,
      newUserId: newUser.id,
    }).catch((emailErr) => {
      console.warn(
        "[auth] No se pudo notificar al admin del nuevo registro:",
        emailErr?.message ?? emailErr,
      );
    });

    res.status(201).json({
      success: true,
      token,
      user: {
        id: newUser.id,
        username: newUser.username,
        email: newUser.email,
        role: newUser.role,
        slug: newUser.slug,
        paidAt: null,
      },
    });
  } catch (error) {
    console.error("Register error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error during registration",
    });
  }
};

/**
 * Comprueba si un nombre de usuario está disponible para registro.
 *
 * Consideraciones de seguridad:
 *   - La respuesta es SIEMPRE genérica (`{ available: boolean }`).
 *     No se distingue entre "taken", "reserved" o "invalid_format":
 *     el frontend no debe poder inferir si un usuario concreto existe
 *     a partir del cuerpo de la respuesta. (Tampoco desde la latencia:
 *     el middleware `withConstantLatency` iguala los tiempos.)
 *   - Si el formato es inválido, devolvemos `available: false` igual que
 *     si ya existiera, para que ambas situaciones sean indistinguibles.
 *   - Logging mínimo para auditoría sin filtrar PII al log.
 */
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
const RESERVED_USERNAMES = new Set(["admin"]);

export const checkUsername = async (req, res) => {
  const raw =
    typeof req.query.username === "string" ? req.query.username.trim() : "";

  if (!raw) {
    return res.status(400).json({
      success: false,
      available: false,
      message: "Username is required",
    });
  }

  // Formato inválido o username reservado: no revelamos el motivo,
  // solo decimos "no disponible".
  const formatOk = USERNAME_RE.test(raw);
  const notReserved = !RESERVED_USERNAMES.has(raw.toLowerCase());

  if (!formatOk || !notReserved) {
    return res.status(200).json({
      success: true,
      available: false,
    });
  }

  try {
    const existing = await User.findByUsername(raw);
    const available = !existing;

    // Log de eventos de seguridad: intentos de username reservado o
    // parecidos a "admin" se monitorizan por separado.
    if (existing && raw.toLowerCase().includes("admin")) {
      logWarn(
        `[security] check-username hit for near-admin username "${raw}" from ${req.ip}`,
      );
    }

    return res.status(200).json({
      success: true,
      available,
    });
  } catch (error) {
    console.error("checkUsername error:", error);
    return res.status(500).json({
      success: false,
      available: false,
      message: "Internal server error",
    });
  }
};

export const me = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    res.json({ success: true, user });
  } catch (error) {
    console.error("Me error:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

export const changePassword = async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({
      success: false,
      message: "currentPassword and newPassword are required",
    });
  }

  if (newPassword.length < 8) {
    return res.status(400).json({
      success: false,
      message: "New password must be at least 8 characters",
    });
  }

  try {
    const user = await User.findByUsername(req.user.username);
    const isMatch = await User.comparePassword(currentPassword, user.password);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: "Current password is incorrect",
      });
    }

    await User.updatePassword(req.user.id, newPassword);
    res.json({ success: true, message: "Password updated successfully" });
  } catch (error) {
    console.error("changePassword error:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

/**
 * Actualiza campos editables del propio usuario (email por ahora).
 *
 * Seguridad: para evitar que un JWT robado modifique el email sin
 * verificación, exigimos `currentPassword` (igual que `changePassword`).
 * El email puede establecerse a `null` (vacío) para borrarlo, lo que
 * impedirá el flujo de recuperación por código en el futuro.
 */
export const updateMe = async (req, res) => {
  const { email, currentPassword } = req.body || {};

  if (typeof email !== "string") {
    return res.status(400).json({
      success: false,
      message: "El email es obligatorio y debe ser una cadena de texto.",
    });
  }

  if (!currentPassword || typeof currentPassword !== "string") {
    return res.status(400).json({
      success: false,
      message:
        "Debes confirmar tu contraseña actual para modificar el email.",
    });
  }

  const trimmedEmail = email.trim();

  if (trimmedEmail && !isValidEmail(trimmedEmail)) {
    return res.status(400).json({
      success: false,
      message: "El formato del email no es válido.",
    });
  }

  if (trimmedEmail.length > 255) {
    return res.status(400).json({
      success: false,
      message: "El email es demasiado largo (máximo 255 caracteres).",
    });
  }

  try {
    // Re-leemos por username para tener la columna `password` (no incluida
    // en PUBLIC_USER_COLUMNS).
    const user = await User.findByUsername(req.user.username);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "Usuario no encontrado.",
      });
    }

    const isMatch = await User.comparePassword(currentPassword, user.password);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: "La contraseña actual es incorrecta.",
      });
    }

    const newEmail = trimmedEmail === "" ? null : trimmedEmail;
    const currentEmail = user.email || null;

    if (currentEmail === newEmail) {
      return res.json({
        success: true,
        message: "El email no ha cambiado.",
        data: {
          id: user.id,
          username: user.username,
          email: newEmail,
          role: user.role,
          slug: user.slug,
        },
      });
    }

    const updatedUser = await User.updateUser(req.user.id, { email: newEmail });

    // Invalidamos cualquier código de reset pendiente: si el email cambió,
    // un código enviado al email antiguo ya no es válido.
    await db.run(
      "UPDATE password_reset_codes SET used = 1 WHERE userId = ? AND used = 0",
      [user.id],
    );

    console.log(
      `✉️ Email actualizado para usuario id=${user.id}: '${currentEmail}' → '${newEmail ?? "(vacío)"}'`,
    );

    return res.json({
      success: true,
      message: newEmail
        ? "Email actualizado correctamente."
        : "Email eliminado correctamente.",
      data: updatedUser,
    });
  } catch (error) {
    console.error("updateMe error:", error);
    return res.status(500).json({
      success: false,
      message: "Error interno al actualizar el email.",
    });
  }
};

const maskEmail = (email) => {
  if (!email || !email.includes("@")) return email || "";
  const [local, domain] = email.split("@");
  if (local.length <= 2) return `${local[0]}***@${domain}`;
  return `${local[0]}${local[1]}***${local[local.length - 1]}@${domain}`;
};

export const requestResetCode = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "Usuario no encontrado",
      });
    }

    if (!user.email) {
      return res.status(400).json({
        success: false,
        message:
          "Tu cuenta no tiene un correo electrónico configurado para recibir el código.",
      });
    }

    // Invalida códigos previos pendientes del usuario
    await db.run(
      "UPDATE password_reset_codes SET used = 1 WHERE userId = ? AND used = 0",
      [user.id],
    );

    // Generar código de 6 dígitos numéricos
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    await db.run(
      "INSERT INTO password_reset_codes (userId, code, expiresAt, used) VALUES (?, ?, ?, 0)",
      [user.id, code, expiresAt],
    );

    console.log(
      `🔑 Código de restablecimiento generado para ${user.username} (${user.email}): ${code}`,
    );

    // Envío asíncrono del correo
    await sendPasswordResetCodeEmail({
      to: user.email,
      username: user.username,
      code,
    });

    const responsePayload = {
      success: true,
      message: `Código de verificación enviado a ${maskEmail(user.email)}.`,
    };

    if (process.env.NODE_ENV !== "production") {
      responsePayload.code = code;
    }

    return res.json(responsePayload);
  } catch (error) {
    console.error("requestResetCode error:", error);
    return res.status(500).json({
      success: false,
      message: "Error al generar el código de recuperación",
    });
  }
};

export const resetPasswordWithCode = async (req, res) => {
  const { code, newPassword } = req.body;

  if (!code || typeof code !== "string" || !code.trim()) {
    return res.status(400).json({
      success: false,
      message: "El código de verificación es obligatorio",
    });
  }

  if (
    !newPassword ||
    typeof newPassword !== "string" ||
    newPassword.length < 8
  ) {
    return res.status(400).json({
      success: false,
      message: "La nueva contraseña debe tener al menos 8 caracteres",
    });
  }

  const cleanCode = code.trim();

  try {
    const resetRecord = await db.get(
      `SELECT * FROM password_reset_codes 
       WHERE userId = ? AND used = 0 
       ORDER BY id DESC LIMIT 1`,
      [req.user.id],
    );

    if (!resetRecord) {
      return res.status(400).json({
        success: false,
        message:
          "No hay ninguna solicitud activa. Solicita un nuevo código.",
      });
    }

    const now = new Date();
    const expiryDate = new Date(resetRecord.expiresAt);

    if (now > expiryDate) {
      await db.run(
        "UPDATE password_reset_codes SET used = 1 WHERE id = ?",
        [resetRecord.id],
      );
      return res.status(400).json({
        success: false,
        message: "El código ha expirado. Por favor, solicita uno nuevo.",
      });
    }

    if (resetRecord.code !== cleanCode) {
      return res.status(400).json({
        success: false,
        message: "El código de verificación es incorrecto.",
      });
    }

    // Código válido: marcar como usado
    await db.run(
      "UPDATE password_reset_codes SET used = 1 WHERE id = ?",
      [resetRecord.id],
    );

    // Actualizar la contraseña del usuario
    await User.updatePassword(req.user.id, newPassword);

    console.log(
      `✅ Contraseña restablecida con éxito para usuario id=${req.user.id}`,
    );

    return res.json({
      success: true,
      message: "Contraseña actualizada correctamente.",
    });
  } catch (error) {
    console.error("resetPasswordWithCode error:", error);
    return res.status(500).json({
      success: false,
      message: "Error interno al restablecer la contraseña",
    });
  }
};

