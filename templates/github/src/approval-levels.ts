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
  "When apps and agents change GitHub with your account. Reading never asks.";

/** Each level's name and what it asks about, as the page and questions show them. */
export const levelTexts = {
  all_changes: {
    title: "Always ask",
    detail:
      "Every new issue, pull request and comment asks first, and so do changing, merging and deleting.",
  },
  updates_and_deletions: {
    title: "Ask except for new issues, pull requests and comments",
    detail:
      "New issues, pull requests, comments, branches and repositories are created at once. Changing, closing, merging and deleting ask first.",
  },
  none: {
    title: "Never ask",
    detail: "Everything runs at once, including merging and deleting.",
  },
} satisfies Record<(typeof approvalLevels)[number], { title: string; detail: string }>;
