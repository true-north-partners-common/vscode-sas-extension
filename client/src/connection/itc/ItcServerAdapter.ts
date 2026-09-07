// Copyright © 2025, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { FileType, Uri, workspace } from "vscode";

import { v4 } from "uuid";

import { onRunError } from "../../commands/run";
import {
  Messages,
  SAS_SERVER_FAVORITES_FOLDER,
  SAS_SERVER_ROOT_FOLDER,
  SAS_SERVER_ROOT_FOLDERS,
  SERVER_FAVORITES_FOLDER_ID,
  SERVER_FOLDER_ID,
} from "../../components/ContentNavigator/const";
import {
  addServerFavorite,
  readServerFavorites,
  removeServerFavorite,
} from "../../components/ContentNavigator/serverFavorites";
import {
  ContentAdapter,
  ContentItem,
  RootFolderMap,
} from "../../components/ContentNavigator/types";
import {
  ContextMenuAction,
  ContextMenuProvider,
  convertStaticFolderToContentItem,
  createStaticFolder,
  homeDirectoryNameAndType,
  sortedContentItems,
} from "../../components/ContentNavigator/utils";
import { getGlobalStorageUri } from "../../components/ExtensionContext";
import { ProfileWithFileRootOptions } from "../../components/profile";
import { getLink, getResourceId, getSasServerUri } from "../rest/util";
import { executeRawCode } from "./CodeRunner";
import { PowershellResponse, ScriptActions } from "./types";
import { getDirectorySeparator } from "./util";

// The two folders we invent rather than read off the file system. Home is not
// one of them here: unlike the rest connection, it is identified by its real
// path, so it can be bookmarked like any other directory.
const isSyntheticFolder = (item: ContentItem): boolean =>
  [SERVER_FOLDER_ID, SERVER_FAVORITES_FOLDER_ID].includes(item.id);

class ItcServerAdapter implements ContentAdapter {
  protected sessionId: string;
  private rootFolders: RootFolderMap;
  private contextMenuProvider: ContextMenuProvider;

  public constructor(
    protected readonly fileNavigationCustomRootPath: ProfileWithFileRootOptions["fileNavigationCustomRootPath"],
    protected readonly fileNavigationRoot: ProfileWithFileRootOptions["fileNavigationRoot"],
  ) {
    this.rootFolders = {};
    this.contextMenuProvider = new ContextMenuProvider(
      [
        ContextMenuAction.CreateChild,
        ContextMenuAction.Delete,
        ContextMenuAction.Update,
        ContextMenuAction.CopyPath,
        ContextMenuAction.AllowDownload,
        ContextMenuAction.AddToFavorites,
        ContextMenuAction.RemoveFromFavorites,
      ],
      {
        [ContextMenuAction.CopyPath]: (item) => !isSyntheticFolder(item),
        // A favorite is a shortcut to a directory, not the directory itself.
        // Renaming or deleting one would act on the original and leave the
        // stored path dangling, so those stay on the item in the tree proper.
        [ContextMenuAction.CreateChild]: (item) =>
          item.permission.addMember && !item.flags?.isFavoriteEntry,
        [ContextMenuAction.Delete]: (item) =>
          item.permission.delete && !item.flags?.isFavoriteEntry,
        [ContextMenuAction.Update]: (item) =>
          item.permission.write && !item.flags?.isFavoriteEntry,
        // The content pane keys this off the content type, which server items
        // do not carry; and the synthetic folders are not real paths.
        [ContextMenuAction.AddToFavorites]: (item) =>
          !item.flags?.isInMyFavorites && !isSyntheticFolder(item),
      },
    );
  }

  /* Only sas content favorites are stored server side, as folder members */
  public async addChildItem(): Promise<boolean> {
    throw new Error("Method not implemented");
  }

  public async addItemToFavorites(item: ContentItem): Promise<boolean> {
    return await addServerFavorite(await this.getPathOfItem(item));
  }

  public async removeItemFromFavorites(item: ContentItem): Promise<boolean> {
    return await removeServerFavorite(await this.getPathOfItem(item));
  }

  public getRootFolder(name: string): ContentItem | undefined {
    return this.rootFolders[name];
  }

  /* The following is needed for creating a flow, which isn't supported on sas server */
  public async getParentOfItem(
    item: ContentItem,
  ): Promise<ContentItem | undefined> {
    const parent = await this.getItemAtPath(item.parentFolderUri);
    if (!parent) {
      return undefined;
    }

    return parent;
  }

  public async getFolderPathForItem(): Promise<string> {
    return "";
  }

  public async connect(): Promise<void> {
    return;
  }

  public connected(): boolean {
    return true;
  }

  public async createNewFolder(
    parentItem: ContentItem,
    folderName: string,
  ): Promise<ContentItem | undefined> {
    try {
      const { success, data } = await this.execute(
        ScriptActions.CreateDirectory,
        {
          folderPath: parentItem.uri,
          folderName,
        },
      );

      if (!success) {
        return;
      }

      return this.convertPowershellResponseToContentItem(data);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (error) {
      return;
    }
  }

  public async createNewItem(
    parentItem: ContentItem,
    fileName: string,
    buffer?: ArrayBufferLike,
  ): Promise<ContentItem | undefined> {
    try {
      const { success, data } = await this.execute(ScriptActions.CreateFile, {
        folderPath: parentItem.uri,
        fileName,
        content: buffer ? Buffer.from(buffer).toString("base64") : "",
      });

      if (!success) {
        return;
      }

      return this.convertPowershellResponseToContentItem(data);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (error) {
      return;
    }
  }

  public async deleteItem(item: ContentItem): Promise<boolean> {
    try {
      const { success } = await this.execute(ScriptActions.DeleteFile, {
        filePath: item.uri,
      });
      if (success) {
        await removeServerFavorite(await this.getPathOfItem(item));
      }
      return success;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (error) {
      return false;
    }
  }

  private fileNavigationRootSettings() {
    return {
      fileNavigationCustomRootPath: this.fileNavigationCustomRootPath,
      fileNavigationRoot: this.fileNavigationRoot || "USER",
    };
  }

  public async getChildItems(parentItem: ContentItem): Promise<ContentItem[]> {
    // If the user is fetching child items of the root folder, give them the
    // "home" directory
    if (parentItem.id === SERVER_FOLDER_ID) {
      const { success, data: items } = await this.execute(
        ScriptActions.GetChildItems,
        {
          path: "/",
          ...this.fileNavigationRootSettings(),
        },
      );
      if (!success) {
        if (this.fileNavigationRoot === "CUSTOM") {
          throw new Error(Messages.FileNavigationRootUserError);
        }
        return [];
      }
      const uri = items[0].parentFolderUri;
      const homeFolder = convertStaticFolderToContentItem(
        createStaticFolder(
          uri,
          ...homeDirectoryNameAndType(
            this.fileNavigationRoot,
            this.fileNavigationCustomRootPath,
          ),
          "/",
          "getDirectoryMembers",
        ),
        {
          write: false,
          delete: false,
          addMember: true,
        },
      );
      homeFolder.contextValue =
        this.contextMenuProvider.availableActions(homeFolder);
      return [
        this.markFavorite(homeFolder, new Set(await readServerFavorites())),
      ];
    }

    if (parentItem.id === SERVER_FAVORITES_FOLDER_ID) {
      return await this.getFavoriteItems();
    }

    const { success, data: items } = await this.execute(
      ScriptActions.GetChildItems,
      {
        path: getLink(parentItem.links, "GET", "getDirectoryMembers").uri,
        ...this.fileNavigationRootSettings(),
      },
    );
    if (!success) {
      return [];
    }

    const favorites = new Set(await readServerFavorites());
    const childItems = items.map((item) =>
      this.markFavorite(
        this.convertPowershellResponseToContentItem(item),
        favorites,
      ),
    );

    return sortedContentItems(childItems);
  }

  // The item as it appears elsewhere in the tree, told that it is bookmarked
  // so it offers "Remove from My Favorites" rather than "Add".
  private markFavorite(item: ContentItem, favorites: Set<string>): ContentItem {
    if (!favorites.has(item.uri)) {
      return item;
    }

    return this.withFavoriteFlags(item, { isInMyFavorites: true });
  }

  private withFavoriteFlags(
    item: ContentItem,
    flags: ContentItem["flags"],
  ): ContentItem {
    const favorited = { ...item, flags: { ...item.flags, ...flags } };

    return {
      ...favorited,
      contextValue: this.contextMenuProvider.availableActions(favorited),
    };
  }

  private async getFavoriteItems(): Promise<ContentItem[]> {
    const paths = await readServerFavorites();
    const items = await Promise.all(
      paths.map((path) => this.favoriteToContentItem(path)),
    );

    return sortedContentItems(
      items.filter((item): item is ContentItem => item !== undefined),
    );
  }

  private async favoriteToContentItem(
    path: string,
  ): Promise<ContentItem | undefined> {
    try {
      const item = await this.getItemAtPath(path);
      if (!item) {
        return undefined;
      }

      return {
        ...this.withFavoriteFlags(item, {
          isInMyFavorites: true,
          isFavoriteEntry: true,
        }),
        uid: `${SERVER_FAVORITES_FOLDER_ID}/${path}`,
      };
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (error) {
      // Moved, deleted, or outside the navigation root this connection was
      // given. Keep the path - a transient failure shouldn't throw away what
      // the user saved - but don't render a node that cannot be opened.
      return undefined;
    }
  }

  public async getPathOfItem(item: ContentItem): Promise<string> {
    return item.uri;
  }

  private async getTempFile() {
    const tempFile = v4();
    const globalStorageUri = getGlobalStorageUri();
    try {
      await workspace.fs.readDirectory(globalStorageUri);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (e) {
      await workspace.fs.createDirectory(globalStorageUri);
    }

    const outputFile = Uri.joinPath(globalStorageUri, tempFile);
    return outputFile;
  }

  public async getContentOfItem(item: ContentItem): Promise<string> {
    const filePath = item.uri;
    const outputFile = await this.getTempFile();

    try {
      const { success } = await this.execute(ScriptActions.FetchFileContent, {
        filePath,
        outputFile: outputFile.fsPath,
      });
      if (!success) {
        return "";
      }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (error) {
      return "";
    }

    const file = await workspace.fs.readFile(outputFile);
    await workspace.fs.delete(outputFile);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return file as unknown as string;
  }

  public async getContentOfUri(uri: Uri): Promise<string> {
    const item = await this.getItemAtPath(getResourceId(uri));
    return ((await this.getContentOfItem(item)) || "").toString();
  }

  public async getItemOfUri(uri: Uri): Promise<ContentItem> {
    return this.getItemAtPath(getResourceId(uri));
  }

  public async getRootItems(): Promise<RootFolderMap> {
    for (let index = 0; index < SAS_SERVER_ROOT_FOLDERS.length; ++index) {
      const delegateFolderName = SAS_SERVER_ROOT_FOLDERS[index];
      this.rootFolders[delegateFolderName] = {
        uid: `${index}`,
        ...convertStaticFolderToContentItem(
          delegateFolderName === "@sasServerFavorites"
            ? SAS_SERVER_FAVORITES_FOLDER
            : SAS_SERVER_ROOT_FOLDER,
          {
            write: false,
            delete: false,
            addMember: false,
          },
        ),
      };
    }

    return this.rootFolders;
  }

  public async getUriOfItem(item: ContentItem): Promise<Uri> {
    return item.vscUri;
  }

  public async moveItem(
    item: ContentItem,
    targetParentFolderUri: string,
  ): Promise<Uri | undefined> {
    try {
      const { success, data } = await this.execute(ScriptActions.RenameFile, {
        oldPath: item.uri,
        newPath: targetParentFolderUri,
        newName: item.name,
      });
      if (!success) {
        return undefined;
      }
      return this.convertPowershellResponseToContentItem(data).vscUri;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (error) {
      return undefined;
    }
  }

  public async renameItem(
    item: ContentItem,
    newName: string,
  ): Promise<ContentItem | undefined> {
    try {
      const { success, data } = await this.execute(ScriptActions.RenameFile, {
        oldPath: item.uri,
        newPath: item.parentFolderUri,
        newName,
      });
      if (!success) {
        return undefined;
      }
      return this.convertPowershellResponseToContentItem(data);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (error) {
      return undefined;
    }
  }

  public async updateContentOfItem(uri: Uri, content: string): Promise<void> {
    try {
      const item = await this.getItemAtPath(getResourceId(uri));
      await this.execute(ScriptActions.UpdateFile, {
        filePath: item.uri,
        content,
      });
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (error) {
      return;
    }
  }

  protected async getItemAtPathWithName(
    path: string,
    name: string,
  ): Promise<ContentItem> {
    const { data: items } = await this.execute(ScriptActions.GetChildItems, {
      path,
      ...this.fileNavigationRootSettings(),
    });

    const foundItem = items.find((item) => item.name === name);
    return this.convertPowershellResponseToContentItem(foundItem);
  }

  protected async getItemAtPath(path: string): Promise<ContentItem> {
    const separator = getDirectorySeparator(path);
    const pathPieces = path.split(separator);
    const name = pathPieces.pop();

    return await this.getItemAtPathWithName(pathPieces.join(separator), name);
  }

  private convertPowershellResponseToContentItem(
    response: PowershellResponse,
  ): ContentItem {
    // response.category can be 0, 1, or 2. 0 is directory, 1 is "sas" type, 2 is other file types
    const type = response.category === 0 ? FileType.Directory : FileType.File;
    const uri = response.uri;
    const links = [
      type === FileType.Directory && {
        method: "GET",
        rel: "getDirectoryMembers",
        href: uri,
        uri: uri,
        type: "GET",
      },
      { method: "GET", rel: "self", href: uri, uri: uri, type: "GET" },
    ].filter((link) => link);

    const modifiedTimeStamp = new Date(
      response.modifiedTimeStamp.replace(/[^0-9]/g, ""),
    ).getTime();
    const item: ContentItem = {
      id: uri,
      uri,
      name: response.name,
      creationTimeStamp: new Date(response.creationTimeStamp).getTime() ?? 0,
      modifiedTimeStamp,
      links,
      permission: {
        write: true,
        delete: true,
        addMember: type === FileType.Directory,
      },
      type: "",
      parentFolderUri: response.parentFolderUri,
      fileStat: {
        ctime: 0,
        mtime: modifiedTimeStamp,
        size: response.size,
        type,
      },
    };

    return {
      ...item,
      contextValue: this.contextMenuProvider.availableActions(item),
      vscUri: getSasServerUri(item, false),
    };
  }

  private async execute(incomingCode: string, params: Record<string, string>) {
    let code = incomingCode;

    Object.keys(params).forEach((key: string) => {
      // This is a little confusing. Basically, we can pass in any kind of string. Some of those
      // strings break powershell (ex. NewFile+!@$%^&*.txt). Thus, we create one level of indirection
      // where we wrap these unprocessed strings in the powershell "heredoc" syntax before passing things
      // along
      const codeToPrefix = `$processed_${key}=\n@'\n${params[key]}\n'@\n`;
      code = codeToPrefix + code.replace(`$${key}`, `$processed_${key}`);
    });

    try {
      const output = await executeRawCode(code);
      const decodedOutput = output ? JSON.parse(output) : "";

      // If we do have an error message with more information, lets dump it to console
      if (decodedOutput && !decodedOutput.success && decodedOutput.message) {
        console.dir(decodedOutput.message);
      }

      return decodedOutput;
    } catch (e) {
      onRunError(e);
      return "";
    }
  }
}

export default ItcServerAdapter;
