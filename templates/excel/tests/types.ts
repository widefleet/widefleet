// Compiled by `pnpm typecheck`: the results a consuming app sees.
import type Excel from "../src/app.ts";

declare const excel: Excel;

export const examples = async () => {
  const drive = await excel.myDrive();

  const found =
    drive.status === "connected" && drive.data.id
      ? await excel.search({ driveId: drive.data.id, q: "Budget.xlsx" })
      : null;

  const workbook = found?.status === "connected" ? found.data.value?.[0] : undefined;

  if (drive.status === "connected" && drive.data.id && workbook?.id) {
    const at = { driveId: drive.data.id, driveItemId: workbook.id, workbookWorksheetId: "Sheet1" };
    const range = await excel.getRange({ ...at, address: "A1:C10" });

    if (range.status === "connected") {
      const address: string | null | undefined = range.data?.address;
      void [address, range.data?.values];
    }

    const written = await excel.updateRange({
      ...at,
      address: "D2:D3",
      body: { formulas: [["=SUM(A2:C2)"], ["=SUM(A3:C3)"]] },
    });

    if (written.resultType === "input_required") void written.inputRequests.approve.message;
  }

  const session = await excel.createSession({
    driveId: "d",
    driveItemId: "i",
    body: { persistChanges: true },
  });

  if (session.status === "connected" && session.data?.id) {
    const sessionId = session.data.id;

    const rows = await excel.listTableRows({
      driveId: "d",
      driveItemId: "i",
      workbookTableId: "Table1",
      sessionId,
    });

    if (rows.status === "connected")
      for (const row of rows.data.value ?? []) void [row.index, row.values];

    // A later page stays in the session.
    if (rows.status === "connected" && rows.data["@odata.nextLink"])
      await excel.listTableRows({ nextLink: rows.data["@odata.nextLink"], sessionId });

    await excel.closeSession({ driveId: "d", driveItemId: "i", sessionId });
  }

  // @ts-expect-error A range needs its address.
  await excel.getRange({ driveId: "d", driveItemId: "i", workbookWorksheetId: "Sheet1" });
  // @ts-expect-error A session is named by its ID.
  await excel.listWorksheets({ driveId: "d", driveItemId: "i", sessionId: 1 });
};
