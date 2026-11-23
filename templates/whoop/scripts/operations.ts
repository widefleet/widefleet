// How the template generator offers WHOOP's API: the connected member's
// profile, body measurements, cycles, recoveries, sleeps and workouts. This
// file lists the operations the template offers, by operation ID, with their
// method names. Operations that change data name the change they make, which
// decides when they ask the user first (see src/approval.ts). The `/v2/partner`
// operations are not offered: they serve WHOOP's trusted partners with their
// own client credentials, not members.

/** Where the generator reads the API, and the names of the generated code. */
export const generator = {
  kind: "openapi",
  source: "https://api.prod.whoop.com/developer/doc/openapi.json",
  service: {
    name: "WHOOP",
    className: "WhoopApi",
    result: "WhoopResult",
    properties: "WhoopProperties",
  },
} as const;

export type Change = "create" | "update" | "delete" | "send";

export const operations = {
  // Member
  getProfileBasic: { name: "getProfile" },
  getBodyMeasurement: { name: "getBodyMeasurement" },

  // Cycles, with the recovery and sleep of each
  getCycleCollection: { name: "listCycles" },
  getCycleById: { name: "getCycle" },
  getRecoveryForCycle: { name: "getCycleRecovery" },
  getSleepForCycle: { name: "getCycleSleep" },

  // Recoveries, sleeps and workouts
  getRecoveryCollection: { name: "listRecoveries" },
  getSleepCollection: { name: "listSleeps" },
  getSleepById: { name: "getSleep" },
  getWorkoutCollection: { name: "listWorkouts" },
  getWorkoutById: { name: "getWorkout" },

  // Ends the application's access to the member's data; WHOOP rejects the saved tokens afterwards.
  revokeUserOAuthAccess: { name: "revokeAccess", change: "delete" },
} satisfies Record<string, { name: string; change?: Change | "read"; description?: string }>;
