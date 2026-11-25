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
  /** Origins the template declares in its project configuration; installing from its page grants them. */
  network: networkPolicy.optional(),
  /** Secrets its wrangler.jsonc requires; an install provides their values. */
  requiredSecrets: z.array(z.string()),
});

export const appTemplateCatalog = z.strictObject({
  templates: z.array(appTemplateSummary),
  createPrompt: z.string(),
});
