// How the template generator offers Strava's API: the connected athlete's
// profile, activities, streams, clubs, gear, routes, segments and uploads.
// Strava publishes a Swagger 2.0 description whose schemas live in sibling
// files; the generator reads it as OpenAPI 3 and brings those schemas in. This
// file lists the operations the template offers, by operation ID, with their
// method names. Operations that change data name the change they make, which
// decides when they ask the user first (see src/approval.ts). New activities
// appear in the athlete's followers' feeds unless their visibility says
// otherwise, so creating them is `send`.
//
// `updateLoggedInAthlete` is not offered: Strava's description puts its weight
// parameter in a path that has no place for it.

/** Where the generator reads the API, and the names of the generated code. */
export const generator = {
  kind: "openapi",
  source: "https://developers.strava.com/swagger/swagger.json",
  service: {
    name: "Strava",
    className: "StravaApi",
    result: "StravaResult",
    properties: "StravaProperties",
  },
} as const;

export type Change = "create" | "update" | "delete" | "send";

// Strava's API reference (https://developers.strava.com/docs/reference/)
// describes activity tags as form fields keyed by tag name, such as
// `tags[WithPet]=true`, for the tags WithPet, Recovery, Competition, ForACause
// and Commute, while its description lists one `tags` string field. The
// methods take the keyed fields instead.
const tagFields = {
  tags: null,
  ...Object.fromEntries(
    ["WithPet", "Recovery", "Competition", "ForACause", "Commute"].map((tag) => [
      `tags[${tag}]`,
      {
        type: "boolean",
        description: `Whether the activity has the ${tag} tag: true adds it, false removes it. Tags cannot be combined with \`commute\` in the same request.`,
      },
    ]),
  ),
};

export const operations = {
  // Athlete
  getLoggedInAthlete: { name: "getAthlete" },
  getLoggedInAthleteZones: { name: "getAthleteZones" },
  getStats: { name: "getAthleteStats" },

  // Activities
  getLoggedInAthleteActivities: { name: "listActivities" },
  getActivityById: { name: "getActivity" },
  createActivity: { name: "createActivity", change: "send", fields: tagFields },
  updateActivityById: { name: "updateActivity", change: "update" },
  getLapsByActivityId: { name: "listActivityLaps" },
  getZonesByActivityId: { name: "getActivityZones" },
  getCommentsByActivityId: { name: "listActivityComments" },
  getKudoersByActivityId: { name: "listActivityKudoers" },

  // Streams
  getActivityStreams: { name: "getActivityStreams" },
  getSegmentEffortStreams: { name: "getSegmentEffortStreams" },
  getSegmentStreams: { name: "getSegmentStreams" },
  getRouteStreams: { name: "getRouteStreams" },

  // Clubs and gear
  getLoggedInAthleteClubs: { name: "listClubs" },
  getClubById: { name: "getClub" },
  getGearById: { name: "getGear" },

  // Routes
  // Strava's path is /athletes/{id}/routes, but its description and API
  // reference document no `id` parameter.
  getRoutesByAthleteId: {
    name: "listRoutes",
    parameters: [
      {
        name: "id",
        in: "path",
        required: true,
        description: "The identifier of the athlete. Must match the authenticated athlete.",
        schema: { type: "integer", format: "int64" },
      },
    ],
  },
  getRouteById: { name: "getRoute" },
  getRouteAsGPX: { name: "exportRouteGpx" },
  getRouteAsTCX: { name: "exportRouteTcx" },

  // Segments and segment efforts
  getSegmentById: { name: "getSegment" },
  getLoggedInAthleteStarredSegments: { name: "listStarredSegments" },
  starSegment: { name: "starSegment", change: "update" },
  exploreSegments: { name: "exploreSegments" },
  getEffortsBySegmentId: { name: "listSegmentEfforts" },
  getSegmentEffortById: { name: "getSegmentEffort" },

  // Uploads create activities from FIT, TCX or GPX files.
  createUpload: { name: "createUpload", change: "send", fields: tagFields },
  getUploadById: { name: "getUpload" },
} satisfies Record<
  string,
  {
    name: string;
    change?: Change | "read";
    description?: string;
    parameters?: readonly object[];
    fields?: typeof tagFields;
  }
>;
