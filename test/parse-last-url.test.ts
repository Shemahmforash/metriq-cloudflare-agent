import { describe, expect, it } from "vitest";
import { parseLastUrl } from "../src/agent-loop";

describe("parseLastUrl", () => {
  it("returns the single URL when input contains exactly one", () => {
    expect(parseLastUrl("https://example.com/fake-pr")).toBe(
      "https://example.com/fake-pr",
    );
  });

  it("returns the LAST URL when input contains multiple (noisy stdout case)", () => {
    const stdout = [
      "cloning https://github.com/example/target-repo",
      "fetching https://example.test/api/v1/mcp",
      "opening PR at https://github.com/example/target-repo/pull/42",
    ].join("\n");
    expect(parseLastUrl(stdout)).toBe(
      "https://github.com/example/target-repo/pull/42",
    );
  });

  it("returns null when input contains no URL", () => {
    expect(parseLastUrl("no url here, just words")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(parseLastUrl("")).toBeNull();
  });

  it("accepts http (not just https)", () => {
    expect(parseLastUrl("see http://example.org/path")).toBe(
      "http://example.org/path",
    );
  });
});
