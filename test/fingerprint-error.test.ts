import { describe, expect, it } from "vitest";
import { fingerprintError } from "../src/agent-loop";

describe("fingerprintError", () => {
  it("returns a 12-char hex string", async () => {
    const fp = await fingerprintError("anything");
    expect(fp).toMatch(/^[0-9a-f]{12}$/);
  });

  it("returns the same fp for identical errors", async () => {
    const a = await fingerprintError("boot failed: ENOSPC");
    const b = await fingerprintError("boot failed: ENOSPC");
    expect(a).toBe(b);
  });

  it("returns different fps for different errors", async () => {
    const a = await fingerprintError("boot failed: ENOSPC");
    const b = await fingerprintError("boot failed: ECONNREFUSED");
    expect(a).not.toBe(b);
  });

  it("normalizes whitespace and case so logically-equivalent errors collapse", async () => {
    const a = await fingerprintError("Boot Failed:   ENOSPC");
    const b = await fingerprintError("boot failed: ENOSPC");
    expect(a).toBe(b);
  });

  it("ignores everything after the first newline (stack-trace noise doesn't fragment fps)", async () => {
    const a = await fingerprintError(
      "boot failed: ENOSPC\n  at /app/entrypoint.sh:12",
    );
    const b = await fingerprintError(
      "boot failed: ENOSPC\n  at /app/entrypoint.sh:99",
    );
    expect(a).toBe(b);
  });
});
