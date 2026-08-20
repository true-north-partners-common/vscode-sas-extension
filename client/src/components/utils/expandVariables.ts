// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import vscodeVariables from "vscode-variables";

/**
 * Expand VS Code's predefined ${...} variables (${userHome},
 * ${workspaceFolder}, ${file}, ${env:NAME}, ${config:NAME}, etc.) in a
 * user-configured setting value, e.g. an autoexec file path, SSH key path,
 * or content navigator root.
 *
 * A recognised placeholder with nothing to substitute (an unset env var, no
 * open file) resolves to an empty string; a genuinely unrecognised one is
 * left untouched, since these values are handed to fs/ssh2 and a bad
 * substitution surfaces naturally as the existing "not found" handling at
 * each call site.
 */
export const expandVariables = (value: string): string =>
  // vscode-variables only recognises the colon form of ${env:NAME}; accept
  // the dot form too so it matches sync's remoteRoot placeholders.
  vscodeVariables(value.replace(/\$\{env\.([^}]+)\}/g, "${env:$1}"));

