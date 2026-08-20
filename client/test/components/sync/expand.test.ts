// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "assert";

import {
  RemoteRootExpansionError,
  resolveRemoteRoot,
} from "../../../src/components/sync/core/expand";

describe("sync/expand", () => {
  it("expands ${env:NAME}", () => {
    const remoteRoot = resolveRemoteRoot("/sasv/${env:USER}/repo", {
      env: { USER: "alice" },
    });
    assert.strictEqual(remoteRoot, "/sasv/alice/repo");
  });

  it("expands ${env.NAME}", () => {
    const remoteRoot = resolveRemoteRoot("/sasv/${env.USERNAME}/repo", {
      env: { USERNAME: "alice" },
    });
    assert.strictEqual(remoteRoot, "/sasv/alice/repo");
  });

  it("expands ${workspaceFolderBasename}", () => {
    const remoteRoot = resolveRemoteRoot("/sasv/${workspaceFolderBasename}", {
      workspaceFolderBasename: "project-a",
    });
    assert.strictEqual(remoteRoot, "/sasv/project-a");
  });

  it("expands multiple placeholders in one path", () => {
    const remoteRoot = resolveRemoteRoot(
      "/sasv/${env:USER}/${workspaceFolderBasename}",
      {
        env: { USER: "alice" },
        workspaceFolderBasename: "project-a",
      },
    );
    assert.strictEqual(remoteRoot, "/sasv/alice/project-a");
  });

  it("throws when an environment variable is missing", () => {
    assert.throws(
      () => resolveRemoteRoot("/sasv/${env:USER}/repo", { env: {} }),
      (error: unknown) =>
        error instanceof RemoteRootExpansionError &&
        error.code === "missingEnvVariable" &&
        error.variable === "${env:USER}",
    );
  });

  it("throws when a placeholder is unsupported", () => {
    assert.throws(
      () => resolveRemoteRoot("/sasv/${workspaceFolder}/repo", {}),
      (error: unknown) =>
        error instanceof RemoteRootExpansionError &&
        error.code === "unsupportedVariable" &&
        error.variable === "${workspaceFolder}",
    );
  });
});
