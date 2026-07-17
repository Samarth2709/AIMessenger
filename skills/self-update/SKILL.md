---
name: self-update
description: Safely improve AIMessenger itself by testing a staged source change, activating a verified release, and confirming watchdog health.
---

# Self Update

Use this workflow only for a requested AIMessenger behavior, architecture, skill, or identity change.

1. Work in `/srv/aimessenger-workspace/source`. Do not modify protected runtime, secret, broker, systemd, or network files.
2. Inspect the affected code and add or update a focused regression or capability test. Capability tests must use fake Telegram, fake Gmail, and a disposable database/workspace.
3. Run the focused test while iterating. When ready, run:

   ```bash
   cd /srv/aimessenger-workspace/source
   npm run self-update -- --summary "short description of the requested change"
   ```

4. The command requires `git diff --check`, `npm test`, and `npm run build` to pass before it changes the active release. It prints a release ID, then the service drains active work and restarts.
5. Confirm the watchdog result with `/updates` or the loopback health endpoint. If it rolls back, report the failure without claiming the change was deployed.
6. In the final response, state only the user-visible change, tests run, release ID, and whether the watchdog accepted it.
