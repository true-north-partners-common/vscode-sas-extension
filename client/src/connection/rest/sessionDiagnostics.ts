// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Seconds an idle compute session survives when nothing says otherwise.
 *
 * The server does not write this default into the context it hands back, so an
 * absent attribute is not "no timeout" - it means this value is the one in
 * force.
 */
export const DEFAULT_SESSION_INACTIVE_TIMEOUT = 900;

/**
 * Where a session's idle timeout could have come from. The profile value is the
 * one we put on the session request; the context value is whatever the
 * deployment already had.
 */
export interface SessionTimeoutSources {
  contextName?: string;
  contextTimeout?: unknown;
  profileTimeout?: unknown;
}

const inMinutes = (seconds: number): string => {
  const value = Math.round((seconds / 60) * 10) / 10;
  return `${value} minute${value === 1 ? "" : "s"}`;
};

// The attribute arrives as untyped JSON, and the server reads a negative value
// as "unset", so anything unusable comes back undefined rather than echoed.
const asTimeout = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

const describe = (timeout: number, source: string): string =>
  timeout === 0
    ? `sessionInactiveTimeout is 0${source}, so the session will not be ended for being idle.`
    : `sessionInactiveTimeout is ${timeout} seconds (${inMinutes(
        timeout,
      )})${source}. The session ends itself once it has been idle that long.`;

/**
 * Say, in one sentence, how long this session may sit idle before the server
 * ends it, and on whose authority.
 */
export const describeSessionTimeout = (
  sources: SessionTimeoutSources = {},
): string => {
  const profileTimeout = asTimeout(sources.profileTimeout);
  if (profileTimeout !== undefined) {
    return describe(profileTimeout, ", set by this connection profile");
  }

  const contextTimeout = asTimeout(sources.contextTimeout);
  const onContext = sources.contextName
    ? ` on compute context "${sources.contextName}"`
    : " for this session";

  if (contextTimeout !== undefined) {
    return describe(contextTimeout, onContext);
  }

  return `sessionInactiveTimeout is not set${onContext}, so the default of ${DEFAULT_SESSION_INACTIVE_TIMEOUT} seconds (${inMinutes(
    DEFAULT_SESSION_INACTIVE_TIMEOUT,
  )}) applies. The session ends itself once it has been idle that long.`;
};

/**
 * The lines written to the SAS log when a session is created.
 *
 * Worth having because nothing else says a new session was started, and a
 * session quietly replaced between two runs is the usual explanation for work
 * that was there a moment ago having gone.
 */
export const sessionDiagnosticLines = (
  sessionId: string,
  sources: SessionTimeoutSources = {},
): string[] => {
  const lines = [
    `NOTE: SAS compute session ${sessionId} started.`,
    `NOTE: ${describeSessionTimeout(sources)}`,
  ];

  // SAS documents both places the attribute can be set but never says which
  // wins, and every neighbouring attribute in the same table is context-wins.
  // Say so rather than let the profile look authoritative when it may not be.
  if (
    asTimeout(sources.profileTimeout) !== undefined &&
    asTimeout(sources.contextTimeout) !== undefined
  ) {
    lines.push(
      `NOTE: compute context "${sources.contextName}" also sets sessionInactiveTimeout to ${asTimeout(
        sources.contextTimeout,
      )} seconds. Which of the two applies is not documented.`,
    );
  }

  return lines;
};
