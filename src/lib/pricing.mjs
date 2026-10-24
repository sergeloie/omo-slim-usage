import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const PEAK_MODELS = new Set(["deepseek-v4.1-flash", "deepseek-v4-pro"])
const PEAK_HOURS = new Set([1, 2, 3, 6, 7, 8, 9])

export function defaultCatalogPath() {
  return join(homedir(), ".cache", "opencode", "models.json")
}

export function loadCatalog(path = defaultCatalogPath()) {
  return JSON.parse(readFileSync(path, "utf8"))
}

function rate(value) {
  return Number.isFinite(value) ? value : null
}

function tierFrom(raw, size) {
  return {
    size,
    input: rate(raw.input),
    output: rate(raw.output),
    cacheRead: rate(raw.cache_read),
    cacheWrite: rate(raw.cache_write),
  }
}

export function withOverrides(catalog, prices = {}) {
  const merged = { ...catalog }
  for (const [key, cost] of Object.entries(prices ?? {})) {
    const slash = key.indexOf("/")
    if (slash < 1 || !cost) continue
    const providerID = key.slice(0, slash)
    const modelID = key.slice(slash + 1)
    if (merged[providerID]?.models?.[modelID]?.cost) continue
    const provider = merged[providerID] ?? { models: {} }
    merged[providerID] = {
      ...provider,
      models: { ...provider.models, [modelID]: { ...(provider.models?.[modelID] ?? {}), cost } },
    }
  }
  return merged
}

export function priceFor(catalog, providerID, modelID) {
  const cost = catalog?.[providerID]?.models?.[modelID]?.cost
  if (!cost) return null
  const tiers = Array.isArray(cost.tiers)
    ? cost.tiers.map((entry) => tierFrom(entry, entry.tier?.size ?? 0))
    : cost.context_over_200k
      ? [tierFrom(cost.context_over_200k, 200000)]
      : undefined
  const price = {
    input: rate(cost.input),
    output: rate(cost.output),
    cacheRead: rate(cost.cache_read),
    cacheWrite: rate(cost.cache_write),
  }
  if (tiers?.length) price.tiers = tiers
  return price
}

function rateFor(price, prompt) {
  let best = null
  for (const tier of price.tiers ?? []) {
    if (prompt > tier.size && (!best || tier.size > best.size)) best = tier
  }
  return best ?? price
}

export function listCost(price, tokens, at = Date.now()) {
  if (!price) return 0
  const input = Number(tokens?.input ?? 0)
  const output = Number(tokens?.output ?? 0)
  const reasoning = Number(tokens?.reasoning ?? 0)
  const cacheRead = Number(tokens?.cacheRead ?? 0)
  const cacheWrite = Number(tokens?.cacheWrite ?? 0)
  const selected = rateFor(price, input + cacheRead + cacheWrite)
  const inputRate = selected.input ?? price.input ?? 0
  const outputRate = selected.output ?? price.output ?? 0
  const cacheReadRate = selected.cacheRead ?? price.cacheRead ?? inputRate
  const cacheWriteRate = selected.cacheWrite ?? price.cacheWrite ?? inputRate
  return (
    (input * inputRate + cacheRead * cacheReadRate + cacheWrite * cacheWriteRate + (output + reasoning) * outputRate) /
    1_000_000
  )
}

export function peakMultiplier(providerID, modelID, at = Date.now()) {
  if (providerID !== "opencode-go" || !PEAK_MODELS.has(modelID)) return 1
  const date = new Date(at)
  const day = date.getUTCDay()
  if (day === 0 || day === 6) return 1
  return PEAK_HOURS.has(date.getUTCHours()) ? 2 : 1
}
