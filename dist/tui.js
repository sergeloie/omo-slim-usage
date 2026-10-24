// src/tui/index.tsx
import { Plugin, usePlugin } from "@opencode/plugin/tui";
import { For, createMemo, createSignal, onCleanup } from "solid-js";
import { readFileSync as readFileSync2 } from "node:fs";
import { dirname as dirname2, join as join2 } from "node:path";

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
function latestBySession(records) {
  const map = /* @__PURE__ */ new Map();
  for (const record of records) {
    if (!record?.id) continue;
    const previous = map.get(record.id);
    if (!previous || (record.ts || 0) >= (previous.ts || 0)) map.set(record.id, record);
  }
  return map;
}
function sessionFamily(records, rootID) {
  const wanted = /* @__PURE__ */ new Set([rootID]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const record of records) {
      if (!wanted.has(record.id) && record.parentID && wanted.has(record.parentID)) {
        wanted.add(record.id);
        grew = true;
      }
    }
  }
  return records.filter((record) => wanted.has(record.id));
}
function filterRecords(records, { sessionID, days, since, all = false, agent, now = Date.now() } = {}) {
  let selected = records;
  if (sessionID) selected = sessionFamily(selected, sessionID);
  if (!all) {
    const cutoff = since ? new Date(since).getTime() : days ? now - days * 864e5 : now - 7 * 864e5;
    selected = selected.filter((record) => (record.created || record.ts || 0) >= cutoff);
  }
  if (agent) selected = selected.filter((record) => record.agent === agent);
  return selected;
}
function aggregate(records) {
  const byAgent = /* @__PURE__ */ new Map();
  const totals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, sessions: 0 };
  for (const record of records) {
    const entry = byAgent.get(record.agent) || {
      agent: record.agent,
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      sessions: 0
    };
    entry.input += record.input;
    entry.output += record.output;
    entry.reasoning += record.reasoning;
    entry.cacheRead += record.cacheRead;
    entry.cacheWrite += record.cacheWrite;
    entry.cost += record.cost;
    entry.sessions += 1;
    byAgent.set(record.agent, entry);
    totals.input += record.input;
    totals.output += record.output;
    totals.reasoning += record.reasoning;
    totals.cacheRead += record.cacheRead;
    totals.cacheWrite += record.cacheWrite;
    totals.cost += record.cost;
    totals.sessions += 1;
  }
  const rows = [...byAgent.values()].sort((a, b) => b.input + b.output - (a.input + a.output) || a.agent.localeCompare(b.agent));
  return { rows, totals };
}
function formatTokens(value) {
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}m`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return String(value);
}
function formatTable({ rows, totals }, { title } = {}) {
  if (!rows.length) return title ? `${title}

no usage recorded` : "no usage recorded";
  const head = "| role | sessions | in | out | reasoning | cache read | cost |";
  const sep = "| --- | --- | --- | --- | --- | --- | --- |";
  const body = rows.map(
    (row) => `| ${row.agent} | ${row.sessions} | ${formatTokens(row.input)} | ${formatTokens(row.output)} | ${formatTokens(
      row.reasoning
    )} | ${formatTokens(row.cacheRead)} | ${row.cost ? `$${row.cost.toFixed(4)}` : "$0"} |`
  );
  const totalLine = `| **total** | ${totals.sessions} | ${formatTokens(totals.input)} | ${formatTokens(
    totals.output
  )} | ${formatTokens(totals.reasoning)} | ${formatTokens(totals.cacheRead)} | ${totals.cost ? `$${totals.cost.toFixed(4)}` : "$0"} |`;
  return [title, "", head, sep, ...body, totalLine].filter((line) => line !== void 0).join("\n");
}

// src/tui/index.tsx
import { jsx } from "@opentui/solid/jsx-runtime";
var REFRESH_MS = 5e3;
var MONTH_HINT = "omo-usage month --write";
var currentSessionID;
function loadRecords() {
  try {
    return [...latestBySession(readSnapshots(defaultStorePath())).values()];
  } catch {
    return [];
  }
}
function loadMonth() {
  try {
    const data = JSON.parse(readFileSync2(join2(dirname2(defaultStorePath()), "month.json"), "utf8"));
    if (!Array.isArray(data.models) || !Array.isArray(data.roleModels)) return null;
    const from = new Date(data.window?.from);
    const now = /* @__PURE__ */ new Date();
    if (from.getFullYear() !== now.getFullYear() || from.getMonth() !== now.getMonth()) return null;
    return data;
  } catch {
    return null;
  }
}
function loadConsole() {
  try {
    const data = JSON.parse(readFileSync2(join2(dirname2(defaultStorePath()), "console.json"), "utf8"));
    if (!Array.isArray(data.models) || typeof data.summary?.costUsd !== "number") return null;
    return data;
  } catch {
    return null;
  }
}
function fmtUsd(value) {
  if (!value) return "$0";
  return value >= 0.01 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`;
}
function fmtN(value) {
  if (value >= 1e9) return `${Math.round(value / 1e9)}g`;
  if (value >= 1e7) return `${Math.round(value / 1e6)}m`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}m`;
  if (value >= 1e4) return `${Math.round(value / 1e3)}k`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return `${Math.round(value)}`;
}
function pct(share) {
  return share == null ? "\u2014" : `${(share * 100).toFixed(1)}%`;
}
function staleness(iso, freshMs = 15 * 6e4) {
  const ts = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ts)) return "stale";
  const age = Date.now() - ts;
  if (age < freshMs) return "";
  const hours = Math.min(Math.floor(age / 36e5), 999);
  return hours ? `stale ${hours}h` : `stale ${Math.floor(age / 6e4)}m`;
}
function monthLines() {
  const month = loadMonth();
  if (!month) return ["month: no data \u2014 month.mjs --write"];
  const total = month.models.reduce((sum, m) => sum + (m.monthToDate ?? 0), 0);
  const forecast = month.models.reduce((sum, m) => sum + (m.projected ?? 0), 0);
  const stale = staleness(month.generatedAt);
  const top = [...month.models].filter((m) => m.monthlyCap != null).sort((a, b) => b.monthToDate - a.monthToDate)[0];
  const lines = [`mo ${fmtUsd(total)} \xB7 proj ${fmtUsd(forecast)}${stale ? ` \xB7 ${stale}` : ""}`];
  if (top) {
    lines.push(`${(top.key.split("/").pop() ?? top.key).padEnd(13).slice(0, 13)} ${fmtUsd(top.monthToDate)} ${pct(top.monthShare)} of $${top.monthlyCap}`);
  }
  return lines;
}
function consoleLines() {
  const data = loadConsole();
  if (!data) return null;
  const stale = staleness(data.generatedAt, 20 * 6e4);
  const top = [...data.models].filter((m) => typeof m.cap === "number").sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0))[0];
  const lines = [`${data.range ?? "\u2014"} ${fmtUsd(data.summary.costUsd)}${stale ? ` \xB7 ${stale}` : ""}`];
  if (top) {
    lines.push(`${(top.key.split("/").pop() ?? top.key).padEnd(13).slice(0, 13)} ${fmtUsd(top.costUsd ?? 0)} ${pct(top.share)} of $${top.cap}`);
  }
  return lines;
}
function spendLines() {
  return consoleLines() ?? monthLines();
}
function monthReport() {
  const month = loadMonth();
  if (!month) return `month (local estimate): no data \u2014 run: ${MONTH_HINT}`;
  const stale = staleness(month.generatedAt);
  const models = [...month.models].sort((a, b) => b.monthToDate - a.monthToDate);
  const pairs = [...month.roleModels].sort((a, b) => (b.listCost ?? 0) - (a.listCost ?? 0));
  const lines = [`month (local estimate)${stale ? ` (${stale})` : ""}`];
  for (const m of models.slice(0, 8)) {
    lines.push(
      [m.key, fmtUsd(m.monthToDate), pct(m.monthShare), pct(m.fiveHourShare), pct(m.weekShare), `fcast ${fmtUsd(m.projected)}`].join(" ")
    );
  }
  if (models.length > 8) lines.push(`(${models.length - 8} omitted)`);
  lines.push("");
  for (const p of pairs.slice(0, 12)) {
    const per = p.requests ? fmtUsd((p.listCost ?? 0) / p.requests) : "$0";
    lines.push(`${`${p.agent} ${p.model}`.padEnd(42).slice(0, 42)} ${fmtUsd(p.listCost)} ${per}/req ${p.requests} req`);
  }
  if (pairs.length > 12) lines.push(`(${pairs.length - 12} omitted)`);
  return lines.join("\n");
}
function consoleReport() {
  const data = loadConsole();
  if (!data) return null;
  const stale = staleness(data.generatedAt, 20 * 6e4);
  const summary = data.summary ?? {};
  const lines = [`console (measured) \xB7 ${data.range ?? "\u2014"} \xB7 ${fmtUsd(summary.costUsd ?? 0)}${stale ? ` \xB7 ${stale}` : ""}`];
  const models = [...data.models ?? []].sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0));
  for (const m of models.slice(0, 8)) {
    lines.push(`${m.key} ${fmtUsd(m.costUsd ?? 0)} ${pct(m.share)} of ${typeof m.cap === "number" ? `$${m.cap}` : "\u2014"} ${m.requests ?? 0} req`);
  }
  if (models.length > 8) lines.push(`(${models.length - 8} omitted)`);
  const days = Array.isArray(data.days) ? [...data.days].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "")).slice(0, 5) : [];
  if (days.length) {
    lines.push("");
    for (const d of days) {
      lines.push(`${d.date ?? "\u2014"} ${fmtUsd(d.costUsd ?? 0)} ${d.requests ?? 0} req`);
    }
  }
  const budgets = Array.isArray(data.budgets) ? data.budgets : [];
  if (budgets.length) {
    lines.push("");
    for (const b of budgets.slice(0, 4)) {
      const parts = [`limit ${fmtUsd(b.limitDollars ?? 0)}`, `spent ${fmtUsd(b.spentDollars ?? 0)}`];
      if (b.scope != null) parts.push(`scope ${b.scope}`);
      if (b.resetsAt != null) parts.push(`resets ${b.resetsAt}`);
      lines.push(parts.join(" \xB7 "));
    }
  }
  return lines.join("\n");
}
function summaryLines(sessionID) {
  const records = loadRecords();
  if (!records.length) return ["usage \xB7 no data yet", ...spendLines()];
  const scoped = filterRecords(records, sessionID ? { sessionID } : { days: 7 });
  const { rows, totals } = aggregate(scoped);
  if (!rows.length) return ["usage \xB7 no data yet", ...spendLines()];
  const lines = [sessionID ? "usage \xB7 this session" : "usage \xB7 7 days"];
  for (const row of rows.slice(0, 4)) {
    lines.push(`${row.agent.padEnd(13).slice(0, 13)} ${fmtUsd(row.cost ?? 0)} ${fmtN(row.input ?? 0)}/${fmtN(row.output ?? 0)}`);
  }
  const totalCost = totals.cost ? fmtUsd(totals.cost) : "$0";
  lines.push(`total        ${totalCost} ${fmtN(totals.input ?? 0)}/${fmtN(totals.output ?? 0)}`);
  return [...lines, ...spendLines()];
}
function reportText(sessionID) {
  const records = loadRecords();
  const consoleSection = consoleReport();
  const tables = records.length ? [
    formatTable(aggregate(filterRecords(records, { sessionID: sessionID || "", all: !sessionID })), {
      title: "this session"
    }),
    "",
    formatTable(aggregate(filterRecords(records, { days: 7 })), { title: "last 7 days" })
  ] : ["no usage recorded yet"];
  return tables.concat(consoleSection ? ["", consoleSection] : []).concat(["", monthReport()]).join("\n");
}
function UsageFooter(props) {
  currentSessionID = props.sessionID;
  const context = usePlugin();
  const [tick, setTick] = createSignal(0);
  const timer = setInterval(() => setTick((value) => value + 1), REFRESH_MS);
  onCleanup(() => clearInterval(timer));
  const lines = createMemo(() => {
    tick();
    return summaryLines(props.sessionID);
  });
  const color = context.theme?.text?.muted ?? context.theme?.text?.base;
  return /* @__PURE__ */ jsx("box", { flexDirection: "column", children: /* @__PURE__ */ jsx(For, { each: lines(), children: (line) => /* @__PURE__ */ jsx("text", { fg: color, children: line }) }) });
}
var index_default = Plugin.define({
  id: "usage-tui",
  setup(context) {
    context.ui.slot({
      append: "sidebar.footer",
      render: ({ sessionID }) => /* @__PURE__ */ jsx(UsageFooter, { sessionID })
    });
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "usage.cost",
          title: "Usage: tokens and cost by role",
          group: "Usage",
          palette: true,
          slash: { name: "cost" },
          run: () => {
            void context.ui.dialog.alert({ title: "Usage by role", message: reportText(currentSessionID) });
          }
        }
      ]
    }));
  }
});
export {
  index_default as default
};
