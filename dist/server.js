// src/server/recorder.ts
import { execFile } from "node:child_process";
import { existsSync as existsSync2 } from "node:fs";
import { join as join2 } from "node:path";
import { Plugin } from "@opencode/plugin";

// src/lib/store.mjs
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
function defaultStorePath(env = process.env) {
  const dir = env.OPENCODE_USAGE_DIR || join(homedir(), ".local", "share", "opencode", "usage");
  return join(dir, "sessions.jsonl");
}
function readSnapshots(file) {
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
    }
  }
  return out;
}
function toRecord(info, now = Date.now()) {
  const tokens = info.tokens || {};
  const cache = tokens.cache || {};
  return {
    ts: now,
    id: info.id,
    parentID: info.parentID || null,
    agent: info.agent || "unknown",
    provider: info.model?.providerID || null,
    model: info.model?.id || null,
    projectID: info.projectID || null,
    title: info.title || null,
    created: info.time?.created || null,
    updated: info.time?.updated || null,
    cost: Number(info.cost || 0),
    input: Number(tokens.input || 0),
    output: Number(tokens.output || 0),
    reasoning: Number(tokens.reasoning || 0),
    cacheRead: Number(cache.read || 0),
    cacheWrite: Number(cache.write || 0),
    outcome: info.outcome || null
  };
}
function latestBySession(records) {
  const map = /* @__PURE__ */ new Map();
  for (const record of records) {
    if (!record?.id) continue;
    const previous = map.get(record.id);
    if (!previous || (record.ts || 0) >= (previous.ts || 0)) map.set(record.id, record);
  }
  return map;
}
function changedSessions(records, previous) {
  const changed = [];
  for (const [id, record] of latestBySession(records)) {
    const before = previous.get(id);
    if (!before || before.input !== record.input || before.output !== record.output || before.reasoning !== record.reasoning || before.cacheRead !== record.cacheRead || before.cacheWrite !== record.cacheWrite || before.cost !== record.cost || before.outcome !== record.outcome || before.title !== record.title) {
      changed.push(record);
    }
  }
  return changed;
}
function sameMetrics(a, b) {
  return a.input === b.input && a.output === b.output && a.reasoning === b.reasoning && a.cacheRead === b.cacheRead && a.cacheWrite === b.cacheWrite && a.cost === b.cost && a.outcome === b.outcome && a.title === b.title;
}
function appendSnapshots(file, records, { dedupe = true } = {}) {
  if (!records.length) return 0;
  const previous = dedupe ? latestBySession(readSnapshots(file)) : /* @__PURE__ */ new Map();
  const fresh = [];
  for (const record of records) {
    if (!record?.id) continue;
    const before = previous.get(record.id);
    if (before && sameMetrics(before, record)) continue;
    fresh.push(record);
    previous.set(record.id, record);
  }
  if (!fresh.length) return 0;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, fresh.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
  return fresh.length;
}

// src/server/recorder.ts
var INTERVAL_MS = Number(process.env.OPENCODE_USAGE_INTERVAL_MS || 15e3);
var MONTH_INTERVAL_MS = Number(process.env.OPENCODE_USAGE_MONTH_MS || 3e5);
var CONSOLE_INTERVAL_MS = Number(process.env.OPENCODE_USAGE_CONSOLE_MS || 9e5);
var recorder_default = Plugin.define({
  id: "usage-tracker",
  async setup(ctx) {
    if (process.env.OPENCODE_USAGE_DISABLE === "1") return;
    const file = defaultStorePath();
    const known = latestBySession(readSnapshots(file));
    let busy = false;
    const listSessions = async () => {
      const attempts = [{ limit: 100 }, { limit: 100, directory: ctx.location?.directory }];
      let lastError;
      for (const query of attempts) {
        try {
          const page = await ctx.session.list(query);
          return Array.isArray(page) ? page : page?.data ?? page?.sessions ?? [];
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    };
    const collect = async () => {
      if (busy) return;
      busy = true;
      try {
        const sessions = await listSessions();
        const records = sessions.filter((session) => session?.id).map((session) => toRecord(session));
        const fresh = changedSessions(records, known);
        if (fresh.length) {
          appendSnapshots(file, fresh);
          for (const record of fresh) known.set(record.id, record);
        }
      } catch {
      } finally {
        busy = false;
      }
    };
    await collect();
    const timer = setInterval(() => void collect(), INTERVAL_MS);
    timer.unref?.();
    const cli = join2(import.meta.dirname, "..", "bin", "omo-usage.mjs");
    let monthBusy = false;
    let consoleBusy = false;
    const runScript = (args, done) => {
      if (!existsSync2(cli)) return done();
      execFile("node", ["--no-warnings", cli, ...args], { timeout: 18e4, windowsHide: true }, () => done());
    };
    const refreshMonth = () => {
      if (monthBusy) return;
      monthBusy = true;
      runScript(["month", "--write"], () => {
        monthBusy = false;
      });
    };
    const refreshConsole = () => {
      if (consoleBusy) return;
      consoleBusy = true;
      runScript(["console", "--write"], () => {
        consoleBusy = false;
      });
    };
    const timers = [timer];
    if (MONTH_INTERVAL_MS > 0) {
      refreshMonth();
      timers.push(setInterval(refreshMonth, MONTH_INTERVAL_MS));
    }
    if (CONSOLE_INTERVAL_MS > 0) {
      refreshConsole();
      timers.push(setInterval(refreshConsole, CONSOLE_INTERVAL_MS));
    }
    for (const entry of timers) entry.unref?.();
    return () => timers.forEach((entry) => clearInterval(entry));
  }
});
export {
  recorder_default as default
};
