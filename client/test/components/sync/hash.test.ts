// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "assert";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { hashBytes, hashFile } from "../../../src/components/sync/core/hash";

describe("sync/hash", () => {
  describe("hashBytes", () => {
    it("matches the known sha256 of a fixed input", () => {
      assert.strictEqual(
        hashBytes(Buffer.from("abc", "utf8")),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      );
    });

    // The reason this hashes a Buffer and never a decoded string: reading as
    // UTF-8 maps every byte the decoder cannot represent to U+FFFD, so these
    // two distinct files would collapse to one digest and a real edit would
    // never be transferred.
    it("distinguishes byte sequences that are not valid UTF-8", () => {
      const a = Buffer.from([0xff, 0xfe, 0x00]);
      const b = Buffer.from([0xfe, 0xff, 0x00]);
      assert.notStrictEqual(hashBytes(a), hashBytes(b));
      assert.strictEqual(a.toString("utf8"), b.toString("utf8"));
    });

    it("is stable across calls", () => {
      const content = Buffer.from("proc print; run;", "utf8");
      assert.strictEqual(hashBytes(content), hashBytes(content));
    });
  });

  describe("hashFile", () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "sas-sync-hash-"));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("hashes a file's bytes", async () => {
      const file = join(dir, "a.sas");
      await writeFile(file, "abc");
      assert.strictEqual(
        await hashFile(file),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      );
    });

    // git lists tracked files that were deleted without `git rm`, and a
    // rename can land mid-sync, so a vanished path is ordinary rather than
    // exceptional and must not fail the whole run.
    it("returns undefined for a file that is not there", async () => {
      assert.strictEqual(await hashFile(join(dir, "missing.sas")), undefined);
    });
  });
});
