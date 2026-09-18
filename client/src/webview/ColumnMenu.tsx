// Copyright © 2025, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import type { SortModelItem } from "../components/LibraryNavigator/types";
import GridMenu from "./GridMenu";
import localize from "./localize";

export interface GridController {
  getSortModel: () => SortModelItem[];
  setSortModel: (sortModel: SortModelItem[]) => void;
  isPinned: (columnId: string) => boolean;
  setPinned: (columnId: string, pinned: boolean) => void;
}

export interface ColumnMenuProps {
  columnId: string;
  dismissMenu: () => void;
  hasSort: boolean;
  left: number;
  loadColumnProperties: () => void;
  pinColumn: (pinned: boolean) => void;
  pinned: boolean;
  removeAllSorting: () => void;
  removeFromSort: () => void;
  sort: SortModelItem["sort"] | undefined;
  sortColumn: (direction: "asc" | "desc") => void;
  top: number;
}

export const getColumnMenu = (
  controller: GridController,
  columnId: string,
  { height, top, left }: DOMRect,
  dismissMenu: () => void,
  loadColumnProperties: (columnName: string) => void,
): ColumnMenuProps => {
  const sortModel = controller.getSortModel();
  return {
    columnId,
    dismissMenu,
    hasSort: sortModel.length > 0,
    left,
    top: top + height,
    pinned: controller.isPinned(columnId),
    sort: sortModel.find((item) => item.colId === columnId)?.sort,
    pinColumn: (pinned: boolean) => controller.setPinned(columnId, pinned),
    sortColumn: (direction: "asc" | "desc") => {
      const existing = sortModel.some((item) => item.colId === columnId);
      controller.setSortModel(
        existing
          ? sortModel.map((item) =>
              item.colId === columnId ? { ...item, sort: direction } : item,
            )
          : [...sortModel, { colId: columnId, sort: direction }],
      );
    },
    removeAllSorting: () => controller.setSortModel([]),
    removeFromSort: () =>
      controller.setSortModel(
        sortModel.filter((item) => item.colId !== columnId),
      ),
    loadColumnProperties: () => loadColumnProperties(columnId),
  };
};

const ColumnMenu = ({
  dismissMenu,
  hasSort,
  left,
  loadColumnProperties,
  pinColumn,
  pinned,
  removeAllSorting,
  removeFromSort,
  sort,
  sortColumn,
  top,
}: ColumnMenuProps) => {
  const menuItems = [
    {
      name: localize("Pin"),
      children: [
        {
          name: localize("Pinned to the left"),
          checked: pinned,
          onPress: () => {
            pinColumn(true);
            dismissMenu();
          },
        },
        {
          name: localize("Not pinned"),
          checked: !pinned,
          onPress: () => {
            pinColumn(false);
            dismissMenu();
          },
        },
      ],
    },
    "separator",
    {
      name: localize("Sort"),
      children: [
        {
          name:
            hasSort && !sort
              ? localize("Ascending (add to sorting)")
              : localize("Ascending"),
          checked: sort === "asc",
          onPress: () => {
            sortColumn("asc");
            dismissMenu();
          },
        },
        {
          name:
            hasSort && !sort
              ? localize("Descending (add to sorting)")
              : localize("Descending"),
          checked: sort === "desc",
          onPress: () => {
            sortColumn("desc");
            dismissMenu();
          },
        },
        "separator",
        {
          name: localize("Remove sorting"),
          onPress: () => {
            removeFromSort();
            dismissMenu();
          },
          disabled: !hasSort || !sort,
        },
        {
          name: localize("Remove all sorting"),
          onPress: () => {
            removeAllSorting();
            dismissMenu();
          },
          disabled: !hasSort,
        },
      ],
    },
    "separator",
    {
      name: localize("Properties"),
      onPress: loadColumnProperties,
    },
  ];

  return <GridMenu menuItems={menuItems} top={top} left={left} />;
};

export default ColumnMenu;
