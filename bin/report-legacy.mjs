#!/usr/bin/env node
// Usage report: per-role tokens and cost for a session, a rolling window, or all time.
//   node report.mjs --session <sessionID>
//   node report.mjs --week | --days 3 | --all
//   node report.mjs --collect          # pull fresh snapshots from `opencode api session.list`
//   node report.mjs --json             # machine output
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import {
  aggregate,
  appendSnapshots,
  defaultStorePath,
  filterRecords,
  formatTable,
  latestBySession,
  readSnapshots,
  toRecord,
} from "../src/lib/store.mjs"

function parseArgs(argv) {
  const args = { all: false, json: false, collect: false, days: null, session: null, agent: null, file: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--all") args.all = true
    else if (arg === "--json") args.json = true
    else if (arg === "--collect") args.collect = true
    else if (arg === "--week") args.days = 7
    else if (arg === "--days") args.days = Number(argv[++index])
    else if (arg === "--session") args.session = argv[++index]
    else if (arg === "--agent") args.agent = argv[++index]
    else if (arg === "--file") args.file = argv[++index]
    else if (arg === "--help" || arg === "-h") args.help = true
  }
  return args
}

function collect(file) {
  const binary = process.platform === "win32" ? "opencode.cmd" : "opencode"
  const raw = execFileSync(binary, ["api", "session.list"], { encoding: "utf8", shell: true, timeout: 120000 })
  const payload = JSON.parse(raw)
  const sessions = Array.isArray(payload) ? payload : payload.data || []
  const records = sessions.filter((session) => session?.id).map((session) => toRecord(session))
  const previous = latestBySession(readSnapshots(file))
  const fresh = []
  for (const record of latestBySession(records).values()) {
    const before = previous.get(record.id)
    if (!before || before.input !== record.input || before.output !== record.output || before.cost !== record.cost) {
      fresh.push(record)
    }
  }
  appendSnapshots(file, fresh)
  return { sessions: sessions.length, written: fresh.length }
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log(
    [
      "usage report",
      "",
      "  --session <id>   one root session and everything it delegated",
      "  --week           last 7 days (default)",
      "  --days <n>       last n days",
      "  --all            everything in the store",
      "  --agent <name>   one role only",
      "  --collect        pull fresh snapshots from the OpenCode API first",
      "  --json           machine-readable output",
      "  --file <path>    alternate store file",
    ].join("\n"),
  )
  process.exit(0)
}

const file = args.file || defaultStorePath()
if (args.collect) {
  try {
    const result = collect(file)
    if (!args.json) console.error(`collected: ${result.written} changed of ${result.sessions} sessions`)
  } catch (error) {
    console.error(`collect failed: ${error.message}`)
    process.exitCode = 1
  }
}

if (!existsSync(file)) {
  console.log(`no usage store yet at ${file}\nrun: node report.mjs --collect`)
  process.exit(0)
}

const records = [...latestBySession(readSnapshots(file)).values()]
const filtered = filterRecords(records, {
  sessionID: args.session,
  days: args.days,
  all: args.all,
  agent: args.agent,
})
const summary = aggregate(filtered)
const label = args.session
  ? `session ${args.session}`
  : args.all
    ? "all time"
    : `last ${args.days || 7} days`

if (args.json) {
  console.log(JSON.stringify({ label, ...summary }, null, 2))
} else {
  console.log(formatTable(summary, { title: `usage · ${label}` }))
  const newest = filtered.reduce((max, record) => Math.max(max, record.updated || record.ts || 0), 0)
  if (newest) console.log(`\nlast activity: ${new Date(newest).toISOString()}`)
}
