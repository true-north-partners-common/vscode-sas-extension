// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import type { CustomDataView } from "@slickgrid-universal/common";

export type Row = Record<string, unknown>;

export interface RowBlock {
  rows: Row[];
  // Total number of rows, when the server knows it
  count?: number;
}

export type FetchRows = (start: number, end: number) => Promise<RowBlock>;

export const BLOCK_SIZE = 100;
const MAX_CACHED_BLOCKS = 10;
// Each request reads the table in the user's SAS session, so scrolling fast
// shouldn't fire a burst of them (AG Grid also allowed 2 at a time).
const MAX_CONCURRENT_REQUESTS = 2;

interface QueuedBlock {
  block: number;
  generation: number;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

// Returned for rows that haven't loaded yet, so the grid renders empty cells
// instead of failing on a missing item.
const PENDING_ROW: Row = Object.freeze({});

/**
 * Lazily loads table rows from the extension host in fixed-size blocks.
 *
 * When the server doesn't report a total row count, the grid keeps growing by
 * a block each time a full block comes back, and stops at the first short
 * block (the end of the table).
 */
export default class RemoteDataModel implements CustomDataView<Row> {
  private blocks = new Map<number, Row[]>();
  private pending = new Map<number, Promise<void>>();
  private length = BLOCK_SIZE;
  private lengthIsFinal = false;
  // Bumped on reset, so responses for a previous sort/filter are dropped.
  private generation = 0;
  private queue: QueuedBlock[] = [];
  private activeRequests = 0;
  // The blocks the grid last asked for; queued blocks outside it are skipped.
  private wanted = { first: 0, last: 0 };

  constructor(
    private readonly fetchRows: FetchRows,
    private readonly onBlockLoaded: (
      fromRow: number,
      toRow: number,
      lengthChanged: boolean,
    ) => void,
  ) {}

  public getLength(): number {
    return this.length;
  }

  public getItem(index: number): Row {
    const block = this.blocks.get(Math.floor(index / BLOCK_SIZE));
    return block?.[index % BLOCK_SIZE] ?? PENDING_ROW;
  }

  public isLoaded(index: number): boolean {
    const block = this.blocks.get(Math.floor(index / BLOCK_SIZE));
    return !!block && index % BLOCK_SIZE < block.length;
  }

  public reset(): void {
    this.generation++;
    this.blocks.clear();
    this.pending.clear();
    // Queued blocks belong to the old sort/filter; settle them unfetched
    this.queue.splice(0).forEach(({ resolve }) => resolve());
    this.length = BLOCK_SIZE;
    this.lengthIsFinal = false;
  }

  /**
   * Loads every block overlapping [fromRow, toRow]. Blocks we've already loaded
   * are reused. Rejects if a request fails.
   */
  public async ensureRange(fromRow: number, toRow: number): Promise<void> {
    // The grid may ask for rows past the end of the table
    const lastRow = Math.min(toRow, this.length - 1);
    if (lastRow < 0) {
      return;
    }
    const first = Math.floor(Math.max(fromRow, 0) / BLOCK_SIZE);
    const last = Math.floor(lastRow / BLOCK_SIZE);
    this.wanted = { first, last };
    const loads: Promise<void>[] = [];
    for (let block = first; block <= last; block++) {
      loads.push(this.loadBlock(block));
    }
    await Promise.all(loads);
  }

  /**
   * Returns rows [fromRow, toRow] for one-off reads such as copying a large
   * selection. Cached blocks are reused, but blocks fetched here aren't cached,
   * so the rows on screen stay in the cache.
   */
  public async getRows(fromRow: number, toRow: number): Promise<Row[]> {
    const first = Math.floor(fromRow / BLOCK_SIZE);
    const last = Math.floor(toRow / BLOCK_SIZE);
    const rows: Row[] = [];
    for (let block = first; block <= last; block++) {
      const start = block * BLOCK_SIZE;
      const blockRows =
        this.blocks.get(block) ??
        (await this.fetchRows(start, start + BLOCK_SIZE)).rows;
      rows.push(
        ...blockRows.slice(
          Math.max(fromRow - start, 0),
          Math.min(toRow - start + 1, BLOCK_SIZE),
        ),
      );
    }
    return rows;
  }

  private loadBlock(block: number): Promise<void> {
    if (this.blocks.has(block)) {
      return Promise.resolve();
    }
    const inFlight = this.pending.get(block);
    if (inFlight) {
      return inFlight;
    }

    const generation = this.generation;
    const load = new Promise<void>((resolve, reject) =>
      this.queue.push({ block, generation, resolve, reject }),
    );
    this.pending.set(block, load);
    this.startQueuedRequests();
    return load;
  }

  private startQueuedRequests() {
    while (
      this.activeRequests < MAX_CONCURRENT_REQUESTS &&
      this.queue.length > 0
    ) {
      const { block, generation, resolve, reject } = this.queue.shift();
      const stale =
        generation !== this.generation ||
        block < this.wanted.first ||
        block > this.wanted.last;
      if (stale) {
        // Scrolled past before its turn; scrolling back asks for it again
        if (generation === this.generation) {
          this.pending.delete(block);
        }
        resolve();
        continue;
      }

      this.activeRequests++;
      this.fetchBlock(block, generation)
        .then(resolve, reject)
        .finally(() => {
          this.activeRequests--;
          this.startQueuedRequests();
        });
    }
  }

  private async fetchBlock(block: number, generation: number): Promise<void> {
    const start = block * BLOCK_SIZE;
    try {
      const { rows, count } = await this.fetchRows(start, start + BLOCK_SIZE);
      if (generation !== this.generation) {
        return;
      }
      this.blocks.set(block, rows);
      this.evictBlocks(block);
      const lengthChanged = this.updateLength(start, rows.length, count);
      this.onBlockLoaded(start, start + rows.length - 1, lengthChanged);
    } finally {
      if (generation === this.generation) {
        this.pending.delete(block);
      }
    }
  }

  private updateLength(
    start: number,
    rowCount: number,
    totalCount: number | undefined,
  ): boolean {
    const previous = this.length;
    // Adapters use -1 (or leave the count out) when they don't know it
    if (totalCount !== undefined && totalCount >= 0) {
      this.length = totalCount;
      this.lengthIsFinal = true;
    } else if (this.lengthIsFinal) {
      // We already know where the table ends
    } else if (rowCount < BLOCK_SIZE) {
      this.length = start + rowCount;
      this.lengthIsFinal = true;
    } else {
      this.length = Math.max(this.length, start + rowCount + BLOCK_SIZE);
    }
    return previous !== this.length;
  }

  // Keep the blocks closest to the one just loaded.
  private evictBlocks(current: number) {
    if (this.blocks.size <= MAX_CACHED_BLOCKS) {
      return;
    }
    const byDistance = [...this.blocks.keys()].sort(
      (a, b) => Math.abs(b - current) - Math.abs(a - current),
    );
    for (const block of byDistance.slice(
      0,
      this.blocks.size - MAX_CACHED_BLOCKS,
    )) {
      this.blocks.delete(block);
    }
  }
}
