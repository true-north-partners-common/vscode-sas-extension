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
    const start = block * BLOCK_SIZE;
    const load = this.fetchRows(start, start + BLOCK_SIZE)
      .then(({ rows, count }) => {
        if (generation !== this.generation) {
          return;
        }
        this.blocks.set(block, rows);
        this.evictBlocks(block);
        const lengthChanged = this.updateLength(start, rows.length, count);
        this.onBlockLoaded(start, start + rows.length - 1, lengthChanged);
      })
      .finally(() => {
        if (generation === this.generation) {
          this.pending.delete(block);
        }
      });
    this.pending.set(block, load);
    return load;
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
