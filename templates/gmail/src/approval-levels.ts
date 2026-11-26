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
  "When apps and agents send or change email with your account. Reading never asks.";

/** Each level's name and what it asks about, as the page and questions show them. */
export const levelTexts = {
  all_changes: {
    title: "Always ask",
    detail: "Every new draft and label asks first, and so do sending, changing and deleting email.",
  },
  updates_and_deletions: {
    title: "Ask except for drafts and labels",
    detail:
      "New drafts and labels are created at once. Sending, changing and deleting email ask first.",
  },
  none: {
    title: "Never ask",
    detail: "Email is sent, changed and deleted at once.",
  },
} satisfies Record<(typeof approvalLevels)[number], { title: string; detail: string }>;
