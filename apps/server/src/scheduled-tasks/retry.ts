// Pure retry-backoff math shared by service.runNow retries (docs §5.10), lease
// recovery (docs §8.8) and dispatcher failure retries (docs §8.7). One spelling
// of the ladder: min(initial * multiplier^(n-1), max) with ±10% jitter from an
// injected deterministic rng.
import type { RetryPolicy } from "@pi-science/contracts";

/** Milliseconds to wait before attempt n+1 after attempt n failed. */
export function retryBackoffMs(retry: RetryPolicy, failedAttemptNo: number): number {
  const exponent = Math.max(0, Math.floor(failedAttemptNo) - 1);
  const baseSeconds = Math.min(retry.initial_backoff_seconds * Math.pow(retry.multiplier, exponent), retry.max_backoff_seconds);
  return baseSeconds * 1000;
}

/** Jittered wall-clock delay: ±10% multiplicative, deterministic under tests. */
export function jitteredBackoffMs(retry: RetryPolicy, failedAttemptNo: number, rng: () => number): number {
  const jitter = 0.9 + rng() * 0.2;
  return Math.max(0, Math.round(retryBackoffMs(retry, failedAttemptNo) * jitter));
}
