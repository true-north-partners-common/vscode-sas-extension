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

import { AxiosError } from "axios";
import { basename, extname, join, posix } from "path";

import { profileConfig } from "../../commands/profile";
import { FileSystemApi } from "../../connection/rest/api/compute";
import { getApiConfig } from "../../connection/rest/common";
import { Session } from "../../connection/session";
import { getContextValue, setContextValue } from "../ExtensionContext";
import { ConnectionType, ProfileSyncOptions } from "../profile";
import { Messages } from "./const";
import { collectEntries, readContents } from "./core/collect";
import {
  ContentMap,
  Diff,
  computeDiff,
  diffIsEmpty,
  isSuspiciousDelete,
  reconcileWithRemote,
} from "./core/diff";
import { discover } from "./core/discover";
import { RemoteRootExpansionError, resolveRemoteRoot } from "./core/expand";
import { emitEnvironment } from "./core/generate";
import { errorsIn } from "./core/log";
import {
  RemoteManifest,
  manifestContents,
  parseManifest,
  serializeManifest,
} from "./core/manifest";
import { toComputePath } from "./core/path";
import { FetchPage, listTree } from "./core/remote";
import { sessionState } from "./core/sessionState";
import {
  Snapshot,
  buildSnapshot,
  loadSnapshot,
  toPosix,
} from "./core/snapshot";

type SyncConfig = NonNullable<ProfileSyncOptions["sync"]>;

const DEFAULT_MAX_FILES = 2000;
const DEFAULT_SYNC_FILE_EXTENSIONS = [".sas", ".inc"];
/**
 * The remote inventory. It is never listed in itself, so it can never appear
 * in a diff as an orphan and delete itself - the failure mode that turns a
 * manifest kept inside the synced tree into an infinite loop.
 */
const MANIFEST_FILE_NAME = ".sas-sync-manifest.json";

/**
 * The macro variable always points at remoteRoot, so the only thing worth
 * configuring is its name. Defaulting it means `%include "&REPO/..."` works
 * without any extra setup; set it to "" to emit nothing.
 */
const DEFAULT_ROOT_MACRO_VAR = "REPO";
const FORCE_RESYNC_CONTEXT_KEY = "SAS.sync.forceResync";

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

/**
 * Submit the environment program unless this compute session has already had
 * exactly this one.
 *
 * The wiring is per-SAS-session state that dies with the session, so what
 * matters is which compute session has seen it - not which Session object
 * asked. Force is honoured because resync is the escape hatch for a session
 * whose state we cannot see; a cache that ignored it would leave no way to
 * re-apply the wiring short of restarting the extension host.
 */
const ensureEnvironment = async (
  session: Session,
  sessionId: string,
  environment: string,
  force: boolean,
): Promise<void> => {
  const state = sessionState(sessionId);
  if (!environment || (!force && state.environment === environment)) {
    return;
  }
  await runChecked(session, environment);
  state.environment = environment;
};

/**
 * Remote roots whose contents have been listed for this compute session.
 *
 * Listing costs a request per directory, which is too much to repeat before
 * every execution. Once per session is the useful cadence: within one
 * session the server does not lose files on its own, whereas a new session
 * can mean a new pod on a new node with nothing on it. Resync forces a
 * fresh look for the rarer cases - another developer, or an admin cleanup.
 */
const markVerified = (sessionId: string, remoteRoot: string): void => {
  sessionState(sessionId).verifiedRoots.add(remoteRoot);
};

const isVerified = (sessionId: string, remoteRoot: string): boolean =>
  sessionState(sessionId).verifiedRoots.has(remoteRoot);

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

/**
 * Re-push every current file without losing track of what should be deleted.
 *
 * Diffing against an empty inventory would also empty the delete list, since
 * removal is detected by a path being known remotely but absent locally - so
 * a forced resync would silently stop cleaning up files removed since the
 * last sync. Reusing the diff computed against the real manifest keeps those
 * deletes, and moves become redundant once everything is uploaded anyway.
 */
const forceFullPut = (diff: Diff, contents: ContentMap): Diff => ({
  ...diff,
  put: Object.keys(contents).sort(),
  move: [],
});

/**
 * Refuse to propagate a deletion that looks like a misconfiguration.
 *
 * Force is the deliberate escape hatch: a user invoking resync explicitly
 * has said what they meant, whereas the automatic path runs before every
 * execution and is where a silent wipe would go unnoticed.
 */
const assertDeletesAreSane = (
  diff: Diff,
  tracked: number,
  force: boolean,
): void => {
  if (force || !isSuspiciousDelete(diff.delete.length, tracked)) {
    return;
  }

  throw new Error(
    l10n.t(Messages.SuspiciousDelete, {
      count: diff.delete.length,
      tracked,
    }),
  );
};

const remotePathFromRel = (remoteRoot: string, relPath: string): string =>
  posix.join(remoteRoot, toPosix(relPath));

const axiosStatus = (error: unknown): number | undefined => {
  if (error instanceof AxiosError) {
    return error.response?.status;
  }
  return undefined;
};

const createFileSystemApi = () => FileSystemApi(getApiConfig());

/**
 * The generated compute client types an upload body as a browser File, but
 * this extension runs in Node and the API accepts any octet-stream bytes -
 * a Buffer works fine at runtime. Centralized here so the mismatch is
 * documented and audited once instead of at every call site.
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
const asRequestBody = (buffer: Buffer): File => buffer as unknown as File;

/**
 * getFileContentFromSystem is typed as returning void, but with
 * responseType: "arraybuffer" the response data is actually a Buffer.
 */
const asArrayBufferLike = (data: unknown): ArrayBufferLike =>
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  data as unknown as ArrayBufferLike;

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

/**
 * Read the remote inventory.
 *
 * Undefined means "unknown", which is not the same as "empty": an unknown
 * inventory has to be treated as a full re-push, whereas an empty one would
 * also imply that every tracked path should be deleted. Conflating the two
 * is how a missing manifest turns into a wiped directory.
 */
/**
 * Every file under the remote root, relative to it.
 *
 * A missing root is not an error here - it simply means nothing is there,
 * which the caller handles as "send everything".
 */
const listRemoteFiles = async (
  sessionId: string,
  remoteRoot: string,
): Promise<string[]> => {
  const api = createFileSystemApi();

  const fetchPage: FetchPage = async (absDirPath, start, limit) => {
    const response = await api.getDirectoryMembers({
      sessionId,
      directoryPath: toComputePath(absDirPath),
      // Dotfiles count: the manifest is one, and so are files a repo
      // legitimately tracks.
      showAll: true,
      start,
      limit,
    });

    const items = (response.data.items ?? [])
      .map((item) => ({
        name: item.name ?? "",
        isDirectory: Boolean(item.isDirectory),
      }))
      .filter(
        (member) =>
          member.name !== "" && member.name !== "." && member.name !== "..",
      );

    return { items, count: response.data.count };
  };

  try {
    return await listTree(remoteRoot, fetchPage);
  } catch (error) {
    if (axiosStatus(error) === 404) {
      return [];
    }
    throw error;
  }
};

const readRemoteManifest = async (
  sessionId: string,
  remoteRoot: string,
): Promise<RemoteManifest | undefined> => {
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

    return parseManifest(
      Buffer.from(asArrayBufferLike(response.data)).toString("utf8"),
    );
  } catch (error) {
    if (axiosStatus(error) === 404) {
      return undefined;
    }
    throw error;
  }
};

/**
 * Directories confirmed to exist for this transfer.
 *
 * ensureDirectory previously issued a HEAD for every uploaded file, so a
 * folder holding two hundred files was probed two hundred times for an
 * answer that could not change during the run.
 */
type DirectoryCache = Set<string>;

const ensureDirectoryCached = async (
  sessionId: string,
  absolutePosixPath: string,
  known: DirectoryCache,
): Promise<void> => {
  if (known.has(absolutePosixPath)) {
    return;
  }
  await ensureDirectory(sessionId, absolutePosixPath);
  known.add(absolutePosixPath);
};

/**
 * Upload one file, conditionally when we know what we are replacing.
 *
 * An ETag is required to replace an existing file but must be absent when
 * creating one, and the manifest already records the ETag from the last
 * write - so the usual HEAD-then-PUT is unnecessary. Losing that race (the
 * file changed underneath us, or the manifest is stale) comes back as a
 * precondition failure, which is better information than a HEAD could have
 * given us anyway: it means someone else touched the file.
 */
const putFile = async (
  sessionId: string,
  absPath: string,
  content: Buffer,
  knownEtag: string | undefined,
): Promise<string | undefined> => {
  const api = createFileSystemApi();
  const write = (ifMatch: string | undefined) =>
    api.updateFileContentOnSystem({
      sessionId,
      filePath: toComputePath(absPath),
      body: asRequestBody(content),
      ifMatch,
    });

  let response;
  try {
    response = await write(knownEtag);
  } catch (error) {
    const status = axiosStatus(error);
    // 412 precondition failed, 428 precondition required, 409 conflict:
    // all mean "your idea of this file is wrong". Re-read the truth once
    // and retry, rather than failing a whole sync over a stale ETag.
    if (status !== 412 && status !== 428 && status !== 409) {
      throw error;
    }
    response = await write(await getEtag(sessionId, absPath));
  }

  const etag = response.headers?.etag;
  return typeof etag === "string" ? etag : undefined;
};

/**
 * Delete without first asking for an ETag.
 *
 * The generated client marks ifMatch required, but an empty value is what
 * the rest of this extension sends for deletes and it is accepted; spending
 * a HEAD to fetch a value we then fall back to "" for bought nothing. A 404
 * is success by another name.
 */
const deleteRemote = async (
  sessionId: string,
  absPath: string,
): Promise<void> => {
  const api = createFileSystemApi();
  await api.deleteFileOrDirectoryFromSystem({
    sessionId,
    fileOrDirectoryPath: toComputePath(absPath),
    ifMatch: "",
  });
};

export interface TransferOutcome {
  /** Manifest entries for everything now known to be on the server. */
  written: RemoteManifest;
  /** Source paths of moves the server actually performed. */
  movedFrom: string[];
  /** Paths whose delete was attempted but did not succeed. */
  failedDeletes: string[];
}

const applyDiffWithApi = async (
  sessionId: string,
  remoteRoot: string,
  diff: Diff,
  contents: Map<string, Buffer>,
  hashes: ContentMap,
  known: RemoteManifest,
  token?: CancellationToken,
): Promise<TransferOutcome> => {
  const api = createFileSystemApi();
  const directories: DirectoryCache = new Set();
  const written: RemoteManifest = {};
  const movedFrom: string[] = [];
  const failedDeletes: string[] = [];

  const stopIfCancelled = () => {
    if (token?.isCancellationRequested) {
      throw new CancellationError();
    }
  };

  await ensureDirectoryCached(sessionId, remoteRoot, directories);

  // Leaf directories are independent of one another (collapseToLeaves
  // already dropped ancestors), and ensureDirectory tolerates a 409 from a
  // shared parent created by a concurrent lane, so this is safe to run in
  // parallel.
  await runConcurrently(diff.mkdir, (relativeDirPath) =>
    ensureDirectoryCached(
      sessionId,
      remotePathFromRel(remoteRoot, relativeDirPath),
      directories,
    ),
  );

  // Moves first: a rename is bytes the server already holds, so doing these
  // before the uploads keeps them out of the transfer entirely.
  for (const { from, to } of diff.move) {
    stopIfCancelled();
    const fromAbs = remotePathFromRel(remoteRoot, from);
    const toAbs = remotePathFromRel(remoteRoot, to);
    await ensureDirectoryCached(sessionId, posix.dirname(toAbs), directories);

    try {
      await api.updateFileOrDirectoryOnSystem({
        sessionId,
        fileOrDirectoryPath: toComputePath(fromAbs),
        ifMatch: known[from]?.etag ?? "",
        // The path element is a plain path: unlike the URI segment above it
        // must not be ~fs~ encoded.
        fileProperties: {
          name: posix.basename(toAbs),
          path: posix.dirname(toAbs),
        },
        overwrite: true,
      });
      written[to] = { hash: hashes[to] };
      movedFrom.push(from);
    } catch {
      // A move is only an optimization. If the server will not do it, fall
      // back to uploading the destination and deleting the source, which is
      // exactly what the diff would have said without rename detection.
      diff.put.push(to);
      diff.delete.push(from);
    }
  }

  await runConcurrently(diff.put, async (relPath) => {
    stopIfCancelled();
    const absPath = remotePathFromRel(remoteRoot, relPath);
    await ensureDirectoryCached(sessionId, posix.dirname(absPath), directories);

    const content = contents.get(toPosix(relPath));
    if (!content) {
      return;
    }

    const etag = await putFile(
      sessionId,
      absPath,
      content,
      known[relPath]?.etag,
    );
    written[relPath] = { hash: hashes[relPath], etag };
  });

  await runConcurrently(diff.delete, async (relPath) => {
    stopIfCancelled();
    try {
      await deleteRemote(sessionId, remotePathFromRel(remoteRoot, relPath));
    } catch (error) {
      if (axiosStatus(error) === 404) {
        return;
      }
      // Recorded rather than swallowed: a file that would not delete is
      // still on the server, and the manifest must keep saying so or the
      // next run will believe the tree is clean.
      failedDeletes.push(relPath);
    }
  });

  // rmdir stays sequential: diff orders it deepest-first so a child is gone
  // before its parent's removal is attempted, which parallel lanes would not
  // preserve.
  for (const relativeDirPath of diff.rmdir) {
    try {
      await deleteRemote(
        sessionId,
        remotePathFromRel(remoteRoot, relativeDirPath),
      );
    } catch {
      // Extra server files can keep directories non-empty; ignore and proceed.
    }
  }

  return { written, movedFrom, failedDeletes };
};

const writeRemoteManifest = async (
  sessionId: string,
  remoteRoot: string,
  manifest: RemoteManifest,
): Promise<void> => {
  const path = manifestPath(remoteRoot);
  await putFile(
    sessionId,
    path,
    Buffer.from(serializeManifest(manifest), "utf8"),
    await getEtag(sessionId, path),
  );
};

/**
 * The inventory to record after a transfer.
 *
 * Built from what the server was known to hold, adjusted by what actually
 * happened rather than by what was planned: a delete that failed leaves its
 * entry in place, so the next run still knows the file is there instead of
 * concluding the tree is clean.
 */
const nextManifest = (
  known: RemoteManifest,
  diff: Diff,
  outcome: TransferOutcome,
): RemoteManifest => {
  const next: RemoteManifest = { ...known };
  const failed = new Set(outcome.failedDeletes);

  for (const relPath of diff.delete) {
    if (!failed.has(relPath)) {
      delete next[relPath];
    }
  }
  for (const relPath of outcome.movedFrom) {
    delete next[relPath];
  }

  return { ...next, ...outcome.written };
};

const saveSnapshot = async (
  remoteRoot: string,
  snapshot: Snapshot,
): Promise<void> => {
  await setContextValue(snapshotKey(remoteRoot), JSON.stringify(snapshot));
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

    const before = await readSnapshot(remoteRoot);
    // The previous stamps let unchanged files skip being re-read; anything
    // whose mtime or size moved is hashed afresh.
    const entries = await collectEntries(syncRoot, relPaths, before.files);
    const after = buildSnapshot(remoteRoot, entries);

    const localContents: ContentMap = Object.fromEntries(
      Object.entries(after.files).map(([relPath, stamp]) => [
        relPath,
        stamp.hash,
      ]),
    );

    // The server is the authority on what the server holds. An unreadable or
    // absent manifest means we cannot know, so everything is re-sent - and
    // crucially nothing is deleted, because an unknown inventory must not be
    // read as an empty one.
    const remoteManifest = await readRemoteManifest(sessionId, remoteRoot);
    const known = remoteManifest ?? {};
    let diff = computeDiff(localContents, manifestContents(known));

    // The manifest says what we wrote, not what is there now. Once per
    // session - and on every resync - look at the server itself, so a file
    // deleted out of band comes back rather than being written off as
    // matching. This is what makes it a mirror instead of a change log.
    const verified = isVerified(sessionId, remoteRoot);
    let trackedRemotely = Object.keys(known).length;
    if (!verified || force) {
      const present = new Set(await listRemoteFiles(sessionId, remoteRoot));
      const managed = normalizeExtensions(config.fileExtensions);
      diff = reconcileWithRemote(
        diff,
        localContents,
        present,
        (relPath) =>
          relPath !== MANIFEST_FILE_NAME &&
          managed.has(extname(relPath).toLowerCase()),
      );
      // The listing can reveal more than the manifest knew about - a lost or
      // corrupt manifest with a full tree behind it being the dangerous
      // case, since a guard measured against an empty manifest would wave
      // through a wipe of everything the listing just found.
      trackedRemotely = Math.max(trackedRemotely, present.size);
    }

    assertDeletesAreSane(diff, trackedRemotely, force);
    if (force) {
      diff = forceFullPut(diff, localContents);
    }

    // Computed on every run since remoteRoot can vary by workspace folder,
    // but only resubmitted when it actually changes for this session.
    const environment = emitEnvironment({
      remoteRoot,
      sasautos: config.sasautos,
      rootMacroVar: config.rootMacroVar ?? DEFAULT_ROOT_MACRO_VAR,
    });

    const nothingToDo =
      !force &&
      remoteManifest !== undefined &&
      diffIsEmpty(diff) &&
      diff.mkdir.length === 0;

    if (nothingToDo) {
      await ensureEnvironment(session, sessionId, environment, force);
      await saveSnapshot(remoteRoot, after);
      markVerified(sessionId, remoteRoot);
      return true;
    }

    // Move destinations are read too. A server-side move is only an
    // optimization, and when it fails the transfer falls back to uploading
    // the destination - which needs bytes in hand, since by then there is no
    // way back to the filesystem. Reading locally is cheap; it is the upload
    // a rename avoids, not the read.
    const contents = await readContents(syncRoot, [
      ...diff.put.map((relPath) => toPosix(relPath)),
      ...diff.move.map(({ to }) => toPosix(to)),
    ]);

    if (token?.isCancellationRequested) {
      throw new CancellationError();
    }

    const outcome = await applyDiffWithApi(
      sessionId,
      remoteRoot,
      diff,
      contents,
      localContents,
      known,
      token,
    );

    await writeRemoteManifest(
      sessionId,
      remoteRoot,
      nextManifest(known, diff, outcome),
    );

    await ensureEnvironment(session, sessionId, environment, force);

    // Reached only on clean transfer and environment setup, so the snapshot
    // records what actually landed and a failure re-sends next time.
    await saveSnapshot(remoteRoot, after);
    markVerified(sessionId, remoteRoot);
    await clearForceResync();
    return true;
  } finally {
    cancelSub?.dispose();
  }
};

export const forceWorkspaceResyncNextRun = async (): Promise<void> => {
  await setContextValue(FORCE_RESYNC_CONTEXT_KEY, "true");
};
