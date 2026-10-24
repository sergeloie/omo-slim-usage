import assert from "node:assert/strict"
import { test } from "node:test"
import { listCost, loadCatalog, peakMultiplier, priceFor, withOverrides } from "../src/lib/pricing.mjs"

const catalog = {
  "opencode-go": {
    models: {
      "deepseek-v4.1-flash": { cost: { input: 0.15, output: 0.6, cache_read: 0.003 } },
      "tier-model": {
        cost: {
          input: 1,
          output: 2,
          cache_read: 0.1,
          tiers: [{ input: 2, output: 4, cache_read: 0.2, cache_write: 2, tier: { type: "context", size: 200000 } }],
        },
      },
      legacy: {
        cost: {
          input: 1,
          output: 2,
          cache_read: 0.1,
          context_over_200k: { input: 2, output: 4, cache_read: 0.2, cache_write: 2 },
        },
      },
    },
  },
}

const tokens = (overrides) => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, ...overrides })

test("catalog prices map cache_read and cache_write to camelCase rates", () => {
  const price = priceFor(catalog, "opencode-go", "tier-model")
  assert.equal(price.input, 1)
  assert.equal(price.cacheRead, 0.1)
  assert.equal(price.cacheWrite, null)
  assert.equal(price.tiers[0].cacheRead, 0.2)
  assert.equal(price.tiers[0].size, 200000)
})

test("a model absent from the catalog has no price", () => {
  assert.equal(priceFor(catalog, "opencode-go", "does-not-exist"), null)
  assert.equal(priceFor(catalog, "elsewhere", "tier-model"), null)
})

test("input, output, cache read and cache write tokens each bill at their own rate", () => {
  const price = { input: 10, output: 20, cacheRead: 1, cacheWrite: 2 }
  const cost = listCost(price, tokens({ input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 }), 0)
  assert.equal(cost, 33)
})

test("cache write tokens fall back to the input rate when no cache write rate exists", () => {
  assert.equal(listCost({ input: 10, output: 20, cacheRead: 1 }, tokens({ cacheWrite: 1_000_000 }), 0), 10)
})

test("reasoning tokens bill at the output rate and are not charged twice", () => {
  const price = { input: 10, output: 20 }
  assert.equal(listCost(price, tokens({ output: 1_000_000, reasoning: 1_000_000 }), 0), 40)
})

test("a request above the tier prompt size uses the tier rates", () => {
  const price = priceFor(catalog, "opencode-go", "tier-model")
  assert.equal(listCost(price, tokens({ input: 200_001 }), 0), 0.400002)
  assert.equal(listCost(price, tokens({ input: 199_999 }), 0), 0.199999)
})

test("a tier without a cache write rate falls back to that tier's input rate", () => {
  const price = priceFor(catalog, "opencode-go", "tier-model")
  assert.equal(listCost(price, tokens({ input: 300_000, cacheWrite: 1_000_000 }), 0), 2.6)
})

test("context_over_200k becomes a tier when the catalog has no tiers array", () => {
  const price = priceFor(catalog, "opencode-go", "legacy")
  assert.equal(price.tiers[0].size, 200000)
  assert.equal(listCost(price, tokens({ input: 250_000 }), 0), 0.5)
  assert.equal(listCost(price, tokens({ input: 100_000 }), 0), 0.1)
})

test("peak multiplier doubles deepseek v4.1 flash on a weekday at 02:00 UTC", () => {
  assert.equal(peakMultiplier("opencode-go", "deepseek-v4.1-flash", Date.UTC(2026, 9, 26, 2, 0, 0)), 2)
})

test("peak multiplier doubles deepseek v4 pro on a weekday at 09:59 UTC", () => {
  assert.equal(peakMultiplier("opencode-go", "deepseek-v4-pro", Date.UTC(2026, 9, 26, 9, 59, 0)), 2)
})

test("peak multiplier is 1 on saturday, at window edges and outside peak hours", () => {
  assert.equal(peakMultiplier("opencode-go", "deepseek-v4.1-flash", Date.UTC(2026, 9, 24, 2, 0, 0)), 1)
  assert.equal(peakMultiplier("opencode-go", "deepseek-v4.1-flash", Date.UTC(2026, 9, 26, 4, 0, 0)), 1)
  assert.equal(peakMultiplier("opencode-go", "deepseek-v4.1-flash", Date.UTC(2026, 9, 26, 10, 0, 0)), 1)
})

test("peak multiplier leaves non-deepseek models and other providers unchanged", () => {
  const at = Date.UTC(2026, 9, 26, 2, 0, 0)
  assert.equal(peakMultiplier("opencode-go", "glm-5.3", at), 1)
  assert.equal(peakMultiplier("elsewhere", "deepseek-v4.1-flash", at), 1)
})

test("loadCatalog reads the local model catalog", () => {
  const loaded = loadCatalog()
  assert.ok(loaded["opencode-go"].models["deepseek-v4.1-flash"].cost.input > 0)
})

test("budget price overrides fill catalog gaps and never replace catalog prices", () => {
  const merged = withOverrides(catalog, {
    "opencode-go/deepseek-v4.1-flash": { input: 99 },
    "opencode-go/kimi-k3.1-pro": { input: 2, output: 10, cache_read: 0.2, cache_write: 2 },
  })
  assert.equal(merged["opencode-go"].models["deepseek-v4.1-flash"].cost.input, 0.15)
  const price = priceFor(merged, "opencode-go", "kimi-k3.1-pro")
  assert.deepEqual(
    { input: price.input, output: price.output, cacheRead: price.cacheRead, cacheWrite: price.cacheWrite },
    { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2 },
  )
  assert.equal(catalog["opencode-go"].models["kimi-k3.1-pro"], undefined)
})
