// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Stats } from "fs";
import { readFile, stat } from "fs/promises";
import { join } from "path";

import { hashFile } from "./hash";
import { FileEntry, FileStamps, toPosix } from "./snapshot";

/**
 * Stat every discovered path and attach its content hash, dropping anything
 * unreadable.
 *
 * `git ls-files --cached` reports files that are still tracked but no longer
 * on disk (deleted without `git rm`), so a missing file here is expected
 * rather than exceptional - it simply falls out of the snapshot and the diff
 * then treats it as a deletion.
 *
 * `known` is the previous snapshot's stamps. When a path's mtime and size
 * both match, its hash is taken from there rather than re-read: that is what
 * keeps a steady-state run from reading the whole tree off disk. Anything
 * else is hashed, so a file whose timestamp lies in either direction is
 * still compared on its actual bytes.
 */
export const collectEntries = async (
  rootAbs: string,
  relPaths: string[],
  known: FileStamps = {},
): Promise<FileEntry[]> => {
  const entries = await Promise.all(
    relPaths.map(async (relPath) => {
      let stats: Stats;
      try {
        stats = await stat(join(rootAbs, relPath));
      } catch {
        return undefined;
      }
      if (!stats.isFile()) {
        return undefined;
      }

      const mtimeMs = Math.floor(stats.mtimeMs);
      const size = stats.size;
      const cached = known[toPosix(relPath)];
      if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
        return { relPath, mtimeMs, size, hash: cached.hash };
      }

      const hash = await hashFile(join(rootAbs, relPath));
      return hash === undefined ? undefined : { relPath, mtimeMs, size, hash };
    }),
  );

  return entries.filter((entry): entry is FileEntry => entry !== undefined);
};

const isErrnoException = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error;

/**
 * Read the files a diff is about to send.
 *
 * A path can vanish between the stat that put it in the diff and this read
 * (deleted, or a rename mid-sync) - dropped from the map rather than
 * thrown, since applyDiffWithApi already skips a put with no content, and
 * the next run's stat will pick it up as a delete instead.
 */
export const readContents = async (
  rootAbs: string,
  relPaths: string[],
): Promise<Map<string, Buffer>> => {
  const pairs = await Promise.all(
    relPaths.map(async (relPath): Promise<[string, Buffer] | undefined> => {
      try {
        return [relPath, await readFile(join(rootAbs, relPath))];
      } catch (error) {
        if (isErrnoException(error) && error.code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
    }),
  );
  return new Map(
    pairs.filter((pair): pair is [string, Buffer] => pair !== undefined),
  );
};
