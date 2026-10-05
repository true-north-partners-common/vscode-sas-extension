// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "assert";

import { syncAutoExecLines } from "../../../src/components/sync/core/autoexec";

describe("sync/autoexec", () => {
  it("assigns the root macro variable", () => {
    const lines = syncAutoExecLines({ remoteRoot: "/home/me/repo" }, undefined);

    assert.ok(
      lines.some((line) =>
        line.includes("call symputx('REPO', '/home/me/repo', 'G')"),
      ),
      `expected an assignment, got ${JSON.stringify(lines)}`,
    );
  });

  it("emits no blank lines, so the autoexec stays readable", () => {
    const lines = syncAutoExecLines({ remoteRoot: "/home/me/repo" }, undefined);

    assert.ok(lines.length > 0);
    assert.ok(lines.every((line) => line.trim() !== ""));
  });

  it("honours a custom macro variable name", () => {
    const lines = syncAutoExecLines(
      { remoteRoot: "/home/me/repo", rootMacroVar: "PROJ" },
      undefined,
    );

    assert.ok(lines.some((line) => line.includes("call symputx('PROJ'")));
  });

  it("leaves the autocall path to the per-run wiring", () => {
    // Those directories live under remoteRoot and do not exist until a
    // transfer has created them, which needs a session to transfer into.
    const lines = syncAutoExecLines(
      { remoteRoot: "/home/me/repo", sasautos: ["macros"] },
      undefined,
    );

    assert.ok(!lines.join("\n").includes("sasautos"));
  });

  it("expands placeholders in the remote root", () => {
    const lines = syncAutoExecLines(
      { remoteRoot: "/home/me/${workspaceFolderBasename}" },
      "my-project",
    );

    assert.ok(
      lines.some((line) => line.includes("'/home/me/my-project'")),
      `expected the basename to be substituted, got ${JSON.stringify(lines)}`,
    );
  });

  it("emits nothing when sync is not configured", () => {
    assert.deepStrictEqual(syncAutoExecLines(undefined, undefined), []);
  });

  it("emits nothing when the macro variable is turned off", () => {
    assert.deepStrictEqual(
      syncAutoExecLines(
        { remoteRoot: "/home/me/repo", rootMacroVar: "" },
        undefined,
      ),
      [],
    );
  });

  it("stays quiet when the remote root cannot be resolved", () => {
    // syncWorkspace reports this properly; failing to connect would be worse.
    assert.deepStrictEqual(
      syncAutoExecLines(
        { remoteRoot: "/home/me/${workspaceFolderBasename}" },
        undefined,
      ),
      [],
    );
    assert.deepStrictEqual(
      syncAutoExecLines(
        { remoteRoot: "/home/${env:NOT_SET_ANYWHERE}" },
        undefined,
      ),
      [],
    );
  });

  it("quotes a root containing a single quote", () => {
    const lines = syncAutoExecLines({ remoteRoot: "/home/o'brien" }, undefined);

    assert.ok(lines.some((line) => line.includes("'/home/o''brien'")));
  });
});
