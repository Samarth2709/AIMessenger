# Cost Accounting

## What `/cost` reports

`/cost` reports only terminal AIMessenger jobs that have recorded usage. It supports three views:

```text
/cost          # today, last 7 calendar days, and all time
/cost 30       # the last 30 calendar days
/cost all      # all time
```

The command deliberately keeps two independent units:

| Provider path | Stored value | Source |
| --- | --- | --- |
| Codex | Codex credits | Selected model plus reported input, cached-input, and output tokens, priced by the versioned rate table in `src/pricing.ts`. |
| Claude | USD, when present | `total_cost_usd` from the Claude CLI result. |
| AI Security gateway | USD, when present | `x-litellm-response-cost` response header, falling back to a numeric `response_cost` response field. |

The `/cost` label `provider-reported USD` means AIMessenger received a dollar value from the Claude CLI or the local LiteLLM gateway. For gateway models, that figure is the gateway's configured accounting value and can differ from a provider invoice when LiteLLM uses custom pricing.

## What is intentionally not estimated

- Codex credits are not displayed as USD. AIMessenger does not have a per-run Codex USD figure to report, so it does not invent one.
- A model not present in `src/pricing.ts` records tokens but no Codex credit amount.
- No historical rows are backfilled. A job completed before usage metering, or a provider response without usage/cost data, remains unpriced.
- A cost is a completion-time snapshot. Changing a rate table later does not rewrite existing job rows.

This avoids presenting an estimate as an invoice. The exact amount charged by a provider remains available in that provider's billing system.

## Stored fields

`jobs` records the metrics used by `/cost`:

| Column | Meaning |
| --- | --- |
| `model` | Model selected for the completed run. |
| `input_tokens` | Tokens sent to the provider. |
| `cached_input_tokens` | Input tokens served from provider cache, when reported. |
| `output_tokens` | Generated tokens. |
| `cost_usd` | Provider- or gateway-reported USD only. |
| `cost_credits` | Codex credits calculated at completion. |
| `usage_recorded_at` | Timestamp proving that this job has metered usage. |

## Inspecting the Pi database

The bot account owns `/var/lib/aimessenger/aimessenger.sqlite`. Run queries as that account and do not copy the database while the service is running.

```bash
ssh home-pi 'sudo -u aimessenger bash -s' <<'EOF'
cd /srv/aimessenger-workspace/current
node <<'NODE'
const Database = require("better-sqlite3");
const db = new Database("/var/lib/aimessenger/aimessenger.sqlite", { readonly: true });
const rows = db.prepare(`
  SELECT id, status, provider, model, input_tokens, cached_input_tokens,
         output_tokens, cost_usd, cost_credits, usage_recorded_at
  FROM jobs
  WHERE usage_recorded_at IS NOT NULL
  ORDER BY id DESC
  LIMIT 20
`).all();
console.table(rows);
NODE
EOF
```

To compare the database with Telegram, run `/cost all` and verify that the result includes the same class of terminal rows. A zero or absent dollar figure is valid when the selected provider did not report USD.
