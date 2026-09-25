const LOCK_KEY = 1179403597; // stable fleetd advisory-lock key

const SCHEMA = `
CREATE TABLE IF NOT EXISTS fleet_control_lease (
  lock_name TEXT PRIMARY KEY,
  holder_id TEXT NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL,
  renewed_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS fleet_snapshots (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  leader_id TEXT NOT NULL,
  ts BIGINT NOT NULL,
  payload JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS fleet_hosts (
  host_id TEXT PRIMARY KEY,
  last_seen BIGINT NOT NULL,
  payload JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS fleet_commands (
  id BIGSERIAL PRIMARY KEY,
  host_id TEXT NOT NULL,
  ts BIGINT NOT NULL,
  action TEXT NOT NULL,
  args JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending',
  idempotency_key TEXT UNIQUE,
  started_at BIGINT,
  completed_at BIGINT,
  result TEXT,
  attempts INTEGER NOT NULL DEFAULT 0
);
ALTER TABLE fleet_commands ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS fleet_commands_pending
  ON fleet_commands(host_id, status, id);
CREATE TABLE IF NOT EXISTS fleet_placements (
  id BIGSERIAL PRIMARY KEY,
  ts BIGINT NOT NULL,
  repo TEXT NOT NULL,
  host_id TEXT,
  action TEXT NOT NULL,
  reason TEXT,
  dry_run BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS fleet_placements_ts ON fleet_placements(ts DESC);
CREATE TABLE IF NOT EXISTS fleet_shared_meta (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at BIGINT NOT NULL
);`;

export class HaCoordinator {
  constructor({ url, replicaId, log = () => {}, warn = () => {}, electionMs = 3000 }) {
    this.url = url;
    this.replicaId = replicaId;
    this.log = log;
    this.warn = warn;
    this.electionMs = electionMs;
    this.pool = null;
    this.leaderClient = null;
    this.isLeader = !url;
    this.leaderId = url ? null : replicaId;
    this.leaderSince = this.isLeader ? Date.now() : null;
    this.onRoleChange = null;
    this.timer = null;
  }

  async start(onRoleChange = null) {
    if (!this.url) return;
    this.onRoleChange = onRoleChange;
    const { default: pg } = await import('pg');
    const { Pool } = pg;
    this.pool = new Pool({
      connectionString: this.url,
      max: Number(process.env.FLEET_PG_POOL_SIZE ?? 6),
      ssl: process.env.FLEET_DATABASE_SSL === '0' ? false : { rejectUnauthorized: process.env.FLEET_DATABASE_SSL_INSECURE !== '1' },
      application_name: `fleetd-${this.replicaId}`,
      connectionTimeoutMillis: Number(process.env.FLEET_PG_CONNECT_TIMEOUT_MS ?? 5000),
      statement_timeout: Number(process.env.FLEET_PG_STATEMENT_TIMEOUT_MS ?? 10000),
      keepAlive: true,
      keepAliveInitialDelayMillis: Number(process.env.FLEET_PG_KEEPALIVE_DELAY_MS ?? 5000),
    });
    this.pool.on('error', (err) => this.warn('postgres pool:', err.message));
    await this.pool.query(SCHEMA);
    await this.elect();
    this.timer = setInterval(() => this.elect().catch((err) => {
      this.warn('leader election:', err.message);
      this.loseLeadership();
    }), this.electionMs);
    this.timer.unref?.();
  }

  setRole(isLeader, leaderId = null) {
    const changed = this.isLeader !== isLeader || this.leaderId !== leaderId;
    this.isLeader = isLeader;
    this.leaderId = isLeader ? this.replicaId : leaderId;
    if (isLeader && !this.leaderSince) this.leaderSince = Date.now();
    if (!isLeader) this.leaderSince = null;
    if (changed) {
      this.log(`control-plane role: ${isLeader ? 'leader' : `standby${leaderId ? ` (leader ${leaderId})` : ''}`}`);
      this.onRoleChange?.({ isLeader: this.isLeader, leaderId: this.leaderId });
    }
  }

  async elect() {
    if (!this.pool) return;
    if (this.leaderClient) {
      try {
        await this.leaderClient.query('SELECT 1');
        await this.leaderClient.query(`
          INSERT INTO fleet_control_lease(lock_name, holder_id, acquired_at, renewed_at)
          VALUES ('fleetd', $1, now(), now())
          ON CONFLICT(lock_name) DO UPDATE SET holder_id=$1, renewed_at=now()`, [this.replicaId]);
        this.setRole(true, this.replicaId);
        return;
      } catch {
        this.loseLeadership();
      }
    }

    const client = await this.pool.connect();
    try {
      const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS won', [LOCK_KEY]);
      if (rows[0]?.won) {
        this.leaderClient = client;
        await client.query(`
          INSERT INTO fleet_control_lease(lock_name, holder_id, acquired_at, renewed_at)
          VALUES ('fleetd', $1, now(), now())
          ON CONFLICT(lock_name) DO UPDATE
            SET holder_id=$1, acquired_at=now(), renewed_at=now()`, [this.replicaId]);
        this.setRole(true, this.replicaId);
        return;
      }
    } finally {
      if (client !== this.leaderClient) client.release();
    }
    const { rows } = await this.pool.query(
      "SELECT holder_id FROM fleet_control_lease WHERE lock_name='fleetd'"
    );
    this.setRole(false, rows[0]?.holder_id ?? null);
  }

  loseLeadership() {
    if (this.leaderClient) {
      try { this.leaderClient.release(true); } catch {}
      this.leaderClient = null;
    }
    this.setRole(false, null);
  }

  async publishSnapshot(snapshot) {
    if (!this.pool || !this.isLeader) return;
    await this.pool.query(`
      INSERT INTO fleet_snapshots(id, leader_id, ts, payload) VALUES (1,$1,$2,$3)
      ON CONFLICT(id) DO UPDATE SET leader_id=$1, ts=$2, payload=$3`,
    [this.replicaId, snapshot.ts, snapshot]);
  }

  async loadSnapshot() {
    if (!this.pool) return null;
    const { rows } = await this.pool.query(
      'SELECT leader_id, ts, payload FROM fleet_snapshots WHERE id=1'
    );
    return rows[0] ?? null;
  }

  async upsertHost(hostId, payload, seenAt = Date.now()) {
    if (!this.pool) return;
    await this.pool.query(`
      INSERT INTO fleet_hosts(host_id,last_seen,payload) VALUES ($1,$2,$3)
      ON CONFLICT(host_id) DO UPDATE SET last_seen=$2,payload=$3`,
    [hostId, seenAt, payload]);
  }

  async loadHosts() {
    if (!this.pool) return [];
    const { rows } = await this.pool.query(
      'SELECT host_id,last_seen,payload FROM fleet_hosts ORDER BY host_id'
    );
    return rows;
  }

  async queueCommand(hostId, action, args, idempotencyKey = null, ts = Date.now()) {
    if (!this.pool) return null;
    const { rows } = await this.pool.query(`
      INSERT INTO fleet_commands(host_id,ts,action,args,status,idempotency_key)
      VALUES ($1,$2,$3,$4,'pending',$5)
      ON CONFLICT(idempotency_key) DO UPDATE
        SET idempotency_key=EXCLUDED.idempotency_key
      RETURNING id`, [hostId, ts, action, args, idempotencyKey]);
    return rows[0]?.id ?? null;
  }

  async pendingCommands(hostId, limit = 8) {
    if (!this.pool) return [];
    const { rows } = await this.pool.query(`
      SELECT id,action,args,idempotency_key FROM fleet_commands
      WHERE host_id=$1 AND status='pending' AND attempts < 3 ORDER BY id LIMIT $2`, [hostId, limit]);
    return rows;
  }

  async claimCommands(hostId, ts = Date.now(), limit = 8) {
    if (!this.pool) return [];
    const { rows } = await this.pool.query(`
      UPDATE fleet_commands
      SET status='sent',started_at=$1,attempts=attempts+1
      WHERE id IN (
        SELECT id FROM fleet_commands
        WHERE host_id=$2 AND status='pending' AND attempts < 3
        ORDER BY id
        LIMIT $3
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id,action,args,idempotency_key`, [ts, hostId, limit]);
    return rows.sort((a, b) => Number(a.id) - Number(b.id));
  }

  async releaseCommandClaim(id) {
    if (!this.pool) return false;
    const released = await this.pool.query(`
      UPDATE fleet_commands
      SET status='pending',started_at=NULL,attempts=GREATEST(attempts-1,0)
      WHERE id=$1 AND status='sent'`, [id]);
    return released.rowCount === 1;
  }

  async markCommandSent(id, ts = Date.now()) {
    if (!this.pool) return false;
    const marked = await this.pool.query(
      "UPDATE fleet_commands SET status='sent',started_at=$1,attempts=attempts+1 "
      + "WHERE id=$2 AND status='pending' AND attempts < 3",
      [ts, id]
    );
    return marked.rowCount === 1;
  }

  async commandById(id) {
    if (!this.pool) return null;
    const { rows } = await this.pool.query(
      'SELECT id,host_id,action,args,status FROM fleet_commands WHERE id=$1', [id]
    );
    return rows[0] ?? null;
  }

  async completeCommand(id, ok, result, ts = Date.now()) {
    if (!this.pool) return false;
    const completed = await this.pool.query(`
      UPDATE fleet_commands SET completed_at=$1,status=$2,result=$3
      WHERE id=$4 AND status='sent'`,
    [ts, ok ? 'done' : 'failed', result, id]);
    return completed.rowCount === 1;
  }

  async resetExpiredCommands(before, maxAttempts = 3) {
    if (!this.pool) return;
    await this.pool.query(`
      UPDATE fleet_commands
      SET status=CASE WHEN attempts >= $2 THEN 'failed' ELSE 'pending' END,
          completed_at=CASE WHEN attempts >= $2 THEN $3 ELSE completed_at END,
          result=CASE WHEN attempts >= $2 THEN 'delivery acknowledgement timed out' ELSE result END
      WHERE status='sent' AND started_at < $1`, [before, maxAttempts, Date.now()]);
  }

  async recentCommands(limit = 20) {
    if (!this.pool) return [];
    const { rows } = await this.pool.query(`
      SELECT host_id,action,status,ts,started_at,attempts FROM fleet_commands
      WHERE status IN ('pending','sent') ORDER BY ts DESC LIMIT $1`, [limit]);
    return rows;
  }

  async insertPlacement({ ts, repo, hostId, action, reason, dryRun }) {
    if (!this.pool) return;
    await this.pool.query(`
      INSERT INTO fleet_placements(ts,repo,host_id,action,reason,dry_run)
      VALUES ($1,$2,$3,$4,$5,$6)`,
    [ts, repo, hostId, action, reason, Boolean(dryRun)]);
  }

  async recentPlacements(limit = 50) {
    if (!this.pool) return [];
    const { rows } = await this.pool.query(`
      SELECT ts,repo,host_id,action,reason,dry_run
      FROM fleet_placements ORDER BY ts DESC LIMIT $1`, [limit]);
    return rows;
  }

  async getMeta(key, fallback = null) {
    if (!this.pool) return fallback;
    const { rows } = await this.pool.query('SELECT value FROM fleet_shared_meta WHERE key=$1', [key]);
    return rows[0]?.value ?? fallback;
  }

  async setMeta(key, value) {
    if (!this.pool) return;
    await this.pool.query(`
      INSERT INTO fleet_shared_meta(key,value,updated_at) VALUES ($1,$2,$3)
      ON CONFLICT(key) DO UPDATE SET value=$2,updated_at=$3`,
    [key, value, Date.now()]);
  }

  async loadSettings() {
    if (!this.pool) return {};
    const { rows } = await this.pool.query(
      "SELECT key,value FROM fleet_shared_meta WHERE key LIKE 'setting.%'"
    );
    return Object.fromEntries(rows.map((row) => [row.key.slice(8), row.value]));
  }

  async listMeta(prefix) {
    if (!this.pool) return {};
    const { rows } = await this.pool.query(
      'SELECT key,value FROM fleet_shared_meta WHERE key LIKE $1',
      [`${prefix}%`]
    );
    return Object.fromEntries(rows.map((row) => [row.key.slice(prefix.length), row.value]));
  }

  async deleteMeta(key) {
    if (!this.pool) return;
    await this.pool.query('DELETE FROM fleet_shared_meta WHERE key=$1', [key]);
  }

  async status() {
    if (!this.pool) return { enabled: false, isLeader: true, leaderId: this.replicaId };
    const { rows } = await this.pool.query(
      "SELECT holder_id,acquired_at,renewed_at FROM fleet_control_lease WHERE lock_name='fleetd'"
    );
    return {
      enabled: true,
      isLeader: this.isLeader,
      leaderId: this.leaderId ?? rows[0]?.holder_id ?? null,
      replicaId: this.replicaId,
      acquiredAt: rows[0]?.acquired_at ?? null,
      renewedAt: rows[0]?.renewed_at ?? null,
    };
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    if (this.leaderClient) {
      try { await this.leaderClient.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]); } catch {}
      try { this.leaderClient.release(); } catch {}
      this.leaderClient = null;
    }
    await this.pool?.end();
  }
}
