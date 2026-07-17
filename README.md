# AIMessenger

AIMessenger turns a private Telegram bot into an unrestricted Codex or Claude coding-agent session running on your own machine. It accepts text, images, and common documents, preserves separate native provider sessions, and returns text or generated files through Telegram.

## Security warning

This service deliberately launches Codex and Claude with all approval and sandbox checks disabled. A message from the allowlisted Telegram account can read or change files, run programs, access the network, and use whatever credentials the local OS user can access. Prompt injection in a website or attachment can cause the same effects. Run it only under an account and on a host where that risk is acceptable.

## Why Telegram

Telegram bots do not require a registered organization or a Twilio number. The bot is identified by an `@username`. The user must initiate the conversation once, after which the bot can reply through the Telegram Bot API. AIMessenger uses long polling, so the host needs outbound internet access but no public port, webhook, domain, or Cloudflare tunnel.

## Create and pair the bot

1. Message [@BotFather](https://t.me/BotFather), run `/newbot`, and save the generated token.
2. Open the new bot and send `/start`.
3. Install dependencies and put the token in the runtime env file. By default, runtime data lives in `~/Library/Application Support/AIMessenger` on macOS and `~/.local/state/AIMessenger` on Linux.

   ```bash
   npm ci
   if [[ "$(uname -s)" == "Darwin" ]]; then
     DATA_DIR="${AIMESSENGER_DATA_DIR:-$HOME/Library/Application Support/AIMessenger}"
   else
     DATA_DIR="${AIMESSENGER_DATA_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/AIMessenger}"
   fi
   mkdir -p "$DATA_DIR"
   chmod 700 "$DATA_DIR"
   cp .env.example "$DATA_DIR/env"
   chmod 600 "$DATA_DIR/env"
   ```

4. Temporarily fill in only `TELEGRAM_BOT_TOKEN`, then discover your numeric Telegram user ID:

   ```bash
   npm run telegram:whoami
   ```

5. Put the reported ID in `TELEGRAM_ALLOWED_USER_ID`. Messages from every other user and every group are ignored.

## Run locally

Both CLIs must be authenticated for the same OS user that runs the service:

```bash
codex login status
claude auth status
npm run build
npm test
npm start
```

If Claude reports an expired OAuth token, run `claude auth login` as that user. Do not put an old `ANTHROPIC_API_KEY` in the runtime env file: an environment key overrides Claude's local authenticated session.

Health is available only on loopback:

```bash
npm run health
```

## Telegram commands

- `/codex` and `/claude` select the provider for new jobs.
- `/status` shows the active provider, model, live Codex turn, queue, and latest retryable job ID.
- `/updates` shows the active release and the latest self-update outcome.
- `/rollback` restores the prior healthy release and restarts after active work drains.
- `/cost` shows today, the last seven calendar days, and all-time provider-reported spend; use `/cost <days>` or `/cost all` for one period. Claude reports a dollar total when available. Codex reports token counts but does not expose a dollar amount through its CLI, so AIMessenger does not guess one.
- `/stop` terminates the current process group and taints that provider session.
- `/new codex|claude|all` starts clean native sessions.
- `/retry <job-id>` retries a failed, canceled, or interrupted job.
- `/model` lists Codex models plus any configured AI Security gateway models; reply with its number to select one and start a fresh session.
- `/skills` lists the reusable workflows available to both providers.
- `/help` shows the command list.

Text-only messages sent while using a standard Codex model run through one persistent Codex App Server conversation. Iris sends Codex's first real progress message, keeps Telegram's typing indicator active, and then sends the completed result. A later Telegram message while that turn is running is injected immediately with Codex `turn/steer`; it does not become a separate job or produce an intermediate Telegram reply. The App Server's tool output and reasoning are not sent to Telegram.

Claude, AI Security gateway models, and any message with a Telegram attachment continue through the durable one-job worker. They preserve the existing media handling and outbox behavior until they have equivalent streaming adapters. The two providers keep their own native session IDs. When switching, transcript entries unseen by the target provider are injected for continuity.

Normal messages receive no queue acknowledgement. Telegram shows its typing indicator while the worker runs, then AIMessenger sends only the final agent response. Job IDs remain internal unless you explicitly use `/status`, `/stop`, or `/retry`.

`/status` reports the active provider, runtime, selected model, live Codex state, and self-update state. `/model` obtains the Codex catalog directly from the installed CLI and also reads the configured local LiteLLM gateway. `CODEX_MODEL` or `CLAUDE_MODEL` remains the fallback until a model is selected through Telegram. Selecting a model or using `/new codex` interrupts and clears any live Codex thread so the next message starts fresh.

## Identity

[`IDENTITY.md`](IDENTITY.md) defines the name, voice, behavior, and host-authority guidance supplied to both providers. In a hardened Pi installation, edit the staged source and run a self-update before the change becomes active:

```bash
ssh -t home-pi 'sudo -u aimessenger nano /srv/aimessenger-workspace/source/IDENTITY.md'
```

## Skills

Skills are portable, provider-neutral `SKILL.md` workflows in [`skills/`](skills). Both Codex and Claude receive the same catalog before every job. When a request matches a skill description, or names a skill directly, the provider reads and follows that skill's canonical file. Use `/skills` in Telegram to see the installed workflows.

Each skill has a directory name that matches its front-matter `name`:

```text
skills/
  research/
    SKILL.md
```

The included [`skills/research/SKILL.md`](skills/research/SKILL.md) defines research source selection and the required cited response format. On the hardened Pi, add or edit a skill in the staged source, then activate a self-update:

```bash
ssh -t home-pi 'sudo -u aimessenger mkdir -p /srv/aimessenger-workspace/source/skills/my-skill'
ssh -t home-pi 'sudo -u aimessenger nano /srv/aimessenger-workspace/source/skills/my-skill/SKILL.md'
```

Keep changes in this repository too, because the next deployment copies its `skills/` directory to the Pi.

## Self updates

The hardened Pi service runs the `current` release, while Iris edits only the staged source:

```text
/srv/aimessenger-workspace/
  source/      # agent-writable staged checkout
  releases/    # complete tested release snapshots
  current      # active release symlink
  previous     # rollback release symlink
```

The provider-neutral `self-update` skill requires a focused test, `git diff --check`, the full test suite, and a TypeScript build before activation. It then changes `current`, drains the running service, and starts an independent loopback watchdog. The watchdog accepts a release only when `/healthz` reports its exact release ID; otherwise it restores `previous` automatically.

Iris can use this workflow from Telegram when a request needs an AIMessenger change. Its reply should identify the pending release rather than claim success before the watchdog has accepted it. Use `/updates` to see the final status or `/rollback` to restore the prior healthy release.

For a manual release from the staged checkout:

```bash
ssh -t home-pi 'sudo -u aimessenger env AIMESSENGER_WORKING_DIR=/srv/aimessenger-workspace AIMESSENGER_DATA_DIR=/var/lib/aimessenger AIMESSENGER_PORT=8787 SELF_UPDATE_WATCHDOG_SECONDS=90 bash -lc "cd /srv/aimessenger-workspace/source && npm run self-update -- --summary '\''manual source update'\''"'
```

After it restarts, verify the active release without exposing the service beyond loopback:

```bash
ssh home-pi 'curl --fail --silent http://127.0.0.1:8787/healthz'
```

## Gmail Drafts

The included `gmail-drafts` and `columbia-gmail-drafts` skills can create drafts for exactly `samarth.kumbla@gmail.com` and `sk5335@columbia.edu`. They are deliberately **draft-only**: Iris cannot send email. Iris first shows a complete proposed email and waits for your explicit Telegram confirmation before creating a draft. A separate Pi system service owns the OAuth tokens and exposes only authenticated `POST /v1/drafts` on loopback. Iris has no read access to the tokens and there is no send endpoint. Review a generated draft in Gmail and manually click **Send** to approve it.

Google's Gmail draft API requires the `gmail.compose` OAuth scope. That scope can technically also send mail, which is why the token is isolated in a different Unix account and the broker itself contains no send code. Do not give the OAuth token to the AIMessenger `ubuntu` user or place it in AIMessenger's env file.

### One-time Pi installation

The current Telegram service must first run under its own unprivileged `aimessenger` system account. This preserves the Pi owner's normal `ubuntu` administration account but prevents an Iris job from reading the OAuth tokens or becoming root. It migrates bot state and existing Codex configuration into `/var/lib/aimessenger`, runs its coding workspace from `/srv/aimessenger-workspace`, and disables the old `systemd --user` instance only after the hardened service passes its loopback health check.

Deploy the current build, migrate to the hardened service, and install the separate Gmail broker:

```bash
TARGET=home-pi INSTALL_HARDENED_SERVICE=1 INSTALL_GMAIL_DRAFT_BROKER=1 bash scripts/deploy.sh
```

The broker starts in an unconfigured state and cannot create a draft until both OAuth authorizations below are complete. Its health endpoint is local only:

```bash
ssh home-pi 'curl --fail --silent http://127.0.0.1:8791/healthz'
```

### Google OAuth setup

1. In [Google Cloud Console](https://console.cloud.google.com/), create or select a project, enable the **Gmail API**, then create an OAuth **Desktop app** client under **APIs & Services > Credentials**.
2. Download that client JSON to your Mac. It is private and must not be committed.
3. Copy it into the broker's protected data directory. Replace the local path below with the downloaded JSON file:

   ```bash
   scp /absolute/path/to/client_secret.json home-pi:/tmp/aimessenger-oauth-client.json
   ssh home-pi 'sudo install -o aimessenger-mail -g aimessenger-mail -m 600 /tmp/aimessenger-oauth-client.json /var/lib/aimessenger-mail/oauth-client.json && rm /tmp/aimessenger-oauth-client.json'
   ```

4. Authorize the Gmail account through a local SSH tunnel. The command prints a Google URL; open it in the browser on your Mac, sign into the requested account, and complete consent:

   ```bash
   ssh -t -L 8765:127.0.0.1:8765 home-pi 'sudo -u aimessenger-mail /usr/bin/node /opt/aimessenger-mail/scripts/gmail-authorize.js --account samarth.kumbla@gmail.com'
   ```

5. Repeat for Columbia:

   ```bash
   ssh -t -L 8765:127.0.0.1:8765 home-pi 'sudo -u aimessenger-mail /usr/bin/node /opt/aimessenger-mail/scripts/gmail-authorize.js --account sk5335@columbia.edu'
   ```

The Columbia Google Workspace administrator may block third-party OAuth. If the second authorization is denied, the app remains able to create drafts only for the personal Gmail account until the Columbia policy allows the client.

Cost tracking begins after upgrading to this version; the existing job database has no historic provider cost records to backfill.

## Files and recovery

- Input: arbitrary Telegram documents plus photos, animations, audio, video, voice messages, video notes, and stickers, up to Telegram's 20 MB hosted Bot API download limit.
- Output: any regular file up to Telegram's 50 MB upload limit. PNG and JPEG files first use Telegram's native photo presentation and fall back to a document if Telegram rejects them.
- Runtime data: `~/Library/Application Support/AIMessenger` on macOS or `~/.local/state/AIMessenger` on a regular Linux installation. The hardened Pi uses `/var/lib/aimessenger`, with mode-restricted job files, SQLite state, and logs.
- Logs: `logs/aimessenger.jsonl` in the runtime data directory. Each private JSONL record covers service lifecycle, queueing, job outcome and duration, and Telegram delivery; it deliberately excludes tokens, message content, agent replies, and attachment paths. On the hardened Pi, use `sudo journalctl -u aimessenger.service -f -o cat`.
- A queued job survives restart. A job already running at a crash, including a live Codex turn, is marked interrupted and is never automatically repeated; send a new message or use `/retry` explicitly.
- A job must produce text or an attachment. A blank provider result is failed and made retryable rather than being silently marked complete.
- Completed agent results are placed in a durable SQLite outbox. Telegram delivery failures retry with bounded exponential backoff, Telegram requests have bounded timeouts, and generated attachments are copied into the job directory before delivery.

## Deploy to a Tailscale host

The deploy script supports both macOS and Linux targets over SSH. Its default remote path is `~/Documents/tmp/AIMessenger` on macOS and `~/AIMessenger` on Linux.

From this repository:

```bash
TARGET="your-user@100.116.241.51" bash scripts/deploy.sh
```

This copies the repository including `.git`, excludes secrets/build artifacts, installs missing Codex and Claude CLIs when Node is available, then builds and tests remotely. Configure the target env file and agent credentials, then install the service:

```bash
TARGET="your-user@100.116.241.51" INSTALL_SERVICE=1 bash scripts/deploy.sh
```

- On macOS, `INSTALL_SERVICE=1` installs a LaunchAgent.
- On Linux, `INSTALL_SERVICE=1` installs a `systemd --user` service.
- For a headless Raspberry Pi, enable linger once so the user service survives reboot: `sudo loginctl enable-linger $USER`.

## Raspberry Pi notes

- Use a 64-bit Pi OS image with Node.js 24+.
- If Node is already installed, ensure `python3`, `make`, and `g++` are present before `npm ci`, because `better-sqlite3` may build from source on Linux ARM64.
- After installing the Linux service, check `systemctl --user status aimessenger.service` and `journalctl --user -u aimessenger.service -f`.
- Smoke test from Telegram with `/status`, then one short Codex request, then `npm run health` over SSH.
