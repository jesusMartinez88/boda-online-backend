import express from "express";
import * as paymentController from "../controllers/paymentController.js";
import { authenticateJWT } from "../middleware/auth.js";

const router = express.Router();

// Lectura de la configuración (publishable key + flags). Pública
// para que el frontend la pueda leer sin JWT, igual que en
// /api/health.
router.get("/config", paymentController.getConfig);

// Endpoints protegidos: crear intent + listar pagos del usuario.
router.post("/create-intent", authenticateJWT, paymentController.createIntent);
// Checkout Session (hosted_page). Devuelve `url` para redirigir al cliente.
router.post(
  "/create-checkout-session",
  authenticateJWT,
  paymentController.createCheckoutSession,
);
router.get("/me", authenticateJWT, paymentController.listMine);

// Webhook de Stripe: SIN JWT (Stripe no se autentica con JWT). El
// cuerpo crudo lo captura el middleware global `express.json({ verify })`
// en `app.js` y queda en `req.rawBody`. No necesitamos `express.raw`
// aquí ni montar esto en otro orden.
router.post("/webhook", paymentController.webhook);

export default router;