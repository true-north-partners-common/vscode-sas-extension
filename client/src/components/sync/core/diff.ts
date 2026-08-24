// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The set of operations needed to make the remote reflect the local tree.
 *
 * Modelled as explicit operation lists rather than a bare "changed files"
 * list so that deletes and renames are handled rather than ignored. A rename
 * is a removal plus an addition, so it falls out of this shape for free.
 */
export interface Diff {
  put: string[];
  delete: string[];
  /** Paths whose content already exists remotely under a different name. */
  move: Move[];
  mkdir: string[];
  rmdir: string[];
}

export interface Move {
  from: string;
  to: string;
}

/** Workspace-relative POSIX path -> sha256 of the file's bytes. */
export type ContentMap = Record<string, string>;

/**
 * Directory churn on its own is not work worth doing, so it does not count
 * towards emptiness.
 */
export const diffIsEmpty = (diff: Diff): boolean =>
  diff.put.length === 0 && diff.delete.length === 0 && diff.move.length === 0;

/**
 * Below this many previously-synced files, a wholesale delete is cheap to
 * recover from and small trees churn legitimately, so the guard stays out
 * of the way.
 */
const DELETE_GUARD_MIN_TRACKED = 10;

/** Treat a delete set at or above this share of the tree as suspect. */
const DELETE_GUARD_FRACTION = 0.5;

/**
 * Whether a delete set looks like a misconfiguration rather than an intent.
 *
 * Deletion is inferred from absence: a path in the snapshot that discovery
 * no longer reports. That inference is only sound when discovery actually
 * ran over the intended tree, and several ordinary mistakes make it report
 * far less than it should - a broadened .gitignore, a localRoot typo, a
 * fileExtensions value matching nothing. Each turns "I cannot see these
 * files" into "delete these files" against a persistent server directory.
 *
 * Unison encodes the same rule for the same reason: with no archive it
 * treats both replicas as empty and unions them rather than inferring a
 * deletion it cannot justify.
 */
export const isSuspiciousDelete = (
  deleteCount: number,
  tracked: number,
): boolean =>
  deleteCount > 0 &&
  tracked >= DELETE_GUARD_MIN_TRACKED &&
  deleteCount >= tracked * DELETE_GUARD_FRACTION;

/**
 * Correct a diff against what the server actually holds.
 *
 * The manifest records what a sync wrote, which is not the same as what is
 * there now. A file removed on the server out of band still appears in the
 * manifest with a matching hash, so a content comparison alone concludes
 * the two sides agree and the file stays missing forever. In a one-way
 * mirror the local tree is authoritative, so anything absent remotely has
 * to be sent again regardless of what the manifest claims.
 *
 * `isManaged` decides what this sync is allowed to remove. A remote root
 * can hold output, logs, or data that no local file corresponds to, and
 * deleting those because they are "not local" would be destroying someone
 * else's work rather than mirroring ours.
 */
export const reconcileWithRemote = (
  diff: Diff,
  local: ContentMap,
  present: ReadonlySet<string>,
  isManaged: (relPath: string) => boolean,
): Diff => {
  const put = new Set(diff.put);
  const remove = new Set(diff.delete);
  const move: Move[] = [];

  // A move whose source is gone cannot be a move. Uploading the destination
  // is what the diff would have said had it known.
  for (const step of diff.move) {
    if (present.has(step.from)) {
      move.push(step);
    } else {
      put.add(step.to);
    }
  }

  // A move's destination is legitimately absent remotely - that is what the
  // move is about to create. Treating "not there" as "must upload" would
  // undo every rename optimization.
  const arriving = new Set(move.map((step) => step.to));

  for (const relPath of Object.keys(local)) {
    if (!present.has(relPath) && !arriving.has(relPath)) {
      put.add(relPath);
    }
  }

  for (const relPath of present) {
    if (!(relPath in local) && isManaged(relPath)) {
      remove.add(relPath);
    }
  }

  // A path cannot be both sent and removed; the local tree wins, since it is
  // the side this mirror is driven from.
  for (const relPath of put) {
    remove.delete(relPath);
  }
  for (const step of move) {
    remove.delete(step.to);
  }

  return {
    ...diff,
    put: [...put].sort(),
    delete: [...remove].sort(),
    move,
  };
};

/**
 * Every ancestor directory of a workspace-relative path, shallowest first.
 * "macros/util/x.sas" -> ["macros", "macros/util"]
 */
export const ancestorDirs = (relPath: string): string[] => {
  const dirs: string[] = [];
  for (
    let i = relPath.indexOf("/");
    i !== -1;
    i = relPath.indexOf("/", i + 1)
  ) {
    dirs.push(relPath.slice(0, i));
  }
  return dirs;
};

const dirSet = (relPaths: string[]): Set<string> => {
  const dirs = new Set<string>();
  for (const relPath of relPaths) {
    for (const dir of ancestorDirs(relPath)) {
      dirs.add(dir);
    }
  }
  return dirs;
};

/**
 * Drop any directory that is an ancestor of another in the same list.
 *
 * Intermediate levels are created implicitly when a directory is made, so
 * emitting a call for every level is wasted work. Collecting ancestors into
 * a set keeps this linear - comparing every pair against every other is
 * quadratic, which bites on the first push of a large tree.
 */
export const collapseToLeaves = (dirs: string[]): string[] => {
  const ancestors = new Set<string>();
  for (const dir of dirs) {
    for (const ancestor of ancestorDirs(dir)) {
      ancestors.add(ancestor);
    }
  }
  return dirs.filter((dir) => !ancestors.has(dir)).sort();
};

const depthOf = (dir: string): number => {
  let depth = 0;
  for (let i = 0; i < dir.length; i++) {
    if (dir.charCodeAt(i) === 47 /* "/" */) {
      depth++;
    }
  }
  return depth;
};

/**
 * Deepest first, so a directory is always emptied before its parent is
 * removed.
 */
export const deepestFirst = (dirs: string[]): string[] =>
  dirs
    .map((dir) => ({ dir, depth: depthOf(dir) }))
    .sort((a, b) => b.depth - a.depth || a.dir.localeCompare(b.dir))
    .map(({ dir }) => dir);

/**
 * Index paths by content, keeping only hashes that appear exactly once.
 *
 * Ambiguity is the reason for the restriction: when two files share content
 * there is no way to tell which removal pairs with which addition, and a
 * wrong guess turns into a wrong move. Falling back to delete-plus-upload
 * for those is always correct, just slower.
 */
const uniqueByHash = (
  relPaths: string[],
  contents: ContentMap,
): Map<string, string> => {
  const seen = new Map<string, string>();
  const duplicated = new Set<string>();

  for (const relPath of relPaths) {
    const hash = contents[relPath];
    if (seen.has(hash)) {
      duplicated.add(hash);
      continue;
    }
    seen.set(hash, relPath);
  }

  for (const hash of duplicated) {
    seen.delete(hash);
  }
  return seen;
};

/**
 * Rewrite matching delete/put pairs as moves.
 *
 * A rename is otherwise a full re-upload of bytes the server already holds,
 * plus a separate delete. Pairing them by content turns that into a single
 * server-side operation carrying no body at all.
 */
const pairRenames = (
  put: string[],
  removed: string[],
  after: ContentMap,
  before: ContentMap,
): { put: string[]; delete: string[]; move: Move[] } => {
  const addedByHash = uniqueByHash(put, after);
  const removedByHash = uniqueByHash(removed, before);

  const move: Move[] = [];
  const movedFrom = new Set<string>();
  const movedTo = new Set<string>();

  for (const [hash, from] of removedByHash) {
    const to = addedByHash.get(hash);
    if (to === undefined) {
      continue;
    }
    move.push({ from, to });
    movedFrom.add(from);
    movedTo.add(to);
  }

  return {
    put: put.filter((relPath) => !movedTo.has(relPath)),
    delete: removed.filter((relPath) => !movedFrom.has(relPath)),
    move: move.sort((a, b) => a.to.localeCompare(b.to)),
  };
};

/**
 * Compute the operations required to make the remote tree match the local
 * one, comparing content rather than timestamps.
 *
 * `before` is what the server is known to hold, which is why this takes
 * plain path -> hash maps: the remote inventory has no local stat data to
 * offer, and content is the only thing both sides can agree on. Timestamps
 * remain useful as a cheap gate for deciding what to re-hash, but they
 * cannot decide what to transfer - a file restored from a backup or checked
 * out from another branch has a wrong timestamp and correct content, or the
 * reverse, depending on which way the clock went.
 *
 * Results are sorted so that generated programs are deterministic and
 * readable in review.
 */
export const computeDiff = (after: ContentMap, before: ContentMap): Diff => {
  const beforePaths = Object.keys(before);
  const changed: string[] = [];
  const removed: string[] = [];

  for (const relPath of beforePaths) {
    if (!(relPath in after)) {
      removed.push(relPath);
    }
  }

  for (const [relPath, hash] of Object.entries(after)) {
    const previous = before[relPath];
    if (previous === undefined || previous !== hash) {
      changed.push(relPath);
    }
  }

  const paired = pairRenames(changed.sort(), removed.sort(), after, before);

  const beforeDirs = dirSet(beforePaths);
  const afterDirs = dirSet(Object.keys(after));

  return {
    put: paired.put,
    delete: paired.delete,
    move: paired.move,
    mkdir: collapseToLeaves([...afterDirs].filter((d) => !beforeDirs.has(d))),
    rmdir: deepestFirst([...beforeDirs].filter((d) => !afterDirs.has(d))),
  };
};
