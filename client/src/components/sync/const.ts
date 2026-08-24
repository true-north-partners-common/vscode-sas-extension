// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { l10n } from "vscode";

export const Messages = {
  NoWorkspaceFolder: l10n.t(
    "Open a folder before syncing your workspace to SAS.",
  ),
  NotTrusted: l10n.t(
    "Workspace sync is disabled because this workspace is not trusted.",
  ),
  RemoteRootNotAbsolute: l10n.t(
    'The sync remoteRoot "{remoteRoot}" must be an absolute path starting with "/".',
  ),
  RemoteRootExpandFailed: l10n.t(
    'Unable to expand sync remoteRoot "{remoteRoot}". {message}',
  ),
  RequiresLocalFolder: l10n.t(
    "Workspace sync requires a folder stored on this machine.",
  ),
  RequiresViya: l10n.t("Workspace sync requires a SAS Viya connection."),
  SyncFailed: l10n.t("Unable to sync the workspace to SAS. {message}"),
  TooManyFiles: l10n.t(
    "Refusing to sync {count} files, which is over the limit of {maxFiles}. Narrow localRoot or raise maxFiles.",
  ),
  SuspiciousDelete: l10n.t(
    "Refusing to delete {count} of {tracked} synced files. This usually means fewer files were found than expected, so check localRoot, fileExtensions, and your .gitignore. Run Resync Workspace to SAS if the deletion is intended.",
  ),
  Syncing: l10n.t("Syncing workspace to SAS..."),
};
