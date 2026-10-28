import type { BetterAuthPlugin } from "better-auth";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Observation } from "./observation.ts";
import type { z } from "zod";
import type { OrganizationAccess } from "./application-context.ts";
import type { Configuration } from "./config.ts";
import type { Database } from "./database.ts";
import type { SendEmail } from "./email.ts";
import type { CreateOrganization } from "./onboarding.ts";

export interface AuthenticationExtension {
  plugins: BetterAuthPlugin[];
  schema?: Record<string, PgTable>;
  // Applies to browser sessions, bearer credentials and OAuth token issuance.
  allowUser?: (userId: string) => Promise<boolean>;
}

export interface RuntimeExtension {
  authentication?: AuthenticationExtension;
  organizationAccess?: OrganizationAccess;
  sendEmail?: SendEmail;
  createOrganization?: CreateOrganization;
  scheduled?: (
    event: { scheduledTime: number; cron: string },
    binding: <Value>(name: string, schema: z.ZodType<Value>) => Value,
  ) => Promise<void>;
}

export interface RuntimeExtensionContext {
  database: Database;
  configuration: Configuration;
  observation?: Observation;
  binding?: <Value>(name: string, schema: z.ZodType<Value>) => Value;
}

// Installations can replace this module when building, while the default build
// remains self-contained. Admission can only narrow verified memberships.
export const createRuntimeExtension = (_context: RuntimeExtensionContext): RuntimeExtension => ({});
