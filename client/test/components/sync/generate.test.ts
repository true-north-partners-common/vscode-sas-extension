// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "assert";

import { Diff } from "../../../src/components/sync/core/diff";
import {
  CHUNK_SIZE,
  chunkBase64,
  emitDelete,
  emitEnvironment,
  emitFileWrite,
  emitMkdirs,
  emitTransfer,
} from "../../../src/components/sync/core/generate";

/**
 * Pull the staged base64 back out of a generated program and decode it, so
 * the test proves a real round trip rather than matching a string.
 */
const decodeEmitted = (program: string): Buffer => {
  const encoded = [...program.matchAll(/^ {2}put '(.*)'@?;$/gm)]
    .map((match) => match[1])
    .join("");
  return Buffer.from(encoded, "base64");
};

const roundTrips = (data: Buffer, note?: string) =>
  assert.deepStrictEqual(
    decodeEmitted(emitFileWrite("/r/x.sas", data)),
    data,
    note,
  );

const emptyDiff = (): Diff => ({ put: [], delete: [], mkdir: [], rmdir: [] });

const transfer = (
  diff: Diff = emptyDiff(),
  contents = new Map<string, Buffer>(),
) => emitTransfer(diff, "/remote/root", contents);

describe("sync/generate", () => {
  describe("chunkBase64", () => {
    it("returns no chunks for empty input", () => {
      assert.deepStrictEqual(chunkBase64(""), []);
    });

    it("does not split at exactly the chunk size", () => {
      assert.strictEqual(chunkBase64("x".repeat(CHUNK_SIZE)).length, 1);
    });

    it("does not split one below the chunk size", () => {
      assert.strictEqual(chunkBase64("x".repeat(CHUNK_SIZE - 1)).length, 1);
    });

    it("splits one above the chunk size", () => {
      const chunks = chunkBase64("x".repeat(CHUNK_SIZE + 1));
      assert.strictEqual(chunks.length, 2);
      assert.strictEqual(chunks[1].length, 1);
    });

    it("loses nothing when splitting", () => {
      const input = "abcdefghij".repeat(100);
      assert.strictEqual(chunkBase64(input).join(""), input);
    });
  });

  describe("emitFileWrite", () => {
    it("round-trips ascii", () => {
      roundTrips(Buffer.from("%macro x; %put hi; %mend;\n", "utf8"));
    });

    it("round-trips content longer than one chunk", () => {
      roundTrips(Buffer.from("data _null_; put 'x'; run;\n".repeat(200)));
    });

    // Byte lengths not divisible by three exercise base64 padding.
    it("round-trips every padding case", () => {
      for (const length of [1, 2, 3, 4, 5, 6, 7]) {
        roundTrips(Buffer.alloc(length, 0x41), `length ${length}`);
      }
    });

    it("round-trips utf-8 beyond ascii", () => {
      roundTrips(Buffer.from("/* ä ö ü — 日本語 */\n", "utf8"));
    });

    it("preserves CRLF byte for byte", () => {
      roundTrips(Buffer.from("line one\r\nline two\r\n", "utf8"));
    });

    it("round-trips arbitrary bytes", () => {
      roundTrips(Buffer.from(Array.from({ length: 256 }, (_, i) => i % 256)));
    });

    // Both SASjs and mp_hashdirectory silently skip zero-length files. The
    // general path handles it: no records staged, so the decode loop runs
    // zero times and leaves a zero-byte file.
    it("creates an empty file through the same template", () => {
      const program = emitFileWrite("/r/empty.sas", Buffer.alloc(0));
      assert.ok(program.includes("filename _out64 '/r/empty.sas';"));
      assert.ok(program.includes("$base64X4."));
      assert.strictEqual(program.match(/^ {2}put '/gm), null);
    });

    it("holds the column between chunks but not on the last", () => {
      const program = emitFileWrite(
        "/r/x.sas",
        Buffer.from("y".repeat(CHUNK_SIZE * 2)),
      );
      const puts = [...program.matchAll(/^ {2}put '.*'(@?);$/gm)].map(
        (m) => m[1],
      );
      assert.ok(puts.length > 1);
      assert.deepStrictEqual(puts.slice(0, -1), puts.slice(0, -1).fill("@"));
      assert.strictEqual(puts[puts.length - 1], "");
    });

    it("escapes a quote in the path", () => {
      const program = emitFileWrite("/r/it's.sas", Buffer.from("x"));
      assert.ok(program.includes("filename _out64 '/r/it''s.sas';"));
    });

    // The write is where a permission problem is finally provable, so it is
    // the one place that reports, and it names the file it could not open.
    it("reports the path it could not open for writing", () => {
      const program = emitFileWrite("/sasv/sasdata/x.sas", Buffer.from("x"));
      assert.ok(
        program.includes(
          "put 'ERROR: sas-sync could not open for writing: ' " +
            "'/sasv/sasdata/x.sas';",
        ),
      );
      // SYSMSG carries the reason - "Insufficient authorization to access" -
      // and FOPEN is the last file function before the PUT, so nothing has
      // reset it.
      assert.ok(program.includes("put 'ERROR- ' sysmsg();"));
      // Nothing is decoded into a handle that never opened.
      assert.ok(/if fileout = 0 then do;/.test(program));
      assert.ok(program.indexOf("else do;") < program.indexOf("fread(filein)"));
    });
  });

  describe("emitMkdirs", () => {
    it("emits nothing for an empty list", () => {
      assert.strictEqual(emitMkdirs([]), "");
    });

    it("puts every path in one DATA step", () => {
      const program = emitMkdirs(["/r/a", "/r/b"]);
      assert.strictEqual(program.match(/^data _null_;$/gm)?.length, 1);
      assert.ok(program.includes("do full = '/r/a', '/r/b';"));
    });

    it("uses dcreate rather than a shell command", () => {
      const program = emitMkdirs(["/r/a"]);
      assert.ok(program.includes("dcreate(part, parent)"));
      assert.ok(!/\bx\s|systask|%sysexec/i.test(program));
    });

    it("escapes a quote in the path", () => {
      assert.ok(emitMkdirs(["/r/it's"]).includes("'/r/it''s'"));
    });

    // The leaf is the only level the sync needs. Checking it first means the
    // steady state never consults an ancestor - which matters because
    // FILEEXIST returns 0 for an existing directory the session cannot read,
    // so asking about /sasv or /sasv/sasdata on a shared mount would produce
    // a DCREATE that was always going to fail.
    it("stops at the leaf when the leaf is already there", () => {
      assert.ok(
        emitMkdirs(["/r/a"]).includes("if fileexist(lvl{n}) then continue;"),
      );
    });

    it("climbs from the leaf rather than descending from the root", () => {
      const program = emitMkdirs(["/r/a"]);
      const climb = program.indexOf("do i = n to 1 by -1;");
      const fill = program.indexOf("do j = i + 1 to n;");
      assert.ok(climb > -1 && fill > climb);
      // lvl{0} is not a subscript, so the fill must not run after a climb
      // that created nothing.
      assert.ok(program.includes("if i > 0 then do j = i + 1 to n;"));
    });

    // DCREATE fails the same way for a forbidden directory and an unreadable
    // one, so reporting here would be crying wolf on a working sync.
    it("stays quiet about a level it could not create", () => {
      assert.ok(
        !emitMkdirs(["/sasv/sasdata/me/repo"]).includes("could not create"),
      );
    });

    it("refuses a path deeper than the level array", () => {
      const program = emitMkdirs(["/r/a"]);
      assert.ok(program.includes("if n > dim(lvl) then do;"));
      assert.ok(program.includes("nested too deeply"));
    });
  });

  describe("emitDelete", () => {
    // FEXIST carries the same lie as FILEEXIST, so guarding on it would skip
    // deletes that would have worked. FDELETE reports absence in its return
    // code like any other refusal.
    it("deletes without asking whether the target is there", () => {
      const program = emitDelete("/r/gone.sas");
      assert.ok(!program.includes("fexist"));
      assert.ok(program.includes("if rc = 0 then rc = fdelete('_del');"));
    });

    it("clears the fileref afterwards", () => {
      assert.ok(emitDelete("/r/gone.sas").includes("rc = filename('_del');"));
    });

    it("escapes a quote in the path", () => {
      assert.ok(emitDelete("/r/it's.sas").includes("'/r/it''s.sas'"));
    });
  });

  describe("emitTransfer", () => {
    it("orders mkdir before writes and writes before deletes", () => {
      const program = transfer(
        {
          put: ["macros/a.sas"],
          delete: ["old.sas"],
          mkdir: ["macros"],
          rmdir: [],
        },
        new Map([["macros/a.sas", Buffer.from("x")]]),
      );
      const mkdir = program.indexOf("'/remote/root/macros'");
      const write = program.indexOf(
        "filename _out64 '/remote/root/macros/a.sas'",
      );
      const del = program.indexOf("/remote/root/old.sas");
      assert.ok(mkdir > -1 && write > mkdir && del > write);
    });

    it("always creates the remote root itself", () => {
      assert.ok(transfer().includes("do full = '/remote/root';"));
    });

    it("removes gone directories as well as gone files", () => {
      const program = transfer({ ...emptyDiff(), rmdir: ["gone"] });
      assert.ok(program.includes("'/remote/root/gone'"));
    });

    it("fails loudly when content is missing", () => {
      assert.throws(
        () => transfer({ ...emptyDiff(), put: ["a.sas"] }),
        /No content supplied for a\.sas/,
      );
    });
  });

  describe("emitEnvironment", () => {
    it("sets the root macro variable as a quoted literal", () => {
      const program = emitEnvironment({
        remoteRoot: "/remote/root",
        rootMacroVar: "REPO",
      });
      assert.ok(program.includes("call symputx('REPO', '/remote/root', 'G');"));
      // Never interpolated into macro-language text, where an ampersand in
      // the path would be rescanned.
      assert.ok(!program.includes("%let"));
    });

    it("adds the autocall path and resets compiled macros", () => {
      const program = emitEnvironment({
        remoteRoot: "/remote/root",
        sasautos: ["macros"],
      });
      assert.ok(
        program.includes("options insert=(sasautos=('/remote/root/macros'));"),
      );
      assert.ok(program.includes("options mrecall"));
    });

    it("emits nothing when nothing is configured", () => {
      assert.strictEqual(emitEnvironment({ remoteRoot: "/remote/root" }), "");
    });
  });
});
