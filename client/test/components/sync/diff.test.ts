// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "assert";

import {
  ancestorDirs,
  collapseToLeaves,
  computeDiff,
  deepestFirst,
  diffIsEmpty,
  isSuspiciousDelete,
  reconcileWithRemote,
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
    /** A stand-in digest, so tests read as "same content" / "different". */
    const h = (marker: string): string => `sha256-${marker}`;

    it("treats everything as new against an empty inventory", () => {
      const diff = computeDiff(
        { "macros/a.sas": h("a"), "main.sas": h("m") },
        {},
      );
      assert.deepStrictEqual(diff.put, ["macros/a.sas", "main.sas"]);
      assert.deepStrictEqual(diff.delete, []);
      assert.deepStrictEqual(diff.move, []);
      assert.deepStrictEqual(diff.mkdir, ["macros"]);
    });

    it("is empty when content is unchanged", () => {
      assert.ok(
        diffIsEmpty(computeDiff({ "a.sas": h("a") }, { "a.sas": h("a") })),
      );
    });

    it("puts a file whose content changed", () => {
      const diff = computeDiff({ "a.sas": h("new") }, { "a.sas": h("old") });
      assert.deepStrictEqual(diff.put, ["a.sas"]);
    });

    // The whole point of comparing content: a checkout or a touch rewrites
    // timestamps without changing bytes, and re-uploading then is pure waste.
    it("does not put a file whose content is identical", () => {
      const diff = computeDiff({ "a.sas": h("a") }, { "a.sas": h("a") });
      assert.deepStrictEqual(diff.put, []);
    });

    it("deletes a file that disappeared", () => {
      const diff = computeDiff(
        { "a.sas": h("a") },
        { "a.sas": h("a"), "b.sas": h("b") },
      );
      assert.deepStrictEqual(diff.delete, ["b.sas"]);
      assert.deepStrictEqual(diff.put, []);
    });

    // A rename is bytes the server already holds. Uploading them again and
    // deleting the old path is five requests and a full body; a move is one
    // request and none.
    it("pairs a rename into a move rather than a put and a delete", () => {
      const diff = computeDiff(
        { "macros/new.sas": h("same") },
        { "macros/old.sas": h("same") },
      );
      assert.deepStrictEqual(diff.move, [
        { from: "macros/old.sas", to: "macros/new.sas" },
      ]);
      assert.deepStrictEqual(diff.put, []);
      assert.deepStrictEqual(diff.delete, []);
    });

    it("counts a move as work", () => {
      assert.ok(
        !diffIsEmpty(
          computeDiff({ "new.sas": h("same") }, { "old.sas": h("same") }),
        ),
      );
    });

    it("moves a file across directories", () => {
      const diff = computeDiff(
        { "b/x.sas": h("same") },
        { "a/x.sas": h("same") },
      );
      assert.deepStrictEqual(diff.move, [{ from: "a/x.sas", to: "b/x.sas" }]);
      assert.deepStrictEqual(diff.mkdir, ["b"]);
      assert.deepStrictEqual(diff.rmdir, ["a"]);
    });

    // With two identical files there is no way to know which removal pairs
    // with which addition, and a wrong guess is a wrong move. Falling back
    // to upload-and-delete is slower but always right.
    it("refuses to pair renames when the content is ambiguous", () => {
      const diff = computeDiff(
        { "new1.sas": h("same"), "new2.sas": h("same") },
        { "old1.sas": h("same"), "old2.sas": h("same") },
      );
      assert.deepStrictEqual(diff.move, []);
      assert.deepStrictEqual(diff.put, ["new1.sas", "new2.sas"]);
      assert.deepStrictEqual(diff.delete, ["old1.sas", "old2.sas"]);
    });

    it("still puts an edited file that shares no content with a deletion", () => {
      const diff = computeDiff(
        { "a.sas": h("edited") },
        { "a.sas": h("original"), "gone.sas": h("other") },
      );
      assert.deepStrictEqual(diff.put, ["a.sas"]);
      assert.deepStrictEqual(diff.delete, ["gone.sas"]);
      assert.deepStrictEqual(diff.move, []);
    });

    it("removes directories that no longer hold files", () => {
      const diff = computeDiff(
        { "keep/a.sas": h("a") },
        { "keep/a.sas": h("a"), "gone/deep/b.sas": h("b") },
      );
      assert.deepStrictEqual(diff.rmdir, ["gone/deep", "gone"]);
    });

    it("does not report directory churn alone as work", () => {
      assert.ok(
        diffIsEmpty(computeDiff({ "a/x.sas": h("a") }, { "a/x.sas": h("a") })),
      );
    });
  });

  describe("reconcileWithRemote", () => {
    const h = (marker: string): string => `sha256-${marker}`;
    const managed = (relPath: string): boolean => relPath.endsWith(".sas");
    const empty = {
      put: [],
      delete: [],
      move: [],
      mkdir: [],
      rmdir: [],
    };

    // The gap this closes: the manifest records what we wrote, so a file
    // removed on the server out of band still looks like a match and would
    // never be restored. In a one-way mirror the local tree wins.
    it("re-sends a file that is missing from the server", () => {
      const result = reconcileWithRemote(
        empty,
        { "a.sas": h("a"), "b.sas": h("b") },
        new Set(["a.sas"]),
        managed,
      );

      assert.deepStrictEqual(result.put, ["b.sas"]);
      assert.deepStrictEqual(result.delete, []);
    });

    it("leaves a matching file alone", () => {
      const result = reconcileWithRemote(
        empty,
        { "a.sas": h("a") },
        new Set(["a.sas"]),
        managed,
      );

      assert.deepStrictEqual(result.put, []);
    });

    it("removes a managed file the local tree no longer has", () => {
      const result = reconcileWithRemote(
        empty,
        { "a.sas": h("a") },
        new Set(["a.sas", "orphan.sas"]),
        managed,
      );

      assert.deepStrictEqual(result.delete, ["orphan.sas"]);
    });

    // A remote root can hold logs, output, or data nobody synced. Deleting
    // those because they are "not local" destroys work rather than mirroring.
    it("leaves unmanaged files on the server alone", () => {
      const result = reconcileWithRemote(
        empty,
        { "a.sas": h("a") },
        new Set(["a.sas", "output.lst", "data.sas7bdat"]),
        managed,
      );

      assert.deepStrictEqual(result.delete, []);
    });

    // A move needs its source to still be there. Uploading the destination
    // is what the diff would have said had it known.
    it("turns a move into a put when the source is gone", () => {
      const result = reconcileWithRemote(
        { ...empty, move: [{ from: "old.sas", to: "new.sas" }] },
        { "new.sas": h("same") },
        new Set([]),
        managed,
      );

      assert.deepStrictEqual(result.move, []);
      assert.deepStrictEqual(result.put, ["new.sas"]);
    });

    it("keeps a move whose source is still there", () => {
      const result = reconcileWithRemote(
        { ...empty, move: [{ from: "old.sas", to: "new.sas" }] },
        { "new.sas": h("same") },
        new Set(["old.sas"]),
        managed,
      );

      assert.deepStrictEqual(result.move, [{ from: "old.sas", to: "new.sas" }]);
      assert.deepStrictEqual(result.put, []);
    });

    it("never both sends and removes the same path", () => {
      const result = reconcileWithRemote(
        { ...empty, delete: ["a.sas"] },
        { "a.sas": h("a") },
        new Set([]),
        managed,
      );

      assert.deepStrictEqual(result.put, ["a.sas"]);
      assert.deepStrictEqual(result.delete, []);
    });

    it("preserves deletes the content diff already found", () => {
      const result = reconcileWithRemote(
        { ...empty, delete: ["gone.sas"] },
        { "a.sas": h("a") },
        new Set(["a.sas", "gone.sas"]),
        managed,
      );

      assert.deepStrictEqual(result.delete, ["gone.sas"]);
    });
  });

  describe("isSuspiciousDelete", () => {
    // The failure this exists to stop: discovery returns nothing (a
    // broadened .gitignore, a localRoot typo, a fileExtensions value that
    // matches no file), every tracked path looks deleted, and the remote
    // root is emptied without a word.
    it("flags a delete of the entire tracked tree", () => {
      assert.ok(isSuspiciousDelete(40, 40));
    });

    it("flags a delete of exactly half the tracked tree", () => {
      assert.ok(isSuspiciousDelete(20, 40));
    });

    it("allows an ordinary delete of a few files", () => {
      assert.ok(!isSuspiciousDelete(3, 40));
    });

    it("allows a run that deletes nothing", () => {
      assert.ok(!isSuspiciousDelete(0, 40));
    });

    // Small trees churn legitimately and are cheap to re-push, so the guard
    // would be noise rather than protection.
    it("stays out of the way below the tracked-file floor", () => {
      assert.ok(!isSuspiciousDelete(9, 9));
    });

    it("does not fire on a first sync, when nothing is tracked yet", () => {
      assert.ok(!isSuspiciousDelete(0, 0));
    });
  });
});
