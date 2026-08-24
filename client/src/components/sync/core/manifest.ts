// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * What the server holds, as last written by a sync.
 *
 * This is an inventory, not a checksum. A single tree-wide hash can tell you
 * the remote drifted but cannot say which path drifted, cannot drive a
 * delete, and is blind to files it never wrote - so a "repair" computed from
 * it re-uploads everything and still leaves the tree wrong. Every mature
 * synchroniser keeps a per-path map for exactly this reason, and one GET
 * costs the same either way.
 *
 * Keeping it on the server rather than only in local state is what lets a
 * fresh clone, a second machine, or a cleared workspace store still work out
 * what to delete.
 */
export interface RemoteFile {
  /** sha256 of the bytes as uploaded. */
  hash: string;
  /** ETag from the write, so the next write can be conditional. */
  etag?: string;
}

export type RemoteManifest = Record<string, RemoteFile>;

export const MANIFEST_SCHEMA_VERSION = 2;

interface ManifestDocument {
  version: number;
  files: RemoteManifest;
}

export const serializeManifest = (files: RemoteManifest): string =>
  JSON.stringify(
    {
      version: MANIFEST_SCHEMA_VERSION,
      // Sorted so a diff of two manifests is readable and byte-stable.
      files: Object.fromEntries(
        Object.entries(files).sort(([a], [b]) => a.localeCompare(b)),
      ),
    },
    undefined,
    2,
  );

const isRemoteFile = (value: unknown): value is RemoteFile =>
  typeof value === "object" &&
  value !== null &&
  "hash" in value &&
  typeof value.hash === "string" &&
  (!("etag" in value) ||
    value.etag === undefined ||
    typeof value.etag === "string");

const isManifestDocument = (value: unknown): value is ManifestDocument => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("version" in value) || !("files" in value)) {
    return false;
  }
  const { version, files } = value;
  return (
    typeof version === "number" &&
    typeof files === "object" &&
    files !== null &&
    Object.values(files).every(isRemoteFile)
  );
};

/**
 * Parse a manifest, or undefined when it cannot be trusted.
 *
 * Undefined is a meaningful answer: it means the remote inventory is unknown,
 * which callers must treat as "re-push everything" rather than "the remote is
 * empty". The difference matters, because the latter reading would also
 * conclude that every tracked path should be deleted.
 *
 * Version 1 was a bare sha256 line covering the whole tree, which carries no
 * per-path information, so it reads as unknown rather than being migrated.
 */
export const parseManifest = (raw: string): RemoteManifest | undefined => {
  const text = raw.trim();
  if (!text) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }

  if (!isManifestDocument(parsed)) {
    return undefined;
  }
  if (parsed.version !== MANIFEST_SCHEMA_VERSION) {
    return undefined;
  }
  return parsed.files;
};

/** The path -> hash view a diff compares against. */
export const manifestContents = (
  manifest: RemoteManifest,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(manifest).map(([relPath, file]) => [relPath, file.hash]),
  );
