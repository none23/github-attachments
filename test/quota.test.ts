import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { QuotaLimits, ReserveRequest } from "../src/quota";

const NOW = Date.now();

describe("quota ledger", () => {
  it("atomically rejects reservations beyond the byte cap", async () => {
    const ledger = env.QUOTA.getByName("storage-cap");
    const limits = makeLimits({ maxStoredBytes: 10 });

    expect(await ledger.reserve(makeReservation("one", 6), limits)).toEqual({ ok: true });
    expect(await ledger.reserve(makeReservation("two", 5), limits)).toEqual({
      ok: false,
      code: "storage_limit",
    });

    expect(await ledger.quota(NOW, limits)).toMatchObject({
      objectCount: 1,
      reservedBytes: 6,
      storedBytes: 0,
    });
  });

  it("does not overcommit quota under concurrent reservations", async () => {
    const ledger = env.QUOTA.getByName("concurrent-storage-cap");
    const limits = makeLimits({ maxStoredBytes: 10 });
    const reservations = Array.from({ length: 10 }, (_, index) =>
      ledger.reserve(makeReservation(`concurrent-${index}`, 2), limits),
    );

    const results = await Promise.all(reservations);
    expect(results.filter((result) => result.ok)).toHaveLength(5);
    expect(await ledger.quota(NOW, limits)).toMatchObject({
      objectCount: 5,
      reservedBytes: 10,
    });
  });

  it("enforces object and operation limits", async () => {
    const objectLedger = env.QUOTA.getByName("object-cap");
    const objectLimits = makeLimits({ maxObjects: 1 });
    expect(await objectLedger.reserve(makeReservation("object-one", 1), objectLimits)).toEqual({
      ok: true,
    });
    expect(await objectLedger.reserve(makeReservation("object-two", 1), objectLimits)).toEqual({
      ok: false,
      code: "object_limit",
    });

    const dailyLedger = env.QUOTA.getByName("daily-cap");
    const dailyLimits = makeLimits({ dailyUploadLimit: 1 });
    expect(await dailyLedger.reserve(makeReservation("daily-one", 1), dailyLimits)).toEqual({
      ok: true,
    });
    expect(await dailyLedger.reserve(makeReservation("daily-two", 1), dailyLimits)).toEqual({
      ok: false,
      code: "daily_limit",
    });
  });

  it("moves reservations to stored usage and releases deleted objects", async () => {
    const ledger = env.QUOTA.getByName("lifecycle");
    const limits = makeLimits();
    const reservation = makeReservation("lifecycle-one", 7);

    expect(await ledger.reserve(reservation, limits)).toEqual({ ok: true });
    expect(await ledger.finalize(reservation.id, reservation.size)).toBe(true);
    expect(await ledger.quota(NOW, limits)).toMatchObject({
      objectCount: 1,
      reservedBytes: 0,
      storedBytes: 7,
    });

    await ledger.release(reservation.id);
    expect(await ledger.quota(NOW, limits)).toMatchObject({
      objectCount: 0,
      reservedBytes: 0,
      storedBytes: 0,
    });
  });

  it("deletes expired R2 objects when its alarm runs", async () => {
    const ledger = env.QUOTA.getByName("expiration");
    const limits = makeLimits();
    const reservation = makeReservation("expired", 4, Date.now() - 2_000);
    reservation.expiresAt = Date.now() - 1_000;
    await env.ATTACHMENTS.put(reservation.objectKey, "test");

    expect(await ledger.reserve(reservation, limits)).toEqual({ ok: true });
    expect(await ledger.finalize(reservation.id, reservation.size)).toBe(true);
    await runInDurableObject(ledger, async (instance) => {
      await instance.alarm();
    });

    expect(await env.ATTACHMENTS.head(reservation.objectKey)).toBeNull();
    expect(await ledger.quota(Date.now(), limits)).toMatchObject({
      objectCount: 0,
      storedBytes: 0,
    });
  });
});

function makeLimits(overrides: Partial<QuotaLimits> = {}): QuotaLimits {
  return {
    dailyUploadLimit: 100,
    maxObjects: 100,
    maxStoredBytes: 1_000,
    monthlyUploadLimit: 1_000,
    ...overrides,
  };
}

function makeReservation(name: string, size: number, createdAt = NOW): ReserveRequest {
  const id = crypto.randomUUID();
  return {
    createdAt,
    expiresAt: createdAt + 86_400_000,
    id,
    objectKey: `objects/${id}-${name}`,
    size,
  };
}
