// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "assert";

import {
  SERVER_FAVORITES_SCHEMA_VERSION,
  emptyFavorites,
  loadFavorites,
} from "../../../src/components/ContentNavigator/core/serverFavorites";

describe("ContentNavigator/serverFavorites", () => {
  describe("emptyFavorites", () => {
    it("starts with no paths, stamped with the profile and schema", () => {
      const favorites = emptyFavorites("viya4");

      assert.deepStrictEqual(favorites, {
        schemaVersion: SERVER_FAVORITES_SCHEMA_VERSION,
        profile: "viya4",
        paths: [],
      });
    });
  });

  describe("loadFavorites", () => {
    const valid = {
      schemaVersion: SERVER_FAVORITES_SCHEMA_VERSION,
      profile: "viya4",
      paths: ["/home/sasdemo/project", "/data/shared"],
    };

    it("round-trips a stored value", () => {
      assert.deepStrictEqual(loadFavorites(valid, "viya4"), valid);
    });

    it("survives JSON serialization", () => {
      assert.deepStrictEqual(
        loadFavorites(JSON.parse(JSON.stringify(valid)), "viya4"),
        valid,
      );
    });

    it("discards favorites saved against a different profile", () => {
      // Two deployments rarely share a file system, so another profile's
      // paths are worse than no paths at all.
      assert.deepStrictEqual(
        loadFavorites(valid, "viya5"),
        emptyFavorites("viya5"),
      );
    });

    it("discards favorites from an older schema", () => {
      assert.deepStrictEqual(
        loadFavorites(
          { ...valid, schemaVersion: SERVER_FAVORITES_SCHEMA_VERSION - 1 },
          "viya4",
        ),
        emptyFavorites("viya4"),
      );
    });

    it("drops entries that are not paths", () => {
      assert.deepStrictEqual(
        loadFavorites(
          { ...valid, paths: ["/data/shared", 7, null, { path: "/x" }] },
          "viya4",
        ).paths,
        ["/data/shared"],
      );
    });

    it("drops duplicate paths", () => {
      assert.deepStrictEqual(
        loadFavorites(
          { ...valid, paths: ["/data/shared", "/data/shared"] },
          "viya4",
        ).paths,
        ["/data/shared"],
      );
    });

    it("falls back to empty for anything unrecognisable", () => {
      const expected = emptyFavorites("viya4");
      for (const stored of [
        undefined,
        null,
        "",
        "not json",
        42,
        [],
        {},
        { schemaVersion: SERVER_FAVORITES_SCHEMA_VERSION, profile: "viya4" },
        {
          schemaVersion: SERVER_FAVORITES_SCHEMA_VERSION,
          profile: "viya4",
          paths: "/data/shared",
        },
      ]) {
        assert.deepStrictEqual(
          loadFavorites(stored, "viya4"),
          expected,
          `expected ${JSON.stringify(stored)} to load as empty`,
        );
      }
    });
  });
});
