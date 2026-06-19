import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { env, fetchMock, SELF } from "cloudflare:test";
import { assertNoLeftoverAlarm, clearAlarm, noteAlarmArmed } from "./do-harness";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    AGENT_LOOP: DurableObjectNamespace;
    METRIQ_API_KEY: string;
    METRIQ_MCP_URL: string;
    CONTROL_TOKEN: string;
  }
}

describe("Worker routes", () => {
  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  // PERMANENT guard: trip deterministically if a route left a driven singleton
  // DO with a live real-time poll alarm (the CI isolation flake — see
  // do-harness.ts). The POST /wake route schedules a real-time IDLE poll alarm;
  // left live it fires ~1s later into a sibling test/file's isolated-storage pop
  // → UND_MOCK_ERR_MOCK_NOT_MATCHED + "Isolated storage failed".
  afterEach(() => {
    assertNoLeftoverAlarm();
  });

  it("GET /health → 200 ok", async () => {
    const res = await SELF.fetch("https://agent.test/health");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("POST /wake forwards to the singleton DO", async () => {
    fetchMock
      .get("https://example.test")
      .intercept({ path: "/api/v1/mcp", method: "POST" })
      .reply(() => ({
        statusCode: 200,
        data: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [
              { type: "text", text: JSON.stringify({ session_id: "via-worker" }) },
            ],
          },
        }),
        responseOptions: { headers: { "content-type": "application/json" } },
      }));

    const res = await SELF.fetch("https://agent.test/wake", {
      method: "POST",
      headers: { authorization: "Bearer test-token" },
    });
    expect(res.status).toBe(202);

    // /wake scheduled a REAL-TIME IDLE poll alarm (POLL_REARM_DELAY_MS = 1000ms)
    // on the singleton DO. THIS was the residual CI isolation-flake leaker: this
    // test never cleared it, so on slower CI it fired ~1s later into a sibling
    // test/file's isolated-storage pop → MockNotMatchedError ('/api/v1/mcp',
    // net.connect disabled) + "Isolated storage failed". Clear it
    // DETERMINISTICALLY in-test, in the same isolated-storage layer that armed it
    // (the only place the workers-pool runtime lets us cancel the timer).
    const stub = env.AGENT_LOOP.get(env.AGENT_LOOP.idFromName("singleton"));
    noteAlarmArmed(stub);
    await clearAlarm(stub);
  });

  it("POST /stop forwards to the singleton DO", async () => {
    const res = await SELF.fetch("https://agent.test/stop", {
      method: "POST",
      headers: { authorization: "Bearer test-token" },
    });
    expect(res.status).toBe(204);
  });

  it("unknown path → 404", async () => {
    const res = await SELF.fetch("https://agent.test/nope");
    expect(res.status).toBe(404);
  });
});

describe("Worker auth on control/debug routes", () => {
  it("POST /stop without a token → 401", async () => {
    const res = await SELF.fetch("https://agent.test/stop", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("GET /debug without a token → 401", async () => {
    const res = await SELF.fetch("https://agent.test/debug");
    expect(res.status).toBe(401);
  });

  it("POST /stop with the wrong token → 401", async () => {
    const res = await SELF.fetch("https://agent.test/stop", {
      method: "POST",
      headers: { authorization: "Bearer nope" },
    });
    expect(res.status).toBe(401);
  });

  it("GET /health needs no token → 200", async () => {
    const res = await SELF.fetch("https://agent.test/health");
    expect(res.status).toBe(200);
  });

  it("POST /stop with the right token → forwarded (204)", async () => {
    const res = await SELF.fetch("https://agent.test/stop", {
      method: "POST",
      headers: { authorization: "Bearer test-token" },
    });
    expect(res.status).toBe(204);
  });
});
