// When this app asks before a change runs: the levels its page and its
// setApprovalLevel method offer, from most to least careful.
// Teams has nothing to create without asking, so no level lies between
// always and never.
import type { Level } from "./approval.ts";

export const approvalLevels = ["all_changes", "none"] as const satisfies readonly Level[];

export const defaultApprovalLevel: (typeof approvalLevels)[number] = "all_changes";

/** What the page says above the levels. */
export const approvalIntro =
  "When apps and agents send messages or start chats with your account. Reading never asks.";

/** Each level's name and what it asks about, as the page and questions show them. */
export const levelTexts = {
  all_changes: {
    title: "Always ask",
    detail: "Every message and new chat asks first.",
  },
  none: {
    title: "Never ask",
    detail: "Messages are sent and chats started at once.",
  },
} satisfies Record<(typeof approvalLevels)[number], { title: string; detail: string }>;
