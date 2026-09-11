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
    it("reports a configured timeout in seconds and minutes", () => {
      const description = describeSessionTimeout("My Context", 3600);

      assert.ok(description.includes("3600 seconds"));
      assert.ok(description.includes("60 minutes"));
      assert.ok(description.includes('compute context "My Context"'));
    });

    it("reports zero as never ending the session", () => {
      const description = describeSessionTimeout("My Context", 0);

      assert.ok(description.includes("will not be ended for being idle"));
      assert.ok(!description.includes(`${DEFAULT_SESSION_INACTIVE_TIMEOUT}`));
    });

    it("falls back to the default when the attribute is absent", () => {
      // Viya does not write its default into the context it returns, so an
      // absent attribute has to be read as "the default is in force".
      const description = describeSessionTimeout("My Context", undefined);

      assert.ok(description.includes("is not set"));
      assert.ok(
        description.includes(`${DEFAULT_SESSION_INACTIVE_TIMEOUT} seconds`),
      );
      assert.ok(description.includes("15 minutes"));
    });

    it("treats a negative timeout as the default, as the server does", () => {
      assert.deepStrictEqual(
        describeSessionTimeout("My Context", -1),
        describeSessionTimeout("My Context", undefined),
      );
    });

    it("treats junk from the server as the default rather than echoing it", () => {
      for (const value of [null, "900", {}, [], NaN, Infinity]) {
        assert.deepStrictEqual(
          describeSessionTimeout("My Context", value),
          describeSessionTimeout("My Context", undefined),
          `expected ${JSON.stringify(value)} to read as unset`,
        );
      }
    });

    it("omits the context when there isn't one", () => {
      const description = describeSessionTimeout(undefined, 900);

      assert.ok(!description.includes("compute context"));
      assert.ok(description.includes("for this session"));
    });

    it("says minute, singular, for sixty seconds", () => {
      assert.ok(describeSessionTimeout(undefined, 60).includes("1 minute"));
      assert.ok(!describeSessionTimeout(undefined, 60).includes("1 minutes"));
    });
  });

  describe("sessionDiagnosticLines", () => {
    it("names the session so it can be matched against server logs", () => {
      const [started, timeout] = sessionDiagnosticLines(
        "abc-123",
        "My Context",
        900,
      );

      assert.strictEqual(started, "NOTE: SAS compute session abc-123 started.");
      assert.ok(timeout.startsWith("NOTE: "));
      assert.ok(timeout.includes("900 seconds"));
    });
  });
});
