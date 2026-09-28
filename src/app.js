import "./env.js";
import express from "express";
import cors from "cors";
import * as Visit from "./models/visit.js";
import guestRoutes from "./routes/guests.js";
import statsRoutes from "./routes/stats.js";
import authRoutes from "./routes/auth.js";
import settingsRoutes from "./routes/settings.js";
import tableRoutes from "./routes/tables.js";
import financeRoutes from "./routes/finances.js";
import todoRoutes from "./routes/todos.js";
import aiRoutes from "./routes/ai.js";
import contactRoutes from "./routes/contacts.js";
import contactMessageRoutes from "./routes/contact-message.js";
import categoryRoutes from "./routes/categories.js";
import musicPlaylistRoutes from "./routes/music-playlist.routes.js";
import userRoutes from "./routes/users.js";
import adminRoutes from "./routes/admin.js";
import landingQuestionnaireRoutes from "./routes/landingQuestionnaire.js";
import invitationMediaRoutes from "./routes/invitation-media.js";
import paymentRoutes from "./routes/payment.js";
import { MEDIA_ROOT } from "./constants/media.js";
import { initializeEmailService } from "./services/emailService.js";
import { initializeWhatsAppService } from "./services/whatsappService.js";
import { initializeStripeService } from "./services/stripeService.js";
import helmet from "helmet";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import jwt from "jsonwebtoken";
import compression from "compression";
import { logError } from "./utils/logger.js";

const app = express();

initializeEmailService();
initializeWhatsAppService();
initializeStripeService();

const isProduction = process.env.NODE_ENV === "production";

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'", "https://js.stripe.com"],
        imgSrc: ["'self'", "data:", "https:", "https://*.stripe.com"],
        connectSrc: ["'self'", "https://api.stripe.com"],
        fontSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        // Stripe.js monta un iframe interno para el Payment Element
        // y para los desafíos 3DS.
        frameSrc: ["'self'", "https://js.stripe.com", "https://hooks.stripe.com"],
      },
    },
    hsts: isProduction
      ? {
          maxAge: 31536000,
          includeSubDomains: true,
          preload: true,
        }
      : false,
  }),
);

app.use(
  compression({
    filter: (req, res) => {
      if (req.originalUrl?.includes("/api/ai")) {
        return false;
      }
      return compression.filter(req, res);
    },
  }),
);

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: (req, res) => {
    const authHeader = req.headers.authorization;
    if (authHeader) {
      try {
        const token = authHeader.split(" ")[1];
        jwt.verify(token, process.env.JWT_SECRET);
        return 500;
      } catch {}
    }
    return 100;
  },
  standardHeaders: "draft-8",
  legacyHeaders: false,
  // `ipKeyGenerator` espera un string (la IP), no el Request. Hay que extraerla.
  // Si se le pasa `req` directamente, lo devuelve tal cual y el hash de
  // `setDraft8Headers` revienta con ERR_INVALID_ARG_TYPE.
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  message: {
    success: false,
    message: "Too many requests, please try again later.",
  },
});

// (Los limiters de /api/auth se aplican dentro de src/routes/auth.js:
//  authLimiter a login/register, checkUsernameLimiter a check-username.)

const corsOptions = {
  origin: process.env.ORIGIN_URL || "http://localhost:4200",
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  credentials: true,
};

app.set("trust proxy", 1);
app.use(cors(corsOptions));
// `verify` captura el cuerpo crudo para que el handler del webhook de
// Stripe pueda validar la firma. Express ya habrá parseado el JSON
// para el resto de rutas (no afecta a su funcionamiento).
app.use(
  express.json({
    limit: "10mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(
  "/media/photos",
  (req, res, next) => {
    // Helmet sets Cross-Origin-Resource-Policy: same-origin by default, which blocks
    // cross-origin image loads (ERR_BLOCKED_BY_RESPONSE.NotSameOrigin).
    // Override it to allow the frontend (different port/origin) to load these assets.
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    next();
  },
  express.static(MEDIA_ROOT, { index: false, fallthrough: false, maxAge: 0 }),
);
app.use("/api/", generalLimiter);

app.get("/health", (req, res) => {
  // Trackear visita única por IP: fire-and-forget, nunca bloquea la respuesta.
  // Solo registra si el request viene con el header x-app-visit que el frontend
  // envía al arrancar, evitando que pings de monitorización externos cuenten.
  if (req.headers["x-app-visit"] === "1") {
    const ip = req.ip ?? "unknown";
    const ua = req.headers["user-agent"] ?? null;
    Visit.track(ip, ua).catch((err) => {
      console.warn("[health] visit track failed:", err?.message);
    });
  }
  res.json({ status: "OK", message: "Wedding API is running" });
});

app.use("/api/auth", authRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/tables", tableRoutes);
app.use("/api/table", tableRoutes);
app.use("/api/guests", guestRoutes);
app.use("/api/stats", statsRoutes);
app.use("/api/finances", financeRoutes);
app.use("/api/todos", todoRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/contacts", contactRoutes);
app.use("/api/contact-message", contactMessageRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/music-playlist", musicPlaylistRoutes);
app.use("/api/users", userRoutes);
app.use("/api/landing-questionnaire", landingQuestionnaireRoutes);
app.use("/api/invitation-media", invitationMediaRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/payments", paymentRoutes);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Endpoint not found",
    path: req.path,
  });
});

app.use((err, req, res, next) => {
  logError(`Error in ${req.method} ${req.path}`, err);

  const production = process.env.NODE_ENV === "production";
  res.status(err.status || 500).json({
    success: false,
    error: "Internal server error",
    ...(production ? {} : { message: err.message, stack: err.stack }),
  });
});

export default app;
