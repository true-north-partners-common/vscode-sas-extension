// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const TOKEN = /\$\{([^}]+)\}/g;

export type RemoteRootExpansionErrorCode =
  | "missingEnvVariable"
  | "missingWorkspaceFolderBasename"
  | "unsupportedVariable";

export class RemoteRootExpansionError extends Error {
  constructor(
    readonly code: RemoteRootExpansionErrorCode,
    readonly variable: string,
    message: string,
  ) {
    super(message);
    this.name = "RemoteRootExpansionError";
  }
}

export interface RemoteRootExpansionOptions {
  workspaceFolderBasename?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Expand supported placeholders in sync remoteRoot.
 *
 * Supported placeholders:
 * - ${env:NAME}
 * - ${env.NAME}
 * - ${workspaceFolderBasename}
 */
export const resolveRemoteRoot = (
  remoteRoot: string,
  options: RemoteRootExpansionOptions = {},
): string => {
  const { workspaceFolderBasename, env = process.env } = options;

  return remoteRoot.replace(TOKEN, (fullToken, token: string) => {
    if (token === "workspaceFolderBasename") {
      if (!workspaceFolderBasename) {
        throw new RemoteRootExpansionError(
          "missingWorkspaceFolderBasename",
          fullToken,
          "No workspace folder is available to resolve ${workspaceFolderBasename}.",
        );
      }
      return workspaceFolderBasename;
    }

    if (token.startsWith("env:") || token.startsWith("env.")) {
      const varName = token.slice(4);
      const value = env[varName];
      if (!value) {
        throw new RemoteRootExpansionError(
          "missingEnvVariable",
          fullToken,
          `Environment variable "${varName}" is not set.`,
        );
      }
      return value;
    }

    throw new RemoteRootExpansionError(
      "unsupportedVariable",
      fullToken,
      "Supported placeholders are ${env:NAME}, ${env.NAME}, and ${workspaceFolderBasename}.",
    );
  });
};
