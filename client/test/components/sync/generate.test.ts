// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "assert";

import { emitEnvironment } from "../../../src/components/sync/core/generate";

describe("sync/generate", () => {
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
