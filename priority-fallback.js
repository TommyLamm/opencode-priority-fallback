/**
 * priority-fallback — opencode 2.x (V2 plugin API) plugin.
 *
 * Keeps each top-level session on the highest-priority model in PRIORITY that
 * is available:
 *
 * - Never touches opencode's own retries. Only after an execution has finally
 *   failed (session.execution.failed) with a switchable error does the failed
 *   model go into a cooldown (shared by all sessions): COOLDOWN_MS, or the
 *   error's retryAfterMs when longer (a daily free limit). The session
 *   then moves to the first model in PRIORITY that is not cooling down and
 *   whose context limit fits the session, and is sent "continue".
 * - When every usable model is cooling down, waits for the earliest cooldown
 *   to end and tries again. Retries forever.
 * - After every step, and before every user prompt, switches back to a
 *   higher-priority model whose cooldown has ended.
 * - A session on a model outside PRIORITY (picked by hand) is never switched.
 *   It only gets the old auto-continue behaviour: "continue" THROTTLE_MS after
 *   a transient error, forever.
 * - Never acts on invalid requests, context overflow (opencode compacts),
 *   content filtering, user interrupts, or child (subagent) sessions.
 *
 * Model limits and variants come from opencode itself (ctx.model.list), so
 * they follow opencode.json.
 *
 * No network access, never deletes files. Appends a small log to
 * $XDG_DATA_HOME/opencode/log/priority-fallback.log.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const ID = "priority-fallback";

// Highest priority first, as provider/model.
const PRIORITY = [
  "opencode/deepseek-v4.1-flash-free",
  "opencode/glm-5.3-flash-free",
  "nvidia/deepseek-ai/deepseek-v4.1-flash",
  "nvidia/minimaxai/minimax-m3.1-flash",
  "nvidia/z-ai/glm-5.3-flash",
];
const COOLDOWN_MS = 10 * 60_000;
// A longer retryAfterMs on the error (e.g. a daily free limit) extends the
// cooldown, up to this cap.
const MAX_COOLDOWN_MS = 24 * 3600_000;
const THROTTLE_MS = 60_000; // continue delay for sessions on a model outside PRIORITY
const MIN_GAP_MS = 5_000; // never send two continues to one session closer than this
// A model fits a session only if the session's last context size leaves this
// much room below the model's context limit (same as compaction.buffer).
const CONTEXT_HEADROOM = 32_000;
const CATALOG_TTL_MS = 60_000;
// Right after setup, model.list still returns models.dev limits without the
// opencode.json overrides, so nothing read that early is cached.
const CATALOG_WARMUP_MS = 10_000;
const CONTINUE_TEXT = "continue";

// Errors after which the failed model cools down and the session moves on.
const SWITCH_TYPES = new Set([
  "provider.rate-limit",
  "provider.internal",
  "provider.transport",
  "provider.timeout",
  "provider.connect",
  "provider.unknown",
  "provider.invalid-output", // incomplete stream
  "provider.error",
  "provider.quota",
  "provider.free-limit",
  "provider.auth",
  "provider.no-route",
]);

// Errors after which a session on a model outside PRIORITY is continued on the
// same model (the old auto-continue set: quota and free-limit last too long).
const RETRY_TYPES = new Set([
  "provider.rate-limit",
  "provider.internal",
  "provider.transport",
  "provider.timeout",
  "provider.connect",
  "provider.unknown",
  "provider.invalid-output",
]);

// Safety net: never act when the message looks like context overflow, an
// invalid request or a cancellation, whatever the error type says.
const NEVER_PATTERN =
  /context.{0,30}(length|window|limit|size)|prompt is too long|too many tokens|maximum.{0,20}length|reduce the length|invalid request|aborted|cancell?ed|interrupted/i;

const LOG_FILE = join(
  process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
  "opencode",
  "log",
  "priority-fallback.log",
);

function log(msg) {
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, `${new Date().toISOString()} pid=${process.pid} ${msg}\n`);
  } catch {}
}

// Shared by every plugin instance in this process (one per location).
const shared = (globalThis.__opencodePriorityFallback ??= {
  cooldowns: new Map(), // model key -> time its cooldown ends
  sessions: new Map(), // sessionID -> session state
  seen: new Map(), // event id -> time, so a location-less event is handled once
  nextInstance: 1,
});

const unwrap = (result) => (result && typeof result === "object" && "data" in result ? result.data : result);
const keyOf = (model) => (model?.providerID && model?.id ? `${model.providerID}/${model.id}` : undefined);
const refOf = (key) => ({ providerID: key.slice(0, key.indexOf("/")), id: key.slice(key.indexOf("/") + 1) });
const variantOf = (model) => (model?.variant && model.variant !== "default" ? model.variant : "");
const label = (model) => (model ? `${keyOf(model)}${variantOf(model) ? `#${variantOf(model)}` : ""}` : "-");

function errorText(error) {
  return `${error?.message ?? ""} ${error?.response?.body ?? ""}`;
}

function summarize(error) {
  return `type=${error?.type} status=${error?.status ?? "-"} message=${JSON.stringify(String(error?.message ?? "").slice(0, 200))}`;
}

function matches(error, types) {
  return !!error && types.has(error.type) && !NEVER_PATTERN.test(errorText(error));
}

function coolingUntil(key, now) {
  const until = shared.cooldowns.get(key) ?? 0;
  if (until && until <= now) shared.cooldowns.delete(key);
  return until > now ? until : 0;
}

function sessionState(sessionID) {
  let state = shared.sessions.get(sessionID);
  if (!state) {
    state = { variants: new Map(), lastContinue: 0, attempts: 0, queue: Promise.resolve() };
    shared.sessions.set(sessionID, state);
  }
  state.lastSeen = Date.now();
  return state;
}

function stepTokens(tokens) {
  if (!tokens) return undefined;
  const total =
    (tokens.input ?? 0) +
    (tokens.output ?? 0) +
    (tokens.reasoning ?? 0) +
    (tokens.cache?.read ?? 0) +
    (tokens.cache?.write ?? 0);
  return total > 0 ? total : undefined;
}

async function setup(ctx) {
  // Only run under the V2 host (needs event + session domains).
  if (!ctx?.event?.subscribe || typeof ctx.session?.switchModel !== "function") return;

  const instance = shared.nextInstance++;
  const directory = ctx.location?.directory;
  const timers = new Map(); // sessionID -> timeout owned by this instance
  const readyAt = Date.now() + CATALOG_WARMUP_MS;
  let catalogCache;
  let disposed = false;
  log(`setup instance=${instance} location=${directory ?? JSON.stringify(ctx.location ?? null)}`);

  // Handle an event only once: in the instance for its location, or (when it
  // has no location) in whichever instance sees it first.
  function mine(event) {
    const location = event.location;
    if (location) {
      if (location.directory !== directory) return false;
      return !("workspaceID" in location) || location.workspaceID === ctx.location?.workspaceID;
    }
    if (!event.id || shared.seen.has(event.id)) return !event.id;
    shared.seen.set(event.id, Date.now());
    return true;
  }

  // Run session work one at a time per session.
  function enqueue(sessionID, why, work) {
    const state = sessionState(sessionID);
    state.queue = state.queue.then(work).catch((err) => log(`${why} failed session=${sessionID}: ${err?.message ?? err}`));
    return state.queue;
  }

  async function catalog() {
    if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.models;
    const models = new Map();
    try {
      const list = unwrap(await ctx.model.list());
      for (const model of Array.isArray(list) ? list : []) {
        models.set(`${model.providerID}/${model.id}`, {
          context: model.limit?.context,
          variants: (model.variants ?? []).map((variant) => variant.id),
          enabled: model.enabled !== false,
        });
      }
    } catch (err) {
      log(`model.list failed: ${err?.message ?? err}`);
    }
    if (Date.now() >= readyAt) catalogCache = { at: Date.now(), models };
    return models;
  }

  // An empty catalog (model.list failed) means "assume usable".
  const usable = (key, models) => models.size === 0 || models.get(key)?.enabled === true;

  function fits(key, tokens, models) {
    const limit = models.get(key)?.context;
    return !limit || !tokens || tokens + CONTEXT_HEADROOM <= limit;
  }

  // Best model for a session right now, or undefined when every usable model
  // is cooling down. When no model fits the context at all, the largest one
  // not cooling down is used and opencode compacts.
  function pick(tokens, models, now) {
    const candidates = PRIORITY.filter((key) => usable(key, models));
    const fitting = candidates.filter((key) => fits(key, tokens, models));
    const pool = fitting.length ? fitting : [...candidates].sort((a, b) => (models.get(b)?.context ?? 0) - (models.get(a)?.context ?? 0));
    const best = pool.find((key) => !coolingUntil(key, now));
    return { best, pool };
  }

  function chooseVariant(state, from, toKey, models) {
    if (state.variants.has(toKey)) return state.variants.get(toKey) || undefined;
    const current = variantOf(from);
    if (!current) return undefined;
    const supported = models.get(toKey)?.variants ?? [];
    if (supported.includes(current)) return current;
    return supported.at(-1); // variants are listed weakest to strongest
  }

  async function getSession(sessionID) {
    try {
      return unwrap(await ctx.session.get({ sessionID }));
    } catch (err) {
      log(`session.get failed session=${sessionID}: ${err?.message ?? err}`);
      return undefined;
    }
  }

  const isTopLevel = (info) => !!info && !info.parentID && !info.time?.archived;

  async function contextTokens(sessionID, state) {
    if (state.tokens) return state.tokens;
    try {
      const messages = unwrap(await ctx.session.context({ sessionID }));
      for (const message of [...(Array.isArray(messages) ? messages : [])].reverse()) {
        const total = message?.type === "assistant" ? stepTokens(message.tokens) : undefined;
        if (total) return (state.tokens = total);
      }
    } catch (err) {
      log(`session.context failed session=${sessionID}: ${err?.message ?? err}`);
    }
    return undefined;
  }

  async function switchTo(sessionID, state, from, toKey, models, why) {
    const variant = chooseVariant(state, from, toKey, models);
    const model = { ...refOf(toKey), ...(variant ? { variant } : {}) };
    await ctx.session.switchModel({ sessionID, model });
    state.model = model;
    log(`switch session=${sessionID} ${label(from)} -> ${label(model)} (${why})`);
  }

  function cancel(sessionID, why) {
    const state = shared.sessions.get(sessionID);
    if (!state?.resumeAt) return;
    clearTimeout(timers.get(sessionID));
    timers.delete(sessionID);
    state.resumeAt = undefined;
    log(`cancel session=${sessionID} reason=${why}`);
  }

  function schedule(sessionID, at, why) {
    const state = sessionState(sessionID);
    clearTimeout(timers.get(sessionID));
    state.resumeAt = at;
    state.directory = directory;
    const delay = Math.max(0, at - Date.now());
    timers.set(
      sessionID,
      setTimeout(() => {
        timers.delete(sessionID);
        if (state.resumeAt !== at) return;
        state.resumeAt = undefined;
        enqueue(sessionID, "resume", () => resume(sessionID));
      }, delay),
    );
    log(`schedule resume in ${delay}ms session=${sessionID} (${why})`);
  }

  // Move a stopped session to the best model and send "continue", or wait for
  // the earliest cooldown when every usable model is cooling down.
  async function resume(sessionID) {
    if (disposed) return;
    const info = await getSession(sessionID);
    if (!isTopLevel(info)) return log(`skip session=${sessionID} (child, archived or missing)`);
    const state = sessionState(sessionID);
    const current = keyOf(info.model);
    const now = Date.now();
    if (PRIORITY.includes(current)) {
      const models = await catalog();
      const tokens = await contextTokens(sessionID, state);
      const { best, pool } = pick(tokens, models, now);
      if (!best) {
        const earliest = Math.min(...pool.map((key) => coolingUntil(key, now) || now + COOLDOWN_MS));
        return schedule(sessionID, Math.max(earliest, now + 1000), `all models cooling, tokens=${tokens ?? "?"}`);
      }
      if (best !== current) await switchTo(sessionID, state, info.model, best, models, `recover, tokens=${tokens ?? "?"}`);
    }
    state.attempts += 1;
    state.lastContinue = Date.now();
    // The prompt hook must not wait on this session's queue while we prompt.
    state.prompting = true;
    try {
      await ctx.session.prompt({ sessionID, text: CONTINUE_TEXT, metadata: { [ID]: true } });
    } finally {
      state.prompting = false;
    }
    log(`sent continue session=${sessionID} attempt=${state.attempts} model=${label(state.model ?? info.model)}`);
  }

  async function onFailed(sessionID, error) {
    const info = await getSession(sessionID);
    if (!isTopLevel(info)) return;
    const state = sessionState(sessionID);
    const current = keyOf(info.model);
    const now = Date.now();
    if (!PRIORITY.includes(current)) {
      if (!matches(error, RETRY_TYPES)) return log(`ignore failure session=${sessionID} model=${label(info.model)} ${summarize(error)}`);
      return schedule(sessionID, now + THROTTLE_MS, `model outside priority list, ${summarize(error)}`);
    }
    if (!matches(error, SWITCH_TYPES)) return log(`ignore failure session=${sessionID} model=${label(info.model)} ${summarize(error)}`);
    const cooldown = Math.min(Math.max(COOLDOWN_MS, Number(error.retryAfterMs) || 0), MAX_COOLDOWN_MS);
    shared.cooldowns.set(current, now + cooldown);
    log(`cooldown ${current} for ${cooldown}ms after ${summarize(error)} session=${sessionID}`);
    schedule(sessionID, Math.max(now, state.lastContinue + MIN_GAP_MS), "failed");
  }

  // Switch back to a higher-priority model whose cooldown has ended.
  async function switchBack(sessionID, why) {
    const state = sessionState(sessionID);
    if (state.topLevel === false) return;
    let current = state.model;
    if (!current || why === "user prompt") {
      const info = await getSession(sessionID);
      state.topLevel = isTopLevel(info);
      if (!state.topLevel) return;
      current = state.model = info.model;
    }
    const rank = PRIORITY.indexOf(keyOf(current));
    if (rank <= 0) return; // already the best, or outside the list
    if (state.topLevel === undefined) {
      state.topLevel = isTopLevel(await getSession(sessionID));
      if (!state.topLevel) return;
    }
    const models = await catalog();
    const { best } = pick(state.tokens, models, Date.now());
    if (best && PRIORITY.indexOf(best) < rank) {
      await switchTo(sessionID, state, current, best, models, `${why}, tokens=${state.tokens ?? "?"}`);
    }
  }

  function onEvent(event) {
    const type = event?.type;
    if (typeof type !== "string" || !type.startsWith("session.")) return;
    const data = event.data ?? event.properties ?? {};
    const sessionID = data.sessionID;
    if (!sessionID || !mine(event)) return;

    // A pending wait is cancelled only by an execution that actually runs a
    // step: right after a failure opencode may start an empty execution that
    // succeeds at once, and that must not drop the wait.
    switch (type) {
      case "session.step.started": {
        const state = sessionState(sessionID);
        state.stepped = true;
        cancel(sessionID, "step started");
        if (data.model) {
          state.model = data.model;
          state.variants.set(keyOf(data.model), variantOf(data.model));
        }
        return;
      }
      case "session.model.selected": {
        const state = sessionState(sessionID);
        if (data.model) state.model = data.model;
        return;
      }
      case "session.step.ended": {
        const state = sessionState(sessionID);
        state.tokens = stepTokens(data.tokens) ?? state.tokens;
        enqueue(sessionID, "switch back", () => switchBack(sessionID, "step ended"));
        return;
      }
      case "session.execution.failed":
        enqueue(sessionID, "failure handling", () => onFailed(sessionID, data.error));
        return;
      case "session.execution.started":
        sessionState(sessionID).stepped = false;
        return;
      case "session.execution.interrupted":
        return cancel(sessionID, `interrupted:${data.reason}`);
      case "session.execution.succeeded": {
        const state = sessionState(sessionID);
        if (!state.stepped) return log(`keep wait session=${sessionID} (empty execution succeeded)`);
        state.attempts = 0;
        return cancel(sessionID, "succeeded");
      }
      case "session.deleted":
        cancel(sessionID, "deleted");
        shared.sessions.delete(sessionID);
        return;
    }
  }

  // Before a user prompt runs, move the session back up the priority list.
  const registrations = [];
  if (typeof ctx.session.hook === "function") {
    try {
      registrations.push(
        await ctx.session.hook("prompt", async (event) => {
          if (disposed || !event?.sessionID || event.metadata?.[ID]) return;
          if (shared.sessions.get(event.sessionID)?.prompting) return;
          await enqueue(event.sessionID, "switch back", () => switchBack(event.sessionID, "user prompt"));
        }),
      );
    } catch (err) {
      log(`instance=${instance} prompt hook unavailable: ${err?.message ?? err}`);
    }
  }

  // Re-arm waits left by a previous instance for this location (config reload).
  for (const [sessionID, state] of shared.sessions) {
    if (state.resumeAt && state.directory === directory) schedule(sessionID, state.resumeAt, "re-armed after reload");
  }

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [id, time] of shared.seen) if (now - time > 10 * 60_000) shared.seen.delete(id);
    for (const [id, state] of shared.sessions) {
      if (!state.resumeAt && now - state.lastSeen > 24 * 3600_000) shared.sessions.delete(id);
    }
  }, 10 * 60_000);
  cleanup.unref?.();

  // ctx.event.subscribe({ signal }) returns an async iterable of events.
  const controller = new AbortController();
  const stream = ctx.event.subscribe({ signal: controller.signal });
  if (!stream || typeof stream[Symbol.asyncIterator] !== "function") {
    log(`instance=${instance} event.subscribe did not return an async iterable; plugin inactive`);
    return;
  }
  (async () => {
    try {
      for await (const event of stream) {
        try {
          onEvent(event);
        } catch (err) {
          log(`event handler error: ${err?.message ?? err}`);
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) log(`instance=${instance} event stream ended: ${err?.message ?? err}`);
    }
  })();

  const announce = setTimeout(() => {
    catalog().then((models) => {
      const limits = PRIORITY.map((key) => `${key}=${models.get(key)?.context ?? "?"}${usable(key, models) ? "" : "(unavailable)"}`);
      log(`instance=${instance} priority ${limits.join(" > ")}`);
    });
  }, CATALOG_WARMUP_MS + 1000);
  announce.unref?.();

  return async () => {
    disposed = true;
    controller.abort();
    clearInterval(cleanup);
    clearTimeout(announce);
    // Keep resumeAt so the next instance for this location re-arms the wait.
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    await Promise.all(registrations.map((registration) => registration?.dispose?.()));
    log(`dispose instance=${instance}`);
  };
}

export default { id: ID, setup };
