## Goal

Retarget AIMessenger from a macOS-hosted Telegram bot to a Raspberry Pi service reachable over Tailscale, with the fastest path being Telegram rather than Messenger.

## Recommendation

Use Telegram.

Reasons:
- The transport already exists in this repo.
- It uses long polling, so the Pi only needs outbound internet and Tailscale/SSH for admin access.
- Messenger would require a new transport plus Meta app/webhook setup.

## Current Gaps

1. Runtime wording and defaults are macOS-specific.
2. Deployment scripts assume a Mac target and `launchctl`.
3. The local test environment currently has a stale `better-sqlite3` native build and needs a clean reinstall/rebuild before tests can be trusted.
4. Pi viability still depends on live checks for:
   - 64-bit Linux on the Pi
   - Node.js 24+
   - Codex auth on the Pi
   - Claude auth on the Pi
   - SSH reachability over Tailscale

## Proposed Work

1. Make the app host-neutral.
   - Replace "Mac" wording in docs and runtime prompts with host/device wording.
   - Make the default data dir platform-aware instead of hard-coding `~/Library/Application Support/AIMessenger`.
   - Verify: app still builds and existing tests pass after dependency rebuild.

2. Keep Telegram as the only transport for now.
   - Do not add Messenger.
   - Verify: existing Telegram commands and attachment flow remain unchanged.

3. Add Linux/Pi deployment support.
   - Keep the existing deploy flow concept.
   - Add Pi-targeted bootstrap/install scripts.
   - Replace LaunchAgent install with a `systemd --user` service or a system service.
   - Verify: install script produces a running service and health endpoint on the Pi.

4. Make auth/setup explicit for Codex and Claude on the Pi.
   - Document the exact env file path, runtime path, and login checks.
   - Verify: `codex login status` and `claude auth status` succeed on the Pi user account that runs the service.

5. Do an end-to-end Telegram smoke test.
   - Pair the bot.
   - Start the service on the Pi.
   - Send `/status`, a normal prompt, and one attachment.
   - Verify: response arrives, files persist, retry/stop still work.

## Expected File Scope

- `README.md`
- `src/config.ts`
- `src/providers/structured.ts`
- `scripts/deploy.sh`
- `scripts/remote-bootstrap.sh`
- `scripts/health-check.sh`
- `scripts/telegram-whoami.ts`
- new Linux service install script
- possibly small test updates if config defaults change

## Non-Goals

- iMessage
- Messenger
- webhook infrastructure
- multi-user access

## First Live Checks Before Implementation

1. Confirm the Pi is reachable over Tailscale + SSH.
2. Confirm the Pi is 64-bit Linux and has enough RAM.
3. Confirm whether `codex` and `claude` can be installed and authenticated there.
