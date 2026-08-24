// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "assert";

import {
  SNAPSHOT_SCHEMA_VERSION,
  buildSnapshot,
  loadSnapshot,
  toPosix,
} from "../../../src/components/sync/core/snapshot";

describe("sync/snapshot", () => {
  describe("toPosix", () => {
    it("normalises windows separators", () => {
      assert.strictEqual(toPosix("macros\\util\\x.sas"), "macros/util/x.sas");
    });

    it("leaves posix paths alone", () => {
      assert.strictEqual(toPosix("macros/util/x.sas"), "macros/util/x.sas");
    });
  });

  describe("buildSnapshot", () => {
    it("keys on normalised paths", () => {
      const snapshot = buildSnapshot("/remote", [
        { relPath: "macros\\a.sas", mtimeMs: 100, size: 10, hash: "abc" },
      ]);
      assert.deepStrictEqual(snapshot.files, {
        "macros/a.sas": { mtimeMs: 100, size: 10, hash: "abc" },
      });
      assert.strictEqual(snapshot.remoteRoot, "/remote");
      assert.strictEqual(snapshot.schemaVersion, SNAPSHOT_SCHEMA_VERSION);
    });
  });

  describe("loadSnapshot", () => {
    const valid = buildSnapshot("/remote", [
      { relPath: "a.sas", mtimeMs: 100, size: 10, hash: "abc" },
    ]);

    it("round-trips a snapshot for the same root", () => {
      assert.deepStrictEqual(loadSnapshot(valid, "/remote"), valid);
    });

    it("survives JSON serialization", () => {
      const revived = loadSnapshot(
        JSON.parse(JSON.stringify(valid)),
        "/remote",
      );
      assert.deepStrictEqual(revived.files, {
        "a.sas": { mtimeMs: 100, size: 10, hash: "abc" },
      });
    });

    // Discarding is always safe: the cost is one full re-push.
    it("discards a snapshot taken against a different root", () => {
      assert.deepStrictEqual(loadSnapshot(valid, "/elsewhere").files, {});
    });

    it("discards a snapshot from an older schema", () => {
      const stale = { ...valid, schemaVersion: 0 };
      assert.deepStrictEqual(loadSnapshot(stale, "/remote").files, {});
    });

    // v1 stored a bare mtime per path. Reading one as if it were v2 would
    // make every stamp undefined, so the diff would see no change and skip
    // the whole tree; discarding costs one full re-push instead.
    it("discards an older snapshot rather than misreading its shape", () => {
      const v2 = {
        schemaVersion: 2,
        remoteRoot: "/remote",
        files: { "a.sas": { mtimeMs: 100, size: 10 } },
      };
      assert.deepStrictEqual(loadSnapshot(v2, "/remote").files, {});
    });

    it("discards a snapshot whose stamps are the wrong shape", () => {
      const malformed = {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        remoteRoot: "/remote",
        files: { "a.sas": 100 },
      };
      assert.deepStrictEqual(loadSnapshot(malformed, "/remote").files, {});
    });

    it("discards junk", () => {
      for (const junk of [undefined, null, 42, "nope", {}, []]) {
        assert.deepStrictEqual(loadSnapshot(junk, "/remote").files, {});
      }
    });
  });
});
