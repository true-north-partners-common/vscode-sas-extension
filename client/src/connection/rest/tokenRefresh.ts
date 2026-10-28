// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { authentication } from "vscode";

import axios, { AxiosError, InternalAxiosRequestConfig } from "axios";

import { SASAuthProvider } from "../../components/AuthProvider";
import { getApiConfig } from "./common";

type RetriedRequest = InternalAxiosRequestConfig & { sasTokenRetry?: boolean };

// Refreshing is itself a request, and it must not be able to trigger another
// refresh.
const isTokenRequest = (request: InternalAxiosRequestConfig): boolean =>
  (request.url ?? "").includes("/SASLogon/oauth/token");

let inFlight: Promise<string | undefined> | undefined;

/**
 * Put a current token on the shared api config.
 *
 * A job being polled has two requests in the air at a time and a long job has
 * hundreds in a row, so an expiry tends to arrive as a burst of 401s rather
 * than one. They share a single refresh: several at once would otherwise race
 * to write the config, and could each raise their own sign-in prompt.
 */
const refreshAccessToken = async (): Promise<string | undefined> => {
  inFlight ??= (async () => {
    try {
      // createIfNone would open a browser for a fresh sign-in, which is the
      // wrong thing to do behind a poll the user is not watching. Asking for
      // the existing session still runs the provider's refresh; if that has
      // nothing left to refresh with, the original 401 stands and the next
      // thing the user does deliberately will prompt them properly.
      const session = await authentication.getSession(SASAuthProvider.id, [], {
        createIfNone: false,
      });
      if (!session) {
        return undefined;
      }

      getApiConfig().accessToken = session.accessToken;
      return session.accessToken;
    } catch {
      // The refresh grant is gone, or the user dismissed the sign-in. Let the
      // original 401 stand rather than replacing it with this.
      return undefined;
    } finally {
      inFlight = undefined;
    }
  })();

  return await inFlight;
};

let installed = false;

/**
 * Re-authenticate once when the compute api rejects a token, then try again.
 *
 * The token is read from the shared api config at send time but only written
 * when a connection is established, so a job outliving its token had every
 * later request refused with nothing putting a current one in place. The SAS
 * Content tree has had an interceptor of its own for this; the compute path,
 * which is where the long-running work happens, had none.
 *
 * This installs on the default axios instance, which is what the generated
 * compute client sends through. Instances made with axios.create - the content
 * tree's among them - keep their own interceptors and are unaffected.
 */
export const installTokenRefresh = (): void => {
  if (installed) {
    return;
  }
  installed = true;

  axios.interceptors.response.use(undefined, async (error: AxiosError) => {
    const request: RetriedRequest | undefined = error.config;

    if (
      error.response?.status !== 401 ||
      !request ||
      request.sasTokenRetry ||
      isTokenRequest(request)
    ) {
      throw error;
    }

    request.sasTokenRetry = true;

    const accessToken = await refreshAccessToken();
    if (!accessToken) {
      throw error;
    }

    request.headers.Authorization = `Bearer ${accessToken}`;
    return await axios.request(request);
  });
};
