import { z } from "zod";
import { networkPolicy } from "./network.ts";

export const templateId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/);

export const templatePath = z.strictObject({ templateId });

export const templateSearch = z.strictObject({ search: z.string().trim().max(200).default("") });

export const appTemplateSummary = z.strictObject({
  id: templateId,
  name: z.string(),
  description: z.string(),
  /** The newest app the caller manages that was installed from this template. */
  installedAppId: z.uuid().nullable(),
});

export const appTemplate = appTemplateSummary.extend({
  source: z.url(),
  markdown: z.string(),
  prompt: z.string(),
  /** Whether this installation builds templates for one-click installs. */
  installable: z.boolean(),
  /** Origins the template declares in widefleet.jsonc; installing from its page grants them. */
  network: networkPolicy.optional(),
  /** Secrets its wrangler.jsonc requires; an install provides their values. */
  requiredSecrets: z.array(z.string()),
  /** Markdown help keyed by the secret name in Wrangler. */
  secretHelp: z.record(z.string(), z.string()).optional(),
  /**
   * The host `markdown` and `secretHelp` name for the app: the installed app's,
   * or the one an install under the template's ID gets.
   */
  appHost: z.string(),
});

export const appTemplateCatalog = z.strictObject({
  templates: z.array(appTemplateSummary),
  createPrompt: z.string(),
});
