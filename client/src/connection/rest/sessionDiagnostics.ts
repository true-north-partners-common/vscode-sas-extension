// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Seconds an idle compute session survives when nothing says otherwise.
 *
 * Viya does not write this default into the context it hands back, so an absent
 * attribute is not "no timeout" - it means this value is the one in force.
 */
export const DEFAULT_SESSION_INACTIVE_TIMEOUT = 900;

const inMinutes = (seconds: number): string => {
  const value = Math.round((seconds / 60) * 10) / 10;
  return `${value} minute${value === 1 ? "" : "s"}`;
};

/**
 * Say, in one sentence, how long this session may sit idle before the server
 * ends it.
 *
 * The attribute arrives as untyped JSON, so anything that is not a usable
 * positive number is reported as the default rather than echoed back.
 */
export const describeSessionTimeout = (
  contextName: string | undefined,
  sessionInactiveTimeout: unknown,
): string => {
  const source = contextName
    ? ` on compute context "${contextName}"`
    : " for this session";

  if (
    typeof sessionInactiveTimeout !== "number" ||
    !Number.isFinite(sessionInactiveTimeout) ||
    sessionInactiveTimeout < 0
  ) {
    return `sessionInactiveTimeout is not set${source}, so the default of ${DEFAULT_SESSION_INACTIVE_TIMEOUT} seconds (${inMinutes(
      DEFAULT_SESSION_INACTIVE_TIMEOUT,
    )}) applies. The session ends itself once it has been idle that long.`;
  }

  if (sessionInactiveTimeout === 0) {
    return `sessionInactiveTimeout is 0${source}, so the session will not be ended for being idle.`;
  }

  return `sessionInactiveTimeout is ${sessionInactiveTimeout} seconds (${inMinutes(
    sessionInactiveTimeout,
  )})${source}. The session ends itself once it has been idle that long.`;
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
  contextName: string | undefined,
  sessionInactiveTimeout: unknown,
): string[] => [
  `NOTE: SAS compute session ${sessionId} started.`,
  `NOTE: ${describeSessionTimeout(contextName, sessionInactiveTimeout)}`,
];
