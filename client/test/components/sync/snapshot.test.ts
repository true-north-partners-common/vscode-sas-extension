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
        { relPath: "macros\\a.sas", mtimeMs: 100 },
      ]);
      assert.deepStrictEqual(snapshot.lastModified, { "macros/a.sas": 100 });
      assert.strictEqual(snapshot.remoteRoot, "/remote");
      assert.strictEqual(snapshot.schemaVersion, SNAPSHOT_SCHEMA_VERSION);
    });
  });

  describe("loadSnapshot", () => {
    const valid = buildSnapshot("/remote", [
      { relPath: "a.sas", mtimeMs: 100 },
    ]);

    it("round-trips a snapshot for the same root", () => {
      assert.deepStrictEqual(loadSnapshot(valid, "/remote"), valid);
    });

    it("survives JSON serialisation", () => {
      const revived = loadSnapshot(
        JSON.parse(JSON.stringify(valid)),
        "/remote",
      );
      assert.deepStrictEqual(revived.lastModified, { "a.sas": 100 });
    });

    // Discarding is always safe: the cost is one full re-push.
    it("discards a snapshot taken against a different root", () => {
      assert.deepStrictEqual(
        loadSnapshot(valid, "/elsewhere").lastModified,
        {},
      );
    });

    it("discards a snapshot from an older schema", () => {
      const stale = { ...valid, schemaVersion: 0 };
      assert.deepStrictEqual(loadSnapshot(stale, "/remote").lastModified, {});
    });

    it("discards junk", () => {
      for (const junk of [undefined, null, 42, "nope", {}, []]) {
        assert.deepStrictEqual(loadSnapshot(junk, "/remote").lastModified, {});
      }
    });
  });
});
