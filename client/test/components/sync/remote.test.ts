// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "assert";

import {
  FetchPage,
  MemberPage,
  PAGE_SIZE,
  listDirectory,
  listTree,
} from "../../../src/components/sync/core/remote";

/** A fake server: a map of directory path -> its members. */
const serverWith = (
  tree: Record<string, { name: string; isDirectory: boolean }[]>,
  options: { reportCount?: boolean } = {},
): { fetchPage: FetchPage; requests: string[] } => {
  const requests: string[] = [];
  const fetchPage: FetchPage = async (dir, start, limit) => {
    requests.push(`${dir}@${start}`);
    const all = tree[dir] ?? [];
    const page: MemberPage = { items: all.slice(start, start + limit) };
    if (options.reportCount !== false) {
      page.count = all.length;
    }
    return page;
  };
  return { fetchPage, requests };
};

const file = (name: string) => ({ name, isDirectory: false });
const dir = (name: string) => ({ name, isDirectory: true });

describe("sync/remote", () => {
  describe("listDirectory", () => {
    it("returns a single short page without asking for more", async () => {
      const { fetchPage, requests } = serverWith({
        "/root": [file("a.sas"), file("b.sas")],
      });

      const members = await listDirectory("/root", fetchPage);

      assert.deepStrictEqual(
        members.map((m) => m.name),
        ["a.sas", "b.sas"],
      );
      assert.deepStrictEqual(requests, ["/root@0"]);
    });

    it("follows pages until the tree is exhausted", async () => {
      const many = Array.from({ length: PAGE_SIZE * 2 + 5 }, (_, i) =>
        file(`f${i}.sas`),
      );
      const { fetchPage, requests } = serverWith({ "/root": many });

      const members = await listDirectory("/root", fetchPage);

      assert.strictEqual(members.length, many.length);
      assert.deepStrictEqual(requests, [
        "/root@0",
        `/root@${PAGE_SIZE}`,
        `/root@${PAGE_SIZE * 2}`,
      ]);
    });

    // count is documented as optional, so a server that omits it must still
    // terminate - on a short page rather than on the count.
    it("terminates when the server reports no count", async () => {
      const many = Array.from({ length: PAGE_SIZE + 1 }, (_, i) =>
        file(`f${i}.sas`),
      );
      const { fetchPage } = serverWith(
        { "/root": many },
        { reportCount: false },
      );

      const members = await listDirectory("/root", fetchPage);

      assert.strictEqual(members.length, many.length);
    });

    // A page that is exactly full is ambiguous on its own. The count settles
    // it, saving a round trip that would come back empty.
    it("stops on an exactly-full final page when count is known", async () => {
      const many = Array.from({ length: PAGE_SIZE }, (_, i) =>
        file(`f${i}.sas`),
      );
      const { fetchPage, requests } = serverWith({ "/root": many });

      const members = await listDirectory("/root", fetchPage);

      assert.strictEqual(members.length, PAGE_SIZE);
      assert.deepStrictEqual(requests, ["/root@0"]);
    });

    // Without a count the same page has to be followed, since a full page is
    // indistinguishable from a truncated one.
    it("asks for another page when a full page carries no count", async () => {
      const many = Array.from({ length: PAGE_SIZE }, (_, i) =>
        file(`f${i}.sas`),
      );
      const { fetchPage, requests } = serverWith(
        { "/root": many },
        { reportCount: false },
      );

      const members = await listDirectory("/root", fetchPage);

      assert.strictEqual(members.length, PAGE_SIZE);
      assert.deepStrictEqual(requests, ["/root@0", `/root@${PAGE_SIZE}`]);
    });

    it("returns nothing for an empty directory", async () => {
      const { fetchPage } = serverWith({ "/root": [] });
      assert.deepStrictEqual(await listDirectory("/root", fetchPage), []);
    });
  });

  describe("listTree", () => {
    it("returns every file as a path relative to the root", async () => {
      const { fetchPage } = serverWith({
        "/root": [file("main.sas"), dir("macros")],
        "/root/macros": [file("a.sas"), dir("util")],
        "/root/macros/util": [file("b.sas")],
      });

      assert.deepStrictEqual(await listTree("/root", fetchPage), [
        "macros/a.sas",
        "macros/util/b.sas",
        "main.sas",
      ]);
    });

    it("returns nothing for an empty root", async () => {
      const { fetchPage } = serverWith({ "/root": [] });
      assert.deepStrictEqual(await listTree("/root", fetchPage), []);
    });

    it("does not descend into files", async () => {
      const { fetchPage, requests } = serverWith({
        "/root": [file("a.sas")],
      });

      await listTree("/root", fetchPage);

      assert.deepStrictEqual(requests, ["/root@0"]);
    });

    it("includes dotfiles the server reports", async () => {
      const { fetchPage } = serverWith({
        "/root": [file(".sas-sync-manifest.json"), file("a.sas")],
      });

      assert.deepStrictEqual(await listTree("/root", fetchPage), [
        ".sas-sync-manifest.json",
        "a.sas",
      ]);
    });
  });
});
