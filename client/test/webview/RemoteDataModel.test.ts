// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { expect } from "chai";

import RemoteDataModel, {
  BLOCK_SIZE,
  RowBlock,
} from "../../src/webview/RemoteDataModel";

const TOTAL_ROWS = 5000;

// A fetcher whose requests stay open until the test releases them
const controllableFetcher = () => {
  const requests: { start: number; release: () => void }[] = [];
  let active = 0;
  let maxActive = 0;
  const fetchRows = (start: number, end: number) =>
    new Promise<RowBlock>((resolve) => {
      active++;
      maxActive = Math.max(maxActive, active);
      requests.push({
        start,
        release: () => {
          active--;
          const rows = [];
          for (let i = start; i < Math.min(end, TOTAL_ROWS); i++) {
            rows.push({ "#": i + 1 });
          }
          resolve({ rows, count: TOTAL_ROWS });
        },
      });
    });
  return {
    fetchRows,
    requests,
    maxActive: () => maxActive,
    releaseAll: async () => {
      while (requests.some((request) => request.release)) {
        const pending = requests.filter((request) => request.release);
        pending.forEach((request) => {
          const release = request.release;
          request.release = undefined;
          release();
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    },
  };
};

describe("RemoteDataModel", () => {
  it("keeps at most two requests in flight", async () => {
    const fetcher = controllableFetcher();
    const model = new RemoteDataModel(fetcher.fetchRows, () => {});
    // Learn the row count first
    const first = model.ensureRange(0, 10);
    await fetcher.releaseAll();
    await first;

    const loading = model.ensureRange(0, 6 * BLOCK_SIZE - 1);
    expect(fetcher.requests.filter((r) => r.release).length).to.equal(2);
    await fetcher.releaseAll();
    await loading;

    expect(fetcher.maxActive()).to.equal(2);
    expect(model.isLoaded(6 * BLOCK_SIZE - 1)).to.equal(true);
  });

  it("skips queued blocks the grid has scrolled past", async () => {
    const fetcher = controllableFetcher();
    const model = new RemoteDataModel(fetcher.fetchRows, () => {});
    const first = model.ensureRange(0, 10);
    await fetcher.releaseAll();
    await first;
    fetcher.requests.length = 0;

    // Scroll through blocks 1-5, then jump to block 40 before any finish
    const scrolled = model.ensureRange(BLOCK_SIZE, 6 * BLOCK_SIZE - 1);
    const jumped = model.ensureRange(40 * BLOCK_SIZE, 40 * BLOCK_SIZE + 20);
    await fetcher.releaseAll();
    await Promise.all([scrolled, jumped]);

    const fetchedBlocks = fetcher.requests.map((r) => r.start / BLOCK_SIZE);
    // The two already in flight finish; the rest of the scroll is skipped
    expect(fetchedBlocks).to.deep.equal([1, 2, 40]);
    expect(model.isLoaded(40 * BLOCK_SIZE)).to.equal(true);
    expect(model.isLoaded(3 * BLOCK_SIZE)).to.equal(false);
  });
});
