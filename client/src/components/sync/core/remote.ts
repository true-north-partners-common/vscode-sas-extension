// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { posix } from "path";

/** One entry as the compute files API reports it. */
export interface RemoteMember {
  name: string;
  isDirectory: boolean;
}

export interface MemberPage {
  items: RemoteMember[];
  /** The API documents this as optional, so it cannot be the only stop rule. */
  count?: number;
}

export type FetchPage = (
  absDirPath: string,
  start: number,
  limit: number,
) => Promise<MemberPage>;

/**
 * The documented default is 10, which would turn a directory listing into a
 * request per ten files. A hundred is already used elsewhere in this
 * extension against the same endpoint.
 */
export const PAGE_SIZE = 100;

/** Bound the walk so a wide tree does not open a request per directory at once. */
const DIRECTORY_CONCURRENCY = 8;

/**
 * Read every member of one directory, following pages.
 *
 * Two stop conditions rather than one: `count` is documented as optional, so
 * a short page has to end the loop on its own. Trusting only `count` would
 * spin forever against a server that omits it, and trusting only page length
 * would stop early on a server that pads.
 */
export const listDirectory = async (
  absDirPath: string,
  fetchPage: FetchPage,
): Promise<RemoteMember[]> => {
  const members: RemoteMember[] = [];

  for (let start = 0; ; start += PAGE_SIZE) {
    const page = await fetchPage(absDirPath, start, PAGE_SIZE);
    members.push(...page.items);

    if (page.items.length < PAGE_SIZE) {
      return members;
    }
    if (page.count !== undefined && members.length >= page.count) {
      return members;
    }
  }
};

const chunk = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
};

/**
 * Every file beneath a remote root, as paths relative to it.
 *
 * There is no recursive listing on the compute files API, so this costs one
 * request per directory plus paging. That is the price of knowing what is
 * actually on the server rather than what we believe we put there - and
 * believing is not good enough for a one-way mirror, where a file deleted
 * out of band has to come back.
 *
 * Directories are walked a level at a time so siblings overlap instead of
 * waiting on each other's round trip.
 */
export const listTree = async (
  absRoot: string,
  fetchPage: FetchPage,
): Promise<string[]> => {
  const files: string[] = [];
  let frontier = [absRoot];

  while (frontier.length > 0) {
    const next: string[] = [];

    for (const group of chunk(frontier, DIRECTORY_CONCURRENCY)) {
      const listings = await Promise.all(
        group.map(async (dir) => ({
          dir,
          members: await listDirectory(dir, fetchPage),
        })),
      );

      for (const { dir, members } of listings) {
        for (const member of members) {
          const absPath = posix.join(dir, member.name);
          if (member.isDirectory) {
            next.push(absPath);
          } else {
            files.push(posix.relative(absRoot, absPath));
          }
        }
      }
    }

    frontier = next;
  }

  return files.sort();
};
