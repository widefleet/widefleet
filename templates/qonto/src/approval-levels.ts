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
  "When apps and agents change your Qonto organization with your account. Reading never asks.";

/** Each level's name and what it asks about, as the page and questions show them. */
export const levelTexts = {
  all_changes: {
    title: "Always ask",
    detail:
      "Every new card, client and quote asks first, and so do transfers, sending invoices, changing and deleting.",
  },
  updates_and_deletions: {
    title: "Ask except for new cards, clients and quotes",
    detail:
      "New cards, clients, quotes, beneficiaries and transfer requests are created at once. Transfers, sending invoices, changing and deleting ask first.",
  },
  none: {
    title: "Never ask",
    detail:
      "Transfers and all other changes run at once. Payments to beneficiaries your organization has not trusted still need approval on your paired phone.",
  },
} satisfies Record<(typeof approvalLevels)[number], { title: string; detail: string }>;
