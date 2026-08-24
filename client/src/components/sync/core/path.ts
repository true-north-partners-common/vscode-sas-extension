// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The compute files API carries a whole path as a single URI segment, so
 * every separator has to be escaped into it rather than left as a delimiter.
 */
const ESCAPES: ReadonlyArray<readonly [RegExp, string]> = [
  // Must come first: the tilde is the escape character, so escaping it
  // after the others would also rewrite the tildes they just introduced.
  [/~/g, "~~"],
  [/\//g, "~fs~"],
  [/\\/g, "~rs~"],
  [/;/g, "~sc~"],
];

/**
 * Encode an absolute POSIX path for a compute files API path parameter.
 *
 * Callers still need to URI-encode the result; this handles only the
 * API's own escaping scheme, which is orthogonal to percent-encoding.
 */
export const toComputePath = (absolutePosixPath: string): string =>
  ESCAPES.reduce(
    (encoded, [pattern, replacement]) => encoded.replace(pattern, replacement),
    absolutePosixPath,
  );
