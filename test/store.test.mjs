import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import {
  aggregate,
  appendSnapshots,
  compactStore,
  formatTable,
  latestBySession,
  readSnapshots,
  sessionFamily,
  filterRecords,
  toRecord,
} from "../src/lib/store.mjs"

const info = (overrides) => ({
  id: "ses_root",
  parentID: undefined,
  agent: "orchestrator",
  projectID: "p1",
  cost: 0,
  tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 1000, write: 20 } },
  time: { created: 1000, updated: 2000 },
  ...overrides,
})

test("last snapshot per session wins", () => {
  const records = [
    { ...toRecord(info({}), 1), input: 10 },
    { ...toRecord(info({}), 2), input: 99 },
  ]
  const latest = latestBySession(records)
  assert.equal(latest.get("ses_root").input, 99)
})

test("session family includes children and grandchildren only", () => {
  const records = [
    toRecord(info({ id: "root", parentID: undefined })),
    toRecord(info({ id: "child", parentID: "root", agent: "fixer" })),
    toRecord(info({ id: "grandchild", parentID: "child", agent: "oracle" })),
    toRecord(info({ id: "other", parentID: "elsewhere", agent: "explorer" })),
  ]
  const family = sessionFamily(records, "root").map((record) => record.id).sort()
  assert.deepEqual(family, ["child", "grandchild", "root"])
})

test("period filter uses session creation time, not snapshot time", () => {
  const now = 10 * 86400000
  const records = [
    toRecord(info({ id: "fresh", time: { created: now - 86400000, updated: now } }), now),
    toRecord(info({ id: "stale", time: { created: now - 30 * 86400000, updated: now } }), now),
  ]
  const week = filterRecords(records, { days: 7, now }).map((record) => record.id)
  assert.deepEqual(week, ["fresh"])
  const all = filterRecords(records, { all: true, now }).map((record) => record.id)
  assert.deepEqual(all.sort(), ["fresh", "stale"])
})

test("appendSnapshots is idempotent for an unchanged snapshot", () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-store-"))
  const file = join(dir, "sessions.jsonl")
  try {
    const record = toRecord(info({ id: "s1" }), 5)
    assert.equal(appendSnapshots(file, [record]), 1)
    assert.equal(appendSnapshots(file, [record]), 0)
    assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 1)
    const grown = { ...record, input: record.input + 1, ts: 6 }
    assert.equal(appendSnapshots(file, [grown]), 1)
    assert.equal(compactStore(file), 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("aggregate sums per role and reports totals", () => {
  const records = [
    toRecord(info({ id: "a", agent: "orchestrator" })),
    toRecord(info({ id: "b", agent: "fixer", tokens: { input: 5, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } })),
    toRecord(info({ id: "c", agent: "fixer" })),
  ]
  const { rows, totals } = aggregate(records)
  assert.equal(totals.sessions, 3)
  assert.equal(totals.input, 205)
  const fixer = rows.find((row) => row.agent === "fixer")
  assert.equal(fixer.sessions, 2)
  assert.equal(fixer.input, 105)
  const table = formatTable({ rows, totals }, { title: "usage" })
  assert.match(table, /\| fixer \| 2 \|/)
})
