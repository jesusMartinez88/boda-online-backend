import { Resend } from "resend";
import db from "../db.js";

let resend = null;
let emailEnabled = false;

/**
 * Inicializar el servicio de email con Resend
 */
export const initializeEmailService = () => {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    console.warn(
      "⚠️ RESEND_API_KEY not configured. Email functionality disabled.",
    );
    emailEnabled = false;
    return null;
  }

  try {
    resend = new Resend(apiKey);
    emailEnabled = true;
    console.log("✅ Resend email service ready");
    return resend;
  } catch (error) {
    console.error("❌ Email service error:", error.message);
    emailEnabled = false;
    return null;
  }
};

/**
 * Enviar email cuando se crea un nuevo invitado
 */
export const sendNewGuestEmail = async (
  guest,
  numAdults,
  numChildren,
  userId,
) => {
  if (!emailEnabled || !process.env.SEND_EMAIL_ON_GUEST_CREATE) {
    console.log("Email sending is disabled.");
    return null;
  }

  try {
    const invitationOwner = await db.get(
      "SELECT email FROM users WHERE id = ?",
      [userId],
    );
    const emailOwner = invitationOwner?.email;

    if (!emailOwner) {
      console.warn("Invitation owner email not configured");
      return null;
    }

    // Formatear datos del invitado
    const guestDetails = `
      <h3>Nuevo Invitado Registrado</h3>
      <table style="border-collapse: collapse; width: 100%; margin-top: 20px;">
        <tr style="background-color: #f0f0f0;">
          <td style="border: 1px solid #ddd; padding: 8px;"><strong>Nombre</strong></td>
          <td style="border: 1px solid #ddd; padding: 8px;">${guest.name}</td>
        </tr>
        <tr>
          <td style="border: 1px solid #ddd; padding: 8px;"><strong>Email</strong></td>
          <td style="border: 1px solid #ddd; padding: 8px;">📧 ${guest.email}</td>
        </tr>
        <tr style="background-color: #f0f0f0;">
          <td style="border: 1px solid #ddd; padding: 8px;"><strong>Teléfono</strong></td>
          <td style="border: 1px solid #ddd; padding: 8px;">📱 ${guest.phone || "No proporcionado"}</td>
        </tr>
        <tr>
          <td style="border: 1px solid #ddd; padding: 8px;"><strong>Asistencia</strong></td>
          <td style="border: 1px solid #ddd; padding: 8px;">${guest.attending ? "✅ Confirmado" : "❌ Rechazado"}</td>
        </tr>
        <tr>
          <td style="border: 1px solid #ddd; padding: 8px;"><strong>Adultos</strong></td>
          <td style="border: 1px solid #ddd; padding: 8px;">👨‍🦱 ${numAdults}</td>
        </tr>
        <tr>
          <td style="border: 1px solid #ddd; padding: 8px;"><strong>Niños</strong></td>
          <td style="border: 1px solid #ddd; padding: 8px;">👶 ${numChildren}</td>
        </tr>
        <tr style="background-color: #f0f0f0;">
          <td style="border: 1px solid #ddd; padding: 8px;"><strong>Tipo de Comida</strong></td>
          <td style="border: 1px solid #ddd; padding: 8px;">🥑 ${guest.mealType || "Normal"}</td>
        </tr>
        <tr>
          <td style="border: 1px solid #ddd; padding: 8px;"><strong>Necesita Autobús</strong></td>
          <td style="border: 1px solid #ddd; padding: 8px;">${guest.needsTransport ? "🚌 Sí" : "✖️ No"}</td>
        </tr>
        <tr style="background-color: #f0f0f0;">
          <td style="border: 1px solid #ddd; padding: 8px;"><strong>Alergias</strong></td>
          <td style="border: 1px solid #ddd; padding: 8px;">🤧 ${guest.allergies || "Ninguna"}</td>
        </tr>
        <tr>
          <td style="border: 1px solid #ddd; padding: 8px;"><strong>Notas</strong></td>
          <td style="border: 1px solid #ddd; padding: 8px;">🗒️ ${guest.notes || "Ninguna"}</td>
        </tr>
      </table>
    `;

    const result = await resend.emails.send({
      from: "Wedding API <onboarding@resend.dev>",
      to: emailOwner,
      subject: `🎉 Nuevo Invitado: ${guest.name}`,
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <style>
              body { font-family: Arial, sans-serif; }
              .container { max-width: 600px; margin: 0 auto; padding: 20px; }
              .header { background-color: #4CAF50; color: white; padding: 20px; border-radius: 5px; }
              .content { margin-top: 20px; }
              .footer { margin-top: 30px; font-size: 12px; color: #666; border-top: 1px solid #ddd; padding-top: 20px; }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="header">
                <h2>🎉 Boda - Nuevo Invitado Registrado</h2>
              </div>
              <div class="content">
                ${guestDetails}
              </div>
              <div class="footer">
                <p>Este es un email automático del sistema de gestión de invitados. No responder directamente.</p>
                <p>${new Date().toLocaleString("es-ES")}</p>
              </div>
            </div>
          </body>
        </html>
      `,
    });

    console.log("✉️ Email enviado:", emailOwner);
    return result;
  } catch (error) {
    console.error("Error sending email:", error.message);
    return null;
  }
};

/**
 * Enviar email de confirmación al invitado (opcional)
 */
export const sendGuestConfirmationEmail = async (guest) => {
  if (!emailEnabled) {
    return null;
  }

  try {
    const result = await resend.emails.send({
      from: "Wedding API <onboarding@resend.dev>",
      to: guest.email,
      subject: "🎉 ¡Confirmamos tu registro en la boda!",
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <style>
              body { font-family: Arial, sans-serif; }
              .container { max-width: 600px; margin: 0 auto; padding: 20px; }
              .header { background-color: #4CAF50; color: white; padding: 20px; border-radius: 5px; }
              .content { margin-top: 20px; line-height: 1.6; }
              .footer { margin-top: 30px; font-size: 12px; color: #666; border-top: 1px solid #ddd; padding-top: 20px; }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="header">
                <h2>🎉 ¡Bienvenido a la Boda!</h2>
              </div>
              <div class="content">
                <p>Hola <strong>${guest.name}</strong>,</p>
                <p>Gracias por registrarte en nuestra boda. Aquí está un resumen de tu registro:</p>
                <ul>
                  <li><strong>Email:</strong> ${guest.email}</li>
                  <li><strong>Asistencia:</strong> ${guest.attending ? "✅ Confirmado" : "❌ Rechazado"}</li>
                  <li><strong>Tipo de Comida:</strong> ${guest.mealType}</li>
                  <li><strong>Necesita Autobús:</strong> ${guest.needsTransport ? "🚌 Sí" : "✖️ No"}</li>
                  ${guest.allergies ? `<li><strong>Alergias:</strong> ${guest.allergies}</li>` : ""}
                </ul>
                <p>Si necesitas hacer cambios en tu registro, por favor contacta con nosotros.</p>
                <p>¡Nos vemos pronto!</p>
              </div>
              <div class="footer">
                <p>Este es un email automático. No responder directamente a este email.</p>
              </div>
            </div>
          </body>
        </html>
      `,
    });

    console.log("✉️ Confirmation email sent:", result.id);
    return result;
  } catch (error) {
    console.error("Error sending confirmation email:", error.message);
    return null;
  }
};

/**
 * Envía al propietario un mensaje recibido desde el formulario público de
 * contacto de la invitación. Si el visitante facilitó un email, se usa como
 * `replyTo` para que los novios puedan responder directamente.
 *
 * @param {object} payload
 * @param {string} payload.name       Nombre del visitante (required)
 * @param {string} [payload.email]    Email del visitante (optional)
 * @param {string} [payload.category] Categoría ("consulta" | "sugerencia" | "rsvp" | "otro")
 * @param {string} [payload.subject]  Asunto libre que escribió el visitante
 * @param {string} payload.message    Mensaje (required)
 * @returns {Promise<object|null>} Resultado de Resend o `null` si falla / está deshabilitado.
 */
export const sendContactMessageEmail = async ({
  name,
  email,
  category,
  subject,
  message,
}) => {
  if (!emailEnabled) {
    console.warn(
      "⚠️ Intento de envío de contacto sin emailService habilitado.",
    );
    return null;
  }

  try {
    const emailOwner = await db.get(
      "SELECT email FROM users WHERE role = ? AND email IS NOT NULL ORDER BY id ASC LIMIT 1",
      ["admin"],
    );
    if (!emailOwner) {
      console.warn("EMAILOWNER not configured");
      return null;
    }

    const safeName = String(name ?? "").slice(0, 100);
    const safeEmail = email ? String(email).slice(0, 255) : null;
    const safeCategory = category ? String(category).slice(0, 40) : "general";
    const safeSubject = subject ? String(subject).slice(0, 200) : "";
    const safeMessage = String(message ?? "").slice(0, 2000);

    const subjectLine = safeSubject
      ? `📩 [Web ${safeCategory}] ${safeSubject} — de ${safeName}`
      : `📩 [Web ${safeCategory}] Mensaje de ${safeName}`;

    const replyToHeader = safeEmail ? [safeEmail] : undefined;

    const categoryLabels = {
      consulta: "Consulta",
      sugerencia: "Sugerencia / petición",
      rsvp: "Sobre mi RSVP",
      otro: "Otro",
      general: "General",
    };
    const categoryDisplay =
      categoryLabels[safeCategory] ?? safeCategory ?? "General";

    const messageBlock = safeMessage
      .split("\n")
      .map((line) =>
        line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
      )
      .join("<br>");

    const result = await resend.emails.send({
      from: "Wedding API <onboarding@resend.dev>",
      to: emailOwner,
      ...(replyToHeader ? { replyTo: replyToHeader } : {}),
      subject: subjectLine,
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <style>
              body { font-family: Arial, sans-serif; }
              .container { max-width: 600px; margin: 0 auto; padding: 20px; }
              .header {
                background-color: #ec4899;
                color: white;
                padding: 20px;
                border-radius: 5px;
              }
              .content { margin-top: 20px; line-height: 1.5; }
              .field-table {
                border-collapse: collapse;
                width: 100%;
                margin-top: 16px;
              }
              .field-table td {
                border: 1px solid #ddd;
                padding: 8px;
                vertical-align: top;
              }
              .field-table td.label {
                background-color: #fdf2f5;
                width: 35%;
                font-weight: 600;
                color: #be185d;
              }
              .message-box {
                margin-top: 16px;
                padding: 16px;
                border-left: 4px solid #ec4899;
                background: #fdf2f5;
                white-space: pre-wrap;
                line-height: 1.6;
              }
              .footer {
                margin-top: 30px;
                font-size: 12px;
                color: #666;
                border-top: 1px solid #ddd;
                padding-top: 20px;
              }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="header">
                <h2 style="margin:0;">💌 Mensaje desde la web de boda</h2>
              </div>
              <div class="content">
                <p>Has recibido un nuevo mensaje desde el formulario de contacto
                  público de la invitación.</p>

                <table class="field-table" role="presentation">
                  <tr>
                    <td class="label">Nombre</td>
                    <td>${safeName}</td>
                  </tr>
                  ${
                    safeEmail
                      ? `<tr>
                          <td class="label">Email</td>
                          <td>${safeEmail}</td>
                        </tr>`
                      : ""
                  }
                  <tr>
                    <td class="label">Categoría</td>
                    <td>${categoryDisplay}</td>
                  </tr>
                  ${
                    safeSubject
                      ? `<tr>
                          <td class="label">Asunto</td>
                          <td>${safeSubject}</td>
                        </tr>`
                      : ""
                  }
                </table>

                <div class="message-box">${messageBlock}</div>

                <p style="margin-top: 24px;">
                  ${
                    safeEmail
                      ? "Podés responder directamente a este email para escribirle al visitante."
                      : "El visitante no dejó email de contacto. Si necesitás responderle, hacelo desde el panel."
                  }
                </p>

                <p style="margin-top: 12px; font-size: 13px; color: #999;">
                  Tip: si respondés desde tu cliente de correo, el email irá
                  directamente a la dirección que nos dejó el visitante.
                </p>
              </div>
              <div class="footer">
                <p>Este mensaje se generó automáticamente desde la web de boda.</p>
                <p>${new Date().toLocaleString("es-ES")}</p>
              </div>
            </div>
          </body>
        </html>
      `,
    });

    console.log("✉️ Contact message email sent to:", emailOwner);
    return result;
  } catch (error) {
    console.error("Error sending contact message email:", error.message);
    return null;
  }
};

/**
 * Envia un código numérico de 6 cifras al propietario para autorizar
 * la eliminación masiva de invitados.
 */
export const sendDeleteCodeEmail = async (code, userId) => {
  if (!emailEnabled) {
    return null;
  }

  try {
    const emailUser = await db.get("SELECT email FROM users WHERE id = ?", [
      userId,
    ]);
    if (!emailUser?.email) {
      console.warn("No email configured for user");
      return null;
    }

    const result = await resend.emails.send({
      from: "Wedding API <onboarding@resend.dev>",
      to: emailUser.email,
      subject: "🛑 Código para eliminación masiva de invitados",
      html: `
        <p>Se ha solicitado borrar <strong>todos</strong> los invitados.</p>
        <p>Utilice el siguiente código de 6 dígitos para confirmar la operación:</p>
        <h2 style="letter-spacing: 4px;">${code}</h2>
        <p>Este código expirará en 15 minutos.</p>
      `,
    });

    console.log("✉️ Delete code sent to:", emailUser.email);
    return result;
  } catch (error) {
    console.error("Error sending delete code email:", error.message);
    return null;
  }
};

/**
 * Envía un código numérico de 6 cifras al usuario para restablecer su contraseña.
 */
export const sendPasswordResetCodeEmail = async ({ to, username, code }) => {
  if (!emailEnabled) {
    console.warn(
      "⚠️ Email service disabled. Reset code cannot be sent via email.",
    );
    return null;
  }

  const recipient = to;
  if (!recipient) {
    console.warn("⚠️ No recipient email available for password reset code");
    return null;
  }

  try {
    const result = await resend.emails.send({
      from: "BodasOnline <onboarding@resend.dev>",
      to: recipient,
      subject: "🔑 Tu código de recuperación de contraseña",
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 540px; margin: 0 auto; background-color: #ffffff; border: 1px solid #f3e8ff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.05);">
          <div style="background: linear-gradient(135deg, #ec4899, #be185d); padding: 24px; text-align: center; color: white;">
            <h1 style="margin: 0; font-size: 24px; font-weight: 700; letter-spacing: -0.5px;">BodasOnline</h1>
            <p style="margin: 6px 0 0; font-size: 14px; opacity: 0.9;">Recuperación de contraseña</p>
          </div>
          <div style="padding: 32px 24px; color: #1f2937;">
            <p style="margin-top: 0; font-size: 16px;">Hola <strong>${username || "usuario"}</strong>,</p>
            <p style="font-size: 15px; color: #4b5563; line-height: 1.5;">
              Hemos recibido una solicitud para restablecer la contraseña de tu cuenta. Utiliza el siguiente código de verificación:
            </p>
            <div style="text-align: center; margin: 28px 0;">
              <div style="display: inline-block; background-color: #fdf2f8; border: 2px dashed #ec4899; border-radius: 12px; padding: 14px 28px;">
                <span style="font-size: 32px; font-weight: 800; letter-spacing: 8px; color: #be185d; font-family: monospace;">${code}</span>
              </div>
            </div>
            <p style="font-size: 13px; color: #6b7280; text-align: center;">
              ⏳ Este código es de un solo uso y expirará en <strong>15 minutos</strong>.
            </p>
            <hr style="border: none; border-top: 1px solid #f3f4f6; margin: 24px 0;" />
            <p style="font-size: 12px; color: #9ca3af; line-height: 1.4; margin-bottom: 0;">
              Si no has solicitado este restablecimiento, puedes ignorar este mensaje de forma segura. Tu contraseña actual no cambiará.
            </p>
          </div>
        </div>
      `,
    });

    console.log("✉️ Password reset code sent to:", recipient);
    return result;
  } catch (error) {
    console.error("Error sending password reset code email:", error.message);
    return null;
  }
};

/**
 * Formatea un importe en céntimos como string en es-ES con la moneda
 * indicada. Lo usamos en los emails para que el cliente vea el mismo
 * formato que en la pantalla de checkout (ej. "59,00 EUR").
 */
const formatMoney = (amountCents, currency) => {
  const major = (amountCents ?? 0) / 100;
  const formatted = major.toLocaleString("es-ES", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${formatted} ${String(currency || "eur").toUpperCase()}`;
};

/**
 * Email de confirmación de pago. Se envía cuando el webhook de Stripe
 * confirma `payment_intent.succeeded`.
 *
 * Si el destinatario no tiene email configurado, devolvemos `null`
 * silenciosamente: el panel admin ya marca al usuario como `paid`,
 * así que el cliente puede seguir usando el producto.
 */
export const sendPaymentReceivedEmail = async ({
  to: recipient,
  username,
  amount,
  currency,
  paymentIntentId,
}) => {
  if (!emailEnabled) {
    console.warn(
      "⚠️ Email service disabled. Payment-received email will not be sent.",
    );
    return null;
  }

  if (!recipient) {
    // Es un caso esperado (registros sin email): solo lo logamos.
    console.log(
      "[payment] Usuario sin email configurado, se omite el email de pago.",
      username ? `(username=${username})` : "",
    );
    return null;
  }

  const amountStr = formatMoney(amount, currency);

  try {
    const result = await resend.emails.send({
      from: "BodasOnline <onboarding@resend.dev>",
      to: recipient,
      subject: "🎉 ¡Pago recibido! Tu boda está activa",
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 540px; margin: 0 auto; background-color: #ffffff; border: 1px solid #f3e8ff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.05);">
          <div style="background: linear-gradient(135deg, #ec4899, #be185d); padding: 24px; text-align: center; color: white;">
            <h1 style="margin: 0; font-size: 24px; font-weight: 700; letter-spacing: -0.5px;">BodasOnline</h1>
            <p style="margin: 6px 0 0; font-size: 14px; opacity: 0.9;">¡Gracias por tu compra!</p>
          </div>
          <div style="padding: 32px 24px; color: #1f2937;">
            <p style="margin-top: 0; font-size: 16px;">Hola <strong>${username || "usuario"}</strong>,</p>
            <p style="font-size: 15px; color: #4b5563; line-height: 1.5;">
              Hemos recibido correctamente el pago de tu
              <strong>Plan Pareja Completo</strong> y tu cuenta ya está activa.
            </p>
            <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
              <tr style="background-color: #fdf2f8;">
                <td style="padding: 12px 14px; border-radius: 8px; font-size: 14px; color: #6b7280;">Importe</td>
                <td style="padding: 12px 14px; border-radius: 8px; font-size: 16px; font-weight: 700; color: #be185d; text-align: right;">${amountStr}</td>
              </tr>
              <tr>
                <td style="padding: 12px 14px; font-size: 14px; color: #6b7280;">Referencia</td>
                <td style="padding: 12px 14px; font-size: 13px; color: #4b5563; text-align: right; font-family: monospace;">${paymentIntentId || "—"}</td>
              </tr>
              <tr style="background-color: #fdf2f8;">
                <td style="padding: 12px 14px; border-radius: 8px; font-size: 14px; color: #6b7280;">Plan</td>
                <td style="padding: 12px 14px; border-radius: 8px; font-size: 14px; color: #1f2937; text-align: right;">Acceso ilimitado · pago único</td>
              </tr>
            </table>
            <p style="font-size: 15px; color: #4b5563; line-height: 1.5;">
              Ya puedes acceder a tu panel de control para empezar a configurar
              tu invitación. Si tienes cualquier duda, responde a este correo y
              te echamos una mano.
            </p>
            <div style="text-align: center; margin: 28px 0;">
              <a href="https://bodas-online.example/dashboard" style="display: inline-block; background: linear-gradient(135deg, #ec4899, #be185d); color: #ffffff; padding: 12px 28px; border-radius: 999px; text-decoration: none; font-weight: 600; font-size: 15px;">
                Ir a mi Panel de Control
              </a>
            </div>
            <p style="font-size: 12px; color: #9ca3af; line-height: 1.4; margin-bottom: 0;">
              Este correo es una confirmación automática del pago procesado
              por Stripe. Guarda el ID de referencia por si necesitas
              contactar con soporte.
            </p>
          </div>
        </div>
      `,
    });

    console.log(
      `✉️ Email de pago recibido enviado a ${recipient} (${amountStr}, intent=${paymentIntentId || "?"})`,
    );
    return result;
  } catch (error) {
    // Nunca rompemos el flujo del webhook por un fallo de envío:
    // el `paidAt` ya está marcado, el admin puede ver el pago.
    console.error(
      "Error sending payment-received email:",
      error?.message ?? error,
    );
    return null;
  }
};

/**
 * Email al admin cuando se registra un nuevo usuario en la plataforma.
 *
 * El destinatario es el usuario con `role = 'admin'` (por defecto el
 * que se llama `admin`, creado por `db.js` al arrancar). Si hay
 * varios admins, notificamos solo al primero — son no hace falta
 * duplicar el aviso.
 *
 * Se dispara fire-and-forget desde `authController.register`: un
 * fallo de envío nunca debe impedir el alta de la cuenta.
 */
export const sendNewUserRegisteredEmail = async ({
  newUsername,
  newUserEmail,
  newUserSlug,
  newUserId,
}) => {
  if (!emailEnabled) {
    console.warn(
      "⚠️ Email service disabled. New-user-registered email will not be sent.",
    );
    return null;
  }

  try {
    const adminRow = await db.get(
      "SELECT email, username FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1",
    );
    const adminEmail = adminRow?.email;

    if (!adminEmail) {
      console.warn(
        "⚠️ No se encontró admin con email configurado. No se envía notificación.",
      );
      return null;
    }

    const createdAt = new Date().toISOString();

    const result = await resend.emails.send({
      from: "BodasOnline <onboarding@resend.dev>",
      to: adminEmail,
      subject: `🆕 Nuevo usuario registrado: ${newUsername}`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 540px; margin: 0 auto; background-color: #ffffff; border: 1px solid #f3e8ff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.05);">
          <div style="background: linear-gradient(135deg, #ec4899, #be185d); padding: 24px; text-align: center; color: white;">
            <h1 style="margin: 0; font-size: 24px; font-weight: 700; letter-spacing: -0.5px;">BodasOnline</h1>
            <p style="margin: 6px 0 0; font-size: 14px; opacity: 0.9;">Nuevo usuario registrado</p>
          </div>
          <div style="padding: 32px 24px; color: #1f2937;">
            <p style="margin-top: 0; font-size: 16px;">Hola <strong>${adminRow.username}</strong>,</p>
            <p style="font-size: 15px; color: #4b5563; line-height: 1.5;">
              Se ha creado una nueva cuenta en BodasOnline. Aquí tienes los
              datos básicos para que puedas revisarla desde el panel de admin.
            </p>
            <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
              <tr style="background-color: #fdf2f8;">
                <td style="padding: 12px 14px; border-radius: 8px; font-size: 14px; color: #6b7280;">Username</td>
                <td style="padding: 12px 14px; border-radius: 8px; font-size: 14px; font-weight: 600; color: #1f2937; text-align: right; font-family: monospace;">${newUsername || "—"}</td>
              </tr>
              <tr>
                <td style="padding: 12px 14px; font-size: 14px; color: #6b7280;">Email</td>
                <td style="padding: 12px 14px; font-size: 14px; color: #1f2937; text-align: right;">${newUserEmail || "—"}</td>
              </tr>
              <tr style="background-color: #fdf2f8;">
                <td style="padding: 12px 14px; border-radius: 8px; font-size: 14px; color: #6b7280;">URL invitación</td>
                <td style="padding: 12px 14px; border-radius: 8px; font-size: 14px; color: #be185d; text-align: right; font-family: monospace;">/${newUserSlug || "—"}/</td>
              </tr>
              <tr>
                <td style="padding: 12px 14px; font-size: 14px; color: #6b7280;">ID interno</td>
                <td style="padding: 12px 14px; font-size: 13px; color: #4b5563; text-align: right; font-family: monospace;">#${newUserId ?? "—"}</td>
              </tr>
            </table>
            <p style="font-size: 12px; color: #9ca3af; line-height: 1.4; margin-bottom: 0;">
              Recibirás otro correo cuando el usuario complete el pago
              (si Stripe está configurado).
            </p>
          </div>
        </div>
      `,
    });

    console.log(
      `✉️ Nuevo-registro notificado a admin ${adminRow.username} <${adminEmail}> (nuevo user=${newUsername}, id=${newUserId}, t=${createdAt})`,
    );
    return result;
  } catch (error) {
    // Nunca rompemos el alta de un usuario por un fallo de email:
    // el admin ya puede verlo desde /admin/users.
    console.error(
      "Error sending new-user-registered email:",
      error?.message ?? error,
    );
    return null;
  }
};
