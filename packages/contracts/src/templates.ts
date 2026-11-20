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
});

export const appTemplate = appTemplateSummary.extend({
  source: z.url(),
  markdown: z.string(),
  prompt: z.string(),
  /** Whether this installation builds templates for one-click installs. */
  installable: z.boolean(),
  /** Origins the template declares in widefleet.jsonc; installing from its page grants them. */
  network: networkPolicy.optional(),
});

export const appTemplateCatalog = z.strictObject({
  templates: z.array(appTemplateSummary),
  createPrompt: z.string(),
});
