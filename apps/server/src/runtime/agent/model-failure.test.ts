import { describe, expect, it } from "vitest";
import { modelFailureFrom, modelFailureText, reportModelFailure } from "./model-failure.js";

const keyless = {
  role: "assistant",
  provider: "opencode-go",
  model: "deepseek-v4.1-flash",
  stopReason: "error",
  errorMessage: "Provider is not configured: opencode-go",
};

describe("modelFailureFrom", () => {
  it("reads the provider, model and category out of the durable failed message", () => {
    expect(modelFailureFrom(keyless)).toEqual({
      category: "credential_missing",
      provider: "opencode-go",
      model: "deepseek-v4.1-flash",
      reason: "Provider is not configured: opencode-go",
    });
  });

  it("treats a refused credential as credential_missing and a provider outage as upstream_error", () => {
    expect(
      modelFailureFrom({ ...keyless, errorMessage: "401 Unauthorized: invalid api key" })?.category,
    ).toBe("credential_missing");
    expect(
      modelFailureFrom({ ...keyless, errorMessage: "503 Service Unavailable" })?.category,
    ).toBe("upstream_error");
    expect(
      modelFailureFrom({ ...keyless, errorMessage: "429 rate limit exceeded" })?.category,
    ).toBe("upstream_error");
  });

  it("ignores messages that did not fail", () => {
    expect(
      modelFailureFrom({
        role: "assistant",
        content: [{ type: "text", text: "OK" }],
        stopReason: "stop",
      }),
    ).toBeNull();
    expect(modelFailureFrom({ role: "user", content: "hello" })).toBeNull();
  });
});

describe("modelFailureText", () => {
  it("names the provider, model and category in one readable line", () => {
    expect(modelFailureText(modelFailureFrom(keyless)!)).toBe(
      "Model request failed (opencode-go/deepseek-v4.1-flash, credential_missing): Provider is not configured: opencode-go",
    );
  });

  it("collapses a multi-line provider body and caps what reaches history", () => {
    const raw = `${"x".repeat(5000)}\n\nsecond line`;
    const failure = modelFailureFrom({ ...keyless, errorMessage: raw })!;
    const text = modelFailureText(failure);
    expect(text).not.toContain("\n");
    expect(text.length).toBeLessThanOrEqual(
      "Model request failed (opencode-go/deepseek-v4.1-flash, model_error): ".length + 301,
    );
    expect(failure.reason).toBe(raw);
  });

  it("classifies on the untruncated reason even when the body is capped for display", () => {
    expect(
      modelFailureFrom({ ...keyless, errorMessage: `${"x".repeat(5000)} 429 rate limit` })
        ?.category,
    ).toBe("upstream_error");
  });
});

describe("reportModelFailure", () => {
  it("emits one structured error line for a failed assistant message", () => {
    const calls: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
    reportModelFailure((level, message, fields) => calls.push({ level, message, fields }), {
      type: "message.completed",
      message: keyless,
    });
    expect(calls).toEqual([
      {
        level: "error",
        message:
          "Model request failed (opencode-go/deepseek-v4.1-flash, credential_missing): Provider is not configured: opencode-go",
        fields: {
          provider: "opencode-go",
          model: "deepseek-v4.1-flash",
          category: "credential_missing",
        },
      },
    ]);
  });

  it("stays quiet for successful messages and unrelated events", () => {
    const calls: string[] = [];
    const log = (level: string, message: string) => {
      calls.push(`${level}:${message}`);
    };
    reportModelFailure(log, {
      type: "message.completed",
      message: { role: "assistant", content: [], stopReason: "stop" },
    });
    reportModelFailure(log, { type: "operation.settled", status: "failed" });
    expect(calls).toEqual([]);
  });
});
