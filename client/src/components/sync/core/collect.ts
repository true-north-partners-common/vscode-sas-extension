// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { readFile, stat } from "fs/promises";
import { join } from "path";

import { FileEntry } from "./snapshot";

/**
 * Stat every discovered path, dropping anything unreadable.
 *
 * `git ls-files --cached` reports files that are still tracked but no longer
 * on disk (deleted without `git rm`), so a missing file here is expected
 * rather than exceptional - it simply falls out of the snapshot and the diff
 * then treats it as a deletion.
 */
export const collectEntries = async (
  rootAbs: string,
  relPaths: string[],
): Promise<FileEntry[]> => {
  const entries = await Promise.all(
    relPaths.map(async (relPath) => {
      try {
        const stats = await stat(join(rootAbs, relPath));
        return stats.isFile()
          ? { relPath, mtimeMs: Math.floor(stats.mtimeMs) }
          : undefined;
      } catch {
        return undefined;
      }
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

