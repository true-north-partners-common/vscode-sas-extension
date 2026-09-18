// Copyright © 2023, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect } from "react";
import { createRoot } from "react-dom/client";

import ".";
import ColumnMenu from "./ColumnMenu";
import GridMenu, { MenuItem } from "./GridMenu";
import TableFilter from "./TableFilter";
import localize from "./localize";
import useDataViewer from "./useDataViewer";

import "./DataViewer.css";

const isMac = navigator.platform.toLowerCase().includes("mac");
const modifierKey = isMac ? "⌘" : "Ctrl+";

const DataViewer = () => {
  const title = document
    .querySelector("[data-title]")
    .getAttribute("data-title");
  const {
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
  } = useDataViewer();

  const handleKeydown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      if (columnMenu) {
        dismissMenu();
      }
      if (cellMenu) {
        dismissCellMenu();
      }
    },
    [cellMenu, columnMenu, dismissCellMenu, dismissMenu],
  );
  const dismissMenusWithoutFocus = useCallback(() => {
    dismissMenu(false);
    if (cellMenu) {
      dismissCellMenu();
    }
  }, [cellMenu, dismissCellMenu, dismissMenu]);
  const handleMouseDown = useCallback(
    (event: MouseEvent) => {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      if (!(event.target as HTMLElement).closest(".grid-menu-popup")) {
        dismissMenusWithoutFocus();
      }
    },
    [dismissMenusWithoutFocus],
  );

  const panelMessageHandler = useCallback(
    (event: MessageEvent) => {
      if (event.data.command === "panel:refreshData") {
        refreshResults(undefined);
      }

      if (
        event.data.command === "panel:changeFocus" &&
        event.data.data.focused
      ) {
        const cell = gridRef.current?.getActiveCell();
        if (cell) {
          gridRef.current?.setActiveCell(cell.row, cell.cell);
          gridRef.current?.focus();
        }
      }
    },
    [gridRef, refreshResults],
  );
  useEffect(() => {
    document.addEventListener("keydown", handleKeydown);
    document.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("blur", dismissMenusWithoutFocus);
    window.addEventListener("message", panelMessageHandler);
    return () => {
      document.removeEventListener("keydown", handleKeydown);
      document.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("blur", dismissMenusWithoutFocus);
      window.removeEventListener("message", panelMessageHandler);
    };
  }, [
    handleKeydown,
    handleMouseDown,
    dismissMenusWithoutFocus,
    panelMessageHandler,
  ]);

  const cellMenuItems: (MenuItem | string)[] = [
    {
      name: localize("Copy"),
      shortcut: `${modifierKey}C`,
      onPress: () => {
        copySelection(false);
        dismissCellMenu();
      },
    },
    {
      name: localize("Copy with headers"),
      onPress: () => {
        copySelection(true);
        dismissCellMenu();
      },
    },
    "separator",
    {
      name: localize("Select all"),
      shortcut: `${modifierKey}A`,
      onPress: () => {
        selectAll();
        dismissCellMenu();
      },
    },
  ];

  return (
    <div className="data-viewer">
      {columns.length > 0 && (
        <>
          <h1>{title}</h1>
          <TableFilter
            onCommit={(value) => {
              refreshResults({ filterValue: value });
            }}
            initialValue={""}
          />
        </>
      )}
      {columnMenu && <ColumnMenu {...columnMenu} />}
      {cellMenu && (
        <GridMenu
          menuItems={cellMenuItems}
          top={cellMenu.top}
          left={cellMenu.left}
        />
      )}
      <div className="grid-wrapper">
        <div ref={containerRef} className="data-grid" />
        {noRows && (
          <div className="no-rows-overlay">
            {localize("No data matches the current filters.")}
          </div>
        )}
      </div>
    </div>
  );
};

const root = createRoot(document.querySelector(".data-viewer-container"));
root.render(<DataViewer />);
