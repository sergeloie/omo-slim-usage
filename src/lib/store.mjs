// Append-only snapshot store for per-role token/cost usage.
// One JSON object per line: the last snapshot per session wins.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export function defaultStorePath(env = process.env) {
  const dir = env.OPENCODE_USAGE_DIR || join(homedir(), ".local", "share", "opencode", "usage")
  return join(dir, "sessions.jsonl")
}

export function readSnapshots(file) {
  if (!existsSync(file)) return []
  const out = []
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      out.push(JSON.parse(trimmed))
    } catch {
      // A torn final line from a crash is ignored, not fatal.
    }
  }
  return out
}

export function toRecord(info, now = Date.now()) {
  const tokens = info.tokens || {}
  const cache = tokens.cache || {}
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
    outcome: info.outcome || null,
  }
}

export function latestBySession(records) {
  const map = new Map()
  for (const record of records) {
    if (!record?.id) continue
    const previous = map.get(record.id)
    if (!previous || (record.ts || 0) >= (previous.ts || 0)) map.set(record.id, record)
  }
  return map
}

export function changedSessions(records, previous) {
  const changed = []
  for (const [id, record] of latestBySession(records)) {
    const before = previous.get(id)
    if (
      !before ||
      before.input !== record.input ||
      before.output !== record.output ||
      before.reasoning !== record.reasoning ||
      before.cacheRead !== record.cacheRead ||
      before.cacheWrite !== record.cacheWrite ||
      before.cost !== record.cost ||
      before.outcome !== record.outcome ||
      before.title !== record.title
    ) {
      changed.push(record)
    }
  }
  return changed
}

function sameMetrics(a, b) {
  return (
    a.input === b.input &&
    a.output === b.output &&
    a.reasoning === b.reasoning &&
    a.cacheRead === b.cacheRead &&
    a.cacheWrite === b.cacheWrite &&
    a.cost === b.cost &&
    a.outcome === b.outcome &&
    a.title === b.title
  )
}

/**
 * Append snapshots, skipping any that match the newest snapshot already on disk.
 * Dedupe is done against the file itself, so multiple plugin instances and
 * separate CLI runs cannot duplicate a record.
 */
export function appendSnapshots(file, records, { dedupe = true } = {}) {
  if (!records.length) return 0
  const previous = dedupe ? latestBySession(readSnapshots(file)) : new Map()
  const fresh = []
  for (const record of records) {
    if (!record?.id) continue
    const before = previous.get(record.id)
    if (before && sameMetrics(before, record)) continue
    fresh.push(record)
    previous.set(record.id, record)
  }
  if (!fresh.length) return 0
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, fresh.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8")
  return fresh.length
}

/** Collapse the store to one line per session (the newest snapshot). */
export function compactStore(file, records = readSnapshots(file)) {
  const latest = [...latestBySession(records).values()].sort((a, b) => (a.ts || 0) - (b.ts || 0))
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, latest.map((record) => JSON.stringify(record)).join("\n") + (latest.length ? "\n" : ""), "utf8")
  return latest.length
}

export function sessionFamily(records, rootID) {
  const wanted = new Set([rootID])
  let grew = true
  while (grew) {
    grew = false
    for (const record of records) {
      if (!wanted.has(record.id) && record.parentID && wanted.has(record.parentID)) {
        wanted.add(record.id)
        grew = true
      }
    }
  }
  return records.filter((record) => wanted.has(record.id))
}

export function filterRecords(records, { sessionID, days, since, all = false, agent, now = Date.now() } = {}) {
  let selected = records
  if (sessionID) selected = sessionFamily(selected, sessionID)
  if (!all) {
    const cutoff = since ? new Date(since).getTime() : days ? now - days * 86400000 : now - 7 * 86400000
    selected = selected.filter((record) => (record.created || record.ts || 0) >= cutoff)
  }
  if (agent) selected = selected.filter((record) => record.agent === agent)
  return selected
}

export function aggregate(records) {
  const byAgent = new Map()
  const totals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, sessions: 0 }
  for (const record of records) {
    const entry = byAgent.get(record.agent) || {
      agent: record.agent,
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      sessions: 0,
    }
    entry.input += record.input
    entry.output += record.output
    entry.reasoning += record.reasoning
    entry.cacheRead += record.cacheRead
    entry.cacheWrite += record.cacheWrite
    entry.cost += record.cost
    entry.sessions += 1
    byAgent.set(record.agent, entry)
    totals.input += record.input
    totals.output += record.output
    totals.reasoning += record.reasoning
    totals.cacheRead += record.cacheRead
    totals.cacheWrite += record.cacheWrite
    totals.cost += record.cost
    totals.sessions += 1
  }
  const rows = [...byAgent.values()].sort((a, b) => b.input + b.output - (a.input + a.output) || a.agent.localeCompare(b.agent))
  return { rows, totals }
}

export function formatTokens(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}m`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

export function formatTable({ rows, totals }, { title } = {}) {
  if (!rows.length) return title ? `${title}\n\nno usage recorded` : "no usage recorded"
  const head = "| role | sessions | in | out | reasoning | cache read | cost |"
  const sep = "| --- | --- | --- | --- | --- | --- | --- |"
  const body = rows.map(
    (row) =>
      `| ${row.agent} | ${row.sessions} | ${formatTokens(row.input)} | ${formatTokens(row.output)} | ${formatTokens(
        row.reasoning,
      )} | ${formatTokens(row.cacheRead)} | ${row.cost ? `$${row.cost.toFixed(4)}` : "$0"} |`,
  )
  const totalLine = `| **total** | ${totals.sessions} | ${formatTokens(totals.input)} | ${formatTokens(
    totals.output,
  )} | ${formatTokens(totals.reasoning)} | ${formatTokens(totals.cacheRead)} | ${
    totals.cost ? `$${totals.cost.toFixed(4)}` : "$0"
  } |`
  return [title, "", head, sep, ...body, totalLine].filter((line) => line !== undefined).join("\n")
}
