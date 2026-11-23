// How the template generator offers Excel's operations of Microsoft Graph:
// workbooks stored in OneDrive and SharePoint, found through their drives.
// Graph describes far more than workbooks, and most of its workbook operations
// are worksheet functions, so this file lists the operations the template
// offers, by operation ID, with their method names. Operations that change
// data name the change they make, which decides when they ask the user first
// (see src/approval.ts). Only additions that leave existing data as it was
// count as `create`; clearing cells counts as a deletion.

/** Where the generator reads the API, and the names of the generated code. */
export const generator = {
  kind: "openapi",
  source:
    "https://raw.githubusercontent.com/microsoftgraph/msgraph-metadata/master/openapi/v1.0/openapi.yaml",
  service: {
    name: "Excel",
    className: "ExcelApi",
    result: "ExcelResult",
    properties: "ExcelProperties",
    typePrefix: "microsoft.graph.",
  },
} as const;

export type Change = "create" | "update" | "delete" | "send";

// Graph reads the session of a workbook call from a header its description leaves out.
const session = {
  sessionId: {
    name: "workbook-session-id",
    description:
      "The `id` of a session from `createSession`. Without it, the call works on the workbook without a session.",
  },
};

export const operations = {
  // Finding workbooks
  "me.GetDrive": { name: "myDrive" },
  "me.ListDrives": { name: "listDrives" },
  "drives.drive.search": {
    name: "search",
    description: "Search a drive for files by name and content, such as `.xlsx` to find workbooks.",
  },
  "drives.drive.recent": { name: "recentItems" },
  "drives.GetItems": { name: "getItem" },
  "drives.items.ListChildren": { name: "listChildren" },

  // Sessions change no data; the calls made in them ask as usual.
  "drives.drive.items.driveItem.workbook.createSession": {
    name: "createSession",
    change: "read",
    description:
      "Create a session for a series of calls. With `persistChanges: true`, changes are saved to the workbook; otherwise they are discarded when the session ends. Pass its `id` as `sessionId`.",
  },
  "drives.drive.items.driveItem.workbook.refreshSession": {
    name: "refreshSession",
    change: "read",
    description: "Keep a session open.",
    headers: session,
  },
  "drives.drive.items.driveItem.workbook.closeSession": {
    name: "closeSession",
    change: "read",
    description: "Close a session.",
    headers: session,
  },

  // Worksheets
  "drives.items.workbook.ListWorksheets": { name: "listWorksheets", headers: session },
  "drives.items.workbook.GetWorksheets": {
    name: "getWorksheet",
    description: "Get a worksheet by its ID or name.",
    headers: session,
  },
  "drives.drive.items.driveItem.workbook.worksheets.add": {
    name: "addWorksheet",
    change: "create",
    headers: session,
  },
  "drives.items.workbook.UpdateWorksheets": {
    name: "updateWorksheet",
    change: "update",
    description: "Rename, move, hide or show a worksheet.",
    headers: session,
  },
  "drives.items.workbook.DeleteWorksheets": {
    name: "deleteWorksheet",
    change: "delete",
    description: "Delete a worksheet and its data.",
    headers: session,
  },

  // Ranges
  "drives.drive.items.driveItem.workbook.worksheets.workbookWorksheet.range-b0fa": {
    name: "getRange",
    description:
      "Get a range of a worksheet by its address, such as `A1:C10`, with its values, formulas, text and number formats. Whole columns or rows, such as `C:C`, read empty cells as null.",
    headers: session,
  },
  "drives.drive.items.driveItem.workbook.worksheets.workbookWorksheet.usedRange-63c8": {
    name: "usedRange",
    description:
      "Get the smallest range that holds the worksheet's data. With `valuesOnly: true`, cells that only have formatting are left out.",
    headers: session,
  },
  "drives.drive.items.driveItem.workbook.worksheets.workbookWorksheet.range.insert-b0fa": {
    name: "insertRange",
    change: "update",
    description: "Insert empty cells at a range, shifting the other cells down or right.",
    headers: session,
  },
  "drives.drive.items.driveItem.workbook.worksheets.workbookWorksheet.range.clear-b0fa": {
    name: "clearRange",
    change: "delete",
    description: "Clear a range's values, formats or both.",
    headers: session,
  },
  "drives.drive.items.driveItem.workbook.worksheets.workbookWorksheet.range.delete-b0fa": {
    name: "deleteRange",
    change: "delete",
    description: "Delete the cells of a range, shifting the other cells up or left.",
    headers: session,
  },

  // Tables
  "drives.items.workbook.ListTables": { name: "listTables", headers: session },
  "drives.items.workbook.worksheets.ListTables": { name: "listWorksheetTables", headers: session },
  "drives.items.workbook.GetTables": {
    name: "getTable",
    description: "Get a table by its ID or name.",
    headers: session,
  },
  "drives.drive.items.driveItem.workbook.tables.add": {
    name: "addTable",
    change: "create",
    description:
      "Turn a range, such as `Sheet1!A1:C1`, into a table. With `hasHeaders: true`, its first row names the columns.",
    headers: session,
  },
  "drives.items.workbook.UpdateTables": {
    name: "updateTable",
    change: "update",
    description: "Rename a table or change its style and its header and total rows.",
    headers: session,
  },
  "drives.items.workbook.DeleteTables": {
    name: "deleteTable",
    change: "delete",
    description: "Delete a table and its data.",
    headers: session,
  },
  "drives.items.workbook.tables.ListRows": {
    name: "listTableRows",
    description: "List a table's rows with their index and values.",
    headers: session,
  },
  "drives.drive.items.driveItem.workbook.tables.workbookTable.rows.add": {
    name: "addTableRows",
    change: "create",
    description:
      "Add rows to a table: `values` holds one list of cell values per row. Without `index`, the rows are added at the end.",
    headers: session,
  },
  "drives.items.workbook.tables.UpdateRows": {
    name: "updateTableRow",
    change: "update",
    description: "Replace the values of a table row, given by its zero-based index.",
    headers: session,
  },
  "drives.items.workbook.tables.DeleteRows": {
    name: "deleteTableRow",
    change: "delete",
    description: "Delete a table row, given by its zero-based index.",
    headers: session,
  },
  "drives.items.workbook.tables.ListColumns": { name: "listTableColumns", headers: session },
  "drives.drive.items.driveItem.workbook.tables.workbookTable.columns.add": {
    name: "addTableColumn",
    change: "create",
    description: "Add a column to a table, with its header and values.",
    headers: session,
  },
  "drives.items.workbook.tables.DeleteColumns": {
    name: "deleteTableColumn",
    change: "delete",
    description: "Delete a table column and its data.",
    headers: session,
  },

  // Named ranges and formulas
  "drives.items.workbook.ListNames": { name: "listNames", headers: session },
  "drives.items.workbook.GetNames": { name: "getName", headers: session },
  "drives.drive.items.driveItem.workbook.names.workbookNamedItem.range": {
    name: "getNamedRange",
    description: "Get the range a name refers to, with its values.",
    headers: session,
  },
  "drives.drive.items.driveItem.workbook.names.add": {
    name: "addName",
    change: "create",
    description: "Name a range or formula, such as `=Sheet1!$A$1:$B$10`.",
    headers: session,
  },
  "drives.items.workbook.DeleteNames": { name: "deleteName", change: "delete", headers: session },

  // Charts
  "drives.items.workbook.worksheets.ListCharts": { name: "listCharts", headers: session },
  "drives.items.workbook.worksheets.GetCharts": { name: "getChart", headers: session },
  "drives.drive.items.driveItem.workbook.worksheets.workbookWorksheet.charts.workbookChart.image-8f13":
    {
      name: "getChartImage",
      description: "Render a chart as a base64-encoded PNG image.",
      headers: session,
    },
  "drives.drive.items.driveItem.workbook.worksheets.workbookWorksheet.charts.add": {
    name: "addChart",
    change: "create",
    description:
      'Add a chart of a range\'s data, such as `{ type: "ColumnClustered", sourceData: "A1:B5", seriesBy: "Auto" }`.',
    headers: session,
  },
  "drives.items.workbook.worksheets.DeleteCharts": {
    name: "deleteChart",
    change: "delete",
    headers: session,
  },

  // Calculation
  "drives.drive.items.driveItem.workbook.application.calculate": {
    name: "calculate",
    change: "update",
    description: "Recalculate the workbook's formulas: `Recalculate`, `Full` or `FullRebuild`.",
    headers: session,
  },
} satisfies Record<
  string,
  {
    name: string;
    change?: Change | "read";
    description?: string;
    headers?: Record<string, { name: string; description: string }>;
  }
>;

// Graph writes a range with a PATCH to the address its `range` function reads.
export const undescribed = {
  updateRange: {
    operation: "drives.drive.items.driveItem.workbook.worksheets.workbookWorksheet.range-b0fa",
    method: "patch",
    change: "update",
    description:
      "Write a range's values, formulas or number formats, each as one list of cells per row, the size of the range. A null cell is left as it is.",
    body: ["microsoft.graph.workbookRange"],
    result: ["microsoft.graph.workbookRange"],
    headers: session,
  },
} satisfies Record<
  string,
  {
    operation: string;
    method: "post" | "put" | "patch" | "delete";
    change: Change;
    description: string;
    body: readonly string[];
    result?: readonly string[];
    headers?: Record<string, { name: string; description: string }>;
  }
>;
