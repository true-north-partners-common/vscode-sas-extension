// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "assert";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  GitNotFoundError,
  discover,
} from "../../../src/components/sync/core/discover";

const stub = (stdout: string) => ({ run: async () => stdout });

describe("sync/discover", () => {
  describe("parsing", () => {
    it("splits on NUL and sorts", async () => {
      assert.deepStrictEqual(
        await discover("/anywhere", stub("b.sas\0a.sas\0")),
        ["a.sas", "b.sas"],
      );
    });

    it("returns nothing for an empty listing", async () => {
      assert.deepStrictEqual(await discover("/anywhere", stub("")), []);
    });

    // -z means a newline in a filename is data, not a separator.
    it("keeps a newline inside a filename intact", async () => {
      const files = await discover("/anywhere", stub("od\nd.sas\0fine.sas\0"));
      assert.deepStrictEqual(files, ["fine.sas", "od\nd.sas"]);
    });

    it("asks git for tracked and untracked files, from the sync root", async () => {
      let call: [string[], string] | undefined;
      await discover("/repo/sas", {
        run: async (args, cwd) => {
          call = [args, cwd];
          return "";
        },
      });
      assert.deepStrictEqual(call, [
        [
          "-c",
          "core.quotepath=false",
          "ls-files",
          "--cached",
          "--others",
          "--exclude-standard",
          "-z",
        ],
        "/repo/sas",
      ]);
    });

    it("explains itself when the directory is not a repository", async () => {
      await assert.rejects(
        discover("/anywhere", {
          run: async () => {
            throw new Error("fatal: not a git repository");
          },
        }),
        /requires a git repository/,
      );
    });

    // Distinct from the above: ENOENT means git is missing, not that the
    // folder is unmanaged. VS Code's own git extension conflates these.
    it("distinguishes a missing git binary", async () => {
      await assert.rejects(
        discover("/anywhere", {
          run: async () => {
            throw new Error("spawn git ENOENT");
          },
        }),
        GitNotFoundError,
      );
    });

    it("lets an abort surface as cancellation, not a git failure", async () => {
      const controller = new AbortController();
      await assert.rejects(
        discover("/anywhere", {
          signal: controller.signal,
          run: async () => {
            controller.abort();
            throw new Error("aborted");
          },
        }),
        /aborted/,
      );
    });
  });

  describe("against a real repository", () => {
    let root: string;

    before(() => {
      root = mkdtempSync(join(tmpdir(), "sas-sync-"));
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: root, stdio: "ignore" });

      git("init", "-q");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "Test");

      mkdirSync(join(root, "sas", "macros"), { recursive: true });
      mkdirSync(join(root, "sas", "build"), { recursive: true });
      mkdirSync(join(root, "docs"), { recursive: true });

      writeFileSync(join(root, ".gitignore"), "*.log\n");
      writeFileSync(join(root, "sas", ".gitignore"), "build/\n");
      writeFileSync(join(root, "sas", "main.sas"), "run;");
      writeFileSync(
        join(root, "sas", "macros", "util.sas"),
        "%macro u; %mend;",
      );
      writeFileSync(join(root, "sas", "noisy.log"), "ignored");
      writeFileSync(join(root, "sas", "build", "out.sas"), "ignored");
      writeFileSync(join(root, "docs", "readme.md"), "outside the sync root");

      git("add", "-A");
      git("commit", "-qm", "initial");
    });

    after(() => rmSync(root, { recursive: true, force: true }));

    it("lists only the subtree, relative to it", async () => {
      assert.deepStrictEqual(await discover(join(root, "sas")), [
        ".gitignore",
        "macros/util.sas",
        "main.sas",
      ]);
    });

    it("honours a nested .gitignore", async () => {
      const files = await discover(join(root, "sas"));
      assert.ok(!files.includes("build/out.sas"));
    });

    it("honours the repository-root .gitignore from a subdirectory", async () => {
      const files = await discover(join(root, "sas"));
      assert.ok(!files.includes("noisy.log"));
    });

    it("picks up an untracked file that is not ignored", async () => {
      const fresh = join(root, "sas", "macros", "fresh.sas");
      writeFileSync(fresh, "%macro f; %mend;");
      try {
        const files = await discover(join(root, "sas"));
        assert.ok(files.includes("macros/fresh.sas"));
      } finally {
        // Leave the shared fixture as found, so the suite stays order-independent.
        rmSync(fresh);
      }
    });
  });
});
