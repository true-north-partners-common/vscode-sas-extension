// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "assert";

import {
  forgetSessionState,
  sessionState,
} from "../../../src/components/sync/core/sessionState";

describe("sync session state", () => {
  afterEach(() => forgetSessionState());

  it("keeps state across repeated lookups of the same session", () => {
    sessionState("session-a").environment = "options mrecall;";
    sessionState("session-a").verifiedRoots.add("/repo");

    const again = sessionState("session-a");
    assert.strictEqual(again.environment, "options mrecall;");
    assert.ok(again.verifiedRoots.has("/repo"));
  });

  it("tracks several roots within one session", () => {
    sessionState("session-a").verifiedRoots.add("/one");
    sessionState("session-a").verifiedRoots.add("/two");

    const state = sessionState("session-a");
    assert.ok(state.verifiedRoots.has("/one"));
    assert.ok(state.verifiedRoots.has("/two"));
  });

  // The reconnect this whole module exists for: the Session object is a
  // singleton that outlives its compute sessions, so a new id has to read as
  // a blank slate or the new session is credited with the old one's setup.
  it("drops everything when the compute session id changes", () => {
    sessionState("session-a").environment = "options mrecall;";
    sessionState("session-a").verifiedRoots.add("/repo");

    const reconnected = sessionState("session-b");
    assert.strictEqual(reconnected.environment, undefined);
    assert.strictEqual(reconnected.verifiedRoots.size, 0);
  });

  it("does not resurrect state when an old id comes back", () => {
    sessionState("session-a").environment = "options mrecall;";
    sessionState("session-b");

    assert.strictEqual(sessionState("session-a").environment, undefined);
  });

  it("starts clean after being forgotten", () => {
    sessionState("session-a").verifiedRoots.add("/repo");
    forgetSessionState();

    assert.strictEqual(sessionState("session-a").verifiedRoots.size, 0);
  });
});
