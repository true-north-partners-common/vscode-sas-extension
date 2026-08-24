// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "assert";

import {
  RemoteManifest,
  manifestContents,
  parseManifest,
  serializeManifest,
} from "../../../src/components/sync/core/manifest";

describe("sync/manifest", () => {
  const sample: RemoteManifest = {
    "macros/b.sas": { hash: "bbb", etag: "etag-b" },
    "a.sas": { hash: "aaa" },
  };

  describe("serializeManifest", () => {
    it("round-trips through parseManifest", () => {
      assert.deepStrictEqual(parseManifest(serializeManifest(sample)), sample);
    });

    // A manifest is read by humans during incidents and diffed between runs,
    // so its byte output must not depend on insertion order.
    it("orders paths so the output is stable", () => {
      const reordered: RemoteManifest = {
        "a.sas": { hash: "aaa" },
        "macros/b.sas": { hash: "bbb", etag: "etag-b" },
      };
      assert.strictEqual(
        serializeManifest(sample),
        serializeManifest(reordered),
      );
    });
  });

  describe("parseManifest", () => {
    // The distinction this file exists to protect: unknown is not empty.
    // An empty inventory would mean every tracked path should be deleted,
    // which is how a corrupt manifest turns into a wiped directory.
    it("reports unknown rather than empty for junk", () => {
      for (const junk of ["", "   ", "not json", "[]", "null", "42"]) {
        assert.strictEqual(parseManifest(junk), undefined);
      }
    });

    it("reports unknown for the v1 scalar hash format", () => {
      assert.strictEqual(
        parseManifest(
          "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08\n",
        ),
        undefined,
      );
    });

    it("reports unknown for a future schema version", () => {
      const future = JSON.stringify({ version: 99, files: {} });
      assert.strictEqual(parseManifest(future), undefined);
    });

    it("reports unknown when an entry is missing its hash", () => {
      const broken = JSON.stringify({
        version: 2,
        files: { "a.sas": { etag: "e" } },
      });
      assert.strictEqual(parseManifest(broken), undefined);
    });

    // Distinct from junk: a genuinely empty tree is a legitimate state and
    // must parse, or a first sync of an empty folder never converges.
    it("accepts a genuinely empty inventory", () => {
      const empty = JSON.stringify({ version: 2, files: {} });
      assert.deepStrictEqual(parseManifest(empty), {});
    });

    it("accepts an entry with no etag", () => {
      const noEtag = JSON.stringify({
        version: 2,
        files: { "a.sas": { hash: "aaa" } },
      });
      assert.deepStrictEqual(parseManifest(noEtag), {
        "a.sas": { hash: "aaa" },
      });
    });
  });

  describe("manifestContents", () => {
    it("projects to the path-to-hash view a diff compares", () => {
      assert.deepStrictEqual(manifestContents(sample), {
        "macros/b.sas": "bbb",
        "a.sas": "aaa",
      });
    });
  });
});
