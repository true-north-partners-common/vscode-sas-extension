// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "assert";

import { errorsIn } from "../../../src/components/sync/core/log";
import type { LogLine } from "../../../src/connection";

const line = (type: string, text: string): LogLine =>
  ({ type, line: text }) as LogLine;

describe("sync/log", () => {
  describe("errorsIn", () => {
    it("finds nothing in a clean log", () => {
      assert.deepStrictEqual(
        errorsIn([
          line("normal", "NOTE: DATA statement used"),
          line("note", ""),
        ]),
        [],
      );
    });

    // Compute strips the prefix from a line it classified, so the type is all
    // that is left to go on.
    it("takes a classified error even without a prefix", () => {
      assert.deepStrictEqual(
        errorsIn([
          line("error", "Insufficient authorization to access /sasv."),
        ]),
        ["Insufficient authorization to access /sasv."],
      );
    });

    // A PUT from the generated program arrives unclassified and carries its
    // own prefix instead.
    it("takes an unclassified line that prefixes itself", () => {
      assert.deepStrictEqual(
        errorsIn([
          line(
            "normal",
            "ERROR: sas-sync could not open for writing: /r/x.sas",
          ),
        ]),
        ["ERROR: sas-sync could not open for writing: /r/x.sas"],
      );
    });

    it("takes the ERROR- continuation carrying the system message", () => {
      assert.strictEqual(
        errorsIn([line("normal", "ERROR- Access denied.")]).length,
        1,
      );
    });

    // The transfer contains a PUT of an ERROR literal. Echoing that statement
    // must not read as the failure it exists to report.
    it("ignores the source echo of the statement that reports a failure", () => {
      assert.deepStrictEqual(
        errorsIn([
          line(
            "source",
            "  put 'ERROR: sas-sync could not open for writing: ' '/r/x.sas';",
          ),
        ]),
        [],
      );
    });

    it("does not mistake a word starting with ERROR for a prefix", () => {
      assert.deepStrictEqual(
        errorsIn([line("normal", "ERRORS were counted")]),
        [],
      );
    });

    it("keeps every error, in the order SAS produced them", () => {
      assert.deepStrictEqual(
        errorsIn([
          line("normal", "ERROR: first"),
          line("normal", "NOTE: between"),
          line("error", "second"),
        ]),
        ["ERROR: first", "second"],
      );
    });
  });
});
