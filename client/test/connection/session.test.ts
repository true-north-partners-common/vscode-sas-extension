import { expect } from "chai";
import * as sinon from "sinon";

import { RunResult } from "../../src/connection";
import { Session } from "../../src/connection/session";

class MockSession extends Session {
  constructor(
    protected readonly connectionMock: () => void,
    protected readonly failures = 0,
  ) {
    super();
  }
  private attempts = 0;
  protected async establishConnection(): Promise<void> {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        this.connectionMock();
        if (this.attempts++ < this.failures) {
          reject(new Error("connect failed"));
          return;
        }
        resolve();
      }, 100);
    });
  }
  protected _run(code: string, ...args: any[]): Promise<RunResult> {
    throw new Error("Method not implemented.");
  }
  protected _close(): Promise<void> | void {}
  sessionId?(): string | undefined {
    return;
  }
}

describe("Session test", () => {
  it("triggers establish connection only once", async () => {
    const mockConnectionFn = sinon.mock();
    const mockSession = new MockSession(mockConnectionFn);
    const setupPromises: Promise<void>[] = Array(10)
      .fill(true)
      .map(() => mockSession.setup());

    // Wait for everything to wrap up
    await Promise.all(setupPromises);

    // We called setup 10 times, but we expect to have only called establishConnection
    // once.
    expect(mockConnectionFn.callCount).to.equal(1);
  });

  // A retained rejection used to wedge the session until the extension host
  // restarted, because setup() only cleared the memo on the success path.
  it("retries establish connection after a failed setup", async () => {
    // A stub rather than a mock: an anonymous mock allows only one call, and
    // retrying is the whole point here.
    const mockConnectionFn = sinon.stub();
    const mockSession = new MockSession(mockConnectionFn, 1);

    let firstError: string | undefined;
    try {
      await mockSession.setup();
    } catch (error) {
      firstError = error instanceof Error ? error.message : String(error);
    }
    expect(firstError).to.equal("connect failed");

    // The second attempt has to reach establishConnection again rather than
    // re-throwing the memoized rejection.
    await mockSession.setup();

    expect(mockConnectionFn.callCount).to.equal(2);
  });

  it("does not retry while a connection attempt is still in flight", async () => {
    const mockConnectionFn = sinon.stub();
    const mockSession = new MockSession(mockConnectionFn, 1);

    const attempts = [mockSession.setup(), mockSession.setup()];
    await Promise.allSettled(attempts);

    expect(mockConnectionFn.callCount).to.equal(1);
  });
});
