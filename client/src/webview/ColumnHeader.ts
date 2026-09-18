// Copyright © 2025, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import localize from "./localize";

const getIconForColumnType = (type: string) => {
  switch (type.toLocaleLowerCase()) {
    case "float":
    case "num":
      return "float";
    case "date":
      return "date";
    case "time":
      return "time";
    case "datetime":
      return "date-time";
    case "currency":
      return "currency";
    case "char":
      return "char";
    default:
      return "";
  }
};

const getTermForColumnType = (type: string) => {
  switch (type.toLocaleLowerCase()) {
    case "float":
    case "num":
      return localize("Numeric");
    case "date":
      return localize("Date");
    case "time":
    case "datetime":
      return localize("Datetime");
    case "currency":
      return localize("Currency");
    case "char":
    default:
      return localize("Character");
  }
};

/**
 * Adds the column type icon and the column menu button to a grid header cell.
 * The grid renders the column name and sort indicators itself.
 */
export const renderColumnHeader = (
  node: HTMLElement,
  columnId: string,
  {
    columnType,
    isMenuOpen,
    displayMenuForColumn,
  }: {
    columnType: string;
    isMenuOpen: boolean;
    displayMenuForColumn: (columnId: string, rect: DOMRect) => void;
  },
) => {
  const icon = document.createElement("span");
  icon.className = `header-icon ${getIconForColumnType(columnType)}`;
  icon.title = getTermForColumnType(columnType);
  node.prepend(icon);

  const dropdown = document.createElement("div");
  dropdown.className = isMenuOpen ? "active dropdown" : "dropdown";
  dropdown.dataset.columnId = columnId;
  const button = document.createElement("button");
  button.type = "button";
  button.tabIndex = -1;
  button.title = localize("Options");
  button.append(document.createElement("span"));
  // Keep clicks on the button from sorting or dragging the column
  for (const type of ["mousedown", "pointerdown"]) {
    button.addEventListener(type, (event) => event.stopPropagation());
  }
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    displayMenuForColumn(columnId, button.getBoundingClientRect());
  });
  dropdown.append(button);
  node.append(dropdown);
};
