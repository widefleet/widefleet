// How the template generator offers Garmin's Connect Personal API: a person's
// own activities, health and wellness data. Every operation only reads. The
// description gives the operations no IDs, so each is listed by its method and
// path, with its method name.
import { download, swaggerPage } from "./openapi.ts";

/** Where the generator reads the API, and the names of the generated code. */
export const generator = {
  kind: "openapi",
  source: swaggerPage,
  service: {
    name: "Garmin Connect",
    className: "GarminConnectApi",
    result: "GarminConnectResult",
    properties: "GarminConnectProperties",
  },
} as const;

// Garmin's Swagger page holds the description inside its script.
export { download };

export const operations = {
  // Activities
  "GET /activitylist-service/activities/search/activities": { name: "searchActivities" },
  "GET /activity-service/activity/{activityId}": { name: "getActivity" },
  "GET /activity-service/activity/{activityId}/workouts": { name: "getActivityWorkouts" },
  "GET /download-service/files/activity/{activityId}": {
    name: "downloadActivity",
    description:
      "Download an activity's original file, such as its FIT file, as a ZIP archive in `base64`.",
  },
  "GET /activity-service/activity/activityTypes/simple": { name: "listActivityTypes" },
  "GET /wellnessactivity-service/activity/summary/range/{fromDate}/{untilDate}": {
    name: "listWellnessActivities",
  },

  // Daily summaries
  "GET /usersummary-service/usersummary/daily": { name: "getDailySummary" },
  "GET /usersummary-service/v2/dailysummaries": { name: "listDailySummaries" },
  "GET /usersummary-service/stats/steps/daily/{startDate}/{endDate}": { name: "listDailySteps" },
  "GET /usersummary-service/stats/stress/daily/{startDate}/{endDate}": { name: "listDailyStress" },
  "GET /usersummary-service/stats/hydration/daily/{startDate}/{endDate}": {
    name: "listDailyHydration",
  },

  // Sleep
  "GET /sleep-service/sleep/dailySleep": { name: "getDailySleep" },
  "GET /sleep-service/sleep/dailySleepSummariesByDate": { name: "listDailySleep" },

  // Heart, Body Battery and breathing
  "GET /wellness-service/wellness/dailyHeartRate": { name: "getDailyHeartRate" },
  "GET /biometric-service/heartRateZones/v2": { name: "getHeartRateZones" },
  "GET /hrv-service/hrv/{calendarDate}": { name: "getHrv" },
  "GET /hrv-service/hrv/daily/{fromDate}/{toDate}": { name: "listDailyHrv" },
  "GET /wellness-service/wellness/bodyBattery/reports/daily": { name: "listDailyBodyBattery" },
  "GET /wellness-service/wellness/daily/spo2acclimation/{calendarDate}": { name: "getDailySpo2" },

  // Fitness
  "GET /metrics-service/metrics/maxmet/daily/{startDate}/{endDate}": { name: "listDailyVo2Max" },
  "GET /fitnessage-service/fitnessage/v2/{calendarDate}": { name: "getFitnessAge" },

  // Weight and nutrition
  "GET /weight-service/weight/all/{startDate}/{endDate}": { name: "listWeights" },
  "GET /weight-service/weight/range/{startDate}/{endDate}": { name: "getWeightRange" },
  "GET /goal-service/goal/user/effective/weightgoal/{startDate}/{endDate}": {
    name: "listWeightGoals",
  },
  "GET /nutrition-service/food/logs/{date}": { name: "getFoodLogs" },

  // Women's health
  "GET /periodichealth-service/menstrualcycle/summary/{calendarDate}": {
    name: "getMenstrualCycleSummary",
  },
  "GET /periodichealth-service/menstrualcycle/dayview/{calendarDate}": {
    name: "getMenstrualCycleDay",
  },

  // Profile
  "GET /userprofile-service/userprofile/settings": { name: "getProfileSettings" },
};
