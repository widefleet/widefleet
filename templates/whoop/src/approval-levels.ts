// When this app asks before a change runs: the levels its page and its
// setApprovalLevel method offer, from most to least careful.
// WHOOP has nothing to create without asking, so no level lies between
// always and never.
import type { Level } from "./approval.ts";

export const approvalLevels = ["all_changes", "none"] as const satisfies readonly Level[];

export const defaultApprovalLevel: (typeof approvalLevels)[number] = "all_changes";

/** What the page says above the levels. */
export const approvalIntro =
  "When apps and agents revoke this app's access to your WHOOP account. Reading never asks.";

/** Each level's name and what it asks about, as the page and questions show them. */
export const levelTexts = {
  all_changes: {
    title: "Always ask",
    detail: "Revoking this app's access asks first.",
  },
  none: {
    title: "Never ask",
    detail: "Revoking this app's access runs at once.",
  },
} satisfies Record<(typeof approvalLevels)[number], { title: string; detail: string }>;
