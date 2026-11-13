// The rolling window: where to cut so what is kept fits the caps. Pure.

/** Counters are kept per 5-minute bucket, so the cut is exact to within 5 minutes of data. */
export const BUCKET_SECONDS = 300;
/** Trim to this share of the byte cap, so the next minutes of ingest do not trip it at once. */
export const BYTES_TARGET = 0.9;

export interface Bucket {
  /** Start of the bucket, unix seconds, a multiple of BUCKET_SECONDS. */
  startS: number;
  requests: number;
  bytes: number;
}

export function bucketStart(ms: number): number {
  return Math.floor(ms / 1000 / BUCKET_SECONDS) * BUCKET_SECONDS;
}

/**
 * The start (unix seconds) of the oldest bucket to keep, or null when everything already fits.
 * Keeps the newest buckets while their total stays within `maxRequests` and within
 * BYTES_TARGET x `maxBytes`; the newest bucket is always kept, even if it alone is over.
 */
export function windowCutoff(buckets: readonly Bucket[], maxRequests: number | null, maxBytes: number | null): number | null {
  if (buckets.length === 0) return null;
  const newestFirst = [...buckets].sort((a, b) => b.startS - a.startS);
  const byteCap = maxBytes === null ? null : maxBytes * BYTES_TARGET;
  let requests = 0;
  let bytes = 0;
  let cutoff = newestFirst[0].startS;
  for (const b of newestFirst) {
    const over = (maxRequests !== null && requests + b.requests > maxRequests) || (byteCap !== null && bytes + b.bytes > byteCap);
    if (over && b !== newestFirst[0]) return cutoff;
    requests += b.requests;
    bytes += b.bytes;
    cutoff = b.startS;
  }
  return null;
}
