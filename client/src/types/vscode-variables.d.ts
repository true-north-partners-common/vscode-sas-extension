// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// vscode-variables ships an empty index.d.ts, so its shape is declared here.
declare module "vscode-variables" {
  function vscodeVariables(input: string, recursive?: boolean): string;
  export = vscodeVariables;
}
