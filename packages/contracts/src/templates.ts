import { z } from "zod";

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
  capabilities: z.array(z.string()),
  setup: z.string(),
  network: z.array(z.url()),
  secrets: z.array(z.string()),
  instructions: z.string(),
  examples: z.array(z.strictObject({ description: z.string(), code: z.string() })),
  prompt: z.string(),
});

export const appTemplateCatalog = z.strictObject({
  templates: z.array(appTemplateSummary),
  createPrompt: z.string(),
});
