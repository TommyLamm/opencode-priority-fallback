// Simulation tests for priority-fallback.js with a fake V2 plugin ctx.
// Usage: npm test   (or: node --test test/priority-fallback.test.mjs)
import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), "pftest-"));
const pluginURL = process.env.PLUGIN_PATH ? pathToFileURL(process.env.PLUGIN_PATH).href : new URL("../priority-fallback.js", import.meta.url).href;
const plugin = (await import(pluginURL)).default;
const LOG = join(process.env.XDG_DATA_HOME, "opencode", "log", "priority-fallback.log");

const M1 = "opencode/deepseek-v4.1-flash-free";
const M2 = "opencode/glm-5.3-flash-free";
const M3 = "nvidia/deepseek-ai/deepseek-v4.1-flash";
const M4 = "nvidia/minimaxai/minimax-m3.1-flash";
const M5 = "nvidia/z-ai/glm-5.3-flash";
const OUTSIDE = "nvidia/moonshotai/kimi-k3";
const CATALOG = [
  [M1, 320000, ["low", "high", "max"]],
  [M2, 300000, ["low", "high", "max"]],
  [M3, 400000, ["none", "low", "high", "max"]],
  [M4, 262144, ["none", "thinking"]],
  [M5, 400000, ["none", "thinking"]],
  [OUTSIDE, 400000, ["max"]],
].map(([key, context, variants]) => {
  const slash = key.indexOf("/");
  return { providerID: key.slice(0, slash), id: key.slice(slash + 1), limit: { context }, variants: variants.map((id) => ({ id })), enabled: true };
});
const MIN = 60_000;

const ref = (key, variant) => {
  const slash = key.indexOf("/");
  return { providerID: key.slice(0, slash), id: key.slice(slash + 1), ...(variant ? { variant } : {}) };
};
const label = (m) => `${m.providerID}/${m.id}${m.variant ? `#${m.variant}` : ""}`;
const flush = async (n = 20) => {
  for (let i = 0; i < n; i++) {
    await new Promise((r) => setImmediate(r));
    mock.timers.tick(0);
  }
};

function harness(directory = "/home/user") {
  const queue = [];
  let wake;
  const calls = [];
  const sessions = new Map();
  const hooks = {};
  const ctx = {
    location: { directory },
    event: {
      subscribe: ({ signal }) => ({
        async *[Symbol.asyncIterator]() {
          while (!signal.aborted) {
            if (queue.length) yield queue.shift();
            else await new Promise((r) => (wake = r));
          }
        },
      }),
    },
    session: {
      get: async ({ sessionID }) => ({ data: structuredClone(sessions.get(sessionID)) }),
      switchModel: async ({ sessionID, model }) => {
        calls.push(`switch ${sessionID} ${label(model)}`);
        sessions.get(sessionID).model = model;
      },
      prompt: async ({ sessionID, text, metadata }) => {
        calls.push(`prompt ${sessionID} ${text}`);
        if (hooks.prompt) await hooks.prompt({ sessionID, metadata });
      },
      context: async () => [],
      hook: async (name, fn) => {
        hooks[name] = fn;
        return { dispose() {} };
      },
    },
    model: { list: async () => ({ data: CATALOG }) },
  };
  const emit = (type, data, location = { directory }) => {
    queue.push({ id: `evt_${Math.random()}`, type, ...(location ? { location } : {}), data });
    wake?.();
  };
  const addSession = (id, key, variant, extra = {}) => sessions.set(id, { id, model: ref(key, variant), time: {}, ...extra });
  return { ctx, calls, sessions, hooks, emit, addSession, stop: () => wake?.() };
}

let h;
let dispose;
async function start(directory) {
  h = harness(directory);
  dispose = await plugin.setup(h.ctx);
  await flush();
  return h;
}
const fail = (id, type, message = "boom") => h.emit("session.execution.failed", { sessionID: id, error: { type, message } });
const stepEnd = (id, tokens = 1000, finish = "tool-calls") =>
  h.emit("session.step.ended", { sessionID: id, assistantMessageID: "msg", finish, tokens: { input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } });
const stepStart = (id, key, variant) => h.emit("session.step.started", { sessionID: id, assistantMessageID: "msg", agent: "build", model: ref(key, variant) });

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_800_000_000_000 });
  const shared = globalThis.__opencodePriorityFallback;
  if (shared) {
    shared.cooldowns.clear();
    shared.sessions.clear();
    shared.seen.clear();
  }
});
afterEach(async () => {
  await dispose?.();
  h?.stop();
  mock.timers.reset();
});

test("failure on model 1 switches to model 2 keeping the variant, then continues", async () => {
  await start();
  h.addSession("s1", M1, "max");
  stepStart("s1", M1, "max");
  fail("s1", "provider.rate-limit", "Rate limit exceeded. Please try again later.");
  await flush();
  assert.deepEqual(h.calls, [`switch s1 ${M2}#max`, "prompt s1 continue"]);
});

test("cooldown blocks switch-back for 10 minutes, then a step end switches back", async () => {
  await start();
  h.addSession("s1", M1, "max");
  stepStart("s1", M1, "max");
  fail("s1", "provider.quota", "Free usage limit reached.");
  await flush();
  h.calls.length = 0;
  stepStart("s1", M2, "max");
  stepEnd("s1");
  await flush();
  assert.deepEqual(h.calls, [], "still cooling: stay on model 2");
  mock.timers.tick(10 * MIN + 1);
  stepEnd("s1");
  await flush();
  assert.deepEqual(h.calls, [`switch s1 ${M1}#max`]);
});

test("user prompt switches back once the cooldown has ended", async () => {
  await start();
  h.addSession("s1", M1);
  fail("s1", "provider.internal");
  await flush();
  h.calls.length = 0;
  mock.timers.tick(10 * MIN + 1);
  await h.hooks.prompt({ sessionID: "s1", metadata: {} });
  assert.deepEqual(h.calls, [`switch s1 ${M1}`]);
});

test("each failing model cools down in turn; all cooling waits for the earliest", async () => {
  await start();
  h.addSession("s1", M1, "max");
  const order = [M1, M2, M3, M4, M5];
  for (let i = 0; i < order.length; i++) {
    fail("s1", "provider.quota", "quota");
    await flush();
    mock.timers.tick(5_001); // MIN_GAP between continues
    await flush();
  }
  assert.deepEqual(h.calls, [
    `switch s1 ${M2}#max`, "prompt s1 continue",
    `switch s1 ${M3}#max`, "prompt s1 continue",
    `switch s1 ${M4}#thinking`, "prompt s1 continue",
    `switch s1 ${M5}#thinking`, "prompt s1 continue",
  ]);
  h.calls.length = 0;
  mock.timers.tick(9 * MIN);
  await flush();
  assert.deepEqual(h.calls, [], "nothing until model 1 cools down");
  mock.timers.tick(1 * MIN);
  await flush();
  assert.deepEqual(h.calls, [`switch s1 ${M1}#max`, "prompt s1 continue"]);
});

test("models whose context is too small are skipped", async () => {
  await start();
  h.addSession("s1", M1, "max");
  stepStart("s1", M1, "max");
  stepEnd("s1", 280_000);
  await flush();
  fail("s1", "provider.timeout");
  await flush();
  assert.deepEqual(h.calls, [`switch s1 ${M3}#max`, "prompt s1 continue"], "glm-free (300K) cannot hold 280K + headroom");
});

test("non-switchable errors and interrupts are ignored", async () => {
  await start();
  h.addSession("s1", M1);
  fail("s1", "provider.invalid-request", "Invalid request");
  fail("s1", "provider.rate-limit", "maximum context length exceeded");
  fail("s1", "provider.content-filter", "Provider blocked the response");
  h.emit("session.execution.interrupted", { sessionID: "s1", reason: "user" });
  await flush();
  mock.timers.tick(30 * MIN);
  await flush();
  assert.deepEqual(h.calls, []);
});

test("child sessions are never touched", async () => {
  await start();
  h.addSession("c1", M1, undefined, { parentID: "s1" });
  fail("c1", "provider.rate-limit");
  stepStart("c1", M2);
  stepEnd("c1");
  await flush();
  assert.deepEqual(h.calls, []);
});

test("a model outside the list is continued after 60s on the same model, quota is ignored", async () => {
  await start();
  h.addSession("s1", OUTSIDE, "max");
  fail("s1", "provider.quota", "quota");
  await flush();
  mock.timers.tick(10 * MIN);
  await flush();
  assert.deepEqual(h.calls, [], "quota on an outside model: no retry");
  fail("s1", "provider.transport", "ECONNRESET");
  await flush();
  mock.timers.tick(59_000);
  await flush();
  assert.deepEqual(h.calls, []);
  mock.timers.tick(1_001);
  await flush();
  assert.deepEqual(h.calls, ["prompt s1 continue"]);
});

test("a new execution that runs a step cancels a pending wait", async () => {
  await start();
  h.addSession("s1", OUTSIDE);
  fail("s1", "provider.transport");
  await flush();
  h.emit("session.execution.started", { sessionID: "s1" });
  stepStart("s1", OUTSIDE);
  await flush();
  mock.timers.tick(2 * MIN);
  await flush();
  assert.deepEqual(h.calls, []);
});

test("an empty execution right after the failure does not cancel the switch", async () => {
  await start();
  h.addSession("s1", M1, "max");
  stepStart("s1", M1, "max");
  // What opencode emitted on 2026-10-24: failed, then an empty execution that succeeds at once.
  fail("s1", "provider.free-limit", "Free usage limit reached.");
  h.emit("session.execution.started", { sessionID: "s1" });
  h.emit("session.execution.succeeded", { sessionID: "s1" });
  await flush();
  assert.deepEqual(h.calls, [`switch s1 ${M2}#max`, "prompt s1 continue"]);
});

test("an empty execution does not cancel an all-cooling wait either", async () => {
  await start();
  h.addSession("s1", OUTSIDE);
  fail("s1", "provider.transport");
  await flush();
  h.emit("session.execution.started", { sessionID: "s1" });
  h.emit("session.execution.succeeded", { sessionID: "s1" });
  await flush();
  mock.timers.tick(MIN + 1);
  await flush();
  assert.deepEqual(h.calls, ["prompt s1 continue"]);
});

test("retryAfterMs longer than the cooldown keeps the model cooling until then", async () => {
  await start();
  h.addSession("s1", M1, "max");
  stepStart("s1", M1, "max");
  h.emit("session.execution.failed", {
    sessionID: "s1",
    error: { type: "provider.free-limit", message: "Free usage limit reached.", status: 429, retryAfterMs: 8 * 60 * MIN },
  });
  await flush();
  h.calls.length = 0;
  mock.timers.tick(10 * MIN + 1);
  stepStart("s1", M2, "max");
  stepEnd("s1");
  await flush();
  assert.deepEqual(h.calls, [], "10 minutes is not enough: the free limit resets in 8 hours");
  mock.timers.tick(8 * 60 * MIN);
  stepEnd("s1");
  await flush();
  assert.deepEqual(h.calls, [`switch s1 ${M1}#max`]);
});

test("events for another location are ignored", async () => {
  await start("/home/user");
  h.addSession("s1", M1);
  h.emit("session.execution.failed", { sessionID: "s1", error: { type: "provider.rate-limit", message: "x" } }, { directory: "/elsewhere" });
  await flush();
  assert.deepEqual(h.calls, []);
});

test("the plugin's own continue does not deadlock through the prompt hook", async () => {
  await start();
  h.addSession("s1", M2);
  h.ctx.session.prompt = async ({ sessionID, text }) => {
    h.calls.push(`prompt ${sessionID} ${text}`);
    await h.hooks.prompt({ sessionID }); // a hook event without metadata
  };
  fail("s1", "provider.rate-limit");
  await flush();
  assert.deepEqual(h.calls, [`switch s1 ${M1}`, "prompt s1 continue"]);
  assert.match(readFileSync(LOG, "utf8"), /sent continue session=s1/);
});

test("a session on the default variant stays on the default variant", async () => {
  await start();
  h.addSession("s1", M1, "default");
  stepStart("s1", M1, "default");
  fail("s1", "provider.quota");
  await flush();
  assert.deepEqual(h.calls, [`switch s1 ${M2}`, "prompt s1 continue"]);
});

test("limits read during warm-up are not cached", async () => {
  await start();
  let reads = 0;
  const raw = CATALOG.map((m) => (m.providerID === "opencode" ? { ...m, limit: { context: 200000 } } : m));
  h.ctx.model.list = async () => ({ data: reads++ === 0 ? raw : CATALOG });
  h.addSession("s0", M3);
  h.addSession("s1", M1);
  mock.timers.tick(1_000);
  fail("s0", "provider.rate-limit"); // reads the catalog during warm-up
  await flush();
  assert.equal(reads, 1);
  stepStart("s1", M1);
  stepEnd("s1", 250_000, "stop");
  await flush();
  mock.timers.tick(11_000);
  h.calls.length = 0;
  fail("s1", "provider.rate-limit");
  await flush();
  assert.deepEqual(h.calls, [`switch s1 ${M2}`, "prompt s1 continue"], "glm-free override (300K) holds 250K");
});
