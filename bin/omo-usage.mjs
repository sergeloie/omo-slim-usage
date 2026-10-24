#!/usr/bin/env node
const HELP = `usage: omo-usage <command> [options]

commands:
  month      month-to-date spend from the local database, per model and per role
  console    Console spend and budget policies for the account (7d or 30d)
  report     per-role tokens and cost from the local session store

run "omo-usage <command> --help" for that command's options`

const COMMANDS = {
  month: { module: "../src/lib/month.mjs", run: "run" },
  console: { module: "../src/lib/console.mjs", run: "run" },
  report: { module: "./report-legacy.mjs" },
}

const [name, ...rest] = process.argv.slice(2)

if (!name) {
  console.error(HELP)
  process.exit(1)
}
if (name === "help" || name === "--help" || name === "-h") {
  console.log(HELP)
  process.exit(0)
}

const command = COMMANDS[name]
if (!command) {
  console.error(`omo-usage: unknown command: ${name}\n\n${HELP}`)
  process.exit(1)
}

process.argv = [process.argv[0], name, ...rest]
try {
  const module = await import(new URL(command.module, import.meta.url).href)
  if (command.run) await module[command.run]()
} catch (error) {
  console.error(`omo-usage ${name}: ${error?.message ?? error}`)
  process.exitCode = 1
}
