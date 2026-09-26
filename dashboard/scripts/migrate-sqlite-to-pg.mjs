#!/usr/bin/env node
// One-shot, read-only migration/archive of every SQLite table into PostgreSQL.
// Control-plane HA uses normalized PostgreSQL tables created by lib/ha.js; the
// historical SQLite rows are retained here as JSONB so no run, alert, or
// decision history is discarded at cutover.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import pg from 'pg';

const sqlitePath = process.env.FLEET_DB ?? new URL('../fleet.db', import.meta.url).pathname;
const databaseUrl = process.env.FLEET_DATABASE_URL;
if (!databaseUrl) {
  console.error('FLEET_DATABASE_URL is required');
  process.exit(2);
}

const { Client } = pg;
const client = new Client({
  connectionString: databaseUrl,
  ssl: process.env.FLEET_DATABASE_SSL === '0'
    ? false
    : { rejectUnauthorized: process.env.FLEET_DATABASE_SSL_INSECURE !== '1' },
});
const db = new DatabaseSync(sqlitePath, { readOnly: true });

const stable = (row) => JSON.stringify(row, Object.keys(row).sort());
await client.connect();
try {
  await client.query(`
    CREATE TABLE IF NOT EXISTS fleet_sqlite_archive (
      table_name TEXT NOT NULL,
      row_number BIGINT NOT NULL,
      payload JSONB NOT NULL,
      PRIMARY KEY(table_name,row_number)
    );
    CREATE TABLE IF NOT EXISTS fleet_sqlite_manifest (
      table_name TEXT PRIMARY KEY,
      row_count BIGINT NOT NULL,
      checksum TEXT NOT NULL,
      migrated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  const tables = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name`).all().map((r) => r.name);

  await client.query('BEGIN');
  for (const table of tables) {
    const safe = String(table).replaceAll('"', '""');
    await client.query('DELETE FROM fleet_sqlite_archive WHERE table_name=$1', [table]);
    const hash = createHash('sha256');
    let count = 0;
    let batch = [];
    const flush = async () => {
      if (!batch.length) return;
      const values = [];
      const params = [];
      batch.forEach((row, index) => {
        const base = index * 3;
        values.push(`($${base + 1},$${base + 2},$${base + 3})`);
        params.push(table, row.rowNumber, row.payload);
      });
      await client.query(
        `INSERT INTO fleet_sqlite_archive(table_name,row_number,payload) VALUES ${values.join(',')}`,
        params
      );
      batch = [];
    };
    for (const row of db.prepare(`SELECT * FROM "${safe}"`).iterate()) {
      count++;
      hash.update(stable(row)).update('\n');
      batch.push({ rowNumber: count, payload: row });
      if (batch.length === 250) await flush();
    }
    await flush();
    const sum = hash.digest('hex');
    await client.query(`
      INSERT INTO fleet_sqlite_manifest(table_name,row_count,checksum,migrated_at)
      VALUES ($1,$2,$3,now())
      ON CONFLICT(table_name) DO UPDATE
        SET row_count=$2,checksum=$3,migrated_at=now()`, [table, count, sum]);
    const { rows: checked } = await client.query(
      'SELECT count(*)::bigint AS n FROM fleet_sqlite_archive WHERE table_name=$1', [table]
    );
    if (Number(checked[0].n) !== count) {
      throw new Error(`${table}: verification failed (${checked[0].n} != ${count})`);
    }
    console.log(`${table}: ${count} row(s), sha256 ${sum}`);
  }
  await client.query('COMMIT');
  console.log(`migration archive complete: ${tables.length} table(s)`);
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  throw err;
} finally {
  db.close();
  await client.end();
}
