// Copyright © 2025, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { getIconLabel, iconForColumn } from "../panels/columnIconClassifier";
import localize from "./localize";

/**
 * Adds the column type icon and the column menu button to a grid header cell.
 * The grid renders the column name and sort indicators itself.
 */
export const renderColumnHeader = (
  node: HTMLElement,
  columnId: string,
  {
    columnType,
    columnFormatCategory,
    isMenuOpen,
    displayMenuForColumn,
  }: {
    columnType: string;
    columnFormatCategory?: string;
    isMenuOpen: boolean;
    displayMenuForColumn: (columnId: string, rect: DOMRect) => void;
  },
) => {
  const iconClass = iconForColumn(columnType, columnFormatCategory);
  const icon = document.createElement("span");
  icon.className = `header-icon ${iconClass}`;
  icon.title = localize(getIconLabel(iconClass) || "Character");
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
