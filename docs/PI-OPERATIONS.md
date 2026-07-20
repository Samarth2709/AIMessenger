# Raspberry Pi Operations

This guide applies to the hardened system service installed by `scripts/install-hardened-system-service.sh`.

## Runtime layout

| Path or service | Purpose |
| --- | --- |
| `aimessenger.service` | The hardened systemd service, running as the unprivileged `aimessenger` user. |
| `/srv/aimessenger-workspace/source` | Staged source checkout that Iris or an operator may edit. |
| `/srv/aimessenger-workspace/current` | Symlink to the active tested release. |
| `/srv/aimessenger-workspace/previous` | Symlink to the release eligible for rollback. |
| `/srv/aimessenger-workspace/releases` | Release snapshots created by self-update. |
| `/var/lib/aimessenger` | Private runtime data: env file, SQLite database, job files, logs, and Codex state. |
| `/opt/aimessenger/tools` | Isolated Codex and Claude CLI shims used by the service. |

The health endpoint binds to `127.0.0.1:8787`; it is not exposed through Tailscale or the public network. Tailscale SSH provides the administrative path.

## Routine checks

```bash
# Active service, exact release ID, and Telegram readiness.
ssh home-pi 'systemctl status aimessenger.service --no-pager && curl --fail --silent http://127.0.0.1:8787/healthz'

# Recent service logs. JSONL application logs remain in /var/lib/aimessenger/logs.
ssh home-pi 'sudo journalctl -u aimessenger.service -n 100 -o cat'

# Follow logs while diagnosing a request.
ssh -t home-pi 'sudo journalctl -u aimessenger.service -f -o cat'
```

In Telegram, `/status` confirms the active provider, model, live Codex state, queue, pending delivery count, and release state. `/updates` shows the last self-update outcome.

## Deploying committed source

Push reviewed source from the development checkout first. The Pi source checkout should remain clean, so use fast-forward-only pulls:

```bash
git push origin main

ssh home-pi 'sudo -u aimessenger bash -lc "cd /srv/aimessenger-workspace/source && git status --short && git pull --ff-only origin main"'
```

If the status output is not empty, stop. Inspect or commit the staged edit before pulling; do not overwrite it with a reset.

Activate the staged commit only through the guarded release command:

```bash
ssh -t home-pi 'sudo -u aimessenger env \
  AIMESSENGER_WORKING_DIR=/srv/aimessenger-workspace \
  AIMESSENGER_DATA_DIR=/var/lib/aimessenger \
  AIMESSENGER_PORT=8787 \
  SELF_UPDATE_WATCHDOG_SECONDS=90 \
  bash -lc "cd /srv/aimessenger-workspace/source && npm run self-update -- --summary '\''manual source update'\''"'
```

The update validates the source, creates a release snapshot, restarts the service after active work drains, and confirms the exact release with its watchdog. Verify it independently:

```bash
ssh home-pi 'curl --fail --silent http://127.0.0.1:8787/healthz'
ssh home-pi 'systemctl is-active aimessenger.service'
```

## Recovery and rollback

Use `/rollback` in the allowlisted Telegram chat for the normal rollback path. It restores `previous`, waits for active work to drain, and starts the same loopback watchdog.

When Telegram is unavailable, inspect before acting:

```bash
ssh home-pi 'readlink -f /srv/aimessenger-workspace/current; readlink -f /srv/aimessenger-workspace/previous; sudo systemctl status aimessenger.service --no-pager'
```

Do not manually change `current` or `previous` while an update is running. The self-update lock, restart request, and watchdog coordinate release activation. If health is failing, collect the journal output and use the Telegram rollback after the service can poll again; otherwise repair the failed release from the staged source and run the guarded update.

## Editing identity and skills

Edit only the staged source, then run the guarded release command above:

```bash
ssh -t home-pi 'sudo -u aimessenger nano /srv/aimessenger-workspace/source/IDENTITY.md'
ssh -t home-pi 'sudo -u aimessenger nano /srv/aimessenger-workspace/source/skills/research/SKILL.md'
```

Keep the same changes committed in the development repository, otherwise a later deployment can replace them. See [Architecture](ARCHITECTURE.md) for how identity and skills are loaded.

## Cost and safe data inspection

Use `/cost` for the normal view of recorded spend. [Cost accounting](COSTS.md) explains the units, known limitations, and read-only database query. Do not change SQLite rows directly: the database is service state, not a billing ledger.

## First installation

From a development checkout, install the hardened service and the optional draft-only Gmail broker:

```bash
TARGET=home-pi INSTALL_HARDENED_SERVICE=1 INSTALL_GMAIL_DRAFT_BROKER=1 bash scripts/deploy.sh
```

The installer requires a built project, the runtime environment file, and authenticated Codex configuration. It creates the dedicated `aimessenger` service account, limits its writable paths, and migrates runtime state into `/var/lib/aimessenger`. Follow the Gmail OAuth instructions in the [README](../README.md#gmail-drafts) after the broker health check succeeds.
