import { z } from "zod";

const migrationName = z
  .string()
  .max(512)
  .regex(/^[0-9]+[A-Za-z0-9_./-]*\.sql$/i)
  .refine(
    (name) =>
      name.split("/").every((part) => part !== "" && part !== "." && part !== "..") &&
      BigInt(/^[0-9]+/.exec(name)?.[0] ?? "0") <= 18446744073709551615n,
    "Use a relative SQL path with a numeric version prefix",
  );

export const migrationEntry = z.strictObject({ name: migrationName, applied: z.boolean() });

export const migrationRequest = z
  .strictObject({
    action: z.enum(["list", "apply"]),
    database: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
    databaseId: z.string().min(1).max(128),
    table: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
    files: z
      .array(
        z.strictObject({
          name: migrationName,
          sql: z
            .string()
            .max(1024 * 1024)
            .refine((sql) => !sql.includes("\0"))
            .optional(),
        }),
      )
      .max(1000),
  })
  .superRefine((request, context) => {
    const names = new Set<string>();
    let bytes = 0;

    for (const [index, file] of request.files.entries()) {
      if (names.has(file.name))
        context.addIssue({
          code: "custom",
          path: ["files", index, "name"],
          message: "Duplicate migration name",
        });
      names.add(file.name);

      if ((request.action === "apply") !== (file.sql !== undefined))
        context.addIssue({
          code: "custom",
          path: ["files", index, "sql"],
          message: "SQL is required only for apply",
        });
      const size = new TextEncoder().encode(file.sql ?? "").byteLength;
      bytes += size;

      if (size > 1024 * 1024)
        context.addIssue({
          code: "custom",
          path: ["files", index, "sql"],
          message: "SQL exceeds 1 MiB",
        });
    }

    if (bytes > 8 * 1024 * 1024)
      context.addIssue({ code: "custom", path: ["files"], message: "Migration SQL exceeds 8 MiB" });
  });

export const migrationOperation = z.strictObject({
  id: z.uuid(),
  state: z.enum(["queued", "running", "succeeded", "failed"]),
  message: z.string().nullable(),
  entries: z.array(migrationEntry).max(1000).nullable(),
});
