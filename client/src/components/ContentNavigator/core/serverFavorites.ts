// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export const SERVER_FAVORITES_SCHEMA_VERSION = 1;

/**
 * The SAS Server pane's favorites, kept on this side of the wire.
 *
 * SAS Content favorites are folder members the server holds for us, but the
 * folders service persists only URIs owned by another persistence service, and
 * a path on the compute file system is owned by nothing: its only address is
 * /compute/sessions/<id>/files/..., which dies with the session. So we store
 * plain paths and re-resolve them against whichever session is current - which
 * is also why nothing here records a session id.
 *
 * Scoped to the connection profile, since two deployments rarely share a file
 * system. The profile is stored alongside the paths as well as being part of
 * the key, so a renamed or repointed profile falls back to empty rather than
 * inheriting somebody else's directories.
 */
export interface ServerFavorites {
  schemaVersion: number;
  profile: string;
  paths: string[];
}

export const emptyFavorites = (profile: string): ServerFavorites => ({
  schemaVersion: SERVER_FAVORITES_SCHEMA_VERSION,
  profile,
  paths: [],
});

const isString = (value: unknown): value is string => typeof value === "string";

const dedupe = (paths: string[]): string[] => [...new Set(paths)];

/**
 * Rebuild favorites from whatever was persisted, discarding anything that
 * doesn't match the current schema and profile. Losing favorites costs the user
 * a few right-clicks, so every doubtful case resolves to empty.
 */
export const loadFavorites = (
  stored: unknown,
  profile: string,
): ServerFavorites => {
  if (
    !stored ||
    typeof stored !== "object" ||
    !("schemaVersion" in stored) ||
    stored.schemaVersion !== SERVER_FAVORITES_SCHEMA_VERSION ||
    !("profile" in stored) ||
    stored.profile !== profile ||
    !("paths" in stored) ||
    !Array.isArray(stored.paths)
  ) {
    return emptyFavorites(profile);
  }

  return {
    ...emptyFavorites(profile),
    paths: dedupe(stored.paths.filter(isString)),
  };
};
