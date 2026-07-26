import { describe, expect, it } from "vitest";
import { fenceLanguage, runnableLanguage } from "./runnable-code";

describe("fenceLanguage", () => {
  it("extracts the language from react-markdown's code className", () => {
    expect(fenceLanguage("language-python")).toBe("python");
  });

  it("finds the language token among other classes and lowercases it", () => {
    expect(fenceLanguage("hljs language-Python extra")).toBe("python");
  });

  it("returns null when the className is missing or has no language token", () => {
    expect(fenceLanguage(undefined)).toBeNull();
    expect(fenceLanguage("")).toBeNull();
    expect(fenceLanguage("hljs")).toBeNull();
  });
});

describe("runnableLanguage", () => {
  it("maps python and the py alias to the python kernel", () => {
    expect(runnableLanguage("python")).toBe("python");
    expect(runnableLanguage("py")).toBe("python");
  });

  it("rejects non-runnable languages and null", () => {
    expect(runnableLanguage("bash")).toBeNull();
    expect(runnableLanguage("javascript")).toBeNull();
    expect(runnableLanguage("r")).toBeNull();
    expect(runnableLanguage(null)).toBeNull();
  });
});
