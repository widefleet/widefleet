// How the template generator offers each method of the Google Sheets API.
// Review this file when the generator reports a new or removed method.
//
// Every method that is not a GET is listed with the kind of change it makes,
// which decides when it asks the user first (see src/approval.ts), as `read`
// when it only reads, or with the reason it is not offered. Only additions that
// leave existing cells as they were count as `create`. GET methods are offered
// unless listed.

/** Where the generator reads the API, and the names of the generated code. */
export const generator = {
  kind: "discovery",
  source: "https://sheets.googleapis.com/$discovery/rest?version=v4",
  service: {
    name: "Google Sheets",
    className: "GoogleSheetsApi",
    result: "GoogleSheetsResult",
    properties: "GoogleSheetsProperties",
  },
} as const;

/**
 * The spreadsheets scope: every method accepts it, and unlike Drive's scopes it
 * reaches only spreadsheets.
 */
export const scopes = ["https://www.googleapis.com/auth/spreadsheets"];

/** Why a method is not offered. */
export const reasons = {} as const;

type Hidden = { hidden: keyof typeof reasons };

export type Change = "create" | "update" | "delete" | "send";

export const operations = {
  "sheets.spreadsheets.create": "create",
  // Adds, changes or deletes sheets, rows, formatting and more.
  "sheets.spreadsheets.batchUpdate": "update",
  "sheets.spreadsheets.getByDataFilter": "read",
  // Adds a copy of a sheet to a spreadsheet.
  "sheets.spreadsheets.sheets.copyTo": "create",
  "sheets.spreadsheets.developerMetadata.search": "read",
  "sheets.spreadsheets.values.update": "update",
  "sheets.spreadsheets.values.batchUpdate": "update",
  "sheets.spreadsheets.values.batchUpdateByDataFilter": "update",
  // Writes after a table; with insertDataOption OVERWRITE, the default, it can
  // overwrite cells below it.
  "sheets.spreadsheets.values.append": "update",
  "sheets.spreadsheets.values.clear": "delete",
  "sheets.spreadsheets.values.batchClear": "delete",
  "sheets.spreadsheets.values.batchClearByDataFilter": "delete",
  "sheets.spreadsheets.values.batchGetByDataFilter": "read",
} satisfies Record<string, Change | "read" | Hidden>;
