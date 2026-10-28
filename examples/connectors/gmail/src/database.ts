// Better Auth's core SQLite schema, with one provider account per Widefleet user.
// Initialization runs in the connector because connector D1 migrations are not a CLI operation.
const schema = [
  `CREATE TABLE IF NOT EXISTS "user" (
    id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
    emailVerified INTEGER NOT NULL, image TEXT, providerEmail TEXT, createdAt DATE NOT NULL, updatedAt DATE NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY NOT NULL, expiresAt DATE NOT NULL, token TEXT NOT NULL UNIQUE,
    createdAt DATE NOT NULL, updatedAt DATE NOT NULL, ipAddress TEXT, userAgent TEXT,
    userId TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS account (
    id TEXT PRIMARY KEY NOT NULL, accountId TEXT NOT NULL, providerId TEXT NOT NULL,
    userId TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
    accessToken TEXT, refreshToken TEXT, idToken TEXT,
    accessTokenExpiresAt DATE, refreshTokenExpiresAt DATE, scope TEXT, password TEXT,
    createdAt DATE NOT NULL, updatedAt DATE NOT NULL,
    UNIQUE (userId, providerId), UNIQUE (providerId, accountId)
  )`,
  `CREATE TABLE IF NOT EXISTS verification (
    id TEXT PRIMARY KEY NOT NULL, identifier TEXT NOT NULL, value TEXT NOT NULL,
    expiresAt DATE NOT NULL, createdAt DATE NOT NULL, updatedAt DATE NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS session_userId ON session (userId)`,
  `CREATE INDEX IF NOT EXISTS verification_identifier ON verification (identifier)`,
];

const initialized = new WeakSet<D1Database>();

export const initialize = async (database: D1Database) => {
  if (initialized.has(database)) return;
  // Share only completion, not an in-flight promise owned by another Worker request.
  await database.batch(schema.map((statement) => database.prepare(statement)));
  initialized.add(database);
};

export const ensureUser = async (database: D1Database, id: string, name: string) => {
  const now = Date.now();
  await database
    .prepare(
      `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES (?, ?, ?, 0, ?, ?) ON CONFLICT (id) DO NOTHING`,
    )
    .bind(id, name, `${id}@widefleet.invalid`, now, now)
    .run();
};
