# Upgrading

## Pre-upgrade checklist

Before upgrading on a live fleet:

1. **Back up the database:**
   ```bash
   sqlite3 dashboard/fleet.db ".backup dashboard/fleet.db.bak.$(date +%Y%m%d)"
   ```

2. **Check fleet health:**
   ```bash
   ./health.sh              # no dead runners
   ./status.sh              # nothing mid-job (ideally)
   ```

3. **Note the current version** (check `git log --oneline -5` or the dashboard
   footer).

## Upgrade procedure

```bash
# 1. Pull the latest code
git pull

# 2. Stop the dashboard daemon
cd dashboard && ./fleetctl.sh stop

# 3. Restart the dashboard (it runs migrations automatically on startup)
./fleetctl.sh start

# 4. Verify migrations ran cleanly
./fleetctl.sh logs | grep -i migration

# 5. Reinstall hooks if any hook files changed
scripts/install-hooks.sh --apply --restart

# 6. Verify health
cd .. && ./health.sh
```

## Upgrading from v0.1 or v0.2 to v0.3

The procedure above covers the code and the schema. A host that ran an earlier
version also needs these, once:

1. **Reinstall the hooks** (step 5 above). The job hooks now remove System V
   shared memory that killed Postgres clusters leave behind
   (`hooks/shm-reap.sh`); a host on the old hooks keeps leaking segments.
2. **Give every runner the same job PATH.** Runners registered before v0.3 took
   their PATH from whatever shell registered them:
   ```bash
   scripts/runner-path.sh            # which runners differ
   scripts/runner-path.sh --apply    # rewrite the idle ones and restart them
   ```
3. **Check the CLI tools jobs call.** `./preflight.sh` now checks the tools in
   `scripts/cli-tools.txt` (shellcheck, jq, make, and deno or ruby when a
   workflow uses them) on the runners' PATH.
4. **Remove the autofix bridge** if this host ran it. It was removed in v0.3:
   unload and delete `~/Library/LaunchAgents/<prefix>.fleet-autofix.plist`, and
   delete `~/.cursor/sdk/auth.json` or `dashboard/.cursor-api-key`.
5. **New runners use runner 2.337.0.** `register.sh` pins it; existing runners
   update themselves through GitHub.
6. **Nothing new turns itself on.** Standby tiers default to
   `FLEET_TIERS_MODE=off`. To try them, start with `observe`; see
   [Standby tiers](design/tiers.md).

## Verifying migration success

```bash
sqlite3 dashboard/fleet.db "SELECT * FROM schema_migrations ORDER BY applied_at DESC LIMIT 5;"
```

Each migration is applied exactly once. If the daemon started without errors and
this query returns recent rows, migrations ran cleanly.

## Rollback

There is **no automatic rollback**. The database schema uses forward-only
migrations.

To roll back:
1. Stop the daemon: `cd dashboard && ./fleetctl.sh stop`
2. Restore the backup: `cp dashboard/fleet.db.bak.YYYYMMDD dashboard/fleet.db`
3. Check out the previous version: `git checkout <previous-tag>`
4. Restart: `./fleetctl.sh start`

Note: data written during the upgrade period (between backup and rollback) will
be lost.

## The runner binary is updated separately

This project installs the [GitHub Actions runner binary](https://github.com/actions/runner/releases), but does not version or update it.
The runner binary updates itself via GitHub's runner update mechanism. Check the
runner version in the dashboard's runner drawer.

`register.sh` pins both the runner version and its SHA-256 checksum in the
script. Update those two constants together after verifying a new GitHub
release; an environment-only version override is intentionally unsupported
because it would bypass the pinned checksum.

## Node.js version

The dashboard requires Node >= 22.5.0 for `node:sqlite`. Check:
```bash
node -v
```

To upgrade Node: `brew upgrade node@22`.

After upgrading Node, restart the daemon:
```bash
cd dashboard && ./fleetctl.sh restart
```

## After upgrading: smoke check

```bash
./health.sh                          # runners alive?
curl http://localhost:7878/api/state | python3 -m json.tool | head -20
cd dashboard && ./fleetctl.sh status
npm test                              # unit tests
```
