// Copyright © 2022-2023, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { window } from "vscode";

import { getSession } from "../connection";
import { Session } from "../connection/session";

export async function closeSession(message?: string): Promise<void> {
  let session: Session;
  try {
    session = getSession();
  } catch {
    // no session, do nothing
  }
  await session?.close();
  if (message) {
    window.showInformationMessage(message);
  }
}

// VS Code only waits briefly for extensions to shut down, so a slow server
// mustn't hold it up; the session's idle timeout remains the fallback.
const CLOSE_ON_EXIT_TIMEOUT_MS = 3000;

/**
 * Ends the session when VS Code closes or reloads, so it doesn't keep running
 * on the server until its idle timeout. Skipped when the profile asks for the
 * session to be reconnected to next time.
 */
export async function closeSessionOnExit(): Promise<void> {
  let session: Session;
  try {
    session = getSession();
  } catch {
    return;
  }
  if (session.keepAliveOnExit?.()) {
    return;
  }
  await Promise.race([
    Promise.resolve(session.close()).catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, CLOSE_ON_EXIT_TIMEOUT_MS)),
  ]);
}
