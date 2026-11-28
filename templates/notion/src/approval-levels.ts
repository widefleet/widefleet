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
  "When apps and agents change your Notion workspace with your account. Reading and searching never ask.";

/** Each level's name and what it asks about, as the page and questions show them. */
export const levelTexts = {
  all_changes: {
    title: "Always ask",
    detail:
      "Every new page, block, comment and upload asks first, and so do changing, deleting and messaging agents.",
  },
  updates_and_deletions: {
    title: "Ask except for new content",
    detail:
      "New pages, blocks, comments and uploads are created at once. Changing, deleting and messaging agents ask first.",
  },
  none: {
    title: "Never ask",
    detail: "Content is created, changed and deleted, and agents are messaged, at once.",
  },
} satisfies Record<(typeof approvalLevels)[number], { title: string; detail: string }>;
