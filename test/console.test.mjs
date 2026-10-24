import assert from "node:assert/strict"
import { rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import {
  buildState,
  fetchCsv,
  fetchUsage,
  loadState,
  microCentsToUsd,
  normalizeDays,
  normalizeModels,
  normalizeSummary,
  readApiKey,
  withCaps,
} from "../src/lib/console.mjs"

const summaryPayload = {
  totalRequests: "20304",
  totalInputTokens: "106775608",
  totalOutputTokens: "15905751",
  totalCacheReadTokens: "2848325248",
  totalCacheWrite5mTokens: "49039",
  totalCacheWrite1hTokens: "41000",
  totalCostMicroCents: "626836195",
  services: [],
}

const modelsPayload = {
  items: [
    {
      model: "hy3",
      provider: "opencode-go",
      totalRequests: "1053",
      totalInputTokens: "3280928",
      totalOutputTokens: "1111821",
      totalCacheReadTokens: "99051456",
      totalCacheWrite5mTokens: "0",
      totalCacheWrite1hTokens: "0",
      totalCostMicroCents: "457098706",
    },
    {
      model: "glm-5.3",
      provider: "opencode-go",
      totalRequests: "20",
      totalInputTokens: "1000",
      totalOutputTokens: "2000",
      totalCacheReadTokens: "0",
      totalCacheWrite5mTokens: "500",
      totalCacheWrite1hTokens: "0",
      totalCostMicroCents: "92640862",
    },
    {
      model: "unused",
      provider: "opencode-go",
      totalRequests: "0",
      totalInputTokens: "0",
      totalOutputTokens: "0",
      totalCacheReadTokens: "0",
      totalCacheWrite5mTokens: "0",
      totalCacheWrite1hTokens: "0",
      totalCostMicroCents: "0",
    },
  ],
  pageInfo: { page: 1 },
}

const daysPayload = [
  { date: "2026-10-24", totalCostMicroCents: "87544918", totalTokens: "60530981", totalRequests: "786" },
  { date: "2026-10-22", totalCostMicroCents: "10000000", totalTokens: "1000", totalRequests: "10" },
]

const key = "oc_sk_test_secret_value"

function fakeFetch(routes, calls, status = 200) {
  return async (url, init) => {
    calls.push({ url, init })
    const path = new URL(url).pathname
    if (status !== 200) {
      return { ok: false, status, json: async () => ({}), text: async () => "" }
    }
    const payload = routes[path]
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
    }
  }
}

const routes = {
  "/api/usage/summary": summaryPayload,
  "/api/usage/models": modelsPayload,
  "/api/usage/cost-by-day": daysPayload,
  "/api/v2/budget-policies": [],
}

test("micro cents convert to usd for strings, numbers and junk", () => {
  assert.equal(microCentsToUsd(626836195), 6.26836195)
  assert.equal(microCentsToUsd("87544918"), 0.87544918)
  assert.equal(microCentsToUsd(null), 0)
  assert.equal(microCentsToUsd(undefined), 0)
  assert.equal(microCentsToUsd("garbage"), 0)
  assert.equal(microCentsToUsd(""), 0)
})

test("read api key names the auth path when the key is missing", () => {
  assert.throws(() => readApiKey("C:/definitely/not/auth.json"), /console: no opencode API key in C:\/definitely\/not\/auth\.json/)
})

test("summary normalizes strings and adds both cache write windows", () => {
  const summary = normalizeSummary(summaryPayload, "30d")
  assert.deepEqual(summary, {
    range: "30d",
    requests: 20304,
    inputTokens: 106775608,
    outputTokens: 15905751,
    cacheReadTokens: 2848325248,
    cacheWriteTokens: 90039,
    costUsd: 6.26836195,
  })
})

test("models normalize, build keys and sort by cost", () => {
  const models = normalizeModels(modelsPayload)
  assert.deepEqual(
    models.map((model) => model.key),
    ["opencode-go/hy3", "opencode-go/glm-5.3", "opencode-go/unused"],
  )
  assert.deepEqual(models[1], {
    provider: "opencode-go",
    model: "glm-5.3",
    key: "opencode-go/glm-5.3",
    requests: 20,
    tokens: { input: 1000, output: 2000, cacheRead: 0, cacheWrite: 500 },
    costUsd: 0.92640862,
  })
  assert.deepEqual(normalizeModels({}), [])
})

test("days normalize and sort by date ascending", () => {
  const days = normalizeDays(daysPayload)
  assert.deepEqual(
    days.map((day) => day.date),
    ["2026-10-22", "2026-10-24"],
  )
  assert.deepEqual(days[1], { date: "2026-10-24", requests: 786, tokens: 60530981, costUsd: 0.87544918 })
  assert.deepEqual(normalizeDays(null), [])
})

test("caps attach share only for real positive caps and never clamp", () => {
  const models = normalizeModels(modelsPayload).slice(0, 2)
  const rows = withCaps(models, {
    "opencode-go/hy3": 60,
    "opencode-go/glm-5.3": "unlimited",
    "opencode-go/unused": null,
    "opencode-go/over": 0.1,
  })
  assert.equal(rows[0].cap, 60)
  assert.equal(rows[0].share, models[0].costUsd / 60)
  assert.equal(rows[1].cap, null)
  assert.equal(rows[1].share, null)

  const [over] = withCaps([{ ...models[0], key: "opencode-go/over", costUsd: 1 }], { "opencode-go/over": 0.1 })
  assert.equal(over.cap, 0.1)
  assert.equal(over.share, 10)
})

test("fetchUsage calls the four endpoints with the range and drops zero-request models", async () => {
  const calls = []
  const usage = await fetchUsage({ range: "7d", key, fetchImpl: fakeFetch(routes, calls) })

  assert.equal(calls.length, 4)
  const urls = calls.map((call) => call.url)
  assert.ok(urls.includes("https://console.opencode.ai/api/usage/summary?range=7d"))
  assert.ok(urls.includes("https://console.opencode.ai/api/usage/models?range=7d"))
  assert.ok(urls.includes("https://console.opencode.ai/api/usage/cost-by-day"))
  assert.ok(urls.includes("https://console.opencode.ai/api/v2/budget-policies"))
  assert.ok(calls.every((call) => call.init.headers.Authorization === `Bearer ${key}`))

  assert.equal(usage.summary.range, "7d")
  assert.equal(usage.summary.costUsd, 6.26836195)
  assert.deepEqual(
    usage.models.map((model) => model.key),
    ["opencode-go/hy3", "opencode-go/glm-5.3"],
  )
  assert.deepEqual(usage.days.map((day) => day.date), ["2026-10-22", "2026-10-24"])
  assert.deepEqual(usage.budgets, [])
  assert.ok(!Number.isNaN(Date.parse(usage.fetchedAt)))
})

test("fetchUsage accepts a custom base url", async () => {
  const calls = []
  await fetchUsage({ key, baseUrl: "http://local.test", fetchImpl: fakeFetch(routes, calls) })
  assert.ok(calls.every((call) => call.url.startsWith("http://local.test/")))
})

test("fetchUsage reports the path and status on a non-2xx response", async () => {
  await assert.rejects(
    fetchUsage({ key, fetchImpl: fakeFetch(routes, [], 503) }),
    /console \/api\/usage\/summary\?range=30d -> 503/,
  )
})

test("fetchCsv downloads the export for the requested range", async () => {
  const header = "day,user_type,user_id,user_name,provider,model,requests"
  const calls = []
  const text = await fetchCsv({
    range: "7d",
    key,
    fetchImpl: fakeFetch({ "/api/v2/usage/export": header }, calls),
  })
  assert.equal(text, header)
  assert.equal(calls[0].url, "https://console.opencode.ai/api/v2/usage/export?range=7d")
})

test("loadState returns null for missing and torn files", () => {
  const file = join(tmpdir(), `console-state-${process.pid}.json`)
  writeFileSync(file, '{"generatedAt":', "utf8")
  assert.equal(loadState(file), null)
  assert.equal(loadState("C:/definitely/not/console.json"), null)
  rmSync(file, { force: true })
})

test("persisted state never contains the api key", async () => {
  const usage = await fetchUsage({ key, fetchImpl: fakeFetch(routes, []) })
  const state = buildState(usage, { "opencode-go/hy3": 60 })
  const text = JSON.stringify(state)
  assert.ok(!text.includes(key))
  assert.ok(!text.includes("oc_sk_"))
  assert.deepEqual(Object.keys(state), ["generatedAt", "range", "source", "summary", "models", "days", "budgets"])
  assert.deepEqual(Object.keys(state.summary), [
    "requests",
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "costUsd",
  ])
  assert.equal(state.models[0].cap, 60)
  assert.equal(state.models[0].share, state.models[0].costUsd / 60)
})
