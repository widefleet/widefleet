// When this app asks before a change runs: the levels its page and its
// setApprovalLevel method offer, from most to least careful.
import type { Level } from "./approval.ts";

export const approvalLevels = [
  "all_changes",
  "updates_and_deletions",
  "none",
] as const satisfies readonly Level[];

export const defaultApprovalLevel: (typeof approvalLevels)[number] = "updates_and_deletions";

/** What the page says above the levels. */
export const approvalIntro =
  "When apps and agents change your environments' data and settings. Reading never asks.";

/** Each level's name and what it asks about, as the page and questions show them. */
export const levelTexts = {
  all_changes: {
    title: "Always ask",
    detail:
      "Every new row, table and column asks first, and so do changing, linking, sharing, deleting and calling actions.",
  },
  updates_and_deletions: {
    title: "Ask except for additions",
    detail:
      "Columns and rows added to another row are created at once. New rows in a table, changing, linking, sharing, deleting and calling actions ask first.",
  },
  none: {
    title: "Never ask",
    detail: "Rows are created, changed, linked and deleted, and actions run, at once.",
  },
} satisfies Record<(typeof approvalLevels)[number], { title: string; detail: string }>;
