import { describe, expect, it } from "vitest";
import { z } from "zod";
import { observeSession } from "./d1-observation.ts";
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

/** Like workerd's D1 session, which keeps its transport in a private field since November 2026. */
class NativeSession {
  readonly #transport: Send;

  constructor(transport: Send) {
    this.#transport = transport;
  }

  async _send(...args: Parameters<Send>) {
    return this.#transport(...args);
  }

  prepare(): D1PreparedStatement {
    throw new Error("Unused fixture method");
  }

  async batch<T>(): Promise<D1Result<T>[]> {
    throw new Error("Unused fixture method");
  }

  getBookmark() {
    return null;
  }
}

const fixture = (transport: Send) => {
  const pending: Promise<void>[] = [];
  const events: Omit<DatabaseObservation, "binding" | "operation">[] = [];
  const context = { waitUntil: (promise: Promise<void>) => void pending.push(promise) };

  const observe = (
    session: D1DatabaseSession = new NativeSession(transport),
    collect = async (event: (typeof events)[number]) => void events.push(event),
  ) => observeSession(session, context, collect);

  const invoke = async (queries: string | string[] = "private SQL") => {
    const { session, complete } = observe();

    const response = await sessionSend
      .parse(session)
      ._send.call(session, "/query", queries, ["private parameter"], "ROWS_AND_COLUMNS");

    complete();

    return response;
  };

  return { context, pending, events, observe, invoke };
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
    const native = new NativeSession(async () => response);

    expect(test.observe(native).session).toBe(native);
    expect(Object.hasOwn(new NativeSession(async () => response), "_send")).toBe(false);
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

    const { session } = test.observe(undefined, async () => {
      throw new Error("Collector unavailable");
    });

    expect(await sessionSend.parse(session)._send.call(session, "/query", "write", [])).toBe(
      response,
    );
    await expect(Promise.all(test.pending)).rejects.toThrow("Collector unavailable");
    expect(calls).toBe(1);
  });

  const unavailable = async (pending: Promise<void>[]) => {
    const failures = await Promise.allSettled(pending);

    expect(failures).toHaveLength(1);

    const rejected = z
      .object({ status: z.literal("rejected"), reason: z.instanceof(Error) })
      .parse(failures[0]);

    expect(rejected.reason.message).toBe("D1 observation unavailable: incompatible native binding");
  };

  it.each(["session-send", "sealed-session"])(
    "keeps the native session and reports when setup is incompatible: %s",
    async (incompatible) => {
      const test = fixture(async () => ({ success: true }));
      const native = new NativeSession(async () => ({ success: true }));

      if (incompatible === "session-send")
        Object.defineProperty(native, "_send", { value: undefined });
      else Object.freeze(native);

      const { session, complete } = test.observe(native);

      expect(session).toBe(native);
      complete();
      expect(test.events).toEqual([]);
      await unavailable(test.pending);
    },
  );

  it("reports a query that completed without passing through the measured transport", async () => {
    const test = fixture(async () => ({ success: true }));
    const { complete } = test.observe();

    // As when D1 queries take a path other than _send, such as its JSRPC binding.
    complete();
    expect(test.events).toEqual([]);
    await unavailable(test.pending);
  });
});
