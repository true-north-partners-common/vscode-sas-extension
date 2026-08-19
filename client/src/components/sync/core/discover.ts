// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/** Injected so tests can exercise the parsing without shelling out. */
export type GitRunner = (
  args: string[],
  cwd: string,
  signal?: AbortSignal,
) => Promise<string>;

export interface DiscoverOptions {
  signal?: AbortSignal;
  run?: GitRunner;
}

/** Raised when git itself is missing, as opposed to the folder not being a repo. */
export class GitNotFoundError extends Error {}

/**
 * Windows git reports paths differently depending on the drive letter's case.
 * See microsoft/vscode#89373.
 */
const sanitizeCwd = (cwd: string): string =>
  cwd.replace(/^([a-z]):\\/, (_, letter) => `${letter.toUpperCase()}:\\`);

const execGit: GitRunner = async (args, cwd, signal) => {
  const { stdout } = await execFileAsync("git", args, {
    cwd: sanitizeCwd(cwd),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
    windowsHide: true,
    signal,
    env: {
      ...process.env,
      // Stable, parseable output that can never block on a prompt or take
      // an index lock.
      LC_ALL: "C",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_PAGER: "cat",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return stdout;
};

const isEnoent = (error: unknown): boolean =>
  error instanceof Error && /ENOENT/.test(error.message);

/**
 * List the files to sync, relative to syncRoot.
 *
 * Git is the only source of truth for scope. Running from syncRoot means git
 * locates the worktree root itself, so ignore rules resolve from the
 * repository root - including nested .gitignore files - while only the
 * subtree below syncRoot is listed. That is what makes a monorepo subtree
 * work without any additional configuration.
 *
 * To exclude something, add it to .gitignore. There is deliberately no
 * second filtering mechanism.
 *
 * Note that --cached lists files that are still tracked but no longer on
 * disk (deleted without `git rm`). The caller stats each path anyway, and
 * skips what it cannot read.
 */
export const discover = async (
  syncRoot: string,
  options: DiscoverOptions = {},
): Promise<string[]> => {
  const { signal, run = execGit } = options;

  let stdout: string;
  try {
    stdout = await run(
      [
        // Without this, non-ASCII paths come back octal-escaped and quoted.
        "-c",
        "core.quotepath=false",
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
      ],
      syncRoot,
      signal,
    );
  } catch (error) {
    if (signal?.aborted) {
      // Let the caller recognise cancellation rather than a git failure.
      throw error;
    }
    if (isEnoent(error)) {
      throw new GitNotFoundError(
        "git was not found on PATH. Workspace sync needs git to decide which files to send.",
      );
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Unable to list files in ${syncRoot}. Workspace sync requires a git repository. (${detail})`,
    );
  }

  // -z gives NUL-separated paths, so filenames containing newlines or
  // quotes survive intact and no unquoting is needed.
  return stdout.split("\0").filter(Boolean).sort();
};
