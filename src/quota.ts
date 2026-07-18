import { DurableObject } from "cloudflare:workers";

const RESERVATION_TTL_MS = 15 * 60 * 1000;
const ALARM_BATCH_SIZE = 1_000;

export interface QuotaLimits {
  dailyUploadLimit: number;
  maxObjects: number;
  maxStoredBytes: number;
  monthlyUploadLimit: number;
}

export interface ReserveRequest {
  createdAt: number;
  expiresAt: number;
  id: string;
  objectKey: string;
  size: number;
}

export type ReserveResult =
  | { ok: true }
  | {
      ok: false;
      code: "daily_limit" | "monthly_limit" | "object_limit" | "storage_limit";
    };

export interface QuotaSnapshot {
  dailyUploads: number;
  maxObjects: number;
  maxStoredBytes: number;
  monthlyUploads: number;
  objectCount: number;
  reservedBytes: number;
  storedBytes: number;
}

type AttachmentRow = {
  id: string;
  object_key: string;
  state: "reserved" | "stored";
} & Record<string, SqlStorageValue>;

type AggregateRow = {
  object_count: number;
  reserved_bytes: number;
  stored_bytes: number;
} & Record<string, SqlStorageValue>;

export class QuotaLedger extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
      await this.rescheduleAlarm();
    });
  }

  async reserve(request: ReserveRequest, limits: QuotaLimits): Promise<ReserveResult> {
    validateReserveRequest(request);
    validateLimits(limits);
    this.removeStaleReservations(request.createdAt);

    const dayKey = periodKey(request.createdAt, "day");
    const monthKey = periodKey(request.createdAt, "month");
    this.removeOldUsage(dayKey, monthKey);

    const aggregate = this.aggregate();
    if (aggregate.stored_bytes + aggregate.reserved_bytes + request.size > limits.maxStoredBytes) {
      return { ok: false, code: "storage_limit" };
    }
    if (aggregate.object_count >= limits.maxObjects) {
      return { ok: false, code: "object_limit" };
    }
    if (this.usage("day", dayKey) >= limits.dailyUploadLimit) {
      return { ok: false, code: "daily_limit" };
    }
    if (this.usage("month", monthKey) >= limits.monthlyUploadLimit) {
      return { ok: false, code: "monthly_limit" };
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO attachments
        (id, object_key, size, state, created_at, expires_at, reservation_expires_at)
       VALUES (?, ?, ?, 'reserved', ?, ?, ?)`,
      request.id,
      request.objectKey,
      request.size,
      request.createdAt,
      request.expiresAt,
      request.createdAt + RESERVATION_TTL_MS,
    );
    this.incrementUsage("day", dayKey);
    this.incrementUsage("month", monthKey);
    await this.ensureEarlierAlarm();

    return { ok: true };
  }

  async finalize(id: string, actualSize: number): Promise<boolean> {
    const row = this.ctx.storage.sql
      .exec<{ size: number; state: string }>("SELECT size, state FROM attachments WHERE id = ?", id)
      .toArray()[0];

    if (row === undefined || row.state !== "reserved" || row.size !== actualSize) {
      return false;
    }

    this.ctx.storage.sql.exec("UPDATE attachments SET state = 'stored' WHERE id = ?", id);
    await this.rescheduleAlarm();
    return true;
  }

  async rollback(id: string): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM attachments WHERE id = ? AND state = 'reserved'", id);
    await this.rescheduleAlarm();
  }

  async release(id: string): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM attachments WHERE id = ?", id);
    await this.rescheduleAlarm();
  }

  async quota(now: number, limits: QuotaLimits): Promise<QuotaSnapshot> {
    validateLimits(limits);
    this.removeStaleReservations(now);
    const dayKey = periodKey(now, "day");
    const monthKey = periodKey(now, "month");
    this.removeOldUsage(dayKey, monthKey);
    const aggregate = this.aggregate();
    await this.rescheduleAlarm();

    return {
      dailyUploads: this.usage("day", dayKey),
      maxObjects: limits.maxObjects,
      maxStoredBytes: limits.maxStoredBytes,
      monthlyUploads: this.usage("month", monthKey),
      objectCount: aggregate.object_count,
      reservedBytes: aggregate.reserved_bytes,
      storedBytes: aggregate.stored_bytes,
    };
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    const rows = this.ctx.storage.sql
      .exec<AttachmentRow>(
        `SELECT id, object_key, state
         FROM attachments
         WHERE (state = 'stored' AND expires_at <= ?)
            OR (state = 'reserved' AND reservation_expires_at <= ?)
         ORDER BY CASE WHEN state = 'stored' THEN expires_at ELSE reservation_expires_at END
         LIMIT ?`,
        now,
        now,
        ALARM_BATCH_SIZE,
      )
      .toArray();

    const storedRows = rows.filter((row) => row.state === "stored");
    if (storedRows.length > 0) {
      await this.env.ATTACHMENTS.delete(storedRows.map((row) => row.object_key));
    }

    for (const row of rows) {
      this.ctx.storage.sql.exec("DELETE FROM attachments WHERE id = ?", row.id);
    }

    await this.rescheduleAlarm();
  }

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
        id INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    const version = this.ctx.storage.sql
      .exec<{ version: number }>(
        "SELECT COALESCE(MAX(id), 0) AS version FROM _sql_schema_migrations",
      )
      .one().version;

    if (version < 1) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE attachments (
          id TEXT PRIMARY KEY,
          object_key TEXT NOT NULL UNIQUE,
          size INTEGER NOT NULL CHECK (size > 0),
          state TEXT NOT NULL CHECK (state IN ('reserved', 'stored')),
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          reservation_expires_at INTEGER NOT NULL
        );
        CREATE INDEX attachments_expiration
          ON attachments(state, expires_at, reservation_expires_at);
        CREATE TABLE usage (
          period_type TEXT NOT NULL CHECK (period_type IN ('day', 'month')),
          period_key TEXT NOT NULL,
          count INTEGER NOT NULL CHECK (count >= 0),
          PRIMARY KEY (period_type, period_key)
        );
        INSERT INTO _sql_schema_migrations (id) VALUES (1);
      `);
    }
  }

  private aggregate(): AggregateRow {
    return this.ctx.storage.sql
      .exec<AggregateRow>(`
        SELECT
          COUNT(*) AS object_count,
          COALESCE(SUM(CASE WHEN state = 'reserved' THEN size ELSE 0 END), 0) AS reserved_bytes,
          COALESCE(SUM(CASE WHEN state = 'stored' THEN size ELSE 0 END), 0) AS stored_bytes
        FROM attachments
      `)
      .one();
  }

  private incrementUsage(periodType: "day" | "month", key: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO usage (period_type, period_key, count) VALUES (?, ?, 1)
       ON CONFLICT (period_type, period_key) DO UPDATE SET count = count + 1`,
      periodType,
      key,
    );
  }

  private usage(periodType: "day" | "month", key: string): number {
    return (
      this.ctx.storage.sql
        .exec<{ count: number }>(
          "SELECT count FROM usage WHERE period_type = ? AND period_key = ?",
          periodType,
          key,
        )
        .toArray()[0]?.count ?? 0
    );
  }

  private removeOldUsage(dayKey: string, monthKey: string): void {
    this.ctx.storage.sql.exec(
      `DELETE FROM usage
       WHERE (period_type = 'day' AND period_key <> ?)
          OR (period_type = 'month' AND period_key <> ?)`,
      dayKey,
      monthKey,
    );
  }

  private removeStaleReservations(now: number): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM attachments WHERE state = 'reserved' AND reservation_expires_at <= ?",
      now,
    );
  }

  private nextAlarm(): number | null {
    return this.ctx.storage.sql
      .exec<{ next_alarm: number | null }>(`
        SELECT MIN(
          CASE WHEN state = 'stored' THEN expires_at ELSE reservation_expires_at END
        ) AS next_alarm
        FROM attachments
      `)
      .one().next_alarm;
  }

  private async ensureEarlierAlarm(): Promise<void> {
    const next = this.nextAlarm();
    if (next === null) {
      return;
    }
    const current = await this.ctx.storage.getAlarm();
    if (current === null || next < current) {
      await this.ctx.storage.setAlarm(next);
    }
  }

  private async rescheduleAlarm(): Promise<void> {
    const next = this.nextAlarm();
    if (next === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(next);
  }
}

function validateReserveRequest(request: ReserveRequest): void {
  if (
    !Number.isSafeInteger(request.createdAt) ||
    !Number.isSafeInteger(request.expiresAt) ||
    !Number.isSafeInteger(request.size) ||
    request.createdAt <= 0 ||
    request.expiresAt <= request.createdAt ||
    request.size <= 0 ||
    !request.id ||
    !request.objectKey
  ) {
    throw new Error("Invalid quota reservation");
  }
}

function validateLimits(limits: QuotaLimits): void {
  if (
    !Number.isSafeInteger(limits.dailyUploadLimit) ||
    !Number.isSafeInteger(limits.maxObjects) ||
    !Number.isSafeInteger(limits.maxStoredBytes) ||
    !Number.isSafeInteger(limits.monthlyUploadLimit) ||
    limits.dailyUploadLimit <= 0 ||
    limits.maxObjects <= 0 ||
    limits.maxStoredBytes <= 0 ||
    limits.monthlyUploadLimit <= 0
  ) {
    throw new Error("Invalid quota limits");
  }
}

function periodKey(timestamp: number, period: "day" | "month"): string {
  const iso = new Date(timestamp).toISOString();
  return period === "day" ? iso.slice(0, 10) : iso.slice(0, 7);
}
