// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "assert";

import {
  DEFAULT_SESSION_INACTIVE_TIMEOUT,
  describeSessionTimeout,
  sessionDiagnosticLines,
} from "../../src/connection/rest/sessionDiagnostics";

describe("connection/sessionDiagnostics", () => {
  describe("describeSessionTimeout", () => {
    it("reports a context timeout in seconds and minutes", () => {
      const description = describeSessionTimeout({
        contextName: "My Context",
        contextTimeout: 3600,
      });

      assert.ok(description.includes("3600 seconds"));
      assert.ok(description.includes("60 minutes"));
      assert.ok(description.includes('compute context "My Context"'));
    });

    it("reports zero as never ending the session", () => {
      const description = describeSessionTimeout({
        contextName: "My Context",
        contextTimeout: 0,
      });

      assert.ok(description.includes("will not be ended for being idle"));
      assert.ok(!description.includes(`${DEFAULT_SESSION_INACTIVE_TIMEOUT}`));
    });

    it("falls back to the default when nothing sets the attribute", () => {
      // The server does not write its default into the context it returns, so
      // an absent attribute has to be read as "the default is in force".
      const description = describeSessionTimeout({ contextName: "My Context" });

      assert.ok(description.includes("is not set"));
      assert.ok(
        description.includes(`${DEFAULT_SESSION_INACTIVE_TIMEOUT} seconds`),
      );
      assert.ok(description.includes("15 minutes"));
    });

    it("treats a negative timeout as unset, as the server does", () => {
      assert.deepStrictEqual(
        describeSessionTimeout({ contextName: "c", contextTimeout: -1 }),
        describeSessionTimeout({ contextName: "c" }),
      );
    });

    it("treats junk from the server as unset rather than echoing it", () => {
      for (const value of [null, "900", {}, [], NaN, Infinity]) {
        assert.deepStrictEqual(
          describeSessionTimeout({ contextName: "c", contextTimeout: value }),
          describeSessionTimeout({ contextName: "c" }),
          `expected ${JSON.stringify(value)} to read as unset`,
        );
      }
    });

    it("prefers the profile value, since that is what we send", () => {
      const description = describeSessionTimeout({
        contextName: "My Context",
        contextTimeout: 900,
        profileTimeout: 7200,
      });

      assert.ok(description.includes("7200 seconds"));
      assert.ok(description.includes("set by this connection profile"));
      assert.ok(!description.includes("900 seconds"));
    });

    it("ignores an unusable profile value and falls back", () => {
      assert.deepStrictEqual(
        describeSessionTimeout({
          contextName: "c",
          contextTimeout: 60,
          profileTimeout: -5,
        }),
        describeSessionTimeout({ contextName: "c", contextTimeout: 60 }),
      );
    });

    it("omits the context when there isn't one", () => {
      const description = describeSessionTimeout({ contextTimeout: 900 });

      assert.ok(!description.includes("compute context"));
      assert.ok(description.includes("for this session"));
    });

    it("says minute, singular, for sixty seconds", () => {
      const description = describeSessionTimeout({ contextTimeout: 60 });

      assert.ok(description.includes("1 minute"));
      assert.ok(!description.includes("1 minutes"));
    });
  });

  describe("sessionDiagnosticLines", () => {
    it("names the session so it can be matched against server logs", () => {
      const [started, timeout] = sessionDiagnosticLines("abc-123", {
        contextName: "My Context",
        contextTimeout: 900,
      });

      assert.strictEqual(started, "NOTE: SAS compute session abc-123 started.");
      assert.ok(timeout.startsWith("NOTE: "));
      assert.ok(timeout.includes("900 seconds"));
    });

    it("flags the undocumented precedence when both sources set a value", () => {
      const lines = sessionDiagnosticLines("abc-123", {
        contextName: "My Context",
        contextTimeout: 900,
        profileTimeout: 7200,
      });

      assert.strictEqual(lines.length, 3);
      assert.ok(lines[2].includes("also sets sessionInactiveTimeout to 900"));
      assert.ok(lines[2].includes("not documented"));
    });

    it("stays quiet about precedence when only one source sets a value", () => {
      for (const sources of [
        { contextName: "c", contextTimeout: 900 },
        { contextName: "c", profileTimeout: 7200 },
        { contextName: "c" },
      ]) {
        assert.strictEqual(
          sessionDiagnosticLines("abc-123", sources).length,
          2,
          `expected two lines for ${JSON.stringify(sources)}`,
        );
      }
    });
  });
});
