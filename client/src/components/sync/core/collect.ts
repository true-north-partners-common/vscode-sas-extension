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

/** Read the files a diff is about to send. */
export const readContents = async (
  rootAbs: string,
  relPaths: string[],
): Promise<Map<string, Buffer>> => {
  const pairs = await Promise.all(
    relPaths.map(async (relPath): Promise<[string, Buffer]> => [
      relPath,
      await readFile(join(rootAbs, relPath)),
    ]),
  );
  return new Map(pairs);
};
