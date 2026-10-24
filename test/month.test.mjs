import assert from "node:assert/strict"
import { test } from "node:test"
import { capsStatus, forecast, spendByModel, spendByRole, spendByRoleModel, windowStatus } from "../src/lib/month.mjs"

const catalog = {
  "opencode-go": {
    models: {
      "glm-5.3": { cost: { input: 1, output: 2, cache_read: 0.1 } },
      hy3: { cost: { input: 2, output: 4, cache_read: 0.2 } },
      "deepseek-v4.1-flash": { cost: { input: 0.15, output: 0.6, cache_read: 0.003 } },
    },
  },
}

const tokens = (input = 0, output = 0) => ({ input, output, reasoning: 0, cacheRead: 0, cacheWrite: 0 })

const message = (overrides) => ({
  agent: "orchestrator",
  provider: "opencode-go",
  model: "glm-5.3",
  tokens: tokens(),
  charged: 0,
  at: Date.UTC(2026, 9, 2),
  ...overrides,
})

const now = Date.UTC(2026, 9, 15, 12, 0, 0)

test("spend by model groups requests and keeps list cost apart from charged cost", () => {
  const messages = [
    message({ tokens: tokens(1_000_000), charged: 0 }),
    message({ tokens: tokens(500_000), charged: 0 }),
    message({ model: "hy3", tokens: tokens(1_000_000), charged: 3 }),
  ]
  const rows = spendByModel(messages, catalog)
  assert.deepEqual(
    rows.map((row) => row.key),
    ["opencode-go/hy3", "opencode-go/glm-5.3"],
  )
  const glm = rows.find((row) => row.key === "opencode-go/glm-5.3")
  assert.equal(glm.requests, 2)
  assert.equal(glm.tokens.input, 1_500_000)
  assert.equal(glm.listCost, 1.5)
  assert.equal(glm.charged, 0)
  const hy3 = rows.find((row) => row.key === "opencode-go/hy3")
  assert.equal(hy3.listCost, 2)
  assert.equal(hy3.charged, 3)
})

test("spend by model applies the peak multiplier per message timestamp", () => {
  const rows = spendByModel(
    [
      message({ model: "deepseek-v4.1-flash", tokens: tokens(1_000_000), at: Date.UTC(2026, 9, 26, 2) }),
      message({ model: "deepseek-v4.1-flash", tokens: tokens(1_000_000), at: Date.UTC(2026, 9, 24, 2) }),
    ],
    catalog,
  )
  assert.equal(Number(rows[0].listCost.toFixed(6)), 0.45)
})

test("spend by role groups requests by agent", () => {
  const messages = [
    message({ agent: "orchestrator", tokens: tokens(1_000_000) }),
    message({ agent: "fixer", tokens: tokens(1_000_000) }),
    message({ agent: "fixer", tokens: tokens(1_000_000) }),
  ]
  const rows = spendByRole(messages, catalog)
  assert.deepEqual(
    rows.map((row) => row.key),
    ["fixer", "orchestrator"],
  )
  assert.equal(rows.find((row) => row.key === "fixer").requests, 2)
  assert.equal(rows.find((row) => row.key === "fixer").listCost, 2)
})

test("an unpriced model still reports its tokens with zero list cost", () => {
  const rows = spendByModel([message({ model: "unknown-model", tokens: tokens(10) })], catalog)
  assert.equal(rows[0].listCost, 0)
  assert.equal(rows[0].tokens.input, 10)
})

test("window status reports month, five hour and seven day spend against each model's own cap", () => {
  const messages = [
    message({ listCost: 10, at: now - 3_600_000 }),
    message({ listCost: 10, at: now - 2 * 86400000 }),
    message({ listCost: 100, at: now - 40 * 86400000 }),
  ]
  const rows = windowStatus(messages, { "opencode-go/glm-5.3": 100 }, { now })
  assert.equal(rows.length, 1)
  const row = rows[0]
  assert.equal(row.monthlyCap, 100)
  assert.equal(row.monthToDate, 20)
  assert.equal(row.fiveHour, 10)
  assert.equal(row.sevenDay, 20)
  assert.equal(row.monthShare, 0.2)
  assert.equal(row.fiveHourShare, 0.5)
  assert.equal(row.weekShare, 0.4)
})

test("an unlimited cap yields null shares", () => {
  const rows = windowStatus([message({ listCost: 10, at: now })], { "opencode-go/glm-5.3": "unlimited" }, { now })
  assert.equal(rows[0].monthlyCap, null)
  assert.equal(rows[0].monthShare, null)
  assert.equal(rows[0].fiveHourShare, null)
  assert.equal(rows[0].weekShare, null)
})

test("an unknown paid model has a null cap rather than an invented limit", () => {
  const rows = windowStatus([message({ model: "unknown", listCost: 10, at: now })], {}, { now })
  assert.equal(rows[0].monthlyCap, null)
  assert.equal(rows[0].monthShare, null)
})

test("forecast projects month to date across the full month", () => {
  const result = forecast([message({ listCost: 10, at: Date.UTC(2026, 3, 2) })], { "opencode-go/glm-5.3": 100 }, {
    now: Date.UTC(2026, 3, 11),
  })
  assert.equal(result.elapsedDays, 10)
  assert.equal(result.monthDays, 30)
  assert.equal(result.perModel[0].projected, 30)
  assert.equal(result.perModel[0].willExceed, false)
})

test("forecast flags a model projected above its cap", () => {
  const result = forecast([message({ listCost: 10, at: Date.UTC(2026, 3, 2) })], { "opencode-go/glm-5.3": 25 }, {
    now: Date.UTC(2026, 3, 11),
  })
  assert.equal(result.perModel[0].projected, 30)
  assert.equal(result.perModel[0].willExceed, true)
})

test("role-model grouping attributes spend to both dimensions", () => {
  const rows = spendByRoleModel(
    [
      message({ agent: "oracle", listCost: 2, at: now }),
      message({ agent: "oracle", listCost: 1, at: now }),
      message({ agent: "fixer", listCost: 4, at: now }),
    ],
    {},
  )
  assert.deepEqual(
    rows.map((row) => [row.agent, row.model, row.listCost, row.requests]),
    [
      ["fixer", "glm-5.3", 4, 1],
      ["oracle", "glm-5.3", 3, 2],
    ],
  )
})

test("capsStatus merges caps and clamps remaining spend at zero", () => {
  const rows = capsStatus([{ key: "opencode-go/glm-5.3", listCost: 150 }], { "opencode-go/glm-5.3": 100 })
  assert.equal(rows[0].cap, 100)
  assert.equal(rows[0].share, 1.5)
  assert.equal(rows[0].remaining, 0)
})
