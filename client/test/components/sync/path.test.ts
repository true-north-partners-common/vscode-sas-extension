// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "assert";

import { toComputePath } from "../../../src/components/sync/core/path";

describe("sync/path", () => {
  describe("toComputePath", () => {
    it("escapes every separator in an ordinary path", () => {
      assert.strictEqual(
        toComputePath("/mnt/repo/macros/a.sas"),
        "~fs~mnt~fs~repo~fs~macros~fs~a.sas",
      );
    });

    it("leaves a bare filename alone", () => {
      assert.strictEqual(toComputePath("a.sas"), "a.sas");
    });

    // The API's scheme covers four characters, not one. A file named
    // read~me.sas or a;b.sas is legal in git and would otherwise be written
    // to the wrong remote path.
    it("escapes a tilde in a filename", () => {
      assert.strictEqual(
        toComputePath("/repo/read~me.sas"),
        "~fs~repo~fs~read~~me.sas",
      );
    });

    it("escapes a semicolon in a filename", () => {
      assert.strictEqual(
        toComputePath("/repo/a;b.sas"),
        "~fs~repo~fs~a~sc~b.sas",
      );
    });

    it("escapes a backslash in a filename", () => {
      assert.strictEqual(
        toComputePath("/repo/a\\b.sas"),
        "~fs~repo~fs~a~rs~b.sas",
      );
    });

    // The tilde is the escape character, so escaping it last would rewrite
    // the tildes the other rules had just introduced - turning every "~fs~"
    // into "~~fs~~" and corrupting the whole path.
    it("does not double-escape the tildes it introduces", () => {
      assert.strictEqual(toComputePath("/a/b"), "~fs~a~fs~b");
      assert.ok(!toComputePath("/a/b").includes("~~"));
    });

    it("distinguishes a literal tilde from a separator", () => {
      assert.notStrictEqual(toComputePath("~fs~"), toComputePath("/"));
    });
  });
});
