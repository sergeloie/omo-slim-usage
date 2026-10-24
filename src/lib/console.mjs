import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { defaultStorePath, formatTokens } from "./store.mjs"

const MICRO_CENTS = 1e8
const BASE_URL = "https://console.opencode.ai"
const RANGES = new Set(["7d", "30d"])
const HELP = `usage: console.mjs [--range 7d|30d] [--json] [--write] [--csv <path>] [--compare] [--help]`

export function microCentsToUsd(value) {
  if (value === null || value === undefined || value === "") return 0
  const amount = Number(value)
  return Number.isFinite(amount) ? amount / MICRO_CENTS : 0
}

export function defaultAuthPath() {
  return join(homedir(), ".local", "share", "opencode", "auth.json")
}

export function readApiKey(authPath = defaultAuthPath()) {
  let key
  try {
    key = JSON.parse(readFileSync(authPath, "utf8"))?.opencode?.key
  } catch {
    key = undefined
  }
  if (typeof key !== "string" || !key) throw new Error(`console: no opencode API key in ${authPath}`)
  return key
}

function num(value) {
  const amount = Number(value ?? 0)
  return Number.isFinite(amount) ? amount : 0
}

export function normalizeSummary(raw, range) {
  return {
    range,
    requests: num(raw?.totalRequests),
    inputTokens: num(raw?.totalInputTokens),
    outputTokens: num(raw?.totalOutputTokens),
    cacheReadTokens: num(raw?.totalCacheReadTokens),
    cacheWriteTokens: num(raw?.totalCacheWrite5mTokens) + num(raw?.totalCacheWrite1hTokens),
    costUsd: microCentsToUsd(raw?.totalCostMicroCents),
  }
}

export function normalizeModels(raw) {
  return (raw?.items ?? [])
    .map((item) => ({
      provider: item.provider,
      model: item.model,
      key: `${item.provider}/${item.model}`,
      requests: num(item.totalRequests),
      tokens: {
        input: num(item.totalInputTokens),
        output: num(item.totalOutputTokens),
        cacheRead: num(item.totalCacheReadTokens),
        cacheWrite: num(item.totalCacheWrite5mTokens) + num(item.totalCacheWrite1hTokens),
      },
      costUsd: microCentsToUsd(item.totalCostMicroCents),
    }))
    .sort((a, b) => b.costUsd - a.costUsd || a.key.localeCompare(b.key))
}

export function normalizeDays(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((item) => ({
      date: item.date,
      requests: num(item.totalRequests),
      tokens: num(item.totalTokens),
      costUsd: microCentsToUsd(item.totalCostMicroCents),
    }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

function capValue(caps, key) {
  const value = caps?.[key]
  return typeof value === "number" && value > 0 ? value : null
}

export function withCaps(models, caps = {}) {
  return models.map((model) => {
    const cap = capValue(caps, model.key)
    return { ...model, cap, share: cap === null ? null : model.costUsd / cap }
  })
}

async function send(path, { key, baseUrl, fetchImpl, timeoutMs }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`console ${path} -> ${response.status}`)
    return response
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`console ${path} timed out after ${timeoutMs}ms`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchUsage({
  range = "30d",
  key,
  baseUrl = BASE_URL,
  fetchImpl = fetch,
  timeoutMs = 20000,
} = {}) {
  const request = async (path) => {
    const response = await send(path, { key, baseUrl, fetchImpl, timeoutMs })
    return response.json()
  }
  const [summary, models, days, budgets] = await Promise.all([
    request(`/api/usage/summary?range=${range}`),
    request(`/api/usage/models?range=${range}`),
    request("/api/usage/cost-by-day"),
    request("/api/v2/budget-policies"),
  ])
  return {
    summary: normalizeSummary(summary, range),
    models: normalizeModels(models).filter((model) => model.requests > 0),
    days: normalizeDays(days),
    budgets,
    fetchedAt: new Date().toISOString(),
  }
}

export async function fetchCsv({
  range = "30d",
  key,
  baseUrl = BASE_URL,
  fetchImpl = fetch,
  timeoutMs = 20000,
} = {}) {
  const response = await send(`/api/v2/usage/export?range=${range}`, { key, baseUrl, fetchImpl, timeoutMs })
  return response.text()
}

export function buildState(usage, caps = {}) {
  const { range, ...summary } = usage.summary
  return {
    generatedAt: usage.fetchedAt,
    range,
    source: "console",
    summary,
    models: withCaps(usage.models, caps),
    days: usage.days,
    budgets: usage.budgets,
  }
}

export function defaultStatePath() {
  return join(dirname(defaultStorePath()), "console.json")
}

export function writeState(state, file = defaultStatePath()) {
  mkdirSync(dirname(file), { recursive: true })
  const body = JSON.stringify(state, null, 2) + "\n"
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, body, "utf8")
  try {
    renameSync(temp, file)
  } catch {
    writeFileSync(file, body, "utf8")
    try {
      unlinkSync(temp)
    } catch {}
  }
  return file
}

export function loadState(file = defaultStatePath()) {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

function readBudget() {
  const user = join(dirname(defaultStorePath()), "budget.json")
  const file = existsSync(user) ? user : join(import.meta.dirname, "budget.json")
  if (!existsSync(file)) return { plan: "go", caps: {} }
  return JSON.parse(readFileSync(file, "utf8"))
}

function money(value) {
  return Number(Number(value).toFixed(4))
}

function percent(share) {
  return share === null || share === undefined ? "-" : Number((share * 100).toFixed(1))
}

function totalTokens(tokens) {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite
}

function printTable(state) {
  console.table(
    state.models.map((row) => ({
      key: row.key,
      requests: row.requests,
      tokens: formatTokens(totalTokens(row.tokens)),
      "cost $": money(row.costUsd),
      cap: row.cap ?? "unlimited",
      "share %": percent(row.share),
    })),
  )
  console.log(
    `total: ${state.summary.requests} requests | ${formatTokens(
      state.summary.inputTokens +
        state.summary.outputTokens +
        state.summary.cacheReadTokens +
        state.summary.cacheWriteTokens,
    )} tokens | $${money(state.summary.costUsd).toFixed(2)}`,
  )
}

function printCompare(state) {
  const file = join(dirname(defaultStorePath()), "month.json")
  const local = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null
  const byKey = new Map((local?.models ?? []).map((row) => [row.key, row.monthToDate]))
  const rows = new Map(state.models.map((row) => [row.key, row.costUsd]))
  for (const key of byKey.keys()) if (!rows.has(key)) rows.set(key, 0)
  console.table(
    [...rows.entries()]
      .map(([key, costUsd]) => {
        const month = byKey.get(key) ?? 0
        const delta = costUsd - month
        return {
          key,
          "console $": money(costUsd),
          "month $": money(month),
          "delta $": money(delta),
          "delta %": month > 0 ? Number(((delta / month) * 100).toFixed(1)) : "-",
        }
      })
      .sort((a, b) => b["console $"] - a["console $"] || a.key.localeCompare(b.key)),
  )
  console.log(`compare: console ${state.range} vs local month-to-date (${local?.generatedAt ?? "no month.json"})`)
}

function parseArgs(argv) {
  const opts = { range: "30d", json: false, write: false, csv: null, compare: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--range") opts.range = argv[++index]
    else if (arg === "--json") opts.json = true
    else if (arg === "--write") opts.write = true
    else if (arg === "--csv") opts.csv = argv[++index]
    else if (arg === "--compare") opts.compare = true
    else if (arg === "--help") opts.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!RANGES.has(opts.range)) throw new Error(`unknown range: ${opts.range} (use 7d or 30d)`)
  if (opts.csv === undefined) throw new Error("--csv needs a path")
  return opts
}

export async function run() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log(HELP)
    return
  }
  const key = readApiKey()
  const usage = await fetchUsage({ range: opts.range, key })
  const budget = readBudget()
  const state = buildState(usage, budget.caps)

  if (opts.json) console.log(JSON.stringify(state, null, 2))
  else printTable(state)
  if (opts.compare) printCompare(state)
  if (opts.csv) {
    writeFileSync(opts.csv, await fetchCsv({ range: opts.range, key }), "utf8")
    console.log(`wrote ${opts.csv}`)
  }
  if (opts.write) console.log(`wrote ${writeState(state)}`)
}

function fail(error) {
  const message = error?.message ?? String(error)
  console.error(message.startsWith("console:") ? message : `console: ${message}`)
  process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run().catch(fail)
