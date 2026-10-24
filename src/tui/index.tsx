// Live per-role usage in the sidebar footer, plus /cost for session and week tables.
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { For, createMemo, createSignal, onCleanup } from "solid-js"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import {
  aggregate,
  defaultStorePath,
  filterRecords,
  formatTable,
  latestBySession,
  readSnapshots,
} from "../lib/store.mjs"

const REFRESH_MS = 5000
const MONTH_HINT = "omo-usage month --write"
let currentSessionID: string | undefined

function loadRecords() {
  try {
    return [...latestBySession(readSnapshots(defaultStorePath())).values()]
  } catch {
    return []
  }
}

function loadMonth() {
  try {
    const data = JSON.parse(readFileSync(join(dirname(defaultStorePath()), "month.json"), "utf8"))
    if (!Array.isArray(data.models) || !Array.isArray(data.roleModels)) return null
    const from = new Date(data.window?.from)
    const now = new Date()
    if (from.getFullYear() !== now.getFullYear() || from.getMonth() !== now.getMonth()) return null
    return data
  } catch {
    return null
  }
}

function loadConsole() {
  try {
    const data = JSON.parse(readFileSync(join(dirname(defaultStorePath()), "console.json"), "utf8"))
    if (!Array.isArray(data.models) || typeof data.summary?.costUsd !== "number") return null
    return data
  } catch {
    return null
  }
}

function fmtUsd(value: number) {
  if (!value) return "$0"
  return value >= 0.01 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`
}

function fmtN(value: number) {
  if (value >= 1e9) return `${Math.round(value / 1e9)}g`
  if (value >= 1e7) return `${Math.round(value / 1e6)}m`
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}m`
  if (value >= 1e4) return `${Math.round(value / 1e3)}k`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`
  return `${Math.round(value)}`
}

function pct(share: number | null | undefined) {
  return share == null ? "—" : `${(share * 100).toFixed(1)}%`
}

function staleness(iso: string | undefined, freshMs = 15 * 60_000) {
  const ts = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(ts)) return "stale"
  const age = Date.now() - ts
  if (age < freshMs) return ""
  const hours = Math.min(Math.floor(age / 3_600_000), 999)
  return hours ? `stale ${hours}h` : `stale ${Math.floor(age / 60_000)}m`
}

function monthLines() {
  const month = loadMonth()
  if (!month) return ["month: no data — month.mjs --write"]
  const total = month.models.reduce((sum, m) => sum + (m.monthToDate ?? 0), 0)
  const forecast = month.models.reduce((sum, m) => sum + (m.projected ?? 0), 0)
  const stale = staleness(month.generatedAt)
  const top = [...month.models].filter((m) => m.monthlyCap != null).sort((a, b) => b.monthToDate - a.monthToDate)[0]
  const lines = [`mo ${fmtUsd(total)} · proj ${fmtUsd(forecast)}${stale ? ` · ${stale}` : ""}`]
  if (top) {
    lines.push(`${(top.key.split("/").pop() ?? top.key).padEnd(13).slice(0, 13)} ${fmtUsd(top.monthToDate)} ${pct(top.monthShare)} of $${top.monthlyCap}`)
  }
  return lines
}

function consoleLines() {
  const data = loadConsole()
  if (!data) return null
  const stale = staleness(data.generatedAt, 20 * 60_000)
  const top = [...data.models].filter((m) => typeof m.cap === "number").sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0))[0]
  const lines = [`${data.range ?? "—"} ${fmtUsd(data.summary.costUsd)}${stale ? ` · ${stale}` : ""}`]
  if (top) {
    lines.push(`${(top.key.split("/").pop() ?? top.key).padEnd(13).slice(0, 13)} ${fmtUsd(top.costUsd ?? 0)} ${pct(top.share)} of $${top.cap}`)
  }
  return lines
}

function spendLines() {
  return consoleLines() ?? monthLines()
}

function monthReport() {
  const month = loadMonth()
  if (!month) return `month (local estimate): no data — run: ${MONTH_HINT}`
  const stale = staleness(month.generatedAt)
  const models = [...month.models].sort((a, b) => b.monthToDate - a.monthToDate)
  const pairs = [...month.roleModels].sort((a, b) => (b.listCost ?? 0) - (a.listCost ?? 0))
  const lines = [`month (local estimate)${stale ? ` (${stale})` : ""}`]
  for (const m of models.slice(0, 8)) {
    lines.push(
      [m.key, fmtUsd(m.monthToDate), pct(m.monthShare), pct(m.fiveHourShare), pct(m.weekShare), `fcast ${fmtUsd(m.projected)}`].join(" "),
    )
  }
  if (models.length > 8) lines.push(`(${models.length - 8} omitted)`)
  lines.push("")
  for (const p of pairs.slice(0, 12)) {
    const per = p.requests ? fmtUsd((p.listCost ?? 0) / p.requests) : "$0"
    lines.push(`${`${p.agent} ${p.model}`.padEnd(42).slice(0, 42)} ${fmtUsd(p.listCost)} ${per}/req ${p.requests} req`)
  }
  if (pairs.length > 12) lines.push(`(${pairs.length - 12} omitted)`)
  return lines.join("\n")
}

function consoleReport() {
  const data = loadConsole()
  if (!data) return null
  const stale = staleness(data.generatedAt, 20 * 60_000)
  const summary = data.summary ?? {}
  const lines = [`console (measured) · ${data.range ?? "—"} · ${fmtUsd(summary.costUsd ?? 0)}${stale ? ` · ${stale}` : ""}`]
  const models = [...(data.models ?? [])].sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0))
  for (const m of models.slice(0, 8)) {
    lines.push(`${m.key} ${fmtUsd(m.costUsd ?? 0)} ${pct(m.share)} of ${typeof m.cap === "number" ? `$${m.cap}` : "—"} ${m.requests ?? 0} req`)
  }
  if (models.length > 8) lines.push(`(${models.length - 8} omitted)`)
  const days = Array.isArray(data.days) ? [...data.days].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "")).slice(0, 5) : []
  if (days.length) {
    lines.push("")
    for (const d of days) {
      lines.push(`${d.date ?? "—"} ${fmtUsd(d.costUsd ?? 0)} ${d.requests ?? 0} req`)
    }
  }
  const budgets = Array.isArray(data.budgets) ? data.budgets : []
  if (budgets.length) {
    lines.push("")
    for (const b of budgets.slice(0, 4)) {
      const parts = [`limit ${fmtUsd(b.limitDollars ?? 0)}`, `spent ${fmtUsd(b.spentDollars ?? 0)}`]
      if (b.scope != null) parts.push(`scope ${b.scope}`)
      if (b.resetsAt != null) parts.push(`resets ${b.resetsAt}`)
      lines.push(parts.join(" · "))
    }
  }
  return lines.join("\n")
}

function summaryLines(sessionID?: string) {
  const records = loadRecords()
  if (!records.length) return ["usage · no data yet", ...spendLines()]
  const scoped = filterRecords(records, sessionID ? { sessionID } : { days: 7 })
  const { rows, totals } = aggregate(scoped)
  if (!rows.length) return ["usage · no data yet", ...spendLines()]
  const lines = [sessionID ? "usage · this session" : "usage · 7 days"]
  for (const row of rows.slice(0, 4)) {
    lines.push(`${row.agent.padEnd(13).slice(0, 13)} ${fmtUsd(row.cost ?? 0)} ${fmtN(row.input ?? 0)}/${fmtN(row.output ?? 0)}`)
  }
  const totalCost = totals.cost ? fmtUsd(totals.cost) : "$0"
  lines.push(`total        ${totalCost} ${fmtN(totals.input ?? 0)}/${fmtN(totals.output ?? 0)}`)
  return [...lines, ...spendLines()]
}

function reportText(sessionID?: string) {
  const records = loadRecords()
  const consoleSection = consoleReport()
  const tables = records.length
    ? [
        formatTable(aggregate(filterRecords(records, { sessionID: sessionID || "", all: !sessionID })), {
          title: "this session",
        }),
        "",
        formatTable(aggregate(filterRecords(records, { days: 7 })), { title: "last 7 days" }),
      ]
    : ["no usage recorded yet"]
  return tables.concat(consoleSection ? ["", consoleSection] : []).concat(["", monthReport()]).join("\n")
}

function UsageFooter(props: { sessionID?: string }) {
  currentSessionID = props.sessionID
  const context = usePlugin()
  const [tick, setTick] = createSignal(0)
  const timer = setInterval(() => setTick((value) => value + 1), REFRESH_MS)
  onCleanup(() => clearInterval(timer))
  const lines = createMemo(() => {
    tick()
    return summaryLines(props.sessionID)
  })
  const color = context.theme?.text?.muted ?? context.theme?.text?.base
  return (
    <box flexDirection="column">
      <For each={lines()}>{(line) => <text fg={color}>{line}</text>}</For>
    </box>
  )
}

export default Plugin.define({
  id: "usage-tui",
  setup(context) {
    context.ui.slot({
      append: "sidebar.footer",
      render: ({ sessionID }) => <UsageFooter sessionID={sessionID} />,
    })

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
            void context.ui.dialog.alert({ title: "Usage by role", message: reportText(currentSessionID) })
          },
        },
      ],
    }))
  },
})
