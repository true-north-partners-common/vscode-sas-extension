// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { createHash } from "crypto";
import { readFile } from "fs/promises";

/**
 * Hash raw bytes, never a decoded string.
 *
 * Decoding as UTF-8 first maps every byte the decoder cannot represent to
 * U+FFFD, so two files differing only in such bytes would hash identically
 * and a real change would go undetected. Hashing the buffer also means the
 * digest describes exactly what gets uploaded.
 */
export const hashBytes = (content: Buffer): string =>
  createHash("sha256").update(content).digest("hex");

const isErrnoException = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error;

/**
 * Hash a file, or undefined if it vanished.
 *
 * A path can disappear between being listed and being read - git still
 * reports a tracked file deleted without `git rm`, and a rename can land
 * mid-sync. That is ordinary rather than exceptional, so it drops out of
 * the result instead of failing the run.
 */
export const hashFile = async (
  absPath: string,
): Promise<string | undefined> => {
  try {
    return hashBytes(await readFile(absPath));
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
};
