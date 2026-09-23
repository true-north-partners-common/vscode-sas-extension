import { Uri } from "vscode";

import { expect } from "chai";
import * as sinon from "sinon";

import LibraryNavigator from "../../../src/components/LibraryNavigator";
import PaginatedResultSet from "../../../src/components/LibraryNavigator/PaginatedResultSet";
import DataViewer from "../../../src/panels/DataViewer";
import TablePropertiesViewer from "../../../src/panels/TablePropertiesViewer";

interface WebviewMessagePanel {
  webview: {
    postMessage: (message: { command: string }) => boolean;
  };
}

class RefreshTrackingPanel {
  public readonly refreshData = sinon.spy();
}

const createDataViewer = () =>
  new DataViewer(
    Uri.file("C:/temp"),
    "WORK.T_REFRESH",
    new PaginatedResultSet(async () => ({ data: { rows: [], count: 0 } })),
    () => [],
    () => {},
  );

const createTablePropertiesViewer = () =>
  new TablePropertiesViewer(
    Uri.file("C:/temp"),
    "WORK.T_REFRESH",
    {
      name: "T_REFRESH",
      libref: "WORK",
    },
    [
      {
        name: "date",
        type: "num",
        format: "YYMMDD10.",
        index: 2,
        formatCategory: "date",
      },
    ],
    false,
    "",
    async () => ({ name: "T_REFRESH", libref: "WORK" }),
    async () => [
      {
        name: "updatedDate",
        type: "num",
        format: "YYMMDD10.",
        index: 2,
        formatCategory: "date",
      },
    ],
  );

describe("LibraryNavigator refresh flow", async function () {
  it("DataViewer.refreshData posts panel refresh message", () => {
    const dataViewer = createDataViewer();
    const postMessage = sinon.spy();

    const panel: WebviewMessagePanel = {
      webview: {
        postMessage,
      },
    };

    Object.defineProperty(dataViewer, "panel", {
      value: panel,
    });

    dataViewer.refreshData();

    expect(
      postMessage.calledOnceWithExactly({
        command: "panel:refreshData",
      }),
    ).to.equal(true);
  });

  it("refreshOpenTableViewers refreshes open DataViewer and TablePropertiesViewer panels", () => {
    const navigator: LibraryNavigator = Object.create(
      LibraryNavigator.prototype,
    );

    const tableViewer = createDataViewer();
    const tableViewerRefresh = sinon.stub(tableViewer, "refreshData");
    const tablePropertiesViewer = createTablePropertiesViewer();
    const tablePropertiesViewerRefresh = sinon.stub(
      tablePropertiesViewer,
      "refreshData",
    );
    const nonTablePanel = new RefreshTrackingPanel();
    const webviewManager = {
      panels: {
        table: tableViewer,
        tableProperties: tablePropertiesViewer,
        other: nonTablePanel,
      },
    };

    Object.defineProperty(navigator, "webviewManager", {
      value: webviewManager,
    });

    navigator.refreshOpenTableViewers();

    expect(tableViewerRefresh.calledOnce).to.equal(true);
    expect(tablePropertiesViewerRefresh.calledOnce).to.equal(true);
    expect(nonTablePanel.refreshData.called).to.equal(false);
  });

  it("refreshWhenVisible defers a hidden panel's refresh until it's shown", () => {
    const dataViewer = createDataViewer();
    const refreshData = sinon.stub(dataViewer, "refreshData");
    let viewStateListener: (e: {
      webviewPanel: { active: boolean; visible: boolean };
    }) => void;
    const panel = {
      visible: false,
      onDidDispose: () => undefined,
      onDidChangeViewState: (listener: typeof viewStateListener) => {
        viewStateListener = listener;
      },
      webview: {
        onDidReceiveMessage: () => undefined,
        postMessage: () => true,
      },
    };
    // @ts-expect-error a partial panel is enough for these listeners
    dataViewer.withPanel(panel);

    dataViewer.refreshWhenVisible();
    expect(refreshData.called).to.equal(false);

    panel.visible = true;
    viewStateListener({ webviewPanel: { active: true, visible: true } });
    expect(refreshData.calledOnce).to.equal(true);

    // Shown again with nothing pending: no second refresh
    viewStateListener({ webviewPanel: { active: true, visible: true } });
    expect(refreshData.calledOnce).to.equal(true);
  });
});
