/**
 * AIPF-007: Rate Limiter
 *
 * In-memory rate limiter for the URL Activity Scanner public MVP.
 * Protects the public prototype against automated abuse without blocking
 * normal internal or RTMS team testing.
 *
 * Safety guarantees:
 *   - Stores only: client IP string, window-start timestamp, batch count.
 *   - Never stores: submitted URLs, domains, paths, query strings, redirect
 *     destinations, resolved IPs, scan results, response headers, or bodies.
 *   - Makes no network, DNS, HTTP, or storage I/O of any kind.
 *   - The `now` field in the input is injectable for deterministic tests.
 *
 * Assumption A-AIPF007-01 — Fixed window:
 *   A fixed 1-hour window is used (not a sliding window / token bucket).
 *   Fixed windows are simpler and sufficient for MVP. At a window boundary,
 *   a burst of up to 2× the per-hour limit is briefly possible. This trade-off
 *   is acceptable for a prototype; a sliding window can be added later.
 *
 * Assumption A-AIPF007-02 — In-memory state:
 *   Rate limit counters live in process memory. Consequences:
 *   - Counters reset on server restart.
 *   - Multiple server processes / serverless cold-starts do not share state.
 *   - If abuse occurs or the tool is promoted to production-critical status,
 *     a persistent shared store (e.g. Redis) must replace this module.
 *
 * Assumption A-AIPF007-03 — Client IP source:
 *   The caller (AIPF-008 API layer) is responsible for extracting clientIp
 *   from the request (e.g. x-forwarded-for header) before calling check().
 *   Private/internal IPs receive no bypass or allowlist treatment.
 *
 * Assumption A-AIPF007-04 — No bypass / allowlist:
 *   No IP, range, or token bypass is implemented. All callers are subject
 *   to the same limits. A bypass mechanism may be added later via a separate
 *   ticket if explicitly approved.
 *
 * Assumption A-AIPF007-05 — Atomic check-and-record:
 *   check() checks the limits and, if allowed, records the request atomically
 *   in a single call. No separate recordAcceptedRequest() is needed because
 *   Node.js runs single-threaded and a two-step check+record would have the
 *   same behaviour. The caller must only invoke check() once per request.
 *
 * Assumption A-AIPF007-06 — maxConcurrentUrlsPerBatch / maxBatchRuntimeMs:
 *   These limits are exposed in the config and returned in every result so
 *   AIPF-008 can use them for concurrency and timeout enforcement. The rate
 *   limiter itself does not enforce them — that is AIPF-008's responsibility.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

/** One-hour fixed window in milliseconds. */
const WINDOW_MS = 60 * 60 * 1_000;

// ─── Public types ─────────────────────────────────────────────────────────────

export interface RateLimiterConfig {
  /** Maximum URLs in a single batch submission. */
  maxUrlsPerBatch: number;
  /** Maximum batch submissions per client IP per hour. */
  maxBatchesPerIpPerHour: number;
  /** Maximum batch submissions across all IPs combined per hour. */
  maxGlobalBatchesPerHour: number;
  /**
   * Maximum concurrent URL checks within a single batch.
   * Enforced by AIPF-008, exposed here for coordination.
   */
  maxConcurrentUrlsPerBatch: number;
  /**
   * Maximum wall-clock time allowed for a single batch in milliseconds.
   * Enforced by AIPF-008, exposed here for coordination.
   */
  maxBatchRuntimeMs: number;
}

export const DEFAULT_CONFIG: Readonly<RateLimiterConfig> = Object.freeze({
  maxUrlsPerBatch:            100,
  maxBatchesPerIpPerHour:      20,
  maxGlobalBatchesPerHour:    200,
  maxConcurrentUrlsPerBatch:    5,
  maxBatchRuntimeMs:       120_000,
});

export type RateLimitCode =
  | "ALLOWED"
  | "BATCH_TOO_LARGE"
  | "IP_RATE_LIMITED"
  | "GLOBAL_RATE_LIMITED"
  | "INVALID_INPUT";

export interface RateLimitResult {
  /** True only when result is "ALLOWED". */
  allowed: boolean;
  /** Machine-readable outcome code. */
  result: RateLimitCode;
  /** Human-readable explanation of the outcome. */
  reason: string;
  /**
   * Seconds until the current rate-limit window resets.
   * Null when the request is allowed or blocked for non-rate-limit reasons.
   */
  retryAfterSeconds: number | null;
  /** The full effective config, returned so callers can surface limits to users. */
  limits: Readonly<RateLimiterConfig>;
}

// ─── Internal types ───────────────────────────────────────────────────────────

interface BucketEntry {
  /** Unix ms timestamp when the current window started. */
  windowStart: number;
  /** Number of accepted batch requests in the current window. */
  count: number;
}

// ─── RateLimiter class ────────────────────────────────────────────────────────

/**
 * In-memory per-IP and global rate limiter.
 *
 * Instantiate once per server process and share the instance across requests.
 * For tests, create a fresh instance per test to guarantee isolated state.
 *
 * @example
 *   const limiter = new RateLimiter();
 *   const result = limiter.check({ clientIp: req.ip, urlCount: urls.length });
 *   if (!result.allowed) { return res.status(429).json(result); }
 */
export class RateLimiter {
  private readonly cfg: Readonly<RateLimiterConfig>;

  /**
   * Per-IP request buckets. Stores only IP string + timestamp + count.
   * Never stores URLs, domains, or scan data.
   */
  private readonly ipBuckets = new Map<string, BucketEntry>();

  /**
   * Global bucket shared across all IPs.
   * windowStart = 0 initially; resets on first request whose `now` value
   * is >= WINDOW_MS (which is always true for real-world Unix timestamps).
   */
  private readonly globalBucket: BucketEntry = { windowStart: 0, count: 0 };

  constructor(config?: Partial<RateLimiterConfig>) {
    this.cfg = Object.freeze({ ...DEFAULT_CONFIG, ...config });
  }

  /**
   * The effective rate-limit configuration for this instance.
   * Used by AIPF-008 to read limits (e.g. maxUrlsPerBatch, maxConcurrentUrlsPerBatch)
   * without making a dummy check() call that would consume quota.
   */
  get limits(): Readonly<RateLimiterConfig> {
    return this.cfg;
  }

  /**
   * Checks the incoming batch request against all rate limits and, if
   * allowed, atomically records the request in the appropriate buckets.
   *
   * No network, DNS, storage, or logging I/O is performed.
   * No submitted URLs or scan data are stored at any point.
   *
   * @param raw - The raw request input. Accepted shape:
   *   { clientIp?: string, urlCount?: number, now?: number }
   *   `now` is a Unix ms timestamp. Omit or set to falsy to use Date.now().
   *   Pass a fixed value in tests for deterministic results.
   * @returns A structured RateLimitResult.
   */
  check(raw: unknown): RateLimitResult {
    // ── Parse input ──────────────────────────────────────────────────────────
    const { clientIp, rawUrlCount, now } = this.parseInput(raw);

    // ── Validate urlCount ────────────────────────────────────────────────────
    if (rawUrlCount === undefined || rawUrlCount === null) {
      return this.deny("INVALID_INPUT", null, "urlCount is required");
    }
    if (
      typeof rawUrlCount !== "number" ||
      !Number.isInteger(rawUrlCount) ||
      !Number.isFinite(rawUrlCount)
    ) {
      return this.deny("INVALID_INPUT", null, "urlCount must be a positive integer");
    }
    if (rawUrlCount <= 0) {
      return this.deny("INVALID_INPUT", null, "urlCount must be greater than zero");
    }

    // ── Batch size check (does not consume quota) ────────────────────────────
    if (rawUrlCount > this.cfg.maxUrlsPerBatch) {
      return this.deny(
        "BATCH_TOO_LARGE",
        null,
        `Batch of ${rawUrlCount} exceeds the limit of ${this.cfg.maxUrlsPerBatch} URLs per batch`
      );
    }

    // ── Per-IP limit check ───────────────────────────────────────────────────
    const ipBucket = this.getIpBucket(clientIp, now);
    if (ipBucket.count >= this.cfg.maxBatchesPerIpPerHour) {
      return this.deny(
        "IP_RATE_LIMITED",
        this.retryAfterSeconds(ipBucket.windowStart, now),
        `This IP has exceeded the limit of ${this.cfg.maxBatchesPerIpPerHour} batches per hour`
      );
    }

    // ── Global limit check ───────────────────────────────────────────────────
    this.resetIfExpired(this.globalBucket, now);
    if (this.globalBucket.count >= this.cfg.maxGlobalBatchesPerHour) {
      return this.deny(
        "GLOBAL_RATE_LIMITED",
        this.retryAfterSeconds(this.globalBucket.windowStart, now),
        `Global batch limit of ${this.cfg.maxGlobalBatchesPerHour} per hour has been reached`
      );
    }

    // ── Allowed — atomically record in both buckets ──────────────────────────
    ipBucket.count += 1;
    this.globalBucket.count += 1;

    return {
      allowed: true,
      result: "ALLOWED",
      reason: "Within rate limits",
      retryAfterSeconds: null,
      limits: this.cfg,
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private parseInput(raw: unknown): {
    clientIp: string;
    rawUrlCount: unknown;
    now: number;
  } {
    if (typeof raw !== "object" || raw === null) {
      return { clientIp: "unknown", rawUrlCount: undefined, now: Date.now() };
    }
    const obj = raw as Record<string, unknown>;

    // Normalize missing or blank clientIp to "unknown".
    // Private/internal IPs are kept as-is — they receive no bypass treatment.
    const rawIp = obj["clientIp"];
    const clientIp =
      typeof rawIp === "string" && rawIp.trim().length > 0
        ? rawIp.trim()
        : "unknown";

    // Accept an injected timestamp for deterministic tests.
    const rawNow = obj["now"];
    const now =
      typeof rawNow === "number" && Number.isFinite(rawNow) && rawNow > 0
        ? rawNow
        : Date.now();

    return { clientIp, rawUrlCount: obj["urlCount"], now };
  }

  /** Returns the existing IP bucket (resetting it if the window expired) or creates a new one. */
  private getIpBucket(clientIp: string, now: number): BucketEntry {
    let bucket = this.ipBuckets.get(clientIp);
    if (bucket === undefined) {
      bucket = { windowStart: now, count: 0 };
      this.ipBuckets.set(clientIp, bucket);
    } else {
      this.resetIfExpired(bucket, now);
    }
    return bucket;
  }

  /** Resets a bucket's count and windowStart when the fixed window has expired. */
  private resetIfExpired(bucket: BucketEntry, now: number): void {
    if (now - bucket.windowStart >= WINDOW_MS) {
      bucket.windowStart = now;
      bucket.count = 0;
    }
  }

  /** Seconds remaining in the current window, minimum 1. */
  private retryAfterSeconds(windowStart: number, now: number): number {
    const remainingMs = windowStart + WINDOW_MS - now;
    return Math.max(1, Math.ceil(remainingMs / 1_000));
  }

  private deny(
    result: RateLimitCode,
    retryAfterSeconds: number | null,
    reason: string
  ): RateLimitResult {
    return { allowed: false, result, reason, retryAfterSeconds, limits: this.cfg };
  }
}

// ─── Shared default instance ──────────────────────────────────────────────────

/**
 * Default shared RateLimiter instance for production use.
 * Import and use this in API route handlers (AIPF-008).
 * For tests, create a fresh `new RateLimiter()` instead.
 */
export const rateLimiter = new RateLimiter();
