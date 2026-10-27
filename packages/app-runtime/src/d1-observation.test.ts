import { describe, expect, it } from "vitest";
import { z } from "zod";
import { observeDatabase } from "./d1-observation.ts";
import type { DatabaseObservation } from "./runtime-extension.ts";
import type { Json } from "./types.ts";

type Send = (
  endpoint: string,
  sql: string | string[],
  parameters: Json[],
  format?: string,
) => Promise<Json>;

const sessionSend = z.object({
  _send: z.custom<Send>((value) => z.function().safeParse(value).success),
});

const fixture = (transport: Send) => {
  const session = () => ({
    _send: transport,
    prepare() {
      throw new Error("Unused fixture method");
    },
    async batch() {
      throw new Error("Unused fixture method");
    },
    getBookmark() {
      return null;
    },
  });

  const native = {
    ...session(),
    alwaysPrimarySession: session(),
    withSession: session,
    async exec() {
      throw new Error("Unused fixture method");
    },
    async dump() {
      throw new Error("Unused fixture method");
    },
  };

  const pending: Promise<void>[] = [];
  const events: Omit<DatabaseObservation, "binding" | "operation">[] = [];
  const context = { waitUntil: (promise: Promise<void>) => void pending.push(promise) };
  const database = native;
  const observed = observeDatabase(database, context, async (event) => void events.push(event));

  const invoke = (queries: string | string[] = "private SQL") => {
    const session = observed.withSession();

    return sessionSend
      .parse(session)
      ._send.call(session, "/query", queries, ["private parameter"], "ROWS_AND_COLUMNS");
  };

  return { native, database, observed, context, pending, events, invoke };
};

describe("D1 response observation", () => {
  it("returns the same response, forwards the same arguments once and leaves shared sessions untouched", async () => {
    const response = [
      { success: true, meta: { rows_read: 2, rows_written: 1, total_attempts: 3 } },
    ];

    const calls: Parameters<Send>[] = [];

    const test = fixture(async (...args) => {
      calls.push(args);

      return response;
    });

    expect(await test.invoke()).toBe(response);
    await Promise.all(test.pending);
    expect(calls).toEqual([["/query", "private SQL", ["private parameter"], "ROWS_AND_COLUMNS"]]);
    expect(
      test.events.map(({ timestamp, ...event }) => {
        expect(timestamp).toBeGreaterThan(0);

        return event;
      }),
    ).toEqual([{ statements: 1, outcome: "ok", rowsRead: 2, rowsWritten: 1 }]);
    expect(Object.getPrototypeOf(test.observed)).toBe(test.database);
    expect(test.native.alwaysPrimarySession._send).not.toBe(
      sessionSend.parse(test.observed.withSession())._send,
    );
    expect(JSON.stringify(test.events)).not.toMatch(/private|total_attempts/);
  });

  it.each([
    {
      response: [
        { success: true, meta: { rows_read: 2, rows_written: 1 } },
        { success: true, meta: { rows_read: 3, rows_written: 0 } },
      ],
      expected: { rowsRead: 5, rowsWritten: 1, outcome: "ok" },
    },
    {
      response: [
        { success: true, meta: { rows_read: 2, rows_written: 1 } },
        { success: true, meta: { rows_read: 3 } },
      ],
      expected: { rowsRead: 5, rowsWritten: null, outcome: "ok" },
    },
    {
      response: [{ success: true, meta: { rows_read: 2, rows_written: 1 } }],
      expected: { rowsRead: null, rowsWritten: null, outcome: "unknown" },
    },
    {
      response: { success: false, error: "private native error" },
      expected: { rowsRead: null, rowsWritten: null, outcome: "error" },
    },
    {
      response: [
        { success: true, meta: { rows_read: 0, rows_written: 0 } },
        { success: true, meta: { rows_read: 0, rows_written: 0 } },
      ],
      expected: { rowsRead: 0, rowsWritten: 0, outcome: "ok" },
    },
  ])("aggregates complete dimensions only: $expected", async ({ response, expected }) => {
    const test = fixture(async () => response);

    expect(await test.invoke(["one", "two"])).toBe(response);
    await Promise.all(test.pending);
    expect(
      test.events.map(({ timestamp, ...event }) => {
        expect(timestamp).toBeGreaterThan(0);

        return event;
      }),
    ).toEqual([{ statements: 2, ...expected }]);
  });

  it("keeps transport errors native and records unknown usage without retrying", async () => {
    const failure = new Error("private transport error");
    let calls = 0;

    const test = fixture(async () => {
      calls++;
      throw failure;
    });

    await expect(test.invoke()).rejects.toBe(failure);
    await Promise.all(test.pending);
    expect(calls).toBe(1);
    expect(
      test.events.map(({ timestamp, ...event }) => {
        expect(timestamp).toBeGreaterThan(0);

        return event;
      }),
    ).toEqual([
      {
        statements: 1,
        outcome: "error",
        rowsRead: null,
        rowsWritten: null,
      },
    ]);
  });

  it("reports incompatible metadata in background without replacing a committed result", async () => {
    const response = { changed: "private result" };
    const test = fixture(async () => response);

    expect(await test.invoke()).toBe(response);
    await expect(Promise.all(test.pending)).rejects.toThrow(
      "D1 observation received an incompatible response",
    );
    expect(
      test.events.map(({ timestamp, ...event }) => {
        expect(timestamp).toBeGreaterThan(0);

        return event;
      }),
    ).toEqual([]);
  });

  it("isolates collector failure without repeating SQL", async () => {
    let calls = 0;
    const response = { success: true, meta: { rows_read: 1, rows_written: 1 } };

    const test = fixture(async () => {
      calls++;

      return response;
    });

    const observed = observeDatabase(test.database, test.context, async () => {
      throw new Error("Collector unavailable");
    });

    expect(await sessionSend.parse(observed.withSession())._send("/query", "write", [])).toBe(
      response,
    );
    await expect(Promise.all(test.pending)).rejects.toThrow("Collector unavailable");
    expect(calls).toBe(1);
  });

  it.each(["primary", "primary-send", "session-send", "sealed-session"])(
    "preserves native execution and errors when setup is incompatible: %s",
    async (incompatible) => {
      for (const fails of [false, true]) {
        const test = fixture(async () => ({ success: true }));
        const result = { count: 1, duration: 0 };
        const failure = new Error("Native SQL failure");
        let calls = 0;

        const execute = async () => {
          calls++;

          if (fails) throw failure;

          return result;
        };

        const nativeSession = test.native.withSession();
        const rows: D1Result[] = [];
        let receivedBookmark: string | undefined;

        Object.defineProperty(nativeSession, "batch", {
          async value(this: D1DatabaseSession) {
            expect(this).toBe(nativeSession);
            await execute();

            return rows;
          },
        });
        Object.defineProperty(nativeSession, "getBookmark", { value: () => "native-bookmark" });
        Object.defineProperty(test.native, "exec", {
          value(this: D1Database) {
            expect(this).toBe(test.native);

            return execute();
          },
        });
        Object.defineProperty(test.native, "withSession", {
          value(bookmark?: string) {
            receivedBookmark = bookmark;

            return nativeSession;
          },
        });

        if (incompatible === "primary")
          Object.defineProperty(test.native, "alwaysPrimarySession", { value: undefined });
        else if (incompatible === "primary-send")
          Object.defineProperty(test.native.alwaysPrimarySession, "_send", { value: undefined });
        else if (incompatible === "session-send")
          Object.defineProperty(nativeSession, "_send", { value: undefined });
        else Object.freeze(nativeSession);

        const observed = observeDatabase(
          test.native,
          test.context,
          async (event) => void test.events.push(event),
        );

        const session = observed.withSession("previous-bookmark");
        const background = Promise.allSettled(test.pending);

        expect(session).toBe(nativeSession);
        expect(receivedBookmark).toBe("previous-bookmark");
        expect(session.getBookmark()).toBe("native-bookmark");
        expect(calls).toBe(0);

        const primary = incompatible === "primary" || incompatible === "primary-send";

        if (primary) expect(observed).toBe(test.native);

        const execution = primary ? observed.exec("write") : session.batch([]);

        if (fails) await expect(execution).rejects.toBe(failure);
        else expect(await execution).toBe(primary ? result : rows);
        expect(calls).toBe(1);
        expect(test.events).toEqual([]);
        const failures = await background;

        expect(failures).toHaveLength(1);

        const rejected = z
          .object({ status: z.literal("rejected"), reason: z.instanceof(Error) })
          .parse(failures[0]);

        expect(rejected.reason.message).toBe(
          "D1 observation unavailable: incompatible native binding",
        );
      }
    },
  );
});
