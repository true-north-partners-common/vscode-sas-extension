// Copyright © 2023, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState } from "react";

import {
  type Column as GridColumn,
  SlickGrid,
  SlickHybridSelectionModel,
  SlickRange,
} from "@slickgrid-universal/common";

import { v4 } from "uuid";

import type {
  SortModelItem,
  TableData,
  TableQuery,
} from "../components/LibraryNavigator/types";
import { Column } from "../connection/rest/api/compute";
import { renderColumnHeader } from "./ColumnHeader";
import { ColumnMenuProps, GridController, getColumnMenu } from "./ColumnMenu";
import RemoteDataModel, { Row } from "./RemoteDataModel";
import localize from "./localize";

declare const acquireVsCodeApi;
const vscode = acquireVsCodeApi();

export const ROW_NUMBER_COLUMN = "#";
// Copying more than this many rows at once would mean paging through the
// whole table; the download command is the better tool for that.
const MAX_COPY_ROWS = 10000;
const defaultTimeout = 60 * 1000; // 60 seconds (accounting for compute session expiration)

const request = <T>(command: string, data?: unknown): Promise<T> => {
  const key = v4();
  vscode.postMessage({ command: `request:${command}`, key, data });

  return new Promise((resolve, reject) => {
    const handler = (event: MessageEvent) => {
      if (
        event.data.key !== key ||
        event.data.command !== `response:${command}`
      ) {
        return;
      }
      window.removeEventListener("message", handler);
      clearTimeout(timeoutId);
      resolve(event.data.data);
    };
    const timeoutId = setTimeout(() => {
      window.removeEventListener("message", handler);
      reject(new Error("Timeout exceeded"));
    }, defaultTimeout);
    window.addEventListener("message", handler);
  });
};

// Tab-separated values, quoted the way spreadsheets expect when pasting.
const toClipboardValue = (value: unknown): string => {
  const text = value === null || value === undefined ? "" : String(value);
  return /[\t\n\r"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export interface CellMenuState {
  left: number;
  top: number;
}

const useDataViewer = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<SlickGrid | undefined>(undefined);
  const modelRef = useRef<RemoteDataModel | undefined>(undefined);
  const queryRef = useRef<TableQuery | undefined>(undefined);
  const sortModelRef = useRef<SortModelItem[]>([]);
  const columnTypesRef = useRef<Record<string, string>>({});
  // Columns pinned by the user. The row number column is always pinned too.
  const pinnedCountRef = useRef(0);

  const [columns, setColumns] = useState<Column[]>([]);
  const [columnMenu, setColumnMenu] = useState<ColumnMenuProps | undefined>();
  const [cellMenu, setCellMenu] = useState<CellMenuState | undefined>();
  const [noRows, setNoRows] = useState(false);

  const columnMenuRef = useRef<ColumnMenuProps | undefined>(columnMenu);
  useEffect(() => {
    columnMenuRef.current = columnMenu;
  }, [columnMenu]);

  const loadViewport = useCallback(() => {
    const grid = gridRef.current;
    const model = modelRef.current;
    if (!grid || !model) {
      return;
    }
    const { top, bottom } = grid.getViewport();
    model.ensureRange(top, bottom).catch(() => {
      // Errors are reported by the extension host.
    });
  }, []);

  const reloadData = useCallback(() => {
    const grid = gridRef.current;
    if (!grid || !modelRef.current) {
      return;
    }
    modelRef.current.reset();
    setNoRows(false);
    grid.getSelectionModel()?.setSelectedRanges([]);
    grid.invalidateAllRows();
    grid.updateRowCount();
    grid.scrollRowToTop(0);
    grid.render();
    loadViewport();
  }, [loadViewport]);

  const refreshResults = useCallback(
    (query: TableQuery | undefined) => {
      queryRef.current = queryRef.current
        ? { ...queryRef.current, ...(query || {}) }
        : query;
      reloadData();
    },
    [reloadData],
  );

  const applySortModel = useCallback(
    (sortModel: SortModelItem[]) => {
      sortModelRef.current = sortModel;
      gridRef.current?.setSortColumns(
        sortModel.map(({ colId, sort }) => ({
          columnId: colId,
          sortAsc: sort === "asc",
        })),
      );
      reloadData();
    },
    [reloadData],
  );

  const setPinned = useCallback((columnId: string, pinned: boolean) => {
    const grid = gridRef.current;
    if (!grid) {
      return;
    }
    const gridColumns = [...grid.getColumns()];
    const index = gridColumns.findIndex((c) => c.id === columnId);
    const isPinned = index <= pinnedCountRef.current;
    if (index < 0 || isPinned === pinned) {
      return;
    }
    const [column] = gridColumns.splice(index, 1);
    if (pinned) {
      // Place after the last pinned column (index 0 is the row number column)
      gridColumns.splice(pinnedCountRef.current + 1, 0, column);
      pinnedCountRef.current++;
    } else {
      pinnedCountRef.current--;
      gridColumns.splice(pinnedCountRef.current + 1, 0, column);
    }
    grid.setOptions({ frozenColumn: pinnedCountRef.current }, false, true);
    grid.setColumns(gridColumns);
  }, []);

  const controller: GridController = {
    getSortModel: () => sortModelRef.current,
    setSortModel: applySortModel,
    isPinned: (columnId) => {
      const index = gridRef.current
        ?.getColumns()
        .findIndex((c) => c.id === columnId);
      return (
        index !== undefined && index > 0 && index <= pinnedCountRef.current
      );
    },
    setPinned,
  };
  const controllerRef = useRef(controller);
  controllerRef.current = controller;

  const dismissMenu = useCallback((focusColumn: boolean = true) => {
    const columnId = columnMenuRef.current?.columnId;
    if (focusColumn && columnId !== undefined && gridRef.current) {
      const index = gridRef.current.getColumnIndex(columnId);
      gridRef.current.getHeaderColumn(index)?.focus();
    }
    setColumnMenu(undefined);
  }, []);

  const displayMenuForColumn = useCallback(
    (columnId: string, rect: DOMRect) => {
      if (columnMenuRef.current) {
        return setColumnMenu(undefined);
      }
      setCellMenu(undefined);
      setColumnMenu(
        getColumnMenu(
          controllerRef.current,
          columnId,
          rect,
          dismissMenu,
          (columnName: string) => {
            vscode.postMessage({
              command: "request:loadColumnProperties",
              data: { columnName },
            });
          },
        ),
      );
    },
    [dismissMenu],
  );

  const copySelection = useCallback(async (includeHeaders: boolean) => {
    const grid = gridRef.current;
    const model = modelRef.current;
    if (!grid || !model) {
      return;
    }
    let ranges = grid.getSelectionModel()?.getSelectedRanges() ?? [];
    const activeCell = grid.getActiveCell();
    if (ranges.length === 0 && activeCell) {
      ranges = [new SlickRange(activeCell.row, activeCell.cell)];
    }
    if (ranges.length === 0) {
      return;
    }

    const gridColumns = grid.getColumns();
    let fromCell = Math.min(...ranges.map((r) => r.fromCell));
    const toCell = Math.max(...ranges.map((r) => r.toCell));
    // Leave out row numbers unless they're all that was selected
    if (gridColumns[fromCell]?.id === ROW_NUMBER_COLUMN && toCell > fromCell) {
      fromCell++;
    }
    const fromRow = Math.min(...ranges.map((r) => r.fromRow));
    const lastRow = Math.min(
      Math.max(...ranges.map((r) => r.toRow)),
      model.getLength() - 1,
    );
    const toRow = Math.min(lastRow, fromRow + MAX_COPY_ROWS - 1);

    const copiedColumns = gridColumns.slice(fromCell, toCell + 1);
    const isSelected = (row: number, cell: number) =>
      ranges.some((range) => range.contains(row, cell));

    const lines: string[] = [];
    if (includeHeaders) {
      lines.push(
        copiedColumns
          .map((column, i) =>
            ranges.some(
              (r) => fromCell + i >= r.fromCell && fromCell + i <= r.toCell,
            )
              ? toClipboardValue(column.id)
              : "",
          )
          .join("\t"),
      );
    }
    const rows: Row[] = await model.getRows(fromRow, toRow);
    rows.forEach((row, rowOffset) => {
      lines.push(
        copiedColumns
          .map((column, i) =>
            isSelected(fromRow + rowOffset, fromCell + i)
              ? toClipboardValue(row[column.field])
              : "",
          )
          .join("\t"),
      );
    });

    vscode.postMessage({
      command: "request:copyToClipboard",
      data: {
        text: lines.join("\n"),
        truncatedAt: toRow < lastRow ? MAX_COPY_ROWS : undefined,
      },
    });
  }, []);

  const selectAll = useCallback(() => {
    const grid = gridRef.current;
    if (!grid || !modelRef.current) {
      return;
    }
    grid
      .getSelectionModel()
      ?.setSelectedRanges([
        new SlickRange(
          0,
          0,
          modelRef.current.getLength() - 1,
          grid.getColumns().length - 1,
        ),
      ]);
  }, []);

  const openCellMenu = useCallback(
    (left: number, top: number, row?: number, cell?: number) => {
      const grid = gridRef.current;
      if (!grid) {
        return;
      }
      const ranges = grid.getSelectionModel()?.getSelectedRanges() ?? [];
      if (
        row !== undefined &&
        cell !== undefined &&
        !ranges.some((range) => range.contains(row, cell))
      ) {
        grid.setActiveCell(row, cell);
      }
      setColumnMenu(undefined);
      setCellMenu({ left, top });
    },
    [],
  );

  const dismissCellMenu = useCallback(() => {
    setCellMenu(undefined);
    gridRef.current?.focus();
  }, []);

  // Load the column definitions once
  useEffect(() => {
    request<{ columns: Column[] }>("loadColumns").then(
      ({ columns: columnsData }) => {
        columnTypesRef.current = Object.fromEntries(
          columnsData.map((column) => [column.name, column.type]),
        );
        setColumns(columnsData);
      },
    );
  }, []);

  // Create the grid once the columns have loaded
  useEffect(() => {
    const container = containerRef.current;
    if (!container || columns.length === 0) {
      return;
    }

    const gridColumns: GridColumn[] = [
      {
        id: ROW_NUMBER_COLUMN,
        field: ROW_NUMBER_COLUMN,
        name: ROW_NUMBER_COLUMN,
        toolTip: localize("Row number"),
        cssClass: "row-number-cell",
        reorderable: false,
        sortable: false,
        width: 70,
      },
      ...columns.map((column) => ({
        id: column.name,
        field: column.name,
        name: column.name,
        sortable: true,
        width: 160,
        minWidth: 40,
      })),
    ];

    const model = new RemoteDataModel(
      async (start, end) => {
        const { rows, count } = await request<TableData>("loadData", {
          start,
          end,
          sortModel: sortModelRef.current,
          query: queryRef.current,
        });
        // The first cell of each row is its row number
        const rowData = rows.map(({ cells }) =>
          Object.fromEntries(
            cells.map((cell, index) => [gridColumns[index].field, cell]),
          ),
        );
        return { rows: rowData, count };
      },
      (fromRow, toRow, lengthChanged) => {
        const grid = gridRef.current;
        if (!grid) {
          return;
        }
        if (lengthChanged) {
          grid.updateRowCount();
        }
        const rows = [];
        for (let row = fromRow; row <= toRow; row++) {
          rows.push(row);
        }
        grid.invalidateRows(rows);
        grid.render();
        setNoRows(model.getLength() === 0);
      },
    );
    modelRef.current = model;

    const grid = new SlickGrid<Row, GridColumn>(container, model, gridColumns, {
      nonce: document.body.dataset.nonce,
      enableHtmlRendering: false,
      defaultFormatter: (_row, _cell, value) =>
        value === null || value === undefined ? "" : String(value),
      enableCellNavigation: true,
      enableColumnReorder: true,
      multiColumnSort: true,
      numberedMultiColumnSort: true,
      frozenColumn: 0,
      rowHeight: 28,
      headerRowHeight: 32,
      defaultColumnWidth: 160,
      editable: false,
      // Deferred until our header and event handlers are attached below
      explicitInitialization: true,
    });
    gridRef.current = grid;

    grid.onHeaderCellRendered.subscribe((_e, { node, column }) => {
      if (column.id === ROW_NUMBER_COLUMN) {
        return;
      }
      renderColumnHeader(node, String(column.id), {
        columnType: columnTypesRef.current[column.id] ?? "",
        isMenuOpen: columnMenuRef.current?.columnId === column.id,
        displayMenuForColumn,
      });
    });

    grid.onHeaderKeyDown.subscribe((_e, { column, event }) => {
      if (
        column.id !== ROW_NUMBER_COLUMN &&
        (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey))
      ) {
        const button = grid
          .getHeaderColumn(grid.getColumnIndex(column.id))
          ?.querySelector(".dropdown button");
        if (button) {
          event.preventDefault();
          displayMenuForColumn(
            String(column.id),
            button.getBoundingClientRect(),
          );
        }
      }
      if (event.key === "Tab") {
        setColumnMenu(undefined);
      }
    });

    grid.onSort.subscribe((_e, args) => {
      // multiColumnSort is enabled, so the grid reports every sorted column
      const sortCols = "sortCols" in args ? args.sortCols : [];
      sortModelRef.current = sortCols.map(({ columnId, sortAsc }) => ({
        colId: String(columnId),
        sort: sortAsc ? "asc" : "desc",
      }));
      reloadData();
    });

    grid.onKeyDown.subscribe((e) => {
      const event = e.getNativeEvent<KeyboardEvent>();
      // Copying is handled by our "copy" listener; skip the grid's built-in
      // Ctrl+C, which only copies the active cell.
      if ((event.ctrlKey || event.metaKey) && event.key === "c") {
        e.stopImmediatePropagation();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key === "a") {
        event.preventDefault();
        selectAll();
      }
      if (
        event.key === "ContextMenu" ||
        (event.key === "F10" && event.shiftKey)
      ) {
        const active = grid.getActiveCellNode();
        if (active) {
          event.preventDefault();
          const { left, bottom } = active.getBoundingClientRect();
          openCellMenu(left, bottom);
        }
      }
    });

    grid.onViewportChanged.subscribe(loadViewport);
    grid.init();
    grid.setSelectionModel(
      new SlickHybridSelectionModel({
        selectionType: "mixed",
        rowSelectColumnIds: [ROW_NUMBER_COLUMN],
        showDragHandle: false,
      }),
    );
    loadViewport();

    const resizeObserver = new ResizeObserver(() => grid.resizeCanvas());
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      grid.destroy();
      gridRef.current = undefined;
      modelRef.current = undefined;
    };
  }, [
    columns,
    displayMenuForColumn,
    loadViewport,
    openCellMenu,
    reloadData,
    selectAll,
  ]);

  // Copy requests come from the keyboard (Ctrl/Cmd+C) or VS Code's Edit > Copy.
  useEffect(() => {
    const handleCopy = (event: ClipboardEvent) => {
      // The grid keeps keyboard focus on elements it adds next to its
      // container, so check the container's parent.
      const gridWrapper = containerRef.current?.parentElement;
      if (!gridWrapper?.contains(document.activeElement)) {
        return;
      }
      event.preventDefault();
      copySelection(false);
    };
    document.addEventListener("copy", handleCopy);
    return () => document.removeEventListener("copy", handleCopy);
  }, [copySelection]);

  // Replace the browser context menu: our own menu on grid cells, nothing
  // elsewhere.
  useEffect(() => {
    const handleContextMenu = (event: MouseEvent) => {
      event.stopImmediatePropagation();
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      const target = event.target as HTMLElement;
      const grid = gridRef.current;
      if (!grid || !target.closest(".slick-cell")) {
        return;
      }
      event.preventDefault();
      const cell = grid.getCellFromEvent(event);
      openCellMenu(event.clientX, event.clientY, cell?.row, cell?.cell);
    };
    window.addEventListener("contextmenu", handleContextMenu, true);
    return () =>
      window.removeEventListener("contextmenu", handleContextMenu, true);
  }, [openCellMenu]);

  // Keep the menu button of the column whose menu is open visible
  useEffect(() => {
    containerRef.current
      ?.querySelectorAll<HTMLElement>(".slick-header-column .dropdown")
      .forEach((dropdown) =>
        dropdown.classList.toggle(
          "active",
          dropdown.dataset.columnId === columnMenu?.columnId,
        ),
      );
  }, [columnMenu]);

  return {
    cellMenu,
    columnMenu,
    columns,
    containerRef,
    copySelection,
    dismissCellMenu,
    dismissMenu,
    gridRef,
    noRows,
    refreshResults,
    selectAll,
  };
};

export default useDataViewer;
