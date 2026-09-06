// Copyright © 2022-2023, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { ProgressLocation, l10n, window } from "vscode";

import type { OnLogFn, RunResult } from ".";

export type SessionContextAttributes =
  | {
      fileNavigationCustomRootPath: string | undefined;
      fileNavigationRoot: "CUSTOM" | "SYSTEM" | "USER" | undefined;
    }
  | undefined;

export abstract class Session {
  protected _rejectRun: (reason?: unknown) => void | undefined;
  protected _connectionPromise: Promise<void> | undefined;

  protected _onSessionLogFn: OnLogFn | undefined;
  public set onSessionLogFn(value: OnLogFn) {
    this._onSessionLogFn = value;
  }

  protected _onExecutionLogFn: OnLogFn | undefined;
  public get onExecutionLogFn(): OnLogFn | undefined {
    return this._onExecutionLogFn;
  }
  public set onExecutionLogFn(value: OnLogFn | undefined) {
    this._onExecutionLogFn = value;
  }

  async setup(silent?: boolean): Promise<void> {
    // If we already have a connection promise we're awaiting, lets use that.
    // Otherwise, establish a new connection
    const connectionPromise = (this._connectionPromise ||=
      this.establishConnection());

    // Clear the memo however the attempt ends, not just when it succeeds.
    // A retained rejection wedges the session for good: every later setup()
    // short-circuits on the settled promise and re-throws the original
    // failure without ever trying to connect again.
    const awaitConnection = async () => {
      try {
        return await connectionPromise;
      } finally {
        // close() may have cleared it, or a later attempt replaced it.
        if (this._connectionPromise === connectionPromise) {
          this._connectionPromise = undefined;
        }
      }
    };

    if (silent) {
      return await awaitConnection();
    }

    await window.withProgress(
      {
        location: ProgressLocation.Notification,
        title: l10n.t("Connecting to SAS session..."),
      },
      awaitConnection,
    );
  }

  protected abstract establishConnection(): Promise<void>;

  run(code: string, ...args): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      this._rejectRun = reject;
      this._run(code, ...args)
        .then(resolve, reject)
        .finally(() => (this._rejectRun = undefined));
    });
  }
  protected abstract _run(code: string, ...args): Promise<RunResult>;

  cancel?(): Promise<void>;

  close(): Promise<void> | void {
    if (this._rejectRun) {
      this._rejectRun({ message: l10n.t("The SAS session has closed.") });
      this._rejectRun = undefined;
    }
    this._connectionPromise = undefined;
    return this._close();
  }
  protected abstract _close(): Promise<void> | void;

  abstract sessionId?(): string | undefined;

  contextAttributes?(): Promise<SessionContextAttributes>;
}
