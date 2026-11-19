import { afterEach, describe, expect, it, vi } from "vitest";
import { inputAnswer, sealedInputRequired } from "@platform/contracts";
import { openInput, rebindInput, requestedInput, sealInput } from "./service-input.ts";

const secret = "service-input-test-secret-never-deploy";

const binding = JSON.stringify(["mcp", "org", "https://issuer.example.test", "alice"]);

const call = { appId: crypto.randomUUID(), entrypoint: "Offers", method: "send", args: [42] };

const question = requestedInput({
  resultType: "input_required",
  inputRequests: {
    confirm: {
      message: "Send offer 42?",
      requestedSchema: {
        type: "object",
        properties: {
          note: { type: "string", maxLength: 20 },
          priority: { type: "string", enum: ["low", "high"] },
          copies: { type: "integer", minimum: 1 },
        },
        required: ["priority"],
      },
    },
  },
  requestState: { text: "Offer text the person saw" },
});

const sealed = async () => {
  if (!question) throw new Error("Expected an input request");

  return sealInput(secret, binding, call, question);
};

afterEach(() => {
  vi.useRealTimers();
});

describe("Service input requests", () => {
  it("recognizes questions and leaves other results alone", () => {
    expect(question?.inputRequests["confirm"]?.message).toBe("Send offer 42?");
    expect(requestedInput({ resultType: "complete" })).toBeUndefined();
    expect(requestedInput(null)).toBeUndefined();
    expect(() => requestedInput({ resultType: "input_required", inputRequests: {} })).toThrow(
      "Invalid input request",
    );
  });

  it("hides the provider's state and returns it with validated answers", async () => {
    const { requestState, inputRequests } = await sealed();
    expect(requestState).not.toContain("Offer text");
    expect(inputRequests).toEqual(question?.inputRequests);

    expect(
      await openInput(secret, binding, call, {
        requestState,
        inputResponses: {
          confirm: { action: "accept", content: { priority: "high", copies: 2 } },
          unasked: { action: "accept", content: {} },
        },
      }),
    ).toEqual({
      inputResponses: { confirm: { action: "accept", content: { priority: "high", copies: 2 } } },
      requestState: { text: "Offer text the person saw" },
    });
  });

  it.each([
    { action: "accept", content: {} },
    { action: "accept", content: { priority: "urgent" } },
    { action: "accept", content: { priority: "low", copies: 0 } },
    { action: "accept", content: { priority: "low", note: "x".repeat(21) } },
    { action: "accept", content: { priority: "low", extra: true } },
    { action: "approve" },
  ])("treats an answer that does not fit the form as unanswered: %j", async (response) => {
    const { requestState } = await sealed();

    expect(
      await openInput(secret, binding, call, {
        requestState,
        inputResponses: { confirm: response },
      }),
    ).toEqual({ inputResponses: {}, requestState: { text: "Offer text the person saw" } });
  });

  it("passes declines and cancellations through", async () => {
    const { requestState } = await sealed();

    for (const action of ["decline", "cancel"])
      expect(
        await openInput(secret, binding, call, {
          requestState,
          inputResponses: { confirm: { action } },
        }),
      ).toMatchObject({ inputResponses: { confirm: { action } } });
  });

  it("rejects state for another caller, another call, a modified token or after expiry", async () => {
    const { requestState } = await sealed();
    const inputResponses = { confirm: { action: "decline" } };
    const modified = `${requestState.slice(0, -2)}${requestState.endsWith("A") ? "B" : "A"}A`;

    const attempts = [
      () =>
        openInput(
          secret,
          JSON.stringify(["mcp", "org", "https://issuer.example.test", "bob"]),
          call,
          {
            requestState,
            inputResponses,
          },
        ),
      () => openInput(secret, binding, { ...call, args: [43] }, { requestState, inputResponses }),
      () =>
        openInput(secret, binding, { ...call, method: "cancel" }, { requestState, inputResponses }),
      () =>
        openInput("another-secret-of-sufficient-length", binding, call, {
          requestState,
          inputResponses,
        }),
      () => openInput(secret, binding, call, { requestState: modified, inputResponses }),
      () => openInput(secret, binding, call, { requestState: "", inputResponses }),
    ];

    for (const attempt of attempts)
      await expect(attempt()).rejects.toThrow("Invalid or expired input request state");

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000 + 1);
    await expect(
      openInput(secret, binding, call, { requestState, inputResponses }),
    ).rejects.toThrow("Invalid or expired input request state");
  });

  it("hands a question to another channel without extending its lifetime", async () => {
    const { requestState } = await sealed();
    const form = JSON.stringify(["mcp-form", "org", "https://issuer.example.test", "alice"]);
    const inputResponses = { confirm: { action: "decline" } };
    const moved = await rebindInput(secret, binding, form, call, requestState);

    expect(moved.inputRequests).toEqual(question?.inputRequests);
    expect(
      await openInput(secret, form, call, { requestState: moved.requestState, inputResponses }),
    ).toEqual({ inputResponses, requestState: { text: "Offer text the person saw" } });

    // State for one channel does not answer through the other.
    await expect(
      openInput(secret, binding, call, { requestState: moved.requestState, inputResponses }),
    ).rejects.toThrow("Invalid or expired input request state");
    await expect(openInput(secret, form, call, { requestState, inputResponses })).rejects.toThrow(
      "Invalid or expired input request state",
    );
    await expect(
      rebindInput(secret, binding, form, { ...call, args: [43] }, requestState),
    ).rejects.toThrow("Invalid or expired input request state");

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000 + 1);
    await expect(
      openInput(secret, form, call, { requestState: moved.requestState, inputResponses }),
    ).rejects.toThrow("Invalid or expired input request state");
  });

  it("keeps argument types apart when matching the call", async () => {
    const pairs = [
      { asked: [42n], other: [{ $bigint: "42" }] },
      { asked: [new Uint8Array([1, 255])], other: [new Int8Array([1, -1])] },
      { asked: [new Map([["a", 1]])], other: [[["a", 1]]] },
      { asked: [new Set([1])], other: [[1]] },
      { asked: [Number.NaN], other: [null] },
      { asked: [Infinity], other: [null] },
      { asked: [0], other: [-0] },
      { asked: [undefined], other: [null] },
      { asked: [1], other: ["1"] },
    ];

    for (const { asked, other } of pairs) {
      if (!question) throw new Error("Expected an input request");
      const { requestState } = await sealInput(secret, binding, { ...call, args: asked }, question);
      const inputResponses = { confirm: { action: "decline" } };

      await expect(
        openInput(secret, binding, { ...call, args: asked }, { requestState, inputResponses }),
      ).resolves.toMatchObject({ inputResponses });
      await expect(
        openInput(secret, binding, { ...call, args: other }, { requestState, inputResponses }),
      ).rejects.toThrow("Invalid or expired input request state");
    }
  });

  it("checks string formats in accepted answers", async () => {
    const formatted = requestedInput({
      resultType: "input_required",
      inputRequests: {
        contact: {
          message: "Who should receive it?",
          requestedSchema: {
            type: "object",
            properties: {
              email: { type: "string", format: "email" },
              site: { type: "string", format: "uri" },
              day: { type: "string", format: "date" },
              at: { type: "string", format: "date-time" },
            },
          },
        },
      },
    });

    if (!formatted) throw new Error("Expected an input request");
    const { requestState } = await sealInput(secret, binding, call, formatted);

    const valid = {
      email: "alice@example.com",
      site: "https://example.com/offers",
      day: "2026-11-19",
      at: "2026-11-19T10:15:00Z",
    };

    expect(
      await openInput(secret, binding, call, {
        requestState,
        inputResponses: { contact: { action: "accept", content: valid } },
      }),
    ).toMatchObject({ inputResponses: { contact: { action: "accept", content: valid } } });

    for (const invalid of [
      { email: "not-an-email" },
      { site: "not a url" },
      { day: "19.11.2026" },
      { at: "tomorrow" },
    ])
      expect(
        await openInput(secret, binding, call, {
          requestState,
          inputResponses: { contact: { action: "accept", content: invalid } },
        }),
      ).toEqual({ inputResponses: {}, requestState: null });
  });

  it("answers questions that use the full request and state limits", async () => {
    const largest = requestedInput({
      resultType: "input_required",
      inputRequests: Object.fromEntries(
        Array.from({ length: 4 }, (_, index) => [`q${index}`, { message: "x".repeat(4000) }]),
      ),
      requestState: "s".repeat(8 * 1024 - 2),
    });

    if (!largest) throw new Error("Expected an input request");

    const sealedLargest = await sealInput(
      secret,
      JSON.stringify(["mcp", "org", `https://${"i".repeat(200)}.example.test`, "s".repeat(255)]),
      call,
      largest,
    );

    expect(sealedInputRequired.safeParse(sealedLargest).success).toBe(true);
    expect(
      inputAnswer.safeParse({ requestState: sealedLargest.requestState, inputResponses: {} })
        .success,
    ).toBe(true);
  });
});
