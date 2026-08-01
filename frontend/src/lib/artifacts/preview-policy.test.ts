import { describe, expect, it } from "vitest";
import { previewPolicy } from "./preview-policy";

describe("file preview policy", () => {
  it("keeps each format's loading and display decisions together", () => {
    expect(previewPolicy("html")).toEqual({ load: ["url", "text"], defaultTab: "preview", supportsCode: true });
    expect(previewPolicy("fits")).toEqual({ load: ["bytes"], defaultTab: "preview", supportsCode: false });
    expect(previewPolicy("text")).toEqual({ load: ["text"], defaultTab: "code", supportsCode: false });
  });
});
