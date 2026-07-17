# AIMessenger

AIMessenger turns a private Telegram bot into an unrestricted Codex or Claude coding-agent session running on your Mac. It accepts text, images, and common documents, queues one job at a time, preserves separate native provider sessions, and returns text or generated files through Telegram.

## Security warning

This service deliberately launches Codex and Claude with all approval and sandbox checks disabled. A message from the allowlisted Telegram account can read or change files, run programs, access the network, and use whatever credentials the macOS user can access. Prompt injection in a website or attachment can cause the same effects. Run it only under an account and on a Mac where that risk is acceptable.

## Why Telegram

Telegram bots do not require a registered organization or a Twilio number. The bot is identified by an `@username`. The user must initiate the conversation once, after which the bot can reply through the Telegram Bot API. AIMessenger uses long polling, so the Mac needs outbound internet access but no public port, webhook, domain, or Cloudflare tunnel.

## Create and pair the bot

1. Message [@BotFather](https://t.me/BotFather), run `/newbot`, and save the generated token.
2. Open the new bot and send `/start`.
3. Install dependencies and put the token in the runtime env file:

   ```bash
   npm ci
   mkdir -p "$HOME/Library/Application Support/AIMessenger"
   chmod 700 "$HOME/Library/Application Support/AIMessenger"
   cp .env.example "$HOME/Library/Application Support/AIMessenger/env"
   chmod 600 "$HOME/Library/Application Support/AIMessenger/env"
   ```

4. Temporarily fill in only `TELEGRAM_BOT_TOKEN`, then discover your numeric Telegram user ID:

   ```bash
   npm run telegram:whoami
   ```

5. Put the reported ID in `TELEGRAM_ALLOWED_USER_ID`. Messages from every other user and every group are ignored.

## Run locally

Both CLIs must be authenticated for the same macOS user that runs the service:

```bash
codex login status
claude auth status
npm run build
npm test
npm start
```

If Claude reports an expired OAuth token, run `claude auth login` as that user. Do not put an old `ANTHROPIC_API_KEY` in the runtime env file: an environment key overrides the macOS keychain login.

Health is available only on loopback:

```bash
npm run health
```

## Telegram commands

- `/codex` and `/claude` select the provider for new jobs.
- `/status` shows the active provider, current job, and queue.
- `/cost` shows today, the last seven calendar days, and all-time provider-reported spend; use `/cost <days>` or `/cost all` for one period. Claude reports a dollar total when available. Codex reports token counts but does not expose a dollar amount through its CLI, so AIMessenger does not guess one.
- `/stop` terminates the current process group and taints that provider session.
- `/new codex|claude|all` starts clean native sessions.
- `/retry <job-id>` retries a failed, canceled, or interrupted job.
- `/help` shows the command list.

Messages arriving while a job runs are queued as later turns. The two providers keep their own native session IDs. When switching, transcript entries unseen by the target provider are injected for continuity.

Cost tracking begins after upgrading to this version; the existing job database has no historic provider cost records to backfill.

## Files and recovery

- Input: PNG, JPEG, GIF, WebP, PDF, DOC/DOCX, PPTX, XLS/XLSX, TXT, and CSV, up to Telegram's 20 MB hosted Bot API download limit.
- Output: the same types, uploaded as documents up to 50 MB.
- Runtime data: `~/Library/Application Support/AIMessenger` with mode-restricted job files, SQLite state, and logs.
- A queued job survives restart. A job already running at a crash is marked `interrupted` and is never automatically repeated; use `/retry` explicitly.
- Completed agent results are placed in a durable SQLite outbox. Telegram delivery failures retry with bounded exponential backoff, and generated attachments are copied into the job directory before delivery.

## Deploy to the Tailscale work Mac

The target is `samarths-macbook-pro` (`100.116.241.51`) and the destination is `~/Documents/tmp/AIMessenger`. Enable **System Settings → General → Sharing → Remote Login** on that Mac first.

From this repository:

```bash
TARGET="your-work-mac-user@100.116.241.51" bash scripts/deploy.sh
```

This copies the repository including `.git`, excludes secrets/build artifacts, installs missing Codex and Claude CLIs when Node is available, then builds and tests remotely. Configure the target env file and agent credentials, then install the user LaunchAgent:

```bash
TARGET="your-work-mac-user@100.116.241.51" INSTALL_SERVICE=1 bash scripts/deploy.sh
```

The LaunchAgent runs after that user logs in and restarts the service after crashes. Keep the Mac powered, awake, connected, and logged in.
