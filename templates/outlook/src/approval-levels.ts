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
  "When apps and agents send email or change your mailbox and calendar. Reading never asks.";

/** Each level's name and what it asks about, as the page and questions show them. */
export const levelTexts = {
  all_changes: {
    title: "Always ask",
    detail:
      "Every new draft, folder and contact asks first, and so do sending, events, changing and deleting.",
  },
  updates_and_deletions: {
    title: "Ask except for drafts, folders and contacts",
    detail:
      "New drafts, folders, contacts and calendars are created at once. Sending, events, changing and deleting ask first.",
  },
  none: {
    title: "Never ask",
    detail: "Email is sent, events are scheduled, and changes and deletions run at once.",
  },
} satisfies Record<(typeof approvalLevels)[number], { title: string; detail: string }>;
