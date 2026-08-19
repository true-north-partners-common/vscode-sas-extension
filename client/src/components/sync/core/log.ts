// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import type { LogLine } from "../../../connection";

/**
 * A submission is only as good as its log. RunResult carries no status, so a
 * transfer that could not write a file resolves exactly like one that wrote
 * every byte, and the only evidence is in the lines that came back.
 *
 * Two shapes count. Compute classifies a line it recognises as an error and
 * strips the prefix from the text, so the type is the signal; a line written
 * by a PUT in the generated program arrives unclassified and carries its own
 * ERROR prefix instead.
 *
 * Source echo is excluded because the transfer contains a PUT of an ERROR
 * literal - the statement that reports a failed write - and an echo of that
 * statement is indistinguishable by text from the failure it describes.
 */
const isError = (log: LogLine): boolean => {
  if (log.type === "source") {
    return false;
  }
  return log.type === "error" || /^\s*ERROR[:\- ]/.test(log.line ?? "");
};

/**
 * The error lines of a submission, in the order SAS produced them, trimmed
 * for display. Empty when the submission was clean.
 */
export const errorsIn = (logs: LogLine[]): string[] =>
  logs.filter(isError).map((log) => log.line.trim());
