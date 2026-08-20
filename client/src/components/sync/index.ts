// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  CancellationError,
  CancellationToken,
  Uri,
  l10n,
  window,
  workspace,
} from "vscode";

import { basename, join } from "path";

import { profileConfig } from "../../commands/profile";
import { Session } from "../../connection/session";
import { getContextValue, setContextValue } from "../ExtensionContext";
import { ConnectionType, ProfileSyncOptions } from "../profile";
import { Messages } from "./const";
import { collectEntries, readContents } from "./core/collect";
import { computeDiff, diffIsEmpty } from "./core/diff";
import { discover } from "./core/discover";
import {
  RemoteRootExpansionError,
  resolveRemoteRoot,
} from "./core/expand";
import { emitEnvironment, emitTransfer } from "./core/generate";
import { errorsIn } from "./core/log";
import {
  Snapshot,
  buildSnapshot,
  loadSnapshot,
  toPosix,
} from "./core/snapshot";

type SyncConfig = NonNullable<ProfileSyncOptions["sync"]>;

const DEFAULT_MAX_FILES = 2000;

/**
 * The macro variable always points at remoteRoot, so the only thing worth
 * configuring is its name. Defaulting it means `%include "&REPO/..."` works
 * without any extra setup; set it to "" to emit nothing.
 */
const DEFAULT_ROOT_MACRO_VAR = "REPO";

/**
 * Submit, and refuse to call it a success if SAS disagreed.
 *
 * RunResult carries no status, so the log is the only place a failed write
 * shows up. The existing handler is teed rather than replaced, because the
 * user still wants the sync log where the rest of the log goes; it is
 * restored on the way out so a failure here cannot leave the session mute.
 */
const runChecked = async (session: Session, code: string): Promise<void> => {
  const errors: string[] = [];
  const forward = session.onExecutionLogFn;

  session.onExecutionLogFn = (logs) => {
    errors.push(...errorsIn(logs));
    forward?.(logs);
  };

  try {
    await session.run(code);
  } finally {
    session.onExecutionLogFn = forward;
  }

  if (errors.length > 0) {
    throw new Error(l10n.t(Messages.SyncFailed, { message: errors[0] }));
  }
};

/**
 * The snapshot is stored per remote root, so two targets cannot clobber each
 * other's state.
 */
const snapshotKey = (remoteRoot: string): string =>
  `SAS.sync.snapshot:${remoteRoot}`;

/**
 * Sync configuration lives on the active Viya profile. An absent block means
 * sync is off, so there is no separate enable switch to keep consistent.
 */
const activeSyncConfig = (): SyncConfig | undefined => {
  const profile = profileConfig.getProfileByName(
    profileConfig.getActiveProfile(),
  );
  if (!profile || profile.connectionType !== ConnectionType.Rest) {
    return undefined;
  }
  return profile.sync;
};

/**
 * Resolve the folder to sync from, preferring the one holding the document
 * being run so that multi-root workspaces behave predictably.
 */
const resolveWorkspaceFolder = (uri?: Uri): Uri | undefined => {
  const folders = workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  const owning = uri ? workspace.getWorkspaceFolder(uri) : undefined;
  return (owning ?? folders[0]).uri;
};

const readSnapshot = async (remoteRoot: string): Promise<Snapshot> => {
  const stored = await getContextValue(snapshotKey(remoteRoot));
  if (!stored) {
    return loadSnapshot(undefined, remoteRoot);
  }
  try {
    return loadSnapshot(JSON.parse(stored), remoteRoot);
  } catch {
    // Corrupt state costs one full re-push, which is always safe.
    return loadSnapshot(undefined, remoteRoot);
  }
};

/**
 * Mirror the workspace into the profile's remote root, then wire up the root
 * macro variable and autocall path.
 *
 * Returns false when sync is not configured, so the caller can carry on
 * exactly as before.
 */
export const syncWorkspace = async (
  session: Session,
  uri: Uri | undefined,
  token?: CancellationToken,
): Promise<boolean> => {
  const config = activeSyncConfig();
  if (!config) {
    return false;
  }

  // Shelling out to git and uploading workspace contents is exactly what
  // workspace trust exists to gate.
  if (!workspace.isTrusted) {
    window.showWarningMessage(Messages.NotTrusted);
    return false;
  }

  const folder = resolveWorkspaceFolder(uri);
  if (!folder) {
    throw new Error(Messages.NoWorkspaceFolder);
  }
  if (folder.scheme !== "file") {
    throw new Error(Messages.RequiresLocalFolder);
  }

  let remoteRoot: string;
  try {
    remoteRoot = resolveRemoteRoot(config.remoteRoot, {
      workspaceFolderBasename: basename(folder.fsPath),
    });
  } catch (error) {
    if (error instanceof RemoteRootExpansionError) {
      throw new Error(
        l10n.t(Messages.RemoteRootExpandFailed, {
          remoteRoot: config.remoteRoot,
          message: `${error.variable}: ${error.message}`,
        }),
      );
    }
    throw error;
  }

  if (!remoteRoot.startsWith("/")) {
    throw new Error(
      l10n.t(Messages.RemoteRootNotAbsolute, {
        remoteRoot,
      }),
    );
  }

  const syncRoot = config.localRoot
    ? join(folder.fsPath, config.localRoot)
    : folder.fsPath;

  const controller = new AbortController();
  const cancelSub = token?.onCancellationRequested(() => controller.abort());

  try {
    const relPaths = await discover(syncRoot, { signal: controller.signal });

    const maxFiles = config.maxFiles ?? DEFAULT_MAX_FILES;
    if (relPaths.length > maxFiles) {
      throw new Error(
        l10n.t(Messages.TooManyFiles, {
          count: relPaths.length,
          maxFiles,
        }),
      );
    }

    const entries = await collectEntries(syncRoot, relPaths);
    const after = buildSnapshot(remoteRoot, entries);
    const before = await readSnapshot(remoteRoot);
    const diff = computeDiff(after.lastModified, before.lastModified);

    // The environment is emitted on every run: the macro variable and
    // autocall path must exist even when no file changed.
    const environment = emitEnvironment({
      remoteRoot,
      sasautos: config.sasautos,
      rootMacroVar: config.rootMacroVar ?? DEFAULT_ROOT_MACRO_VAR,
    });

    if (diffIsEmpty(diff) && diff.mkdir.length === 0) {
      if (environment) {
        await runChecked(session, environment);
      }
      return true;
    }

    const contents = await readContents(
      syncRoot,
      diff.put.map((relPath) => toPosix(relPath)),
    );

    if (token?.isCancellationRequested) {
      throw new CancellationError();
    }

    await runChecked(
      session,
      `${emitTransfer(diff, remoteRoot, contents)}\n${environment}`,
    );

    // Reached only on a clean log, so the snapshot records what actually
    // landed and a failure re-sends next time.
    await setContextValue(
      snapshotKey(remoteRoot),
      JSON.stringify(after),
    );
    return true;
  } finally {
    cancelSub?.dispose();
  }
};
