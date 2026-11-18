import { afterEach, describe, expect, it, vi } from "vitest";
import { openInput, requestedInput, sealInput } from "./service-input.ts";

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
});
