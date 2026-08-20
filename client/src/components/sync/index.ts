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

import { createHash } from "crypto";
import { readFile } from "fs/promises";
import { basename, extname, join, posix } from "path";

import { AxiosError } from "axios";

import { profileConfig } from "../../commands/profile";
import { FileSystemApi } from "../../connection/rest/api/compute";
import { getApiConfig } from "../../connection/rest/common";
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
import { emitEnvironment } from "./core/generate";
import { errorsIn } from "./core/log";
import {
  Snapshot,
  buildSnapshot,
  loadSnapshot,
  toPosix,
} from "./core/snapshot";

type SyncConfig = NonNullable<ProfileSyncOptions["sync"]>;

const DEFAULT_MAX_FILES = 2000;
const DEFAULT_SYNC_FILE_EXTENSIONS = [".sas", ".inc"];
const MANIFEST_FILE_NAME = ".sas-sync-manifest.sha256";

/**
 * The macro variable always points at remoteRoot, so the only thing worth
 * configuring is its name. Defaulting it means `%include "&REPO/..."` works
 * without any extra setup; set it to "" to emit nothing.
 */
const DEFAULT_ROOT_MACRO_VAR = "REPO";
const FORCE_RESYNC_CONTEXT_KEY = "SAS.sync.forceResync";
const SAS_FILE_SEPARATOR = "~fs~";

/**
 * Submit, and refuse to call it a success if SAS disagreed.
 *
 * RunResult carries no status, so the log is still the source of truth for
 * environment setup failures.
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

// Keyed by session identity so a reconnect (a new Session) re-applies, while
// repeated runs against the same session skip a submission that would be a
// no-op.
const lastEnvironmentBySession = new WeakMap<Session, string>();

const ensureEnvironment = async (
  session: Session,
  environment: string,
): Promise<void> => {
  if (!environment || lastEnvironmentBySession.get(session) === environment) {
    return;
  }
  await runChecked(session, environment);
  lastEnvironmentBySession.set(session, environment);
};

/**
 * The snapshot is stored per remote root, so two targets cannot clobber each
 * other's state.
 */
const snapshotKey = (remoteRoot: string): string =>
  `SAS.sync.snapshot:${remoteRoot}`;

const manifestPath = (remoteRoot: string): string =>
  posix.join(remoteRoot, MANIFEST_FILE_NAME);

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

const normalizeExtensions = (configured?: string[]): Set<string> => {
  const source =
    configured && configured.length > 0
      ? configured
      : DEFAULT_SYNC_FILE_EXTENSIONS;

  const normalized = new Set<string>();
  for (const extension of source) {
    const token = extension.trim().toLowerCase();
    if (!token) {
      continue;
    }
    normalized.add(token.startsWith(".") ? token : `.${token}`);
  }

  if (normalized.size === 0) {
    for (const extension of DEFAULT_SYNC_FILE_EXTENSIONS) {
      normalized.add(extension);
    }
  }

  return normalized;
};

const filterSyncPaths = (
  relPaths: string[],
  configuredExtensions?: string[],
): string[] => {
  const allowed = normalizeExtensions(configuredExtensions);
  return relPaths.filter((relPath) =>
    allowed.has(extname(relPath).toLowerCase()),
  );
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

const shouldForceResync = async (): Promise<boolean> =>
  Boolean(await getContextValue(FORCE_RESYNC_CONTEXT_KEY));

const clearForceResync = async (): Promise<void> => {
  await setContextValue(FORCE_RESYNC_CONTEXT_KEY, "");
};

const computeManifestHash = async (
  syncRoot: string,
  relPaths: string[],
): Promise<string> => {
  const manifestHash = createHash("sha256");
  const sorted = [...relPaths].sort();

  for (const relPath of sorted) {
    const fileHash = createHash("sha256");
    fileHash.update(await readFile(join(syncRoot, relPath), "utf8"));

    manifestHash.update(toPosix(relPath));
    manifestHash.update("\0");
    manifestHash.update(fileHash.digest("hex"));
    manifestHash.update("\n");
  }

  return manifestHash.digest("hex");
};

const toComputePath = (absolutePosixPath: string): string =>
  absolutePosixPath.split("/").join(SAS_FILE_SEPARATOR);

const remotePathFromRel = (remoteRoot: string, relPath: string): string =>
  posix.join(remoteRoot, toPosix(relPath));

const axiosStatus = (error: unknown): number | undefined => {
  if (error instanceof AxiosError) {
    return error.response?.status;
  }
  return undefined;
};

const createFileSystemApi = () => FileSystemApi(getApiConfig());

const TRANSFER_CONCURRENCY = 8;

/**
 * Run a worker over every item with at most `concurrency` requests in
 * flight, so independent uploads/deletes don't wait on each other's HTTP
 * round trip the way a plain sequential loop would.
 */
const runConcurrently = async <T>(
  items: T[],
  worker: (item: T) => Promise<void>,
  concurrency = TRANSFER_CONCURRENCY,
): Promise<void> => {
  let next = 0;
  const lanes = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (next < items.length) {
        await worker(items[next++]);
      }
    },
  );
  await Promise.all(lanes);
};

const pathExists = async (
  sessionId: string,
  absolutePosixPath: string,
): Promise<boolean> => {
  const api = createFileSystemApi();
  try {
    await api.headersForFileorDirectoryProperties({
      sessionId,
      fileOrDirectoryPath: toComputePath(absolutePosixPath),
    });
    return true;
  } catch (error) {
    if (axiosStatus(error) === 404) {
      return false;
    }
    throw error;
  }
};

const getEtag = async (
  sessionId: string,
  absolutePosixPath: string,
): Promise<string | undefined> => {
  const api = createFileSystemApi();
  try {
    const response = await api.headersForFileorDirectoryProperties({
      sessionId,
      fileOrDirectoryPath: toComputePath(absolutePosixPath),
    });
    const etag = response.headers.etag;
    return typeof etag === "string" ? etag : undefined;
  } catch (error) {
    if (axiosStatus(error) === 404) {
      return undefined;
    }
    throw error;
  }
};

const ensureDirectory = async (
  sessionId: string,
  absolutePosixPath: string,
): Promise<void> => {
  if (absolutePosixPath === "/") {
    return;
  }

  if (await pathExists(sessionId, absolutePosixPath)) {
    return;
  }

  const parent = posix.dirname(absolutePosixPath);
  await ensureDirectory(sessionId, parent);

  const api = createFileSystemApi();
  try {
    await api.createFileOrDirectory({
      sessionId,
      fileOrDirectoryPath: toComputePath(parent),
      fileProperties: {
        name: posix.basename(absolutePosixPath),
        isDirectory: true,
      },
    });
  } catch (error) {
    if (axiosStatus(error) === 409) {
      return;
    }
    if (!(await pathExists(sessionId, absolutePosixPath))) {
      throw error;
    }
  }
};

const remoteManifestHash = async (
  sessionId: string,
  remoteRoot: string,
): Promise<string | undefined> => {
  const api = createFileSystemApi();
  try {
    const response = await api.getFileContentFromSystem(
      {
        sessionId,
        filePath: toComputePath(manifestPath(remoteRoot)),
      },
      {
        responseType: "arraybuffer",
      },
    );

    // The endpoint returns binary data; decode and use the first line.
    const raw = Buffer.from(response.data as unknown as ArrayBufferLike)
      .toString("utf8")
      .trim();
    if (!raw) {
      return undefined;
    }
    return raw.split(/\r?\n/, 1)[0].trim() || undefined;
  } catch (error) {
    if (axiosStatus(error) === 404) {
      return undefined;
    }
    throw error;
  }
};

const remoteNeedsResync = async (
  sessionId: string,
  remoteRoot: string,
  probeRelPath?: string,
): Promise<boolean> => {
  const probePath = probeRelPath
    ? remotePathFromRel(remoteRoot, probeRelPath)
    : remoteRoot;
  return !(await pathExists(sessionId, probePath));
};

const applyDiffWithApi = async (
  sessionId: string,
  remoteRoot: string,
  diff: ReturnType<typeof computeDiff>,
  contents: Map<string, Buffer>,
): Promise<void> => {
  const api = createFileSystemApi();

  await ensureDirectory(sessionId, remoteRoot);

  // Leaf directories are independent of one another (collapseToLeaves
  // already dropped ancestors), and ensureDirectory tolerates a 409 from a
  // shared parent created by a concurrent lane, so this is safe to run in
  // parallel.
  await runConcurrently(diff.mkdir, (relativeDirPath) =>
    ensureDirectory(sessionId, remotePathFromRel(remoteRoot, relativeDirPath)),
  );

  await runConcurrently(diff.put, async (relPath) => {
    const absPath = remotePathFromRel(remoteRoot, relPath);
    await ensureDirectory(sessionId, posix.dirname(absPath));

    const content = contents.get(toPosix(relPath));
    if (!content) {
      return;
    }

    await api.updateFileContentOnSystem({
      sessionId,
      filePath: toComputePath(absPath),
      // Generated types require File, but API accepts octet-stream bytes.
      body: content as unknown as File,
      ifMatch: await getEtag(sessionId, absPath),
    });
  });

  await runConcurrently(diff.delete, async (relPath) => {
    const absPath = remotePathFromRel(remoteRoot, relPath);
    const etag = await getEtag(sessionId, absPath);
    if (!etag && !(await pathExists(sessionId, absPath))) {
      return;
    }

    try {
      await api.deleteFileOrDirectoryFromSystem({
        sessionId,
        fileOrDirectoryPath: toComputePath(absPath),
        ifMatch: etag || "",
      });
    } catch {
      // Keep deletes best-effort to preserve current sync behavior.
    }
  });

  // rmdir stays sequential: diff orders it deepest-first so a child is gone
  // before its parent's removal is attempted, which parallel lanes would not
  // preserve.
  for (const relativeDirPath of diff.rmdir) {
    const absPath = remotePathFromRel(remoteRoot, relativeDirPath);
    const etag = await getEtag(sessionId, absPath);
    if (!etag && !(await pathExists(sessionId, absPath))) {
      continue;
    }

    try {
      await api.deleteFileOrDirectoryFromSystem({
        sessionId,
        fileOrDirectoryPath: toComputePath(absPath),
        ifMatch: etag || "",
      });
    } catch {
      // Extra server files can keep directories non-empty; ignore and proceed.
    }
  }
};

const writeRemoteManifest = async (
  sessionId: string,
  remoteRoot: string,
  hash: string,
): Promise<void> => {
  const api = createFileSystemApi();
  const path = manifestPath(remoteRoot);

  await ensureDirectory(sessionId, posix.dirname(path));
  await api.updateFileContentOnSystem({
    sessionId,
    filePath: toComputePath(path),
    body: Buffer.from(`${hash}\n`, "utf8") as unknown as File,
    ifMatch: await getEtag(sessionId, path),
  });
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
  options: { force?: boolean } = {},
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
    const sessionId = session.sessionId?.();
    if (!sessionId) {
      throw new Error(Messages.RequiresViya);
    }

    const force = options.force || (await shouldForceResync());
    const relPaths = filterSyncPaths(
      await discover(syncRoot, { signal: controller.signal }),
      config.fileExtensions,
    );

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
    let diff = force
      ? computeDiff(after.lastModified, {})
      : computeDiff(after.lastModified, before.lastModified);
    let forceTransfer = force;
    // A pure function of (relPaths, mtimes): the diff proves those are
    // unchanged from the last successful sync, so its cached hash can be
    // reused instead of re-reading and re-hashing every file.
    let localManifest: string | undefined =
      diffIsEmpty(diff) && diff.mkdir.length === 0
        ? before.manifestHash
        : undefined;
    const getLocalManifest = async (): Promise<string> => {
      if (!localManifest) {
        localManifest = await computeManifestHash(syncRoot, relPaths);
      }
      return localManifest;
    };

    // Computed on every run since remoteRoot can vary by workspace folder,
    // but only resubmitted when it actually changes for this session.
    const environment = emitEnvironment({
      remoteRoot,
      sasautos: config.sasautos,
      rootMacroVar: config.rootMacroVar ?? DEFAULT_ROOT_MACRO_VAR,
    });

    if (diffIsEmpty(diff) && diff.mkdir.length === 0) {
      const probeRelPath = entries[0]?.relPath;
      if (await remoteNeedsResync(sessionId, remoteRoot, probeRelPath)) {
        forceTransfer = true;
        diff = computeDiff(after.lastModified, {});
      } else {
        const [localHash, remoteHash] = await Promise.all([
          getLocalManifest(),
          remoteManifestHash(sessionId, remoteRoot),
        ]);
        if (localHash !== remoteHash) {
          forceTransfer = true;
          diff = computeDiff(after.lastModified, {});
        }
      }
    }

    if (!forceTransfer && diffIsEmpty(diff) && diff.mkdir.length === 0) {
      await ensureEnvironment(session, environment);
      // Only a freshly computed hash (not the one already in before) needs
      // writing back - otherwise this is a no-op every steady-state run.
      if (localManifest && localManifest !== before.manifestHash) {
        await setContextValue(
          snapshotKey(remoteRoot),
          JSON.stringify({ ...after, manifestHash: localManifest }),
        );
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

    await applyDiffWithApi(sessionId, remoteRoot, diff, contents);
    await writeRemoteManifest(sessionId, remoteRoot, await getLocalManifest());

    await ensureEnvironment(session, environment);

    // Reached only on clean transfer and environment setup, so the snapshot
    // records what actually landed and a failure re-sends next time.
    await setContextValue(
      snapshotKey(remoteRoot),
      JSON.stringify({ ...after, manifestHash: await getLocalManifest() }),
    );
    await clearForceResync();
    return true;
  } finally {
    cancelSub?.dispose();
  }
};

export const forceWorkspaceResyncNextRun = async (): Promise<void> => {
  await setContextValue(FORCE_RESYNC_CONTEXT_KEY, "true");
};
