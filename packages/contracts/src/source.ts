import { z } from "zod";

export const gitCommit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);

export const gitBranch = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (name) =>
      name !== "HEAD" &&
      !name.startsWith("-") &&
      Array.from(name).every(
        (character) => character.charCodeAt(0) > 32 && character.charCodeAt(0) !== 127,
      ) &&
      !/[~^:?*[\\]/.test(name) &&
      !name.includes("..") &&
      !name.includes("@{") &&
      !name.endsWith(".") &&
      name
        .split("/")
        .every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock")),
    "Use a valid Git branch name",
  );

export const sourceRevision = z.strictObject({
  commit: gitCommit,
  branch: gitBranch,
  directory: z
    .string()
    .min(1)
    .max(1024)
    .refine(
      (path) =>
        path === "." ||
        path
          .split("/")
          .every((part) => part !== "" && part !== "." && part !== ".." && !part.includes("\\")),
      "Use a repository-relative project directory",
    ),
});

export const sourceRepository = z.strictObject({
  url: z.url(),
  branch: gitBranch,
  commit: gitCommit.nullable(),
});

export const appSource = z.strictObject({
  supported: z.boolean(),
  available: z.boolean(),
  error: z.string().optional(),
  repository: sourceRepository.nullable(),
  deployed: sourceRevision.nullable(),
});

export const sourceCredential = z.strictObject({
  url: z.url(),
  username: z.string().min(1),
  password: z.string().min(1),
  expiresAt: z.iso.datetime(),
});

export const sourceSetup = z.strictObject({ branch: gitBranch.optional() });

export const sourcePreparation = z.strictObject({
  organizationId: z.string().min(1),
  repository: sourceRepository.nullable(),
});
