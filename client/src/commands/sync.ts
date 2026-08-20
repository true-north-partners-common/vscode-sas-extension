// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { ProgressLocation, l10n, window } from "vscode";

import { syncWorkspace } from "../components/sync";
import { getSession } from "../connection";
import { profileConfig, switchProfile } from "./profile";

export const resyncWorkspace = async (): Promise<void> => {
  if (profileConfig.getActiveProfile() === "") {
    await switchProfile();
    return;
  }

  const session = getSession();
  await session.setup();

  await window.withProgress(
    {
      location: ProgressLocation.Notification,
      title: l10n.t("Resyncing workspace to SAS..."),
      cancellable: typeof session.cancel === "function",
    },
    async (_progress, cancellationToken) => {
      cancellationToken.onCancellationRequested(() => {
        session.cancel?.();
      });
      const synced = await syncWorkspace(
        session,
        window.activeTextEditor?.document.uri,
        cancellationToken,
        { force: true },
      );

      if (!synced) {
        window.showInformationMessage(
          l10n.t("Workspace sync is not configured for the active profile."),
        );
        return;
      }

      window.showInformationMessage(l10n.t("Workspace sync complete."));
    },
  );
};
