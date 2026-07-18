export interface ServiceLimits {
  dailyUploadLimit: number;
  maxFileBytes: number;
  maxImageBytes: number;
  maxObjects: number;
  maxStoredBytes: number;
  monthlyUploadLimit: number;
  retentionDays: number;
}

export function readLimits(env: Env): ServiceLimits {
  return {
    dailyUploadLimit: positiveInteger(env.DAILY_UPLOAD_LIMIT, "DAILY_UPLOAD_LIMIT"),
    maxFileBytes: positiveInteger(env.MAX_FILE_BYTES, "MAX_FILE_BYTES"),
    maxImageBytes: positiveInteger(env.MAX_IMAGE_BYTES, "MAX_IMAGE_BYTES"),
    maxObjects: positiveInteger(env.MAX_OBJECTS, "MAX_OBJECTS"),
    maxStoredBytes: positiveInteger(env.MAX_STORED_BYTES, "MAX_STORED_BYTES"),
    monthlyUploadLimit: positiveInteger(env.MONTHLY_UPLOAD_LIMIT, "MONTHLY_UPLOAD_LIMIT"),
    retentionDays: positiveInteger(env.RETENTION_DAYS, "RETENTION_DAYS"),
  };
}

function positiveInteger(raw: string, name: string): number {
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`${name} must be a positive integer`);
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} exceeds the safe integer range`);
  }

  return value;
}
