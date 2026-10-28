// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "assert";
import { AxiosError, AxiosResponse } from "axios";

import { isTransient, withRetry } from "../../src/connection/rest/retry";

const axiosErrorWith = (status?: number): AxiosError => {
  const error = new AxiosError("boom");
  if (status !== undefined) {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    error.response = { status } as AxiosResponse;
  }
  return error;
};

// Nothing here should wait out the real backoff.
const immediately = { delaysMs: [0, 0, 0] };

describe("connection/retry", () => {
  describe("isTransient", () => {
    it("retries a request that never got an answer", () => {
      // A dropped socket, a sleeping network adapter, DNS not back yet.
      assert.strictEqual(isTransient(axiosErrorWith(undefined)), true);
    });

    it("retries a server fault", () => {
      assert.strictEqual(isTransient(axiosErrorWith(500)), true);
      assert.strictEqual(isTransient(axiosErrorWith(503)), true);
    });

    it("does not retry a refused credential", () => {
      // By the time a 401 reaches here it has already had its refresh.
      assert.strictEqual(isTransient(axiosErrorWith(401)), false);
      assert.strictEqual(isTransient(axiosErrorWith(403)), false);
    });

    it("does not retry a session that is gone", () => {
      assert.strictEqual(isTransient(axiosErrorWith(404)), false);
      assert.strictEqual(isTransient(axiosErrorWith(410)), false);
    });

    it("does not retry something that is not an http failure", () => {
      assert.strictEqual(isTransient(new Error("nope")), false);
      assert.strictEqual(isTransient(undefined), false);
    });
  });

  describe("withRetry", () => {
    it("returns the first answer when there is one", async () => {
      let calls = 0;
      const result = await withRetry(async () => {
        ++calls;
        return "ok";
      }, immediately);

      assert.strictEqual(result, "ok");
      assert.strictEqual(calls, 1);
    });

    it("carries on once the connection comes back", async () => {
      let calls = 0;
      const result = await withRetry(async () => {
        if (++calls < 3) {
          throw axiosErrorWith(undefined);
        }
        return "ok";
      }, immediately);

      assert.strictEqual(result, "ok");
      assert.strictEqual(calls, 3);
    });

    it("gives up once the budget is spent, and reports the last failure", async () => {
      let calls = 0;
      await assert.rejects(
        withRetry(async () => {
          ++calls;
          throw axiosErrorWith(undefined);
        }, immediately),
        /boom/,
      );

      // One attempt, then one per delay.
      assert.strictEqual(calls, immediately.delaysMs.length + 1);
    });

    it("does not retry what will not come good", async () => {
      let calls = 0;
      await assert.rejects(
        withRetry(async () => {
          ++calls;
          throw axiosErrorWith(404);
        }, immediately),
        /boom/,
      );

      assert.strictEqual(calls, 1);
    });

    it("honours a caller's own idea of what is retryable", async () => {
      let calls = 0;
      const result = await withRetry(
        async () => {
          if (++calls < 2) {
            throw new Error("not axios, but retry me anyway");
          }
          return "ok";
        },
        { ...immediately, isRetryable: () => true },
      );

      assert.strictEqual(result, "ok");
      assert.strictEqual(calls, 2);
    });
  });
});
