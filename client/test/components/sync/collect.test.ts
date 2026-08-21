// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "assert";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  collectEntries,
  readContents,
} from "../../../src/components/sync/core/collect";

describe("sync/collect", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sas-sync-collect-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("collectEntries", () => {
    it("drops a path that does not exist on disk", async () => {
      writeFileSync(join(root, "a.sas"), "a");

      const entries = await collectEntries(root, ["a.sas", "gone.sas"]);

      assert.deepStrictEqual(
        entries.map((entry) => entry.relPath),
        ["a.sas"],
      );
    });
  });

  describe("readContents", () => {
    it("reads the content of every existing path", async () => {
      writeFileSync(join(root, "a.sas"), "hello");

      const contents = await readContents(root, ["a.sas"]);

      assert.strictEqual(contents.get("a.sas")?.toString("utf8"), "hello");
    });

    // git ls-files can still report a path deleted on disk but not yet
    // `git rm`'d, and a path can also vanish between the stat that put it
    // in the diff and this read - neither should crash the whole sync.
    it("drops a path deleted since it was discovered, instead of throwing", async () => {
      writeFileSync(join(root, "gone.sas"), "bye");
      unlinkSync(join(root, "gone.sas"));

      const contents = await readContents(root, ["gone.sas"]);

      assert.strictEqual(contents.has("gone.sas"), false);
    });

    it("still reads the other files when one is missing", async () => {
      writeFileSync(join(root, "a.sas"), "hello");

      const contents = await readContents(root, ["a.sas", "gone.sas"]);

      assert.strictEqual(contents.size, 1);
      assert.strictEqual(contents.get("a.sas")?.toString("utf8"), "hello");
    });
  });
});
