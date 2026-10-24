# omo-slim-usage

Usage tracking for OpenCode: per-role tokens and cost, Console spend, monthly caps and forecast, a sidebar footer and a `/cost` dialog in the TUI.

Three numbers are reported, and they are not the same thing:

| number | source | meaning |
|---|---|---|
| **charged** | `data.cost` on every assistant message | what the provider billed. Under a Go subscription this is `$0` for plan-covered work. |
| **list price** | tokens × catalog price at request time (`~/.cache/opencode/models.json`, USD per 1M tokens) | what the same tokens would cost at list price. This is what the Go plan measures its limits in, so caps and forecasts use it. |
| **Console spend** | `https://console.opencode.ai/api/...` | the server's own per-model spend and request counts. The source of truth for money. |

## Go plan limits

Limits are **per model**. There is no shared pool, and free models report no cap:

| window | share of that model's monthly cap |
|---|---|
| rolling 5 hours | 20% |
| rolling 7 days | 50% |
| calendar month, resets 1st 00:00 UTC | 100% |

Caps live in [`src/lib/budget.json`](src/lib/budget.json) under `caps` (`"unlimited"` or `null` where the plan documents no entry). Prices for models missing from the local catalog live under `prices`, in the same shape as a catalog `cost` block.

DeepSeek V4.1 Flash and V4 Pro double their price 01:00–04:00 and 06:00–10:00 UTC on weekdays; `src/lib/pricing.mjs` applies that multiplier.

## Install

Published package, once it exists:

```bash
opencode plugin add @sergeloie/omo-slim-usage
```

Local checkout, before publishing:

```bash
git clone <this repo> omo-slim-usage
cd omo-slim-usage && npm install
opencode plugin add git+file:///C:/DevProjects/omo-slim-usage
```

The plugin ships prebuilt (`dist/server.js`, `dist/tui.js`), so OpenCode does not compile anything itself.

### Registration

`opencode.jsonc` — the recorder that writes the store, and the no-op server half of the TUI package:

```jsonc
{
  "plugins": ["@sergeloie/omo-slim-usage", "@sergeloie/omo-slim-usage/tui"]
}
```

`tui.json` — the TUI plugin:

```jsonc
{
  "plugin": "@sergeloie/omo-slim-usage/tui"
}
```

Restart OpenCode after changing registration or any file the plugin loads.

## CLI

```bash
omo-usage month                      # month to date: models, roles, forecast
omo-usage month --write              # refresh month.json for the TUI
omo-usage month --json
omo-usage month --csv usage.csv      # sections: model, role, role-model

omo-usage console                    # Console tables for the account, last 30 days
omo-usage console --range 7d
omo-usage console --compare          # Console per model vs local month.json
omo-usage console --write            # refresh console.json for the TUI
omo-usage console --csv usage.csv    # server-side daily export

omo-usage report --week              # per role, from the local store
omo-usage report --session <id>      # that session plus everything it delegated
omo-usage report --days 3 --agent fixer
```

`month` reads the OpenCode database directly, one row per assistant request. `console` talks to the Console HTTP API with the personal key from `auth.json`; the key is never written to `console.json` or printed. `report` reads the append-only snapshot store that the recorder writes.

## Configuration

| variable | default | meaning |
|---|---|---|
| `OPENCODE_USAGE_DIR` | `~/.local/share/opencode/usage` | store directory |
| `OPENCODE_USAGE_INTERVAL_MS` | `15000` | recorder poll interval |
| `OPENCODE_USAGE_MONTH_MS` | `300000` | month report refresh; `0` disables it |
| `OPENCODE_USAGE_CONSOLE_MS` | `900000` | Console report refresh; `0` disables it |
| `OPENCODE_USAGE_DISABLE` | unset | `1` disables the recorder |

## In the TUI

- Sidebar footer (`ctrl+x b`): spend for the current session and the last 7 days per role, plus one line of month total, forecast and the model closest to its cap. Refreshed every 5 s from local files.
- Console numbers take priority over the local estimate once `console.json` exists; a stale file is labelled `stale Nh`.
- `/cost` opens the dialog: session table, 7-day table, the Console block, then the month block with per-model cap shares, 5-hour and 7-day shares, forecast, and the role-model breakdown.
- Nothing in the TUI calls a model.

## Development

```bash
npm install
npm run build     # esbuild: src/server/recorder.ts -> dist/server.js, src/tui/index.tsx -> dist/tui.js
npm test          # node --test
```

`prepare` builds automatically on install, so a `git+file://` install works without a manual build step. Bump the commit to change the package cache key.

## Limits

- **No blocking, by design.** Nothing here stops, downgrades or reroutes a model. The numbers exist so models can be chosen per role.
- Cap shares are an **estimate** from list price. The plan's own allowance counter is visible only in the Console; `opencode.allowance` arrives per request but is not stored.
- The Console MCP server (`opencode-console`, `get_usage`) is **not** used: it reports workspace spend and excludes Go-plan usage, so it returns zero for Go traffic. The HTTP API behind `console.opencode.ai/api/...` does return Go usage per model, and that is the path taken here.
- Local estimates and Console measurements **diverge** when another install shares the account, and when the local catalog price differs from what the server billed. Compare them with `omo-usage console --compare` before trusting either.
- Console budget policies (`scope: each|combined`, `shared`) are a separate layer from the Go per-model windows and are not configured here.
- The recorder samples the newest 100 sessions per poll. Older sessions stay in the database and are still counted by `omo-usage month`, which reads it directly.
- A model with no catalog price and no `prices` override costs `$0` in the report. Check `budget.json` when a paid model looks free.
