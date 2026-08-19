// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { FileTimes } from "./snapshot";

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
  mkdir: string[];
  rmdir: string[];
}

/**
 * Directory churn on its own is not work worth doing, so it does not count
 * towards emptiness.
 */
export const diffIsEmpty = (diff: Diff): boolean =>
  diff.put.length === 0 && diff.delete.length === 0;

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
 * Compute the operations required to make the remote tree match the local
 * one. Takes the mtime maps rather than whole snapshots - the remote root
 * and schema version are storage identity, and the diff must not depend on
 * them.
 *
 * Results are sorted so that generated programs are deterministic and
 * readable in review.
 */
export const computeDiff = (after: FileTimes, before: FileTimes): Diff => {
  const beforePaths = Object.keys(before);
  const put: string[] = [];
  const removed: string[] = [];

  for (const relPath of beforePaths) {
    if (!(relPath in after)) {
      removed.push(relPath);
    }
  }

  for (const [relPath, mtime] of Object.entries(after)) {
    const previous = before[relPath];
    if (previous === undefined || mtime > previous) {
      put.push(relPath);
    }
  }

  const beforeDirs = dirSet(beforePaths);
  const afterDirs = dirSet(Object.keys(after));

  return {
    put: put.sort(),
    delete: removed.sort(),
    mkdir: collapseToLeaves([...afterDirs].filter((d) => !beforeDirs.has(d))),
    rmdir: deepestFirst([...beforeDirs].filter((d) => !afterDirs.has(d))),
  };
};
