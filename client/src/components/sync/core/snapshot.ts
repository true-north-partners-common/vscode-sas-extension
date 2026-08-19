// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A record of what was last pushed to a given remote root.
 *
 * Tracks modification times only - no content hashing. This mirrors the
 * approach taken by the Databricks CLI (libs/sync), which has shipped this
 * way for years. Hashing can be layered on later if spurious re-uploads
 * turn out to be a real problem.
 */
export interface Snapshot {
  schemaVersion: number;
  /** Absolute POSIX path on the SAS server. */
  remoteRoot: string;
  /** Workspace-relative POSIX path -> mtime in milliseconds. */
  lastModified: FileTimes;
}

/** The payload a diff actually operates on. */
export type FileTimes = Record<string, number>;

export const SNAPSHOT_SCHEMA_VERSION = 1;

export const emptySnapshot = (remoteRoot: string): Snapshot => ({
  schemaVersion: SNAPSHOT_SCHEMA_VERSION,
  remoteRoot,
  lastModified: {},
});

export interface FileEntry {
  /** Workspace-relative path, POSIX separators. */
  relPath: string;
  mtimeMs: number;
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
    snapshot.lastModified[toPosix(entry.relPath)] = entry.mtimeMs;
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

const isSnapshot = (value: unknown): value is Snapshot => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (
    !("schemaVersion" in value) ||
    !("remoteRoot" in value) ||
    !("lastModified" in value)
  ) {
    return false;
  }
  const { schemaVersion, remoteRoot, lastModified } = value;
  return (
    typeof schemaVersion === "number" &&
    typeof remoteRoot === "string" &&
    typeof lastModified === "object" &&
    lastModified !== null
  );
};
