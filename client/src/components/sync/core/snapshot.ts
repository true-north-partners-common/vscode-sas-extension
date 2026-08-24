// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A record of what was last pushed to a given remote root.
 *
 * This is a local cache, not a record of the server's contents - the remote
 * manifest owns that. Its only job is to let a run skip re-reading files
 * whose (mtime, size) are unchanged, so losing it costs a re-hash of the
 * tree rather than a re-upload.
 */
export interface Snapshot {
  schemaVersion: number;
  /** Absolute POSIX path on the SAS server. */
  remoteRoot: string;
  /** Workspace-relative POSIX path -> the stat fields we compare on. */
  files: FileStamps;
}

/**
 * What we knew about a file at the last successful sync.
 *
 * mtime and size are the cheap gate: when both match, the content is
 * assumed unchanged and the file is not re-read. When either differs the
 * file is re-hashed, and only a differing hash causes a transfer - so a
 * `git checkout` or a `touch`, which rewrites timestamps without changing
 * content, costs one local read instead of a full upload.
 */
export interface FileStamp {
  mtimeMs: number;
  size: number;
  /** sha256 of the bytes, as last hashed. */
  hash: string;
}

/** The payload a diff actually operates on. */
export type FileStamps = Record<string, FileStamp>;

/**
 * Version 3 added the content hash, making the snapshot a cache of local
 * work rather than a record of what the server holds - the remote manifest
 * owns that now. An older snapshot is discarded rather than migrated; the
 * cost is re-hashing the tree once, not re-uploading it, because the remote
 * manifest still says what is already there.
 */
export const SNAPSHOT_SCHEMA_VERSION = 3;

export const emptySnapshot = (remoteRoot: string): Snapshot => ({
  schemaVersion: SNAPSHOT_SCHEMA_VERSION,
  remoteRoot,
  files: {},
});

export interface FileEntry {
  /** Workspace-relative path, POSIX separators. */
  relPath: string;
  mtimeMs: number;
  size: number;
  hash: string;
}

/**
 * Paths are normalised to POSIX separators so that a Windows checkout
 * produces the same keys as a macOS or Linux one. Without this the snapshot
 * never matches and every run re-uploads the whole tree.
 */
export const toPosix = (relPath: string): string => relPath.replace(/\\/g, "/");

export const buildSnapshot = (
  remoteRoot: string,
  entries: FileEntry[],
): Snapshot => {
  const snapshot = emptySnapshot(remoteRoot);
  for (const entry of entries) {
    snapshot.files[toPosix(entry.relPath)] = {
      mtimeMs: entry.mtimeMs,
      size: entry.size,
      hash: entry.hash,
    };
  }
  return snapshot;
};

/**
 * A snapshot is only meaningful for the remote root it was taken against,
 * and only for the schema that wrote it. Anything else is discarded rather
 * than misread - the cost is one full re-push, which is always safe.
 */
export const loadSnapshot = (stored: unknown, remoteRoot: string): Snapshot =>
  isSnapshot(stored) &&
  stored.schemaVersion === SNAPSHOT_SCHEMA_VERSION &&
  stored.remoteRoot === remoteRoot
    ? stored
    : emptySnapshot(remoteRoot);

const isFileStamp = (value: unknown): value is FileStamp =>
  typeof value === "object" &&
  value !== null &&
  "mtimeMs" in value &&
  "size" in value &&
  "hash" in value &&
  typeof value.mtimeMs === "number" &&
  typeof value.size === "number" &&
  typeof value.hash === "string";

const isFileStamps = (value: unknown): value is FileStamps =>
  typeof value === "object" &&
  value !== null &&
  Object.values(value).every(isFileStamp);

const isSnapshot = (value: unknown): value is Snapshot => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (
    !("schemaVersion" in value) ||
    !("remoteRoot" in value) ||
    !("files" in value)
  ) {
    return false;
  }
  const { schemaVersion, remoteRoot, files } = value;
  return (
    typeof schemaVersion === "number" &&
    typeof remoteRoot === "string" &&
    isFileStamps(files)
  );
};
