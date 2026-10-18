import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../src/lib/server/database.ts";

export const observeOAuthResourceWrites = async (database: Database) => {
  // Sequences count attempted writes even if the surrounding transaction rolls back.
  await database.execute(sql`
    CREATE SEQUENCE fixture_oauth_resource_writes;
    CREATE FUNCTION fixture_count_oauth_resource_write() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM nextval('fixture_oauth_resource_writes');
      RETURN NULL;
    END;
    $$;
    CREATE TRIGGER fixture_count_oauth_resource_write
      BEFORE INSERT OR UPDATE OR DELETE ON oauth_resource
      FOR EACH STATEMENT EXECUTE FUNCTION fixture_count_oauth_resource_write();
  `);

  return async () => {
    const result = await database.execute(sql`
      SELECT CASE WHEN is_called THEN last_value ELSE 0 END::integer AS count
      FROM fixture_oauth_resource_writes
    `);

    return z.object({ count: z.number() }).parse(result.rows[0]).count;
  };
};
