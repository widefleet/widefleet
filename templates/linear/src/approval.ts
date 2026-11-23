import { z } from "zod";
import type { ApprovalQuestion } from "./results.ts";
import type { JsonValue } from "./selection.ts";

/**
 * When a user is asked before a change runs, from most to least careful:
 * every change, changes to existing data, or never. Queries never ask.
 */
export const approvalLevels = ["all_changes", "updates_and_deletions", "none"] as const;

export type ApprovalLevel = (typeof approvalLevels)[number];

export const approvalLevel = z.enum(approvalLevels);

export const defaultApprovalLevel: ApprovalLevel = "updates_and_deletions";

export type Change = "create" | "update" | "delete";

/** Whether a change asks the user first at an approval level. */
export const asks = (level: ApprovalLevel, change: Change) =>
  change === "create" ? level === "all_changes" : level !== "none";

/** Whether moving from one level to another asks fewer questions. */
export const loosens = (from: ApprovalLevel, to: ApprovalLevel) =>
  approvalLevels.indexOf(to) > approvalLevels.indexOf(from);

export const levelDescriptions: Record<ApprovalLevel, string> = {
  all_changes: "Ask before every change",
  updates_and_deletions: "Ask before changing or deleting existing data",
  none: "Never ask",
};

/** Each Widefleet user's level, kept in the app's database. */
export const approvals = (database: D1Database, userId: string) => ({
  level: async () => {
    const saved = await database
      .prepare("SELECT level FROM approval_level WHERE userId = ?")
      .bind(userId)
      .first("level");

    return saved === null ? defaultApprovalLevel : approvalLevel.parse(saved);
  },
  set: async (level: ApprovalLevel) => {
    await database
      .prepare(
        "INSERT INTO approval_level (userId, level) VALUES (?, ?) ON CONFLICT (userId) DO UPDATE SET level = excluded.level",
      )
      .bind(userId, level)
      .run();
  },
});

// Widefleet shows questions of up to 4096 characters.
const maxMessage = 4096;

const maxPreviewString = 200;

const longString = z.string().min(maxPreviewString + 1);

export const question = (message: string): ApprovalQuestion => ({
  resultType: "input_required",
  inputRequests: {
    approve: { message, requestedSchema: { type: "object", properties: {} } },
  },
});

const changeWords: Record<Change, string> = {
  create: "creates data",
  update: "changes existing data",
  delete: "deletes or replaces data",
};

/**
 * The question asked before a change runs, with the mutation and its input.
 * When they do not fit, long strings are shortened with their length stated;
 * the approved call still runs with the complete input.
 */
export const changeQuestion = (mutation: string, change: Change, input: JsonValue) => {
  const ask = `Run the Linear change "${mutation}"? It ${changeWords[change]}.`;
  const exact = `${ask}\n\nInput:\n${JSON.stringify(input, null, 2)}`;

  if (exact.length <= maxMessage) return question(exact);

  const shortened = JSON.stringify(
    input,
    (_, value: JsonValue) => {
      const long = longString.safeParse(value);

      return long.success
        ? `${long.data.slice(0, maxPreviewString)}… (${long.data.length} characters)`
        : value;
    },
    2,
  );

  return question(
    `${ask}\n\nInput, shortened for review. Approving runs the change with the complete input:\n${shortened}`.slice(
      0,
      maxMessage,
    ),
  );
};

/** The answer Widefleet passes back after the user responded to a question. */
export const approvalAnswer = z
  .object({
    inputResponses: z.object({
      approve: z.object({ action: z.enum(["accept", "decline", "cancel"]) }).optional(),
    }),
  })
  .optional();
