// Compiled by `pnpm typecheck`: the results a consuming app sees.
import type Notion from "../src/app.ts";

declare const notion: Notion;

export const examples = async () => {
  const found = await notion.search({
    body: { query: "Roadmap", filter: { property: "object", value: "page" } },
  });

  if (found.status === "connected") {
    for (const result of found.data.results) {
      const id: string = result.id;
      void id;
    }

    const cursor = found.data.next_cursor;

    if (cursor) await notion.search({ body: { start_cursor: cursor } });
  }

  const database = await notion.getDatabase({ database_id: "d" });

  if (database.status === "connected" && "data_sources" in database.data)
    for (const source of database.data.data_sources) {
      const rows = await notion.queryDataSource({
        data_source_id: source.id,
        body: { page_size: 100 },
      });

      if (rows.status === "notion_error") void rows.error.code;
    }

  // @ts-expect-error Blocks need their ID.
  await notion.listBlockChildren({ page_size: 50 });
  // @ts-expect-error Query parameters have Notion's types.
  await notion.listUsers({ page_size: "5" });

  const created = await notion.createPage({
    body: {
      parent: { page_id: "p" },
      properties: { title: { title: [{ text: { content: "Notes" } }] } },
    },
  });

  if (created.resultType === "input_required") void created.inputRequests.approve.message;
};
