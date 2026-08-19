// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { posix } from "path";

import { Diff } from "./diff";

/**
 * Characters of base64 per PUT statement. Matches the SASjs CLI, which has
 * been round-tripping files this way in production for years.
 */
export const CHUNK_SIZE = 220;

/**
 * File contents travel as base64 rather than raw source. This removes the
 * escaping problem entirely - base64 contains no quotes, no ampersands, no
 * percent signs and no semicolons, so there is no text/binary distinction
 * and no encoding negotiation to get wrong.
 *
 * Empty input yields no chunks, which the emitter relies on: a file with no
 * records decodes to a zero-byte file without needing a special case.
 */
export const chunkBase64 = (encoded: string): string[] => {
  const chunks: string[] = [];
  for (let i = 0; i < encoded.length; i += CHUNK_SIZE) {
    chunks.push(encoded.slice(i, i + CHUNK_SIZE));
  }
  return chunks;
};

/**
 * Every path reaching SAS goes through here, as a quoted literal inside a
 * DATA step. Nothing in this module interpolates a path into macro-language
 * text, so the macro processor never rescans a filename containing an
 * ampersand or a percent sign.
 */
const sasPath = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/**
 * Write one file: stage the base64 in a temporary fileref, then decode it
 * four characters at a time into three bytes.
 *
 * Chunks need no escaping - the base64 alphabet cannot contain a quote.
 */
export const emitFileWrite = (absPath: string, data: Buffer): string => {
  const puts = chunkBase64(data.toString("base64"))
    .map((chunk, i, all) => `  put '${chunk}'${i < all.length - 1 ? "@" : ""};`)
    .join("\n");

  return `
filename _in64 temp lrecl=99999999;
data _null_;
  file _in64;
${puts}
run;

filename _out64 ${sasPath(absPath)};

data _null_;
  length filein 8 fileout 8;
  filein  = fopen("_in64", 'I', 4, 'B');
  fileout = fopen("_out64", 'O', 3, 'B');
  char = '20'x;
  do while(fread(filein) = 0);
    length raw $4;
    do i = 1 to 4;
      rc = fget(filein, char, 1);
      substr(raw, i, 1) = char;
    end;
    rc = fput(fileout, input(raw, $base64X4.));
    rc = fwrite(fileout);
  end;
  rc = fclose(filein);
  rc = fclose(fileout);
run;

filename _in64 clear;
filename _out64 clear;
`;
};

/**
 * Create directories, including intermediate levels, without XCMD.
 *
 * Walks each absolute path from the root calling DCREATE for any level that
 * does not yet exist. Paths must be absolute POSIX. Emits nothing for an
 * empty list.
 */
export const emitMkdirs = (absPaths: string[]): string => {
  if (absPaths.length === 0) {
    return "";
  }
  return `
data _null_;
  length full $2048 part $256 parent $2048 acc $2048 dname $2048;
  do full = ${absPaths.map(sasPath).join(", ")};
    acc = '';
    do i = 1 to countw(full, '/');
      part = scan(full, i, '/');
      if acc = '' then parent = '/';
      else parent = acc;
      acc = cats(acc, '/', part);
      if fileexist(acc) = 0 then do;
        dname = dcreate(part, parent);
        if dname = '' then put 'ERROR: sas-sync could not create ' acc=;
      end;
    end;
  end;
run;
`;
};

export const emitDelete = (absPath: string): string => `
data _null_;
  rc = filename('_del', ${sasPath(absPath)});
  if rc = 0 and fexist('_del') then rc = fdelete('_del');
  rc = filename('_del');
run;
`;

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

/**
 * Apply a diff: create directories, write files, remove what is gone.
 *
 * One submission carries the entire batch, which for a first push is
 * dramatically faster than one HTTP round trip per file. Self-contained - no
 * external macro library is required.
 */
export const emitTransfer = (
  diff: Diff,
  remoteRoot: string,
  contents: Map<string, Buffer>,
): string => {
  const parts: string[] = ["options nobomfile;"];

  // The root itself plus every new leaf directory. Intermediate levels are
  // created implicitly, which is why the diff collapses them out.
  parts.push(
    emitMkdirs([
      remoteRoot,
      ...diff.mkdir.map((dir) => posix.join(remoteRoot, dir)),
    ]),
  );

  for (const relPath of diff.put) {
    const data = contents.get(relPath);
    if (data === undefined) {
      throw new Error(`No content supplied for ${relPath}`);
    }
    parts.push(emitFileWrite(posix.join(remoteRoot, relPath), data));
  }

  for (const relPath of [...diff.delete, ...diff.rmdir]) {
    parts.push(emitDelete(posix.join(remoteRoot, relPath)));
  }

  return parts.join("\n");
};
