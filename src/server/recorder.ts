// Records per-session (and therefore per-role) token/cost usage into the append-only store.
// Runs inside the OpenCode server: every session — including headless runs and subagents — is captured.
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { Plugin } from "@opencode/plugin"
import {
  appendSnapshots,
  changedSessions,
  defaultStorePath,
  latestBySession,
  readSnapshots,
  toRecord,
} from "../lib/store.mjs"

const INTERVAL_MS = Number(process.env.OPENCODE_USAGE_INTERVAL_MS || 15000)
const MONTH_INTERVAL_MS = Number(process.env.OPENCODE_USAGE_MONTH_MS || 300000)
const CONSOLE_INTERVAL_MS = Number(process.env.OPENCODE_USAGE_CONSOLE_MS || 900000)

export default Plugin.define({
  id: "usage-tracker",
  async setup(ctx) {
    if (process.env.OPENCODE_USAGE_DISABLE === "1") return
    const file = defaultStorePath()
    const known = latestBySession(readSnapshots(file))
    let busy = false

    const listSessions = async () => {
      const attempts = [{ limit: 100 }, { limit: 100, directory: ctx.location?.directory }]
      let lastError
      for (const query of attempts) {
        try {
          const page = await ctx.session.list(query)
          return Array.isArray(page) ? page : page?.data ?? page?.sessions ?? []
        } catch (error) {
          lastError = error
        }
      }
      throw lastError
    }

    const collect = async () => {
      if (busy) return
      busy = true
      try {
        const sessions = await listSessions()
        const records = sessions.filter((session) => session?.id).map((session) => toRecord(session))
        const fresh = changedSessions(records, known)
        if (fresh.length) {
          appendSnapshots(file, fresh)
          for (const record of fresh) known.set(record.id, record)
        }
      } catch {
        // Never break a session because usage recording failed.
      } finally {
        busy = false
      }
    }

    await collect()
    const timer = setInterval(() => void collect(), INTERVAL_MS)
    timer.unref?.()

    const cli = join(import.meta.dirname, "..", "bin", "omo-usage.mjs")
    let monthBusy = false
    let consoleBusy = false

    const runScript = (args, done) => {
      if (!existsSync(cli)) return done()
      execFile("node", ["--no-warnings", cli, ...args], { timeout: 180000, windowsHide: true }, () => done())
    }

    const refreshMonth = () => {
      if (monthBusy) return
      monthBusy = true
      runScript(["month", "--write"], () => {
        monthBusy = false
      })
    }

    const refreshConsole = () => {
      if (consoleBusy) return
      consoleBusy = true
      runScript(["console", "--write"], () => {
        consoleBusy = false
      })
    }

    const timers = [timer]
    if (MONTH_INTERVAL_MS > 0) {
      refreshMonth()
      timers.push(setInterval(refreshMonth, MONTH_INTERVAL_MS))
    }
    if (CONSOLE_INTERVAL_MS > 0) {
      refreshConsole()
      timers.push(setInterval(refreshConsole, CONSOLE_INTERVAL_MS))
    }
    for (const entry of timers) entry.unref?.()
    return () => timers.forEach((entry) => clearInterval(entry))
  },
})
