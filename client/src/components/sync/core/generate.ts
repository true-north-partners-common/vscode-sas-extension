// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { posix } from "path";

/**
 * Every path reaching SAS goes through here, as a quoted literal inside a
 * DATA step. Nothing in this module interpolates a path into macro-language
 * text, so the macro processor never rescans a filename containing an
 * ampersand or a percent sign.
 */
const sasPath = (value: string): string => `'${value.replace(/'/g, "''")}'`;

export interface EnvironmentOptions {
  remoteRoot: string;
  /** Directories, relative to remoteRoot, to add to the autocall path. */
  sasautos?: string[];
  /** Macro variable set to remoteRoot, e.g. "REPO". */
  rootMacroVar?: string;
}

/**
 * Session wiring: the root macro variable and the autocall path.
 *
 * Separate from the transfer because it has a different trigger condition -
 * the wiring must exist on every run, whereas the transfer only happens when
 * something changed.
 *
 * The macro variable is set with CALL SYMPUTX rather than %LET so that the
 * path stays a quoted literal, consistent with every other path in this
 * module.
 */
export const emitEnvironment = (options: EnvironmentOptions): string => {
  const { remoteRoot, sasautos = [], rootMacroVar } = options;
  const parts: string[] = [];

  if (rootMacroVar) {
    parts.push(`
data _null_;
  call symputx('${rootMacroVar}', ${sasPath(remoteRoot)}, 'G');
run;
`);
  }

  if (sasautos.length > 0) {
    const paths = sasautos
      .map((dir) => sasPath(posix.join(remoteRoot, dir)))
      .join(" ");
    parts.push(`options insert=(sasautos=(${paths}));`);
    // A macro compiled earlier in the session otherwise wins over the file
    // we just updated.
    parts.push("options mrecall mcompilenote=all;");
  }

  return parts.join("\n");
};
