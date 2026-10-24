import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { pathToFileURL } from "node:url"
import { defaultStorePath } from "./store.mjs"
import { listCost, loadCatalog, peakMultiplier, priceFor, withOverrides } from "./pricing.mjs"

const DAY = 86400000
const FIVE_HOURS = 5 * 3600000

function startOfMonth(now) {
  const date = new Date(now)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
}

function startOfNextMonth(now) {
  const date = new Date(now)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
}

function emptyTokens() {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
}

function addTokens(target, tokens) {
  target.input += tokens.input
  target.output += tokens.output
  target.reasoning += tokens.reasoning
  target.cacheRead += tokens.cacheRead
  target.cacheWrite += tokens.cacheWrite
}

function capValue(caps, key) {
  const value = caps?.[key]
  return typeof value === "number" && value > 0 ? value : null
}

function shareOf(spend, cap, factor) {
  return cap === null ? null : spend / (cap * factor)
}

function costOf(message, catalog) {
  const price = catalog ? priceFor(catalog, message.provider, message.model) : null
  if (price) {
    return (
      listCost(price, message.tokens, message.at) *
      peakMultiplier(message.provider, message.model, message.at)
    )
  }
  return Number(message.listCost ?? 0)
}

export function readMessages(dbPath, from, to, catalog = loadCatalog()) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const rows = db
      .prepare(
        `select
           json_extract(data, '$.agent') as agent,
           json_extract(data, '$.model.providerID') as provider,
           json_extract(data, '$.model.id') as model,
           json_extract(data, '$.tokens.input') as input,
           json_extract(data, '$.tokens.output') as output,
           json_extract(data, '$.tokens.reasoning') as reasoning,
           json_extract(data, '$.tokens.cache.read') as cache_read,
           json_extract(data, '$.tokens.cache.write') as cache_write,
           json_extract(data, '$.cost') as charged,
           time_created as at
         from session_message
         where type = 'assistant'
           and time_created >= ?
           and time_created <= ?
           and json_extract(data, '$.model.providerID') is not null
         order by time_created`,
      )
      .all(from, to)
    return rows.map((row) => {
      const message = {
        agent: row.agent ?? "unknown",
        provider: row.provider,
        model: row.model,
        tokens: {
          input: Number(row.input ?? 0),
          output: Number(row.output ?? 0),
          reasoning: Number(row.reasoning ?? 0),
          cacheRead: Number(row.cache_read ?? 0),
          cacheWrite: Number(row.cache_write ?? 0),
        },
        charged: Number(row.charged ?? 0),
        at: Number(row.at),
      }
      message.listCost = costOf(message, catalog)
      return message
    })
  } finally {
    db.close()
  }
}

function groupSpend(messages, catalog, keyOf) {
  const groups = new Map()
  for (const message of messages) {
    const key = keyOf(message)
    let entry = groups.get(key)
    if (!entry) {
      entry = { key, requests: 0, tokens: emptyTokens(), listCost: 0, charged: 0 }
      groups.set(key, entry)
    }
    entry.requests += 1
    addTokens(entry.tokens, message.tokens)
    entry.listCost += costOf(message, catalog)
    entry.charged += message.charged
  }
  return [...groups.values()].sort((a, b) => b.listCost - a.listCost || a.key.localeCompare(b.key))
}

export function spendByModel(messages, catalog) {
  return groupSpend(messages, catalog, (message) => `${message.provider}/${message.model}`).map((row) => {
    const [provider, ...rest] = row.key.split("/")
    return { ...row, provider, model: rest.join("/") }
  })
}

export function spendByRole(messages, catalog) {
  return groupSpend(messages, catalog, (message) => message.agent).map((row) => ({ ...row, agent: row.key }))
}

export function spendByRoleModel(messages, catalog) {
  return groupSpend(messages, catalog, (message) => `${message.agent}|${message.provider}/${message.model}`).map(
    (row) => {
      const [agent, rest] = row.key.split("|")
      const [provider, ...model] = rest.split("/")
      return { ...row, agent, provider, model: model.join("/") }
    },
  )
}

export function windowStatus(messages, caps, { now = Date.now(), catalog } = {}) {
  const monthStart = startOfMonth(now)
  const fiveHourStart = now - FIVE_HOURS
  const weekStart = now - 7 * DAY
  const groups = new Map()
  for (const message of messages) {
    const key = `${message.provider}/${message.model}`
    let entry = groups.get(key)
    if (!entry) {
      entry = { key, requests: 0, tokens: emptyTokens(), monthToDate: 0, charged: 0, fiveHour: 0, sevenDay: 0 }
      groups.set(key, entry)
    }
    const cost = costOf(message, catalog)
    if (message.at >= monthStart && message.at <= now) {
      entry.monthToDate += cost
      entry.charged += message.charged
      entry.requests += 1
      addTokens(entry.tokens, message.tokens)
    }
    if (message.at >= fiveHourStart && message.at <= now) entry.fiveHour += cost
    if (message.at >= weekStart && message.at <= now) entry.sevenDay += cost
  }
  return [...groups.values()]
    .map((entry) => {
      const cap = capValue(caps, entry.key)
      return {
        key: entry.key,
        monthlyCap: cap,
        monthToDate: entry.monthToDate,
        fiveHour: entry.fiveHour,
        sevenDay: entry.sevenDay,
        monthShare: shareOf(entry.monthToDate, cap, 1),
        fiveHourShare: shareOf(entry.fiveHour, cap, 0.2),
        weekShare: shareOf(entry.sevenDay, cap, 0.5),
        requests: entry.requests,
        charged: entry.charged,
        tokens: entry.tokens,
      }
    })
    .sort((a, b) => b.monthToDate - a.monthToDate || a.key.localeCompare(b.key))
}

export function forecast(messages, caps, { now = Date.now(), catalog } = {}) {
  const monthStart = startOfMonth(now)
  const monthEnd = startOfNextMonth(now)
  const elapsedDays = (now - monthStart) / DAY
  const monthDays = (monthEnd - monthStart) / DAY
  const groups = new Map()
  for (const message of messages) {
    if (message.at < monthStart || message.at > now) continue
    const key = `${message.provider}/${message.model}`
    groups.set(key, (groups.get(key) ?? 0) + costOf(message, catalog))
  }
  const perModel = [...groups.entries()]
    .map(([key, monthToDate]) => {
      const cap = capValue(caps, key)
      const projected = elapsedDays > 0 ? monthToDate * (monthDays / elapsedDays) : 0
      return { key, monthToDate, projected, cap, willExceed: cap !== null && projected > cap }
    })
    .sort((a, b) => b.monthToDate - a.monthToDate || a.key.localeCompare(b.key))
  return { elapsedDays, monthDays, perModel }
}

export function capsStatus(rows, caps) {
  return rows.map((row) => {
    const cap = capValue(caps, row.key)
    return {
      ...row,
      cap,
      share: cap === null ? null : row.listCost / cap,
      remaining: cap === null ? null : Math.max(0, cap - row.listCost),
    }
  })
}

function usageDir() {
  return dirname(defaultStorePath())
}

function defaultDbPath() {
  return join(homedir(), ".local", "share", "opencode", "opencode.db")
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
  return tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheWrite
}

function printTables(models, roles) {
  console.table(
    models.map((row) => ({
      key: row.key,
      requests: row.requests,
      tokens: totalTokens(row.tokens),
      "month $": money(row.monthToDate),
      cap: row.monthlyCap ?? "unlimited",
      "month %": percent(row.monthShare),
      "5h %": percent(row.fiveHourShare),
      "7d %": percent(row.weekShare),
      forecast: money(row.projected),
    })),
  )
  console.table(
    roles.map((row) => ({
      role: row.key,
      requests: row.requests,
      tokens: totalTokens(row.tokens),
      "month $": money(row.listCost),
      charged: money(row.charged),
    })),
  )
  const monthToDate = models.reduce((sum, row) => sum + row.monthToDate, 0)
  const charged = roles.reduce((sum, row) => sum + row.charged, 0)
  const projected = models.reduce((sum, row) => sum + row.projected, 0)
  console.log(
    `total: month $${money(monthToDate).toFixed(2)} | charged $${money(charged).toFixed(2)} | forecast $${money(
      projected,
    ).toFixed(2)}`,
  )
}

function csvValue(value) {
  if (value === null || value === undefined) return ""
  return typeof value === "number" ? Number(value.toFixed(6)) : String(value)
}

function writeCsv(path, models, roles, roleModels = []) {
  const header =
    "section,key,requests,input,output,reasoning,cacheRead,cacheWrite,listCost,charged,cap,monthShare,fiveHourShare,weekShare,projected"
  const lines = [header]
  for (const row of models) {
    lines.push(
      [
        "model",
        row.key,
        row.requests,
        row.tokens.input,
        row.tokens.output,
        row.tokens.reasoning,
        row.tokens.cacheRead,
        row.tokens.cacheWrite,
        row.monthToDate,
        row.charged,
        row.monthlyCap,
        row.monthShare,
        row.fiveHourShare,
        row.weekShare,
        row.projected,
      ]
        .map(csvValue)
        .join(","),
    )
  }
  for (const row of roles) {
    lines.push(
      [
        "role",
        row.key,
        row.requests,
        row.tokens.input,
        row.tokens.output,
        row.tokens.reasoning,
        row.tokens.cacheRead,
        row.tokens.cacheWrite,
        row.listCost,
        row.charged,
        null,
        null,
        null,
        null,
        null,
      ]
        .map(csvValue)
        .join(","),
    )
  }
  for (const row of roleModels) {
    lines.push(
      [
        "role-model",
        `${row.agent}|${row.provider}/${row.model}`,
        row.requests,
        row.tokens.input,
        row.tokens.output,
        row.tokens.reasoning,
        row.tokens.cacheRead,
        row.tokens.cacheWrite,
        row.listCost,
        row.charged,
        null,
        null,
        null,
        null,
        null,
      ]
        .map(csvValue)
        .join(","),
    )
  }
  writeFileSync(path, lines.join("\n") + "\n", "utf8")
}

function writeState(state) {
  const file = join(usageDir(), "month.json")
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

function parseArgs(argv) {
  const opts = { json: false, write: false, csv: null, db: null, catalog: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--json") opts.json = true
    else if (arg === "--write") opts.write = true
    else if (arg === "--csv") opts.csv = argv[++index]
    else if (arg === "--db") opts.db = argv[++index]
    else if (arg === "--catalog") opts.catalog = argv[++index]
    else throw new Error(`unknown argument: ${arg}`)
  }
  return opts
}

export function run() {
  const opts = parseArgs(process.argv.slice(2))
  const now = Date.now()
  const monthStart = startOfMonth(now)
  const budget = readBudget()
  const catalog = withOverrides(loadCatalog(opts.catalog ?? undefined), budget.prices)
  const messages = readMessages(opts.db ?? defaultDbPath(), monthStart, now, catalog)
  const status = windowStatus(messages, budget.caps, { now, catalog })
  const forecastResult = forecast(messages, budget.caps, { now, catalog })
  const projectedByKey = new Map(forecastResult.perModel.map((entry) => [entry.key, entry]))
  const models = status.map((row) => ({
    ...row,
    projected: projectedByKey.get(row.key)?.projected ?? 0,
    willExceed: projectedByKey.get(row.key)?.willExceed ?? false,
  }))
  const roles = spendByRole(messages, catalog)
  const roleModels = spendByRoleModel(messages, catalog)
  const state = {
    generatedAt: new Date(now).toISOString(),
    window: { from: new Date(monthStart).toISOString(), to: new Date(now).toISOString() },
    plan: budget.plan ?? "go",
    models,
    roles,
    roleModels,
    forecast: forecastResult,
  }
  if (opts.json) console.log(JSON.stringify(state, null, 2))
  else printTables(models, roles)
  if (opts.csv) writeCsv(opts.csv, models, roles, roleModels)
  if (opts.write) console.log(`wrote ${writeState(state)}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run()
