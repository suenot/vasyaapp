import { create } from 'zustand';
import { invoke } from '../transport';

export type ChatTypeFilter = 'contacts' | 'non_contacts' | 'groups' | 'channels' | 'bots';

export interface ChatFolder {
  id: string;
  name: string;
  icon?: string;
  includedChatTypes: ChatTypeFilter[];
  excludedChatTypes: ChatTypeFilter[];
  includedChatIds: number[];
  excludedChatIds: number[];
  order: number;
}

/** A tab entry: either a built-in filter or a custom folder */
export interface TabEntry {
  id: string;
  visible: boolean;
}

/** Built-in tab IDs in default order */
export const BUILTIN_TAB_IDS = ['all', 'contacts', 'chats', 'favorites'] as const;
export type BuiltinTabId = typeof BUILTIN_TAB_IDS[number];

const DEFAULT_VISIBLE: Record<string, boolean> = {
  all: true,
  contacts: true,
  chats: false,
  favorites: true,
};

/** Backend folder record (snake_case from Rust) */
interface FolderRecord {
  id: string;
  name: string;
  icon?: string;
  included_chat_types: string[];
  excluded_chat_types: string[];
  included_chat_ids: number[];
  excluded_chat_ids: number[];
  sort_order: number;
}

/** Backend tab record */
interface TabRecord {
  id: string;
  visible: boolean;
  sort_order: number;
}

function folderFromRecord(r: FolderRecord): ChatFolder {
  return {
    id: r.id,
    name: r.name,
    icon: r.icon,
    includedChatTypes: r.included_chat_types as ChatTypeFilter[],
    excludedChatTypes: r.excluded_chat_types as ChatTypeFilter[],
    includedChatIds: r.included_chat_ids,
    excludedChatIds: r.excluded_chat_ids,
    order: r.sort_order,
  };
}

function folderToRecord(f: ChatFolder): FolderRecord {
  return {
    id: f.id,
    name: f.name,
    icon: f.icon,
    included_chat_types: f.includedChatTypes,
    excluded_chat_types: f.excludedChatTypes,
    included_chat_ids: f.includedChatIds,
    excluded_chat_ids: f.excludedChatIds,
    sort_order: f.order,
  };
}

function tabsToRecords(tabs: TabEntry[]): TabRecord[] {
  return tabs.map((t, i) => ({ id: t.id, visible: t.visible, sort_order: i }));
}

/** Ensure tabs array is in sync with folders */
function syncTabs(tabs: TabEntry[], folders: ChatFolder[]): TabEntry[] {
  const folderIds = new Set(folders.map(f => f.id));
  const existingIds = new Set(tabs.map(t => t.id));

  const result = tabs.filter(t =>
    (BUILTIN_TAB_IDS as readonly string[]).includes(t.id) || folderIds.has(t.id)
  );

  for (const id of BUILTIN_TAB_IDS) {
    if (!existingIds.has(id)) {
      result.push({ id, visible: DEFAULT_VISIBLE[id] ?? true });
    }
  }

  for (const folderId of folderIds) {
    if (!existingIds.has(folderId)) {
      result.push({ id: folderId, visible: true });
    }
  }

  return result;
}

interface FolderStore {
  folders: ChatFolder[];
  tabs: TabEntry[];
  loaded: boolean;
  loadFromDb: () => Promise<void>;
  addFolder: (folder: Omit<ChatFolder, 'id' | 'order'>) => void;
  updateFolder: (id: string, folder: Partial<ChatFolder>) => void;
  deleteFolder: (id: string) => void;
  reorderFolders: (newOrder: string[]) => void;
  setTabVisible: (id: string, visible: boolean) => void;
  reorderTabs: (orderedIds: string[]) => void;
  getVisibleTabs: () => TabEntry[];
  addChatToFolder: (folderId: string, chatId: number) => void;
  removeChatFromFolder: (folderId: string, chatId: number) => void;
}

/** Persist a single folder to DB (fire-and-forget) */
function persistFolder(folder: ChatFolder) {
  invoke('save_folder', { folder: folderToRecord(folder) }).catch(e =>
    console.error('Failed to save folder:', e)
  );
}

/** Persist full tabs list to DB */
function persistTabs(tabs: TabEntry[]) {
  invoke('save_tabs', { tabs: tabsToRecords(tabs) }).catch(e =>
    console.error('Failed to save tabs:', e)
  );
}

export const useFolderStore = create<FolderStore>()((set, get) => ({
  folders: [],
  tabs: BUILTIN_TAB_IDS.map(id => ({ id, visible: DEFAULT_VISIBLE[id] ?? true })),
  loaded: false,

  loadFromDb: async () => {
    try {
      const [folderRecords, tabRecords] = await Promise.all([
        invoke<FolderRecord[]>('get_folders'),
        invoke<TabRecord[]>('get_tabs'),
      ]);

      const folders = folderRecords.map(folderFromRecord);
      let tabs: TabEntry[] = tabRecords
        .sort((a, b) => a.sort_order - b.sort_order)
        .map(r => ({ id: r.id, visible: r.visible }));

      // If DB had no tabs yet, initialize defaults
      if (tabs.length === 0) {
        tabs = BUILTIN_TAB_IDS.map(id => ({ id, visible: DEFAULT_VISIBLE[id] ?? true }));
        // Add folder tabs
        for (const f of folders) {
          tabs.push({ id: f.id, visible: true });
        }
        persistTabs(tabs);
      }

      tabs = syncTabs(tabs, folders);

      set({ folders, tabs, loaded: true });
    } catch (e) {
      console.error('Failed to load folders from DB:', e);
      set({ loaded: true });
    }
  },

  addFolder: (folderData) => {
    const newFolder: ChatFolder = {
      ...folderData,
      id: Math.random().toString(36).substring(2, 9),
      order: get().folders.length,
    };
    const newTabs = [...get().tabs, { id: newFolder.id, visible: true }];
    set({ folders: [...get().folders, newFolder], tabs: newTabs });
    persistFolder(newFolder);
    persistTabs(newTabs);
  },

  updateFolder: (id, updates) => {
    const newFolders = get().folders.map(f => f.id === id ? { ...f, ...updates } : f);
    set({ folders: newFolders });
    const updated = newFolders.find(f => f.id === id);
    if (updated) persistFolder(updated);
  },

  deleteFolder: (id) => {
    const newTabs = get().tabs.filter(t => t.id !== id);
    set({
      folders: get().folders.filter(f => f.id !== id),
      tabs: newTabs,
    });
    invoke('delete_folder', { id }).catch(e => console.error('Failed to delete folder:', e));
    persistTabs(newTabs);
  },

  reorderFolders: (newOrderIds) => {
    const newFolders = [...get().folders].sort(
      (a, b) => newOrderIds.indexOf(a.id) - newOrderIds.indexOf(b.id)
    );
    newFolders.forEach((f, i) => { f.order = i; });
    set({ folders: newFolders });
    newFolders.forEach(f => persistFolder(f));
  },

  setTabVisible: (id, visible) => {
    const newTabs = get().tabs.map(t => t.id === id ? { ...t, visible } : t);
    set({ tabs: newTabs });
    persistTabs(newTabs);
  },

  reorderTabs: (orderedIds) => {
    const tabMap = new Map(get().tabs.map(t => [t.id, t]));
    const reordered: TabEntry[] = [];
    for (const id of orderedIds) {
      const tab = tabMap.get(id);
      if (tab) reordered.push(tab);
    }
    for (const tab of get().tabs) {
      if (!orderedIds.includes(tab.id)) {
        reordered.push(tab);
      }
    }
    set({ tabs: reordered });
    persistTabs(reordered);
  },

  getVisibleTabs: () => {
    const state = get();
    return syncTabs(state.tabs, state.folders).filter(t => t.visible);
  },

  addChatToFolder: (folderId, chatId) => {
    const newFolders = get().folders.map(f =>
      f.id === folderId && !f.includedChatIds.includes(chatId)
        ? { ...f, includedChatIds: [...f.includedChatIds, chatId] }
        : f
    );
    set({ folders: newFolders });
    const updated = newFolders.find(f => f.id === folderId);
    if (updated) persistFolder(updated);
  },

  removeChatFromFolder: (folderId, chatId) => {
    const newFolders = get().folders.map(f =>
      f.id === folderId
        ? { ...f, includedChatIds: f.includedChatIds.filter(id => id !== chatId) }
        : f
    );
    set({ folders: newFolders });
    const updated = newFolders.find(f => f.id === folderId);
    if (updated) persistFolder(updated);
  },
}));
