// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import type { ProfileSyncOptions } from "../../profile";
import { resolveRemoteRoot } from "./expand";
import { DEFAULT_ROOT_MACRO_VAR, emitEnvironment } from "./generate";

/**
 * The root macro variable, as autoexec lines for the session request.
 *
 * The per-run wiring is submitted long after the session starts, by which time
 * the profile's autoexec has already been and gone. An autoexec that builds
 * paths out of the root macro variable therefore ran without it. Sending the
 * assignment with the session request puts it ahead of everything the autoexec
 * does, because the server runs the lines in the order they are given.
 *
 * Only the macro variable goes here. The autocall path is deliberately left to
 * the per-run wiring: those directories live under remoteRoot and do not exist
 * until a transfer has put them there, which cannot happen before the session
 * being transferred into.
 *
 * This is the value for the folder that was active when the session started,
 * which is all that can be known that early. syncWorkspace reassigns it on
 * every run, so a session that later serves a different workspace folder is
 * corrected before any code of the user's runs.
 */
export const syncAutoExecLines = (
  sync: ProfileSyncOptions["sync"],
  workspaceFolderBasename: string | undefined,
): string[] => {
  const rootMacroVar = sync?.rootMacroVar ?? DEFAULT_ROOT_MACRO_VAR;
  if (!sync?.remoteRoot || !rootMacroVar) {
    return [];
  }

  let remoteRoot: string;
  try {
    remoteRoot = resolveRemoteRoot(sync.remoteRoot, {
      workspaceFolderBasename,
    });
  } catch {
    // syncWorkspace reports an unresolvable root properly, naming the variable
    // that failed. Refusing to open a session over it would be a worse trade.
    return [];
  }

  return emitEnvironment({ remoteRoot, rootMacroVar })
    .split("\n")
    .filter((line) => line.trim() !== "");
};
