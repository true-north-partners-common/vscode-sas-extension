// Copyright © 2024, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { FileType, Uri } from "vscode";

import { AxiosResponse } from "axios";

import { getSession } from "..";
import {
  FOLDER_TYPES,
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
  AddChildItemProperties,
  ContentAdapter,
  ContentItem,
  RootFolderMap,
} from "../../components/ContentNavigator/types";
import {
  ContextMenuAction,
  ContextMenuProvider,
  createStaticFolder,
  getTypeName,
  homeDirectoryNameAndType,
  isReference,
  sortedContentItems,
} from "../../components/ContentNavigator/utils";
import { appendSessionLogFn } from "../../components/logViewer";
import { ProfileWithFileRootOptions } from "../../components/profile";
import { FileProperties, FileSystemApi } from "./api/compute";
import { getApiConfig } from "./common";
import {
  getLink,
  getResourceId,
  getResourceIdFromItem,
  getSasServerUri,
} from "./util";

export const SAS_SERVER_HOME_DIRECTORY = "SAS_SERVER_HOME_DIRECTORY";
const SAS_FILE_SEPARATOR = "~fs~";

// The two folders we invent rather than read off the file system.
const isSyntheticFolder = (item: ContentItem): boolean =>
  [SERVER_FOLDER_ID, SERVER_FAVORITES_FOLDER_ID].includes(item.id);

// Home is a real directory, but it is already the pane's entry point, so
// there is nothing to gain from bookmarking it.
const isFavoritable = (item: ContentItem): boolean =>
  !isSyntheticFolder(item) && item.id !== SAS_SERVER_HOME_DIRECTORY;

const rootFolderFor = (delegateFolderName: string) => {
  switch (delegateFolderName) {
    case "@sasServerRoot":
      return SAS_SERVER_ROOT_FOLDER;
    case "@sasServerFavorites":
      return SAS_SERVER_FAVORITES_FOLDER;
    default:
      return {};
  }
};

class RestServerAdapter implements ContentAdapter {
  protected baseUrl: string;
  protected fileSystemApi: ReturnType<typeof FileSystemApi>;
  protected sessionId: string;
  private rootFolders: RootFolderMap;
  private fileMetadataMap: {
    [id: string]: { etag: string; lastModified?: string; contentType?: string };
  };
  private fileNavigationSetByAdmin: boolean;
  private contextMenuProvider: ContextMenuProvider;

  public constructor(
    protected fileNavigationCustomRootPath: ProfileWithFileRootOptions["fileNavigationCustomRootPath"],
    protected fileNavigationRoot: ProfileWithFileRootOptions["fileNavigationRoot"],
  ) {
    this.rootFolders = {};
    this.fileMetadataMap = {};
    this.fileNavigationSetByAdmin = false;
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
          !item.flags?.isInMyFavorites && isFavoritable(item),
      },
    );
  }

  addChildItem: (
    childItemUri: string | undefined,
    parentItemUri: string | undefined,
    properties: AddChildItemProperties,
  ) => Promise<boolean>;
  recycleItem?: (item: ContentItem) => Promise<{ newUri?: Uri; oldUri?: Uri }>;
  restoreItem?: (item: ContentItem) => Promise<boolean>;

  private async establishConnection() {
    const session = getSession();
    session.onSessionLogFn = appendSessionLogFn;
    await session.setup(true);
    this.sessionId = session?.sessionId();

    // Overwrite file nav settings with data coming from the compute context
    if (session.contextAttributes) {
      const attributes = await session.contextAttributes();
      if (
        attributes &&
        (attributes.fileNavigationCustomRootPath ||
          attributes.fileNavigationRoot)
      ) {
        this.fileNavigationSetByAdmin = true;
        this.fileNavigationCustomRootPath =
          attributes.fileNavigationCustomRootPath ?? "";
        this.fileNavigationRoot = attributes.fileNavigationRoot ?? "USER";
      }
    }

    return this.sessionId;
  }

  public async connect(): Promise<void> {
    await this.establishConnection();
    // This proxies all calls to the fileSystem api to reconnect
    // if we ever get a 401 (unauthorized)
    const reconnect = async () => {
      return await this.establishConnection();
    };
    this.fileSystemApi = new Proxy(FileSystemApi(getApiConfig()), {
      get: function (target, property) {
        if (typeof target[property] === "function") {
          return new Proxy(target[property], {
            apply: async function (target, _this, argList) {
              try {
                return await target(...argList);
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
              } catch (error) {
                // If we get any error, lets reconnect and try again. If we fail a second time,
                // then we can assume it's a "real" error
                const sessionId = await reconnect();

                // If we reconnected, lets make sure we update our session id
                if (argList.length && argList[0].sessionId) {
                  argList[0].sessionId = sessionId;
                }

                return await target(...argList);
              }
            },
          });
        }

        return target[property];
      },
    });
  }

  public connected(): boolean {
    return true;
  }

  public async setup(): Promise<void> {
    if (this.sessionId && this.fileSystemApi) {
      return;
    }

    await this.connect();
  }

  public async addItemToFavorites(item: ContentItem): Promise<boolean> {
    return await addServerFavorite(await this.getPathOfItem(item));
  }

  public async removeItemFromFavorites(item: ContentItem): Promise<boolean> {
    return await removeServerFavorite(await this.getPathOfItem(item));
  }

  public async createNewFolder(
    parentItem: ContentItem,
    folderName: string,
  ): Promise<ContentItem | undefined> {
    try {
      const response = await this.fileSystemApi.createFileOrDirectory({
        sessionId: this.sessionId,
        fileOrDirectoryPath: this.getCreationPath(parentItem.uri),
        fileProperties: { name: folderName, isDirectory: true },
      });

      return this.filePropertiesToContentItem(response.data);
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
      const response = await this.fileSystemApi.createFileOrDirectory({
        sessionId: this.sessionId,
        fileOrDirectoryPath: this.getCreationPath(parentItem.uri),
        fileProperties: { name: fileName, isDirectory: false },
      });

      const contentItem = this.filePropertiesToContentItem(response.data);
      this.updateFileMetadata(
        this.trimComputePrefix(contentItem.uri),
        response,
      );

      if (buffer) {
        await this.updateContentOfItemAtPath(
          this.trimComputePrefix(contentItem.uri),
          buffer,
        );
      }

      return contentItem;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (error) {
      return;
    }
  }

  private getCreationPath(uri: string) {
    if (
      uri === SAS_SERVER_HOME_DIRECTORY &&
      this.fileNavigationRoot === "CUSTOM"
    ) {
      return (
        this.fileNavigationCustomRootPath.replace(/\//g, SAS_FILE_SEPARATOR) ||
        SAS_FILE_SEPARATOR
      );
    }
    return this.trimComputePrefix(uri);
  }

  public async deleteItem(item: ContentItem): Promise<boolean> {
    const filePath = this.trimComputePrefix(item.uri);
    try {
      await this.fileSystemApi.deleteFileOrDirectoryFromSystem({
        sessionId: this.sessionId,
        fileOrDirectoryPath: filePath,
        ifMatch: "",
      });
      delete this.fileMetadataMap[filePath];
      // A deliberate delete is the one signal that tells a stale favorite
      // apart from one we simply cannot reach right now.
      await removeServerFavorite(this.pathOfUri(item.uri));
      return true;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (error) {
      return false;
    }
  }

  private getNavigationRoot(): string {
    if (this.fileNavigationRoot === "CUSTOM") {
      const navPath = this.fileNavigationCustomRootPath.split("/").join("~fs~");
      return `/compute/sessions/${this.sessionId}/files/${navPath}/members`;
    }
    return `/compute/sessions/${this.sessionId}/files/~fs~/members`;
  }

  public async getChildItems(parentItem: ContentItem): Promise<ContentItem[]> {
    // If the user is fetching child items of the root folder, give them the
    // "home" directory
    if (parentItem.id === SERVER_FOLDER_ID) {
      return [
        this.filePropertiesToContentItem(
          createStaticFolder(
            SAS_SERVER_HOME_DIRECTORY,
            ...homeDirectoryNameAndType(
              this.fileNavigationRoot,
              this.fileNavigationCustomRootPath,
            ),
            this.getNavigationRoot(),
            "getDirectoryMembers",
          ),
        ),
      ];
    }

    if (parentItem.id === SERVER_FAVORITES_FOLDER_ID) {
      return await this.getFavoriteItems();
    }

    const favorites = new Set(await readServerFavorites());
    const allItems = [];
    const limit = 100;
    let start = 0;
    let totalItemCount = 0;
    do {
      let response;
      try {
        response = await this.fileSystemApi.getDirectoryMembers({
          sessionId: this.sessionId,
          directoryPath: this.trimComputePrefix(
            getLink(parentItem.links, "GET", "getDirectoryMembers").uri,
          ).replace("/members", ""),
          limit,
          start,
        });
      } catch (error) {
        // If this error is specifically related to file nav root settings, provide
        // better feedback to the user
        if (
          error.status === 404 &&
          parentItem.uri === SAS_SERVER_HOME_DIRECTORY &&
          this.fileNavigationRoot === "CUSTOM"
        ) {
          if (this.fileNavigationSetByAdmin) {
            throw new Error(Messages.FileNavigationRootAdminError);
          } else {
            throw new Error(Messages.FileNavigationRootUserError);
          }
        }
        throw error;
      }
      totalItemCount = response.data.count;

      allItems.push(
        ...response.data.items.map((childItem: FileProperties, index) =>
          this.markFavorite(
            {
              ...this.filePropertiesToContentItem(childItem),
              uid: `${parentItem.uid}/${index + start}`,
            },
            favorites,
          ),
        ),
      );

      start += limit;
    } while (start < totalItemCount);

    return sortedContentItems(allItems);
  }

  public async getContentOfItem(item: ContentItem): Promise<string> {
    const path = this.trimComputePrefix(item.uri);
    return await this.getContentOfItemAtPath(path);
  }

  public async getContentOfUri(uri: Uri): Promise<string> {
    const path = this.trimComputePrefix(getResourceId(uri));
    return await this.getContentOfItemAtPath(path);
  }

  private async getContentOfItemAtPath(path: string) {
    const response = await this.fileSystemApi.getFileContentFromSystem(
      {
        sessionId: this.sessionId,
        filePath: path,
      },
      {
        responseType: "arraybuffer",
      },
    );

    this.updateFileMetadata(path, response);

    // Disabling typescript checks on this line as this function is typed
    // to return AxiosResponse<void,any>. However, it appears to return
    // AxiosResponse<string,>.
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return response.data as unknown as string;
  }

  public async getFolderPathForItem(): Promise<string> {
    // This is for creating a filename statement which won't work as expected for
    // file system files.
    return "";
  }

  public async getPathOfItem(item: ContentItem): Promise<string> {
    const uri =
      item.uri === SAS_SERVER_HOME_DIRECTORY
        ? this.getNavigationRoot().replace("/members", "")
        : item.uri;

    return this.pathOfUri(uri);
  }

  // The session-independent path of an item, and its inverse. Favorites are
  // stored in this form: a compute uri carries the session id, so it would go
  // stale the moment the session it names is recycled.
  private pathOfUri(uri: string): string {
    return this.trimComputePrefix(uri)
      .split(SAS_FILE_SEPARATOR)
      .join("/")
      .replace(/~sc~/g, ";");
  }

  private computePathOfPath(path: string): string {
    return path.replace(/;/g, "~sc~").split("/").join(SAS_FILE_SEPARATOR);
  }

  // The item as it appears elsewhere in the tree, told that it is bookmarked
  // so it offers "Remove from My Favorites" rather than "Add".
  private markFavorite(item: ContentItem, favorites: Set<string>): ContentItem {
    if (!favorites.has(this.pathOfUri(item.uri))) {
      return item;
    }

    const favorited = {
      ...item,
      flags: { ...item.flags, isInMyFavorites: true },
    };

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
      const response = await this.fileSystemApi.getFileorDirectoryProperties({
        sessionId: this.sessionId,
        fileOrDirectoryPath: this.computePathOfPath(path),
      });

      return {
        ...this.filePropertiesToContentItem(response.data, {
          isInMyFavorites: true,
          isFavoriteEntry: true,
        }),
        uid: `${SERVER_FAVORITES_FOLDER_ID}/${path}`,
      };
    } catch {
      // Moved, deleted, or outside the navigation root this session was given.
      // Keep the path - a transient failure shouldn't throw away what the user
      // saved - but don't render a node that cannot be opened.
      return undefined;
    }
  }

  public async getItemOfUri(uri: Uri): Promise<ContentItem> {
    const fileOrDirectoryPath = this.trimComputePrefix(getResourceId(uri));
    const response = await this.fileSystemApi.getFileorDirectoryProperties({
      sessionId: this.sessionId,
      fileOrDirectoryPath,
    });

    this.updateFileMetadata(fileOrDirectoryPath, response);

    return this.filePropertiesToContentItem(response.data);
  }

  public async getParentOfItem(
    item: ContentItem,
  ): Promise<ContentItem | undefined> {
    const fileOrDirectoryPath = this.getParentPathOfUri(
      this.trimComputePrefix(item.uri),
    );
    const response = await this.fileSystemApi.getFileorDirectoryProperties({
      sessionId: this.sessionId,
      fileOrDirectoryPath,
    });

    return this.filePropertiesToContentItem(response.data);
  }

  public getRootFolder(name: string): ContentItem | undefined {
    return this.rootFolders[name];
  }

  public async getRootItems(): Promise<RootFolderMap> {
    await this.setup();

    for (let index = 0; index < SAS_SERVER_ROOT_FOLDERS.length; ++index) {
      const delegateFolderName = SAS_SERVER_ROOT_FOLDERS[index];
      const result = { data: rootFolderFor(delegateFolderName) };

      this.rootFolders[delegateFolderName] = {
        ...result.data,
        uid: `${index}`,
        ...this.filePropertiesToContentItem(result.data),
      };
    }

    return this.rootFolders;
  }

  public async getUriOfItem(item: ContentItem): Promise<Uri> {
    // Favorites are resolved to the real file as they are listed rather than
    // stored as references, so there is nothing here to dereference.
    return item.vscUri;
  }

  public async moveItem(
    item: ContentItem,
    targetParentFolderUri: string,
  ): Promise<Uri | undefined> {
    const currentFilePath = this.trimComputePrefix(item.uri);
    const newFilePath = this.trimComputePrefix(targetParentFolderUri);
    const { etag } = await this.getFileInfo(currentFilePath, true);
    const params = {
      sessionId: this.sessionId,
      fileOrDirectoryPath: currentFilePath,
      ifMatch: etag,
      fileProperties: {
        name: item.name,
        path: newFilePath
          .split(SAS_FILE_SEPARATOR)
          .join("/")
          .replace(/~sc~/g, ";"),
      },
    };

    try {
      const response =
        await this.fileSystemApi.updateFileOrDirectoryOnSystem(params);
      delete this.fileMetadataMap[currentFilePath];
      this.updateFileMetadata(newFilePath, response);

      return this.filePropertiesToContentItem(response.data).vscUri;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (error) {
      return;
    }
  }

  public async renameItem(
    item: ContentItem,
    newName: string,
  ): Promise<ContentItem | undefined> {
    const filePath = this.trimComputePrefix(item.uri);

    const parsedFilePath = filePath.split(SAS_FILE_SEPARATOR);
    parsedFilePath.pop();
    const encodedPath = parsedFilePath.join("/");
    const path = this.decodePath(encodedPath);

    try {
      const response = await this.fileSystemApi.updateFileOrDirectoryOnSystem({
        sessionId: this.sessionId,
        fileOrDirectoryPath: filePath,
        ifMatch: "",
        fileProperties: { name: newName, path },
      });

      this.updateFileMetadata(filePath, response);

      return this.filePropertiesToContentItem(response.data);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (error) {
      return;
    }
  }

  public async updateContentOfItem(uri: Uri, content: string): Promise<void> {
    const filePath = this.trimComputePrefix(getResourceId(uri));
    return await this.updateContentOfItemAtPath(filePath, content);
  }

  private async updateContentOfItemAtPath(
    filePath: string,
    content: string | ArrayBufferLike,
  ): Promise<void> {
    const { etag } = await this.getFileInfo(filePath);
    const data = {
      sessionId: this.sessionId,
      filePath,
      // updateFileContentOnSystem requires body to be a File type. However, the
      // underlying code is expecting a string. This forces compute to accept
      // a string.
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      body: content as unknown as File,
      ifMatch: etag,
    };
    const response = await this.fileSystemApi.updateFileContentOnSystem(data);

    this.updateFileMetadata(filePath, response);
  }

  private getParentPathOfUri(uri: string) {
    const uriPieces = uri.split(SAS_FILE_SEPARATOR);
    uriPieces.pop();
    return uriPieces.join(SAS_FILE_SEPARATOR);
  }

  private filePropertiesToContentItem(
    fileProperties: FileProperties & { type?: string },
    flags?: ContentItem["flags"],
  ): ContentItem {
    const links = fileProperties.links.map((link) => ({
      method: link.method,
      rel: link.rel,
      href: link.href,
      type: link.type,
      uri: link.uri,
    }));

    const id = getLink(links, "GET", "self").uri;
    const isRootFolder = [
      SERVER_FOLDER_ID,
      SAS_SERVER_HOME_DIRECTORY,
      SERVER_FAVORITES_FOLDER_ID,
    ].includes(id);
    const item = {
      id,
      uri: id,
      name: fileProperties.name,
      creationTimeStamp: 0,
      modifiedTimeStamp: new Date(fileProperties.modifiedTimeStamp).getTime(),
      links,
      permission: {
        write: !isRootFolder && !fileProperties.readOnly,
        delete: !isRootFolder && !fileProperties.readOnly,
        addMember:
          !!getLink(links, "POST", "makeDirectory") ||
          !!getLink(links, "POST", "createFile") ||
          id === SAS_SERVER_HOME_DIRECTORY,
      },
      flags,
      type: fileProperties.type || "",
      parentFolderUri: this.getParentPathOfUri(id),
    };

    const typeName = getTypeName(item);

    return {
      ...item,
      contextValue: this.contextMenuProvider.availableActions(item),
      fileStat: {
        ctime: item.creationTimeStamp,
        mtime: item.modifiedTimeStamp,
        size: 0,
        type:
          fileProperties.isDirectory ||
          FOLDER_TYPES.indexOf(typeName) >= 0 ||
          isRootFolder
            ? FileType.Directory
            : FileType.File,
      },
      isReference: isReference(item),
      resourceId: getResourceIdFromItem(item),
      vscUri: getSasServerUri(item, flags?.isInRecycleBin || false),
      typeName: getTypeName(item),
    };
  }

  private trimComputePrefix(uri: string): string {
    const uriWithoutPrefix = uri.replace(
      /\/compute\/sessions\/[a-zA-Z0-9-]*\/files\//,
      "",
    );
    try {
      return decodeURIComponent(uriWithoutPrefix);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (error) {
      return uriWithoutPrefix;
    }
  }

  private updateFileMetadata(id: string, { headers }: AxiosResponse) {
    this.fileMetadataMap[id] = {
      etag: headers.etag,
    };

    return this.fileMetadataMap[id];
  }

  private async getFileInfo(path: string, forceRefresh?: boolean) {
    if (!forceRefresh && path in this.fileMetadataMap) {
      return this.fileMetadataMap[path];
    }

    // If we don't have file metadata stored, lets attempt to fetch it
    try {
      const response = await this.fileSystemApi.getFileorDirectoryProperties({
        sessionId: this.sessionId,
        fileOrDirectoryPath: path,
      });
      return this.updateFileMetadata(path, response);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (error) {
      // Intentionally blank
    }

    return {
      etag: "",
    };
  }

  private decodePath(path: string): string {
    return path.replace(/~~|~sc~/g, (match) => {
      if (match === "~~") {
        return "~";
      }
      if (match === "~sc~") {
        return ";";
      }
      return match;
    });
  }
}

export default RestServerAdapter;
