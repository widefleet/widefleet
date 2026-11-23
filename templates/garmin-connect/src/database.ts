// Each user's Personal API key with the access token last issued for it, and
// the single-use tickets of connections started from Widefleet. Each app
// initializes its own tables on first use.
const schema = [
  `CREATE TABLE IF NOT EXISTS api_key (
    userId TEXT PRIMARY KEY NOT NULL, apiKey TEXT NOT NULL, displayName TEXT,
    accessToken TEXT, accessTokenExpiresAt INTEGER, rejected INTEGER NOT NULL, savedAt INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS verification (
    id TEXT PRIMARY KEY NOT NULL, identifier TEXT NOT NULL, value TEXT NOT NULL,
    expiresAt DATE NOT NULL, createdAt DATE NOT NULL, updatedAt DATE NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS verification_identifier ON verification (identifier)`,
];

const initialized = new WeakSet<D1Database>();

export const initialize = async (database: D1Database) => {
  if (initialized.has(database)) return;
  // Share only completion, not an in-flight promise owned by another Worker request.
  await database.batch(schema.map((statement) => database.prepare(statement)));
  initialized.add(database);
};
