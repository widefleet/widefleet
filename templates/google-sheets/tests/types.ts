// Compiled by `pnpm typecheck`: the results a consuming app sees for typed selections.
import type GoogleSheets from "../src/app.ts";

declare const sheets: GoogleSheets;

export const selections = async () => {
  const spreadsheet = await sheets.get(
    { spreadsheetId: "sheet-1" },
    { properties: { title: true }, sheets: { properties: { sheetId: true, title: true } } },
  );

  if (spreadsheet.status === "connected") {
    const title: string | undefined = spreadsheet.data.properties?.title;
    const sheet: number | undefined = spreadsheet.data.sheets?.[0]?.properties?.sheetId;
    // @ts-expect-error Not selected.
    void spreadsheet.data.spreadsheetUrl;
    void [title, sheet];
  }

  // @ts-expect-error Spreadsheet has no such field.
  await sheets.get({ spreadsheetId: "s" }, { notAField: true });
  // @ts-expect-error A related object needs a nested selection.
  await sheets.get({ spreadsheetId: "s" }, { properties: true });
  // @ts-expect-error The range is required.
  await sheets.valuesGet({ spreadsheetId: "s" }, { values: true });
  await sheets.valuesUpdate(
    // @ts-expect-error valueInputOption has fixed choices.
    { spreadsheetId: "s", range: "A1", valueInputOption: "FORMULA", body: { values: [["1"]] } },
    { updatedCells: true },
  );

  await sheets.valuesUpdate(
    // @ts-expect-error valueInputOption is required for writes.
    { spreadsheetId: "s", range: "A1", body: { values: [["1"]] } },
    { updatedCells: true },
  );

  const appended = await sheets.valuesAppend(
    {
      spreadsheetId: "s",
      range: "Sheet1!A:C",
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      body: { values: [["2026-12-01", "Coffee", 4.5]] },
    },
    { updates: { updatedRange: true } },
  );

  if (appended.resultType === "input_required") void appended.inputRequests.approve.message;
};

// The example in template.md.
export const read = async () => {
  const range = await sheets.valuesGet(
    { spreadsheetId: "sheet-1", range: "Expenses!A2:C", valueRenderOption: "UNFORMATTED_VALUE" },
    { values: true },
  );

  if (range.status === "connected")
    for (const [date, item, amount] of range.data.values ?? []) void [date, item, amount];
};
