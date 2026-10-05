import { createClient } from "@libsql/client";
import bcrypt from "bcryptjs";

const isProduction = process.env.NODE_ENV === "production";
const url = isProduction
  ? process.env.TURSO_DATABASE_URL
  : process.env.DB_PATH || "file:data/wedding.db";
const authToken = isProduction ? process.env.TURSO_AUTH_TOKEN : undefined;

if (isProduction && !url) {
  console.error("TURSO_DATABASE_URL is not set in environment variables.");
  process.exit(1);
}

console.log(
  `Using ${isProduction ? "Turso" : "local SQLite"} database: ${url}`,
);

const client = createClient({
  url: url,
  authToken: authToken,
});

const db = {
  /**
   * Ejecuta una consulta y devuelve todas las filas (mimic sqlite3.all)
   */
  all: async (sql, params = []) => {
    try {
      const result = await client.execute({ sql, args: params });
      return result.rows;
    } catch (err) {
      console.error("Database Error (all):", err);
      throw err;
    }
  },

  /**
   * Ejecuta una consulta y devuelve la primera fila (mimic sqlite3.get)
   */
  get: async (sql, params = []) => {
    try {
      const result = await client.execute({ sql, args: params });
      return result.rows[0];
    } catch (err) {
      console.error("Database Error (get):", err);
      throw err;
    }
  },

  /**
   * Ejecuta una consulta (INSERT, UPDATE, DELETE) (mimic sqlite3.run)
   */
  run: async (sql, params = []) => {
    try {
      const result = await client.execute({ sql, args: params });
      return {
        lastID: result.lastInsertRowid ? Number(result.lastInsertRowid) : null,
        changes: result.rowsAffected,
      };
    } catch (err) {
      console.error("Database Error (run):", err);
      throw err;
    }
  },

  /**
   * Ejecuta múltiples consultas en una transacción (mimic sqlite3.serialize simple logic or batch)
   */
  batch: async (queries) => {
    try {
      return await client.batch(queries);
    } catch (err) {
      console.error("Database Error (batch):", err);
      throw err;
    }
  },

  // Método de conveniencia para ejecutar SQL crudo
  execute: async (sql, params = []) => {
    return await client.execute({ sql, args: params });
  },
};

const recreateLegacyUniqueTable = async ({
  tableName,
  legacyConstraint,
  createTableSql,
  columns,
}) => {
  const tableSqlRow = await db.get(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    [tableName],
  );
  const tableSql = tableSqlRow?.sql || "";
  if (!legacyConstraint.test(tableSql)) return false;

  const existingColumns = await db.all(`PRAGMA table_info(${tableName})`);
  const existingColumnNames = new Set(
    existingColumns.map((column) => column.name),
  );
  const columnsToCopy = columns.filter((column) =>
    existingColumnNames.has(column),
  );

  await db.run(`DROP TABLE IF EXISTS ${tableName}_new`);
  await db.run(createTableSql.replaceAll("__TABLE__", `${tableName}_new`));
  await db.run(`
    INSERT INTO ${tableName}_new (${columnsToCopy.join(", ")})
    SELECT ${columnsToCopy.join(", ")} FROM ${tableName}
  `);
  await db.run(`DROP TABLE ${tableName}`);
  await db.run(`ALTER TABLE ${tableName}_new RENAME TO ${tableName}`);
  return true;
};

const initializeTables = async () => {
  try {
    console.log(
      `Initializing ${isProduction ? "Turso" : "local SQLite"} database tables...`,
    );

    /**
     * Activar `ON DELETE CASCADE` para todas las FKs.
     *
     * SQLite/libSQL NO aplica las foreign keys por defecto: aunque el
     * schema declare `FOREIGN KEY (userId) REFERENCES users(id) ON
     * DELETE CASCADE`, hasta que se hace `PRAGMA foreign_keys = ON`
     * esas constraints son no-op. Sin esto, borrar un usuario dejaba
     * filas huérfanas en guests, settings, tables, finances, contacts,
     * todos, music_playlist, landing_questionnaire, etc.
     *
     * En Turso (modo remoto) el PRAGMA se aplica per-request: cada
     * `client.execute` abre una conexión nueva, así que el flag puede
     * resetearse. Como defensa adicional, lo re-aplicamos justo antes
     * de los DELETE en `User.deleteUser` y `adminController.deleteUser`.
     */
    await db.run("PRAGMA foreign_keys = ON");

    // Tabla de invitados
    await db.run(`
      CREATE TABLE IF NOT EXISTS guests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER,
        name TEXT NOT NULL,
        email TEXT,
        phone TEXT,
        attending INTEGER DEFAULT 0,
        mealType TEXT DEFAULT 'normal',
        needsTransport INTEGER DEFAULT 0,
        allergies TEXT,
        notes TEXT,
        tableId INTEGER,
        isAdult INTEGER DEFAULT 1,
        seatNumber INTEGER,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Tabla de configuración (por usuario)
    await db.run(`
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER,
        key TEXT NOT NULL,
        value TEXT,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(userId, key),
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // NOTA: el índice único `idx_settings_user_key ON settings(userId, key)`
    // se crea más abajo, dentro del bloque de migración que añade `userId`
    // a `settings` (ver bloque "Migración: settings — cambiar de UNIQUE(key) a
    // UNIQUE(userId, key)"). NO crearlo aquí: si la tabla `settings` viene
    // de un deploy anterior con schema legacy (sin `userId`), este CREATE
    // INDEX falla con `no such column: userId` antes de poder migrar la tabla.

    // Tabla de pagos (1 fila por PaymentIntent de Stripe).
    // PCI DSS: nunca almacenamos datos de tarjeta; solo metadatos
    // del intent (id, importe, moneda, estado, método) y el userId.
    //
    // Campos de descuento (todos opcionales, NULL cuando no se aplicó
    // ningún cupón): `originalAmount` (importe sin descuento en céntimos),
    // `discountCode` (código normalizado en MAYÚSCULAS), `discountPercent`
    // (1-100). El `amount` final es siempre el que se cobró a Stripe.
    await db.run(`
      CREATE TABLE IF NOT EXISTS payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER NOT NULL,
        stripePaymentIntentId TEXT UNIQUE NOT NULL,
        amount INTEGER NOT NULL,
        currency TEXT NOT NULL,
        status TEXT NOT NULL,
        paymentMethod TEXT,
        clientSecret TEXT,
        originalAmount INTEGER,
        discountCode TEXT,
        discountPercent INTEGER,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Migración: añadir columnas de descuento a `payments` en BDs
    // existentes que se creasen antes del feature de cupones.
    try {
      const paymentsInfo = await db.all("PRAGMA table_info(payments)");
      const paymentsCols = new Set(paymentsInfo.map((c) => c.name));
      if (!paymentsCols.has("originalAmount")) {
        await db.run(`ALTER TABLE payments ADD COLUMN originalAmount INTEGER`);
      }
      if (!paymentsCols.has("discountCode")) {
        await db.run(`ALTER TABLE payments ADD COLUMN discountCode TEXT`);
      }
      if (!paymentsCols.has("discountPercent")) {
        await db.run(`ALTER TABLE payments ADD COLUMN discountPercent INTEGER`);
      }
    } catch (err) {
      if (!err.message?.includes("duplicate column")) {
        console.error("Migration warning (payments discount cols):", err.message);
      }
    }

    await db.run(`
      CREATE INDEX IF NOT EXISTS idx_payments_user
      ON payments(userId, createdAt DESC)
    `);

    // Las configuraciones por defecto se inicializan por usuario en initUserDefaults()

    // Tabla de mesas
    await db.run(`
      CREATE TABLE IF NOT EXISTS tables (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER,
        name TEXT NOT NULL,
        capacity INTEGER,
        shape TEXT DEFAULT 'round',
        posX REAL DEFAULT 0,
        posY REAL DEFAULT 0,
        highchairs INTEGER DEFAULT 0,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(userId, name),
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Tabla de acompañantes
    await db.run(`
      CREATE TABLE IF NOT EXISTS companions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guestId INTEGER NOT NULL,
        name TEXT NOT NULL,
        relation TEXT,
        mealType TEXT DEFAULT 'normal',
        allergies TEXT,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (guestId) REFERENCES guests(id) ON DELETE CASCADE
      )
    `);

    // Tabla de preferencias
    await db.run(`
      CREATE TABLE IF NOT EXISTS preferences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guestId INTEGER NOT NULL,
        musicPreference TEXT,
        seatLocation TEXT,
        dietaryRestriction TEXT,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (guestId) REFERENCES guests(id) ON DELETE CASCADE
      )
    `);

    // Tabla de usuarios
    await db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT DEFAULT 'user',
        slug TEXT UNIQUE NOT NULL DEFAULT '',
        email TEXT,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Migración: agregar slug a usuarios existentes si no existe
    try {
      const usersInfo = await db.all("PRAGMA table_info(users)");
      const hasSlug = usersInfo.some((col) => col.name === "slug");
      const hasEmail = usersInfo.some((col) => col.name === "email");
      if (!hasSlug) {
        await db.run(`ALTER TABLE users ADD COLUMN slug TEXT`);
        // Asignar slug basado en username para usuarios existentes
        const existingUsers = await db.all("SELECT id, username FROM users");
        for (const u of existingUsers) {
          const slug = u.username
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "");
          await db.run("UPDATE users SET slug = ? WHERE id = ?", [slug, u.id]);
        }
        console.log("✅ Column slug added to existing users table");
      }
      if (!hasEmail) {
        await db.run(`ALTER TABLE users ADD COLUMN email TEXT`);
        console.log("✅ Column email added to existing users table");
      }
    } catch (err) {
      if (!err.message?.includes("duplicate column")) {
        console.error("Migration warning (users slug/email):", err.message);
      }
    }

    // Migración: columnas admin-only (paidAt, invitationCompletedAt, lastLoginAt, notes)
    // Nota: la columna `plan` quedó obsoleta y ya no se crea; en BDs creadas
    // antes de este cambio sigue existiendo pero ningún endpoint la usa.
    try {
      const usersInfo = await db.all("PRAGMA table_info(users)");
      const colsByName = new Set(usersInfo.map((c) => c.name));
      if (!colsByName.has("paidAt")) {
        await db.run(`ALTER TABLE users ADD COLUMN paidAt DATETIME`);
        console.log("✅ Column paidAt added to users table");
      }
      if (!colsByName.has("invitationCompletedAt")) {
        await db.run(`ALTER TABLE users ADD COLUMN invitationCompletedAt DATETIME`);
        console.log("✅ Column invitationCompletedAt added to users table");
      }
      if (!colsByName.has("lastLoginAt")) {
        await db.run(`ALTER TABLE users ADD COLUMN lastLoginAt DATETIME`);
        console.log("✅ Column lastLoginAt added to users table");
      }
      if (!colsByName.has("notes")) {
        await db.run(`ALTER TABLE users ADD COLUMN notes TEXT`);
        console.log("✅ Column notes added to users table");
      }
    } catch (err) {
      if (!err.message?.includes("duplicate column")) {
        console.error("Migration warning (users admin fields):", err.message);
      }
    }

    // Usuario admin por defecto: si la tabla `users` no contiene un usuario
    // con username `admin`, se crea con la contraseña `admin`. La contraseña
    // debe cambiarse en el primer login desde la app. Esto evita depender de
    // variables de entorno para el seeding inicial.
    const adminUsername = "admin";
    const adminPassword = "admin";
    const existingAdmin = await db.get(
      "SELECT id FROM users WHERE username = ?",
      [adminUsername],
    );
    if (!existingAdmin) {
      const hashedPassword = bcrypt.hashSync(adminPassword, 10);
      const adminSlug = adminUsername
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      await db.run(
        "INSERT INTO users (username, password, role, slug) VALUES (?, ?, ?, ?)",
        [adminUsername, hashedPassword, "admin", adminSlug],
      );
      console.log(
        `✅ Default admin '${adminUsername}' created with slug '${adminSlug}' (password: admin — cámbiala en el primer login)`,
      );
    }

    // Tabla de códigos de restablecimiento de contraseña
    await db.run(`
      CREATE TABLE IF NOT EXISTS password_reset_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER NOT NULL,
        code TEXT NOT NULL,
        expiresAt DATETIME NOT NULL,
        used INTEGER DEFAULT 0,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    await db.run(`
      CREATE INDEX IF NOT EXISTS idx_password_reset_codes_user
      ON password_reset_codes(userId, used)
    `);

    // Tabla de finanzas
    await db.run(`
      CREATE TABLE IF NOT EXISTS finances (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER,
        description TEXT NOT NULL,
        amount REAL NOT NULL,
        type TEXT CHECK(type IN ('income', 'expense')) NOT NULL,
        category TEXT,
        paidBy TEXT,
        date DATETIME DEFAULT CURRENT_TIMESTAMP,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Tabla de tareas (Todos)
    await db.run(`
      CREATE TABLE IF NOT EXISTS todos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER,
        name TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        date DATETIME,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Tabla de playlist de musica
    await db.run(`
      CREATE TABLE IF NOT EXISTS music_playlist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        youtube_url TEXT NOT NULL,
        youtube_id TEXT,
        note TEXT,
        order_index INTEGER NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    await db.run(`
      CREATE INDEX IF NOT EXISTS idx_music_playlist_order_index
      ON music_playlist(order_index)
    `);

    // Tabla de categorías de contactos
    await db.run(`
      CREATE TABLE IF NOT EXISTS contact_categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(userId, name),
        UNIQUE(userId, slug),
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Las categorías por defecto se inicializan por usuario en initUserDefaults()

    // Tabla de contactos para invitaciones
    await db.run(`
      CREATE TABLE IF NOT EXISTS contacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER,
        name TEXT NOT NULL,
        phone TEXT NOT NULL,
        side TEXT NOT NULL,
        country_code TEXT DEFAULT '+34' NOT NULL,
        linkSent INTEGER DEFAULT 0,
        sentAt DATETIME,
        invitation_status TEXT DEFAULT 'not_sent',
        responded_at DATETIME,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Migración: agregar country_code a contactos existentes si no existe
    // Solo intentar si la tabla ya existía (verificar si tiene la columna)
    try {
      const tableInfo = await db.all("PRAGMA table_info(contacts)");
      const hasCountryCode = tableInfo.some(
        (col) => col.name === "country_code",
      );

      if (!hasCountryCode) {
        await db.run(
          `ALTER TABLE contacts ADD COLUMN country_code TEXT DEFAULT '+34' NOT NULL`,
        );
        console.log("✅ Column country_code added to existing contacts table");
      }
    } catch (err) {
      // Ignorar errores de migración - la columna ya existe en el schema
      if (!err.message.includes("duplicate column")) {
        console.error("Migration warning:", err.message);
      }
    }

    // Migración: agregar invitation_status y responded_at a contactos existentes
    try {
      const tableInfo = await db.all("PRAGMA table_info(contacts)");
      const hasInvitationStatus = tableInfo.some(
        (col) => col.name === "invitation_status",
      );
      const hasRespondedAt = tableInfo.some(
        (col) => col.name === "responded_at",
      );

      if (!hasInvitationStatus) {
        await db.run(
          `ALTER TABLE contacts ADD COLUMN invitation_status TEXT DEFAULT 'not_sent'`,
        );
        console.log(
          "✅ Column invitation_status added to existing contacts table",
        );
      }
      if (!hasRespondedAt) {
        await db.run(`ALTER TABLE contacts ADD COLUMN responded_at DATETIME`);
        console.log("✅ Column responded_at added to existing contacts table");
      }
    } catch (err) {
      if (!err.message.includes("duplicate column")) {
        console.error("Migration warning:", err.message);
      }
    }

    // Migración: agregar captainIds a tables (para múltiples capitanes)
    try {
      const tablesInfo = await db.all("PRAGMA table_info(tables)");
      const hasCaptainIds = tablesInfo.some((col) => col.name === "captainIds");
      if (!hasCaptainIds) {
        await db.run(`ALTER TABLE tables ADD COLUMN captainIds TEXT`);
        console.log("✅ Column captainIds added to existing tables table");
      }
    } catch (err) {
      if (!err.message?.includes("duplicate column")) {
        console.error("Migration warning (captainIds):", err.message);
      }
    }

    // Migración: quitar columna captainId legacy
    try {
      const tablesInfo = await db.all("PRAGMA table_info(tables)");
      const hasCaptainId = tablesInfo.some((col) => col.name === "captainId");
      if (hasCaptainId) {
        await db.run(`ALTER TABLE tables DROP COLUMN captainId`);
        console.log("✅ Column captainId dropped from tables table");
      }
    } catch (err) {
      if (!err.message?.includes("no such column")) {
        console.error("Migration warning (drop captainId):", err.message);
      }
    }

    // Migración: agregar rotation a tables existentes si no existe
    try {
      const tablesInfo = await db.all("PRAGMA table_info(tables)");
      const hasRotation = tablesInfo.some((col) => col.name === "rotation");
      if (!hasRotation) {
        await db.run(
          `ALTER TABLE tables ADD COLUMN rotation INTEGER DEFAULT 0`,
        );
        console.log("✅ Column rotation added to existing tables table");
      }
    } catch (err) {
      if (!err.message?.includes("duplicate column")) {
        console.error("Migration warning (rotation):", err.message);
      }
    }

    // Migración: agregar highchairs a tables existentes si no existe
    try {
      const tablesInfo = await db.all("PRAGMA table_info(tables)");
      const hasHighchairs = tablesInfo.some((col) => col.name === "highchairs");
      if (!hasHighchairs) {
        await db.run(
          `ALTER TABLE tables ADD COLUMN highchairs INTEGER DEFAULT 0`,
        );
        console.log("✅ Column highchairs added to existing tables table");
      }
    } catch (err) {
      if (!err.message?.includes("duplicate column")) {
        console.error("Migration warning (highchairs):", err.message);
      }
    }

    // Migraciones de userId en tablas de datos existentes
    const dataTables = [
      "guests",
      "tables",
      "finances",
      "todos",
      "music_playlist",
      "contacts",
      "contact_categories",
    ];
    for (const tableName of dataTables) {
      try {
        const cols = await db.all(`PRAGMA table_info(${tableName})`);
        const hasUserId = cols.some((c) => c.name === "userId");
        if (!hasUserId) {
          await db.run(`ALTER TABLE ${tableName} ADD COLUMN userId INTEGER`);
          console.log(`✅ Column userId added to ${tableName}`);
          // Asignar al primer admin los registros sin userId
          const adminUser = await db.get(
            "SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1",
          );
          if (adminUser) {
            await db.run(
              `UPDATE ${tableName} SET userId = ? WHERE userId IS NULL`,
              [adminUser.id],
            );
            console.log(
              `✅ Existing rows in ${tableName} assigned to admin (id=${adminUser.id})`,
            );
          }
        }
      } catch (err) {
        if (!err.message?.includes("duplicate column")) {
          console.error(
            `Migration warning (userId in ${tableName}):`,
            err.message,
          );
        }
      }
    }

    try {
      const tablesRecreated = await recreateLegacyUniqueTable({
        tableName: "tables",
        legacyConstraint:
          /(?:name\s+TEXT[^,]*\s+UNIQUE\b|UNIQUE\s*\(\s*[`"]?name[`"]?\s*\))/i,
        createTableSql: `
          CREATE TABLE __TABLE__ (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            userId INTEGER,
            name TEXT NOT NULL,
            capacity INTEGER,
            shape TEXT DEFAULT 'round',
            posX REAL DEFAULT 0,
            posY REAL DEFAULT 0,
            captainIds TEXT,
            rotation INTEGER DEFAULT 0,
            highchairs INTEGER DEFAULT 0,
            createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(userId, name),
            FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
          )
        `,
        columns: [
          "id",
          "userId",
          "name",
          "capacity",
          "shape",
          "posX",
          "posY",
          "captainIds",
          "rotation",
          "highchairs",
          "createdAt",
          "updatedAt",
        ],
      });
      if (tablesRecreated)
        console.log("✅ tables: legacy schema migrated to multi-user");

      const categoriesRecreated = await recreateLegacyUniqueTable({
        tableName: "contact_categories",
        legacyConstraint:
          /(?:name\s+TEXT[^,]*\s+UNIQUE\b|slug\s+TEXT[^,]*\s+UNIQUE\b)/i,
        createTableSql: `
          CREATE TABLE __TABLE__ (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            userId INTEGER,
            name TEXT NOT NULL,
            slug TEXT NOT NULL,
            createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(userId, name),
            UNIQUE(userId, slug),
            FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
          )
        `,
        columns: ["id", "userId", "name", "slug", "createdAt"],
      });
      if (categoriesRecreated) {
        console.log(
          "✅ contact_categories: legacy schema migrated to multi-user",
        );
      }
    } catch (err) {
      console.error(
        "Migration warning (legacy multi-user UNIQUE constraints):",
        err.message,
      );
    }

    // Migración: settings — cambiar de UNIQUE(key) a UNIQUE(userId, key)
    // SQLite no permite DROP CONSTRAINT, así que solo agregamos userId si no existe
    try {
      const settingsCols = await db.all("PRAGMA table_info(settings)");
      const hasUserIdInSettings = settingsCols.some((c) => c.name === "userId");
      if (!hasUserIdInSettings) {
        await db.run(`ALTER TABLE settings ADD COLUMN userId INTEGER`);
        const adminUser = await db.get(
          "SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1",
        );
        if (adminUser) {
          await db.run("UPDATE settings SET userId = ? WHERE userId IS NULL", [
            adminUser.id,
          ]);
          console.log(
            `✅ Existing settings assigned to admin (id=${adminUser.id})`,
          );
        }
        console.log("✅ Column userId added to settings");
      }
      await db.run(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_settings_user_key ON settings(userId, key)`,
      );
    } catch (err) {
      if (!err.message?.includes("duplicate column")) {
        console.error("Migration warning (userId in settings):", err.message);
      }
    }

    // Migración: quitar UNIQUE(key) legacy de settings (versión single-user).
    // El bloque anterior añade userId y un UNIQUE INDEX (userId, key), pero NO
    // elimina la constraint de tabla UNIQUE(key) que quedó del schema original.
    // Esa constraint legacy hace que cualquier INSERT de un usuario nuevo con una
    // key que ya existe para el admin falle con SQLITE_CONSTRAINT_PRIMARYKEY,
    // porque el ON CONFLICT(userId, key) del modelo no captura conflictos sobre
    // `key` a secas. La única forma de quitarla en SQLite es recrear la tabla.
    try {
      const settingsSqlRow = await db.get(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='settings'",
      );
      const tableSql = settingsSqlRow?.sql || "";
      const settingsCols = await db.all("PRAGMA table_info(settings)");

      // Detectar cualquier esquema legacy:
      //   1. `key TEXT PRIMARY KEY` (esquema muy antiguo, sin id, key es PK)
      //   2. `, UNIQUE(key)` o `, UNIQUE(`key`)` (versión single-user con UNIQUE)
      //   3. Falta la columna `id` que el modelo actual espera
      const hasLegacyPrimaryKey = /key\s+TEXT\s+PRIMARY\s+KEY/i.test(tableSql);
      const hasLegacyUniqueKey = /,\s*UNIQUE\s*\(\s*[`"]?key[`"]?\s*\)/i.test(
        tableSql,
      );
      const hasIdColumn = settingsCols.some((c) => c.name === "id");
      const isLegacySchema =
        hasLegacyPrimaryKey || hasLegacyUniqueKey || !hasIdColumn;

      if (isLegacySchema) {
        console.log(
          "⚠️  Legacy settings schema detected — recreating table...",
        );
        if (hasLegacyPrimaryKey)
          console.log("    reason: key TEXT PRIMARY KEY");
        if (hasLegacyUniqueKey)
          console.log("    reason: UNIQUE(key) table constraint");
        if (!hasIdColumn) console.log("    reason: missing `id` column");

        const hasCreatedAt = settingsCols.some((c) => c.name === "createdAt");

        await db.run(`
          CREATE TABLE settings_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            userId INTEGER,
            key TEXT NOT NULL,
            value TEXT,
            updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(userId, key),
            FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
          )
        `);
        // Copiamos solo las columnas que existen en ambos esquemas.
        // El nuevo esquema no tiene `createdAt`; el legacy sí.
        await db.run(`
          INSERT INTO settings_new (userId, key, value, updatedAt)
          SELECT userId, key, value, updatedAt FROM settings
        `);
        await db.run(`DROP TABLE settings`);
        await db.run(`ALTER TABLE settings_new RENAME TO settings`);
        await db.run(
          `CREATE UNIQUE INDEX IF NOT EXISTS idx_settings_user_key
           ON settings(userId, key)`,
        );
        console.log("✅ settings: legacy schema migrated to multi-user");
        if (hasCreatedAt) {
          console.log(
            "   (columna legacy `createdAt` descartada intencionalmente)",
          );
        }
      }
    } catch (err) {
      console.error(
        "Migration warning (drop legacy UNIQUE on settings.key):",
        err.message,
      );
    }

    // Tabla del cuestionario inicial que rellena el cliente justo después
    // de registrarse. Sirve para que el admin sepa cómo quiere el cliente su
    // landing antes de ponerse a diseñarla (cuenta atrás, fecha, invitados,
    // color, transporte/hotel, etc.).
    //
    // Diseño: una fila por usuario (UNIQUE(userId)). Los campos booleanos se
    // guardan como INTEGER 0/1 (mismo patrón que `auto_assign_tables` en
    // `settings`); las opciones "abiertas" van en JSON dentro de
    // `additionalServices` para no romper el esquema si en el futuro el
    // admin añade más preguntas.
    try {
      /*
       * Columna legacy `ourStoryCaptions` (formato antiguo del
       * cuestionario, captions como JSON sin foto asociada): la
       * creamos como TEXT nullable para que el admin frontend siga
       * pudiendo leer datos históricos. Los cuestionarios nuevos usan
       * `ourStoryEntries` (foto + caption por entrada) y nunca tocan
       * esta columna.
       */
      await db.run(`
        CREATE TABLE IF NOT EXISTS landing_questionnaire (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          userId INTEGER UNIQUE NOT NULL,
          weddingDate TEXT,
          estimatedGuests INTEGER,
          predominantColor TEXT,
          hasCountdown INTEGER DEFAULT 0,
          hasBusService INTEGER DEFAULT 0,
          hasHotelService INTEGER DEFAULT 0,
          hasCoverPhoto INTEGER DEFAULT 0,
          hasOurStory INTEGER DEFAULT 0,
          hasGallery INTEGER DEFAULT 0,
          hasAddToCalendar INTEGER DEFAULT 0,
          hasVenueMap INTEGER DEFAULT 0,
          hasGiftRegistry INTEGER DEFAULT 0,
          giftBankAccount TEXT,
          hasBackgroundMusic INTEGER DEFAULT 0,
          backgroundMusicSong TEXT,
          ourStoryEntries TEXT,
          ourStoryCaptions TEXT,
          contactCouple INTEGER DEFAULT 0,
          contactGroomPhone TEXT,
          contactBridePhone TEXT,
          additionalServices TEXT,
          notes TEXT,
          createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
          updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
        )
      `);

      // Migración: si la tabla ya existía de una versión previa sin alguna
      // columna, las añadimos sin perder datos. Mismo patrón tolerante que
      // en el resto del esquema.
      const lqInfo = await db.all("PRAGMA table_info(landing_questionnaire)");
      const lqCols = new Set(lqInfo.map((c) => c.name));
      const lqMigrations = [
        ["weddingDate", "TEXT"],
        ["estimatedGuests", "INTEGER"],
        ["predominantColor", "TEXT"],
        ["hasCountdown", "INTEGER DEFAULT 0"],
        ["hasBusService", "INTEGER DEFAULT 0"],
        ["hasHotelService", "INTEGER DEFAULT 0"],
        ["hasCoverPhoto", "INTEGER DEFAULT 0"],
        ["hasOurStory", "INTEGER DEFAULT 0"],
        ["hasGallery", "INTEGER DEFAULT 0"],
        ["hasAddToCalendar", "INTEGER DEFAULT 0"],
        ["hasVenueMap", "INTEGER DEFAULT 0"],
        ["hasGiftRegistry", "INTEGER DEFAULT 0"],
        ["giftBankAccount", "TEXT"],
        ["hasBackgroundMusic", "INTEGER DEFAULT 0"],
        ["backgroundMusicSong", "TEXT"],
        ["ourStoryEntries", "TEXT"],
        ["ourStoryCaptions", "TEXT"],
        ["contactCouple", "INTEGER DEFAULT 0"],
        ["contactGroomPhone", "TEXT"],
        ["contactBridePhone", "TEXT"],
        ["additionalServices", "TEXT"],
        ["notes", "TEXT"],
      ];
      for (const [name, type] of lqMigrations) {
        if (!lqCols.has(name)) {
          await db.run(`ALTER TABLE landing_questionnaire ADD COLUMN ${name} ${type}`);
          console.log(`✅ Column ${name} added to landing_questionnaire`);
        }
      }

      // Migración de datos: copiar valores de columnas renombradas si existen.
      // hasCalendarEvent → hasAddToCalendar
      if (lqCols.has("hasCalendarEvent")) {
        await db.run(`UPDATE landing_questionnaire SET hasAddToCalendar = hasCalendarEvent WHERE hasCalendarEvent IS NOT NULL AND hasAddToCalendar = 0`);
        console.log("✅ Migrated data: hasCalendarEvent → hasAddToCalendar");
      }
      // hasVenueLocation → hasVenueMap
      if (lqCols.has("hasVenueLocation")) {
        await db.run(`UPDATE landing_questionnaire SET hasVenueMap = hasVenueLocation WHERE hasVenueLocation IS NOT NULL AND hasVenueMap = 0`);
        console.log("✅ Migrated data: hasVenueLocation → hasVenueMap");
      }
      // hasContactBrideGroom → contactCouple
      if (lqCols.has("hasContactBrideGroom")) {
        await db.run(`UPDATE landing_questionnaire SET contactCouple = hasContactBrideGroom WHERE hasContactBrideGroom IS NOT NULL AND contactCouple = 0`);
        console.log("✅ Migrated data: hasContactBrideGroom → contactCouple");
      }
      // contactBrideGroomPhone → contactGroomPhone
      if (lqCols.has("contactBrideGroomPhone")) {
        await db.run(`UPDATE landing_questionnaire SET contactGroomPhone = contactBrideGroomPhone WHERE contactBrideGroomPhone IS NOT NULL AND contactGroomPhone IS NULL`);
        console.log("✅ Migrated data: contactBrideGroomPhone → contactGroomPhone");
      }
    } catch (err) {
      console.error("Migration warning (landing_questionnaire):", err.message);
    }

    // Tabla de visitas únicas globales por IP — conteo de visitas a la app.
    // No está vinculada a ningún usuario: cualquier petición a /health desde
    // el frontend cuenta como una visita, deduplicada por IP en 24 h.
    try {
      await db.run(`
        CREATE TABLE IF NOT EXISTS page_visits (
          id        INTEGER PRIMARY KEY AUTOINCREMENT,
          ip        TEXT NOT NULL,
          userAgent TEXT,
          visitedAt DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      // Índice para la deduplicación en 24 h (WHERE ip = ? AND visitedAt >= ...)
      await db.run(
        `CREATE INDEX IF NOT EXISTS idx_page_visits_ip ON page_visits(ip)`,
      );
      await db.run(
        `CREATE INDEX IF NOT EXISTS idx_page_visits_visited_at ON page_visits(visitedAt)`,
      );

      // Migración: si la tabla ya existía con la columna 'slug' del intento
      // anterior, la eliminamos recreando la tabla sin ella.
      const lqCols = await db.all("PRAGMA table_info(page_visits)");
      const hasSlug = lqCols.some((c) => c.name === "slug");
      if (hasSlug) {
        await db.run(`
          CREATE TABLE IF NOT EXISTS page_visits_new (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            ip        TEXT NOT NULL,
            userAgent TEXT,
            visitedAt DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);
        await db.run(`
          INSERT INTO page_visits_new (ip, userAgent, visitedAt)
          SELECT ip, userAgent, visitedAt FROM page_visits
        `);
        await db.run(`DROP TABLE page_visits`);
        await db.run(`ALTER TABLE page_visits_new RENAME TO page_visits`);
        await db.run(`CREATE INDEX IF NOT EXISTS idx_page_visits_ip ON page_visits(ip)`);
        await db.run(`CREATE INDEX IF NOT EXISTS idx_page_visits_visited_at ON page_visits(visitedAt)`);
        console.log("✅ page_visits: migrated to global schema (slug column removed)");
      }
    } catch (err) {
      console.error("Migration warning (page_visits):", err.message);
    }

    // Tabla de códigos de descuento (Plan Pareja Completo).
    //
    // Solo guardamos códigos de porcentaje (no mayor). La expiración es
    // opcional: `expiresAt = NULL` significa que el código no expira.
    // `active = 0` permite desactivar un código sin borrarlo.
    //
    // El `code` se almacena SIEMPRE en mayúsculas y sin espacios para
    // que `BODAS10` y `bodas10` se consideren el mismo código. La capa
    // de servicio (`discountService`) normaliza antes de consultar.
    //
    // No tiene FK a `users`: los códigos son globales (cualquier usuario
    // autenticado puede usarlos), por eso vive fuera de la limpieza
    // one-shot de huérfanos de abajo.
    await db.run(`
      CREATE TABLE IF NOT EXISTS discount_codes (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        code        TEXT UNIQUE NOT NULL,
        percent     INTEGER NOT NULL CHECK (percent > 0 AND percent <= 100),
        active      INTEGER NOT NULL DEFAULT 1,
        description TEXT,
        expiresAt   DATETIME,
        createdAt   DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt   DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await db.run(`
      CREATE INDEX IF NOT EXISTS idx_discount_codes_active_expiry
        ON discount_codes(active, expiresAt)
    `);

    /**
     * Limpieza one-shot: borrar filas huérfanas que se acumularon
     * mientras el cascade de FK estaba desactivado (PRAGMA foreign_keys).
     * Se ejecuta DESPUÉS de crear las tablas para que `no such table`
     * no aparezca en BDs recién creadas. Antes verificamos con
     * `sqlite_master` que la tabla exista (algunas tablas listadas
     * pueden no existir en versiones muy antiguas del schema).
     */
    const orphanTables = [
      "guests",
      "tables",
      "finances",
      "todos",
      "music_playlist",
      "contacts",
      "contact_categories",
      "settings",
      "landing_questionnaire",
    ];
    let totalOrphansRemoved = 0;
    for (const tableName of orphanTables) {
      try {
        const exists = await db.get(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
          [tableName],
        );
        if (!exists) continue;
        const result = await db.run(
          `DELETE FROM ${tableName}
           WHERE userId IS NOT NULL
             AND userId NOT IN (SELECT id FROM users)`,
        );
        if (result.changes > 0) {
          console.log(
            `🧹 ${result.changes} huérfanas eliminadas de ${tableName}`,
          );
          totalOrphansRemoved += result.changes;
        }
      } catch (err) {
        console.error(`Orphan cleanup warning (${tableName}):`, err.message);
      }
    }
    if (totalOrphansRemoved > 0) {
      console.log(
        `✅ Limpieza de huérfanos completada: ${totalOrphansRemoved} filas eliminadas en total`,
      );
    }

    console.log(
      `${isProduction ? "Turso" : "Local SQLite"} database initialized successfully`,
    );

    // Backfill: garantizar que todos los usuarios tengan settings por defecto.
    // Con el esquema legacy de settings (key TEXT PRIMARY KEY) la función
    // initUserDefaults() fallaba silenciosamente para usuarios nuevos porque
    // INSERT OR IGNORE no podía crear filas con keys que ya existían para el
    // admin. Esto deja al usuario sin defaults y rompe PUT /api/settings/:key.
    // initUserDefaults es idempotente (INSERT OR IGNORE), así que es seguro
    // ejecutarlo para todos los usuarios; solo insertará los que falten.
    try {
      const allUsers = await db.all("SELECT id FROM users");
      for (const u of allUsers) {
        const hasAny = await db.get(
          "SELECT 1 AS x FROM settings WHERE userId = ? LIMIT 1",
          [u.id],
        );
        if (!hasAny) {
          await initUserDefaults(u.id);
          console.log(`✅ Backfilled default settings for user id=${u.id}`);
        }
      }
    } catch (err) {
      console.error("Backfill warning (default settings):", err.message);
    }
  } catch (err) {
    console.error(
      `Error initializing ${isProduction ? "Turso" : "local SQLite"} tables:`,
      err,
    );
  }
};

/**
 * Inicializa los settings y categorías por defecto para un usuario recién creado.
 * Se llama desde el authController al crear un usuario nuevo.
 */
export const initUserDefaults = async (userId) => {
  const defaults = [
    ["total_estimated_guests", "0"],
    ["max_guests_per_table", "10"],
    ["auto_assign_tables", "0"],
    ["enable_highchairs", "0"],
    ["enable_whatsapp", "0"],
    ["whatsapp_apikey", ""],
    ["whatsapp_phone", ""],
  ];
  for (const [key, value] of defaults) {
    await db.run(
      `INSERT OR IGNORE INTO settings (userId, key, value) VALUES (?, ?, ?)`,
      [userId, key, value],
    );
  }
  // Categorías de contacto por defecto
  const defaultCategories = [
    ["Novio", "novio"],
    ["Novia", "novia"],
  ];
  for (const [name, slug] of defaultCategories) {
    await db.run(
      `INSERT OR IGNORE INTO contact_categories (userId, name, slug) VALUES (?, ?, ?)`,
      [userId, name, slug],
    );
  }
};

// Ejecutar inicialización
export const initializationPromise = initializeTables();

export default db;
