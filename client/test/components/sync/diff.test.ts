// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "assert";

import {
  ancestorDirs,
  collapseToLeaves,
  computeDiff,
  deepestFirst,
  diffIsEmpty,
} from "../../../src/components/sync/core/diff";

describe("sync/diff", () => {
  describe("ancestorDirs", () => {
    it("returns every ancestor, shallowest first", () => {
      assert.deepStrictEqual(ancestorDirs("a/b/c/x.sas"), [
        "a",
        "a/b",
        "a/b/c",
      ]);
    });

    it("returns nothing for a file at the root", () => {
      assert.deepStrictEqual(ancestorDirs("x.sas"), []);
    });
  });

  describe("collapseToLeaves", () => {
    it("drops ancestors, since creating a directory creates its parents", () => {
      assert.deepStrictEqual(collapseToLeaves(["a", "a/b", "a/b/c"]), [
        "a/b/c",
      ]);
    });

    it("keeps siblings", () => {
      assert.deepStrictEqual(collapseToLeaves(["a/b", "a/c"]), ["a/b", "a/c"]);
    });

    it("does not treat a name prefix as an ancestor", () => {
      assert.deepStrictEqual(collapseToLeaves(["macros", "macrosolder"]), [
        "macros",
        "macrosolder",
      ]);
    });
  });

  describe("deepestFirst", () => {
    it("orders children before parents so removal succeeds", () => {
      assert.deepStrictEqual(deepestFirst(["a", "a/b/c", "a/b"]), [
        "a/b/c",
        "a/b",
        "a",
      ]);
    });
  });

  describe("computeDiff", () => {
    it("treats everything as new against an empty snapshot", () => {
      const diff = computeDiff({ "macros/a.sas": 100, "main.sas": 100 }, {});
      assert.deepStrictEqual(diff.put, ["macros/a.sas", "main.sas"]);
      assert.deepStrictEqual(diff.delete, []);
      assert.deepStrictEqual(diff.mkdir, ["macros"]);
    });

    it("is empty when nothing changed", () => {
      assert.ok(diffIsEmpty(computeDiff({ "a.sas": 100 }, { "a.sas": 100 })));
    });

    it("puts a file whose mtime advanced", () => {
      const diff = computeDiff({ "a.sas": 200 }, { "a.sas": 100 });
      assert.deepStrictEqual(diff.put, ["a.sas"]);
    });

    it("ignores a file whose mtime went backwards", () => {
      assert.ok(diffIsEmpty(computeDiff({ "a.sas": 50 }, { "a.sas": 100 })));
    });

    it("deletes a file that disappeared", () => {
      const diff = computeDiff(
        { "a.sas": 100 },
        { "a.sas": 100, "b.sas": 100 },
      );
      assert.deepStrictEqual(diff.delete, ["b.sas"]);
      assert.deepStrictEqual(diff.put, []);
    });

    // The bug worth not reproducing: SASjs leaves both names on the server
    // forever, because its diff only ever adds.
    it("removes the old path on a rename", () => {
      const diff = computeDiff(
        { "macros/new.sas": 100 },
        { "macros/old.sas": 100 },
      );
      assert.deepStrictEqual(diff.put, ["macros/new.sas"]);
      assert.deepStrictEqual(diff.delete, ["macros/old.sas"]);
    });

    it("removes directories that no longer hold files", () => {
      const diff = computeDiff(
        { "keep/a.sas": 100 },
        { "keep/a.sas": 100, "gone/deep/b.sas": 100 },
      );
      assert.deepStrictEqual(diff.rmdir, ["gone/deep", "gone"]);
    });

    it("does not report directory churn alone as work", () => {
      assert.ok(
        diffIsEmpty(computeDiff({ "a/x.sas": 100 }, { "a/x.sas": 100 })),
      );
    });
  });
});
