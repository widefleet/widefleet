import type { OrganizationAccess } from "./application-context.ts";
import type { Configuration } from "./config.ts";
import type { Database } from "./database.ts";
import type { SendEmail } from "./email.ts";

export interface RuntimeExtension {
  organizationAccess?: OrganizationAccess;
  sendEmail?: SendEmail;
}

export interface RuntimeExtensionContext {
  database: Database;
  configuration: Configuration;
}

// Installations can replace this module when building, while the default build
// remains self-contained. Admission can only narrow verified memberships.
export const createRuntimeExtension = (_context: RuntimeExtensionContext): RuntimeExtension => ({});
