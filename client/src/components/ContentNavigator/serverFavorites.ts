// Copyright © 2026, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { profileConfig } from "../../commands/profile";
import { getContextValue, setContextValue } from "../ExtensionContext";
import {
  ServerFavorites,
  emptyFavorites,
  loadFavorites,
} from "./core/serverFavorites";

const favoritesKey = (profile: string): string =>
  `SAS.server.favorites:${profile}`;

const readFavorites = async (): Promise<ServerFavorites> => {
  const profile = profileConfig.getActiveProfile();
  const stored = await getContextValue(favoritesKey(profile));
  if (!stored) {
    return emptyFavorites(profile);
  }

  try {
    return loadFavorites(JSON.parse(stored), profile);
  } catch {
    // Corrupt state costs the user their shortcuts, never their files.
    return emptyFavorites(profile);
  }
};

const writeFavorites = async (favorites: ServerFavorites): Promise<void> => {
  await setContextValue(
    favoritesKey(favorites.profile),
    JSON.stringify(favorites),
  );
};

export const readServerFavorites = async (): Promise<string[]> =>
  (await readFavorites()).paths;

export const addServerFavorite = async (path: string): Promise<boolean> => {
  if (!path) {
    return false;
  }

  const favorites = await readFavorites();
  if (favorites.paths.includes(path)) {
    return true;
  }

  await writeFavorites({ ...favorites, paths: [...favorites.paths, path] });
  return true;
};

export const removeServerFavorite = async (path: string): Promise<boolean> => {
  const favorites = await readFavorites();
  if (!favorites.paths.includes(path)) {
    return false;
  }

  await writeFavorites({
    ...favorites,
    paths: favorites.paths.filter((favorite) => favorite !== path),
  });
  return true;
};
