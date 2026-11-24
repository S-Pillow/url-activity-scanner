/**
 * Shared request-scoped cancellation primitives.
 *
 * A single AbortSignal flows from the batch scheduler through DNS and every
 * outbound HTTP(S) hop. ScanAbortError is internal and must not be exposed to
 * API callers.
 */

export const SCAN_ABORT_ERROR_CODE = "ERR_SCAN_ABORTED";

export class ScanAbortError extends Error {
  readonly code = SCAN_ABORT_ERROR_CODE;

  constructor(message = "Scan cancelled") {
    super(message);
    this.name = "ScanAbortError";
  }
}

export function isScanAbortError(error: unknown): error is ScanAbortError {
  return (
    error instanceof ScanAbortError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === SCAN_ABORT_ERROR_CODE)
  );
}

/** Throws the scanner's stable internal cancellation error when aborted. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ScanAbortError();
  }
}

/**
 * Races an operation against a signal while retaining rejection handlers on
 * the underlying promise. This is needed for Node DNS APIs, which cannot be
 * cancelled: callers stop immediately and late DNS completion is ignored.
 */
export function raceWithSignal<T>(
  operation: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) return operation;
  throwIfAborted(signal);

  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
    };

    const settle = (
      callback: (value: T) => void,
      value: T
    ): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const onAbort = (): void => fail(new ScanAbortError());
    signal.addEventListener("abort", onAbort, { once: true });

    // Close the check/listener registration race.
    if (signal.aborted) {
      onAbort();
      return;
    }

    operation.then(
      (value) => settle(resolve, value),
      (error) => fail(error)
    );
  });
}
