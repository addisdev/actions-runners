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

To pin a runner version, set `RUNNER_VERSION` before running `register.sh`:
```bash
RUNNER_VERSION=2.337.0 ./register.sh owner/project-ios
```

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
