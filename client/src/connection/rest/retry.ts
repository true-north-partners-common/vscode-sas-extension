// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { AxiosError } from "axios";

/**
 * Backoff for a connection that may be absent for a while.
 *
 * The case this exists for is a laptop that slept partway through a job. The
 * event loop sleeps with the machine, so the budget below is not spent waiting
 * out the nap: it is what we are willing to spend re-establishing a connection
 * once the machine is awake, before concluding the failure is real.
 */
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Whether an error is worth another attempt.
 *
 * No response at all means the request never completed - a dropped socket, a
 * network adapter that is still waking, DNS that is not back yet - and those
 * come good on their own. A response means the server answered and meant it,
 * so only its own faults are worth repeating: a 401 has already had its one
 * refresh and retry before it reaches here, and a 404 on a session is as final
 * as an answer gets.
 */
export const isTransient = (error: unknown): boolean => {
  if (!(error instanceof AxiosError)) {
    return false;
  }

  const status = error.response?.status;
  return status === undefined || status >= 500;
};

export interface RetryOptions {
  isRetryable?: (error: unknown) => boolean;
  /** Overridable so tests do not have to wait out the real backoff. */
  delaysMs?: number[];
}

/**
 * Run an operation, retrying while it fails in a way that tends to pass.
 */
export const withRetry = async <T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> => {
  const { isRetryable = isTransient, delaysMs = RETRY_DELAYS_MS } = options;

  for (let attempt = 0; ; ++attempt) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= delaysMs.length || !isRetryable(error)) {
        throw error;
      }
      await delay(delaysMs[attempt]);
    }
  }
};
