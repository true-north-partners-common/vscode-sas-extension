// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * What has already been done to the compute session we are talking to.
 *
 * Keyed by the compute session id rather than by the Session object, because
 * getSession() hands back a singleton that outlives the compute sessions it
 * wraps: an idle timeout swaps the compute session underneath it while the
 * object identity - and so anything keyed on that identity - stays put. State
 * keyed the wrong way survives a reconnect and reports work as done that the
 * new session never saw, which is only recoverable by restarting the
 * extension host.
 *
 * Only one compute session is live at a time, so a change of id replaces the
 * previous entry rather than accumulating one per session.
 */
export interface SessionState {
  /** The environment program last submitted to this session, if any. */
  environment?: string;
  /** Remote roots whose contents have been listed for this session. */
  verifiedRoots: Set<string>;
}

let current: { sessionId: string; state: SessionState } | undefined;

export const sessionState = (sessionId: string): SessionState => {
  if (current?.sessionId !== sessionId) {
    current = { sessionId, state: { verifiedRoots: new Set<string>() } };
  }
  return current.state;
};

/**
 * Forget everything remembered about the current session.
 *
 * Nothing on the connection side announces a session ending, so this is not
 * wired to a close event; it exists so a caller that does know can say so.
 */
export const forgetSessionState = (): void => {
  current = undefined;
};
