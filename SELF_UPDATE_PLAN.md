# Self-Update Architecture

## Goal

Iris can improve AIMessenger from Telegram without an operator deploying each change. A self-update must edit a staging copy, prove the change with automated tests, activate atomically, and roll back automatically if the replacement service is unhealthy.

This must not make `/opt/aimessenger/app`, systemd unit files, the Gmail broker, or secret files writable to the agent.

## Release Layout

Keep the trusted runtime boundary and add an agent-owned release area:

```text
/srv/aimessenger-workspace/
  source/                 # writable staging checkout used by Iris
  releases/<release-id>/  # complete tested releases
  current -> releases/... # active release symlink
  previous -> releases/...# last known-good release symlink

/var/lib/aimessenger/
  self-update.json        # requested activation and current update state
  self-update-restart     # consumed by the running service
```

The systemd service starts Node from `current/dist/src/index.js`, with its working directory under `current`. `/opt/aimessenger` remains the root-owned bootstrap/tool location only.

## Update Flow

1. Iris receives a clear architecture or behavior request and edits only `source/`.
2. Iris adds or updates a focused regression/capability test for the requested behavior.
3. Iris runs `git diff --check`, `npm test`, and `npm run build` in `source/`.
4. A local self-update script copies the validated source, dependencies, and build output into a new `releases/<release-id>/` directory. It writes the exact test results, source revision, and previous release ID to `self-update.json`.
5. The script atomically flips `previous` and `current` symlinks, then writes `self-update-restart`.
6. The running service observes the restart request, stops accepting new work, lets the active turn finish or interrupts it after a bounded timeout, and exits cleanly. `Restart=always` starts the new `current` release.
7. An independent unprivileged watchdog waits for the loopback health endpoint and checks that it reports the candidate release ID. On failure it atomically restores `current` to `previous`; systemd's normal restart retry brings the known-good release back.
8. On success, the watchdog marks the release healthy. The initiating response identifies the pending release, and `/updates` reports the final watchdog result after restart.

No root process executes agent-controlled JavaScript, tests, npm lifecycle hooks, or build commands. Root is needed only once to install the systemd unit and create the writable `/srv/aimessenger-workspace` release area.

## Safety Rules

- Only the Telegram allowlisted user may request self-updates.
- The self-update skill may change AIMessenger source, tests, skills, and identity instructions. It may not change `/var/lib/aimessenger/env`, `/etc/systemd`, `/opt/aimessenger/tools`, Gmail broker code, OAuth files, service users, network policy, or the Telegram allowlist.
- A release can activate only after all required checks pass. Failed tests leave `current` untouched.
- Each release records its parent and keeps at least the current and previous known-good copies. `/rollback` flips back to the previous release and uses the same restart/health process.
- Generated tests use fake Telegram, fake Gmail, and disposable workspaces. They never send messages, email, or mutate the live production SQLite database merely to test a change.
- The agent may run a disposable App Server capability test only when it has no host-side mutation beyond its temporary workspace.

## User Experience

- A normal request such as "make Iris's replies shorter" or "add a status field" can result in an autonomous self-update when it requires code or identity changes.
- Iris first gives the normal short acknowledgement, then sends one final message: what changed, tests run, release ID, and whether the watchdog accepted it.
- `/status` adds active release, previous release, last update outcome, and last capability-test result.
- `/updates` shows the active release and latest update outcome. `/rollback` restores the previous healthy release.

## Implementation Scope

1. Add release metadata, self-update state, `/updates`, and `/rollback` command support.
2. Add the self-update service module that watches for restart requests and drains active work before exit.
3. Add the `self-update-release` command and a standalone release watchdog.
4. Change the hardened installer to bootstrap `source/`, `releases/`, and the `current`/`previous` symlinks; point systemd at `current`.
5. Add the provider-neutral `self-update` skill and narrowly scoped identity instructions.
6. Add unit tests for failed-test rejection, atomic release state, drain/restart requests, rollback, and status output.
7. Verify on the Pi with a harmless release change, forced failed health check, automatic rollback, then a successful release activation.

## Success Criteria

- Iris can make a source change from Telegram without SSH or a manual deploy.
- A failed build/test never replaces the active release.
- A release that fails its health check restores the previous working release automatically.
- The service comes back healthy after each successful update and reports the exact tested release.
- Secrets and root-owned runtime files remain unreadable and unwritable to the AIMessenger agent.
