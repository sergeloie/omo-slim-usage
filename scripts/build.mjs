import { statSync } from "node:fs"
import { build } from "esbuild"

const targets = [
  {
    entryPoints: ["src/server/recorder.ts"],
    outfile: "dist/server.js",
    external: ["@opencode/*"],
  },
  {
    entryPoints: ["src/tui/index.tsx"],
    outfile: "dist/tui.js",
    jsx: "automatic",
    jsxImportSource: "@opentui/solid",
    external: ["solid-js", "solid-js/*", "@opentui/*", "@opencode/*"],
  },
]

for (const target of targets) {
  try {
    await build({ ...target, platform: "node", format: "esm", bundle: true, logLevel: "warning" })
  } catch {
    console.error(`build failed: ${target.outfile}`)
    process.exit(1)
  }
  const kb = (statSync(target.outfile).size / 1024).toFixed(1)
  console.log(`${target.outfile}  ${kb} kB`)
}
