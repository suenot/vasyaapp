import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { invoke } from '../../transport';
import { AccountSettings } from '../Settings/AccountSettings';
import { MyQrCode } from '../Profile/MyQrCode';
import { AccountSwitcher } from '../Accounts/AccountSwitcher';
import { MessageList, MessageListHandle } from '../Messages/MessageList';
import { prioritizeChat } from '../../hooks/useMediaQueue';
import { ChatList, ChatHeader, ChatHeaderHandle, ChatContextMenu, ChatInfoPanel, ChatFilters, TopicList } from '../Chat';
import { NewChatButton } from '../Chat/NewChatButton';
import { useSettingsStore } from '../../store/settingsStore';
import { useAccountsStore } from '../../store/accountsStore';
import { useChatsStore } from '../../store/chatsStore';
import { useConnectionStore } from '../../store/connectionStore';
import { useDebounce } from '../../hooks/useDebounce';
import { useTauriEvent } from '../../hooks/useTauriEvent';
import { useNotifications } from '../../hooks/useNotifications';
import { useHotkeysStore } from '../../store/hotkeysStore';
import { useMuteStore } from '../../store/muteStore';
import { useSelectionStore } from '../../store/selectionStore';
import { useFolderStore } from '../../store/folderStore';
import { Chat, ForumTopic, GlobalSearchResult, GlobalMessageResult } from '../../types/telegram';
import { useTranslation } from '../../i18n';
import './MainLayout.css';

export const MainLayout = () => {
  const { t } = useTranslation();
  const activeAccountId = useAccountsStore((s) => s.activeAccountId);
  const accounts = useAccountsStore((s) => s.accounts);
  const activeAccount = useMemo(
    () => accounts.find((a) => a.id === activeAccountId) ?? null,
    [accounts, activeAccountId]
  );
  const getCachedChats = useChatsStore((s) => s.getChats);
  const setCachedChats = useChatsStore((s) => s.setChats);

  const [chats, setChats] = useState<Chat[]>(
    activeAccount ? getCachedChats(activeAccount.id) || [] : []
  );
  // Latest chats accessible from stable callbacks without putting `chats` in
  // their deps (which would rebuild them on every streaming flush).
  const chatsRef = useRef(chats);
  chatsRef.current = chats;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedChatId, setSelectedChatId] = useState<number | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showMyQr, setShowMyQr] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<string>('all');
  const folderLayout = useSettingsStore((s) => s.folderLayout);
  const folders = useFolderStore((s) => s.folders);
  const foldersLoaded = useFolderStore((s) => s.loaded);
  const loadFoldersFromDb = useFolderStore((s) => s.loadFromDb);
  const [favorites, setFavorites] = useState<Set<number>>(() => {
    const saved = localStorage.getItem('favorites');
    return saved ? new Set(JSON.parse(saved)) : new Set();
  });
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; chatId: number } | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<number | null>(null);
  const [showChatInfo, setShowChatInfo] = useState(false);
  const [isSearchExpanded, setIsSearchExpanded] = useState(false);
  const [selectedTopic, setSelectedTopic] = useState<ForumTopic | null>(null);
  const messageListRef = useRef<MessageListHandle>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const chatHeaderRef = useRef<ChatHeaderHandle>(null);
  const chatListRef = useRef<HTMLDivElement>(null);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);

  // Native OS notifications for incoming messages
  useNotifications(selectedChatId);

  const debouncedSearch = useDebounce(searchQuery, 200);

  // Global search state
  const [globalResults, setGlobalResults] = useState<GlobalSearchResult[]>([]);
  const [globalLoading, setGlobalLoading] = useState(false);
  const [globalSearchLimit, setGlobalSearchLimit] = useState(5);

  // Cross-chat message search state
  const [messageResults, setMessageResults] = useState<GlobalMessageResult[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);

  // Mutable refs for streaming chat-loaded events without re-renders
  const [chatIdsSet] = useState(() => new Set<number>());
  const [loadedChatsArr] = useState<Chat[]>(() => []);
  const flushRef = useRef(0);
  // Coalesce background avatar updates: many `chat-avatar-updated` events per
  // second are merged into a single state update per animation frame.
  const pendingAvatarsRef = useRef<Map<number, string>>(new Map());
  const avatarFlushRef = useRef(0);

  useTauriEvent<Chat>('chat-loaded', useCallback((chat: Chat) => {
    if (chatIdsSet.has(chat.id)) return;
    chatIdsSet.add(chat.id);
    loadedChatsArr.push(chat);

    // First chat arriving proves the connection is alive
    if (chatIdsSet.size === 1) {
      useConnectionStore.getState().setConnected();
    }

    // Batch: one React state update per animation frame instead of per event
    if (!flushRef.current) {
      flushRef.current = requestAnimationFrame(() => {
        flushRef.current = 0;
        setChats([...loadedChatsArr]);
        setLoading(false);
      });
    }
  }, [chatIdsSet, loadedChatsArr]));

  // Handle avatar updates from background downloads (batched per frame)
  useTauriEvent<{ chatId: number; avatarPath: string }>('chat-avatar-updated', useCallback((evt) => {
    const idx = loadedChatsArr.findIndex((c) => c.id === evt.chatId);
    if (idx !== -1) {
      loadedChatsArr[idx] = { ...loadedChatsArr[idx], avatarPath: evt.avatarPath };
    }
    pendingAvatarsRef.current.set(evt.chatId, evt.avatarPath);
    if (!avatarFlushRef.current) {
      avatarFlushRef.current = requestAnimationFrame(() => {
        avatarFlushRef.current = 0;
        const pending = pendingAvatarsRef.current;
        pendingAvatarsRef.current = new Map();
        setChats((prev) => prev.map((c) =>
          pending.has(c.id) ? { ...c, avatarPath: pending.get(c.id)! } : c
        ));
      });
    }
  }, [loadedChatsArr]));

  useTauriEvent<number>('chats-loading-complete', useCallback((_total: number) => {
    if (activeAccount) {
      setCachedChats(activeAccount.id, loadedChatsArr);
    }
    setLoading(false);
    setError('');
  }, [activeAccount, setCachedChats, loadedChatsArr]));

  // Keep the chat list reactive to incoming messages even when the chat is not
  // open: update the last-message preview, bump unread (unless it's the open
  // chat or our own message), and move the chat to the top of the list.
  useTauriEvent<{
    accountId: string;
    chatId: number;
    text: string | null;
    isOutgoing: boolean;
    hasMedia: boolean;
    mediaType?: string;
  }>('telegram:new-message', useCallback((evt) => {
    if (evt.accountId !== activeAccountId) return;

    const mediaEmoji: Record<string, string> = {
      photo: '🖼️', video: '🎬', voice: '🎤', audio: '🎵',
      document: '📄', sticker: '🪧', videonote: '🎥',
    };
    const preview = (evt.text && evt.text.trim())
      || (evt.hasMedia ? (mediaEmoji[evt.mediaType ?? ''] ?? '📎') : '');
    const bumpUnread = !evt.isOutgoing && evt.chatId !== selectedChatId;

    const apply = (list: Chat[]): Chat[] => {
      const idx = list.findIndex((c) => c.id === evt.chatId);
      if (idx === -1) return list; // unknown chat — it will appear after next sync
      const updated: Chat = {
        ...list[idx],
        lastMessage: preview || list[idx].lastMessage,
        unreadCount: bumpUnread ? list[idx].unreadCount + 1 : list[idx].unreadCount,
      };
      const next = list.slice();
      next.splice(idx, 1);
      next.unshift(updated);
      return next;
    };

    setChats((prev) => apply(prev));
    // Mirror the reorder/update into the streaming array so a later rAF flush
    // (during initial load) doesn't revert it.
    const merged = apply(loadedChatsArr);
    loadedChatsArr.length = 0;
    for (const c of merged) loadedChatsArr.push(c);
  }, [activeAccountId, selectedChatId, loadedChatsArr]));

  // Listen for connection-status events from backend updates handler
  const setConnectionStatus = useConnectionStore((s) => s.setStatus);
  useTauriEvent<{ accountId: string; status: string }>('connection-status', useCallback((evt) => {
    if (evt.accountId === activeAccountId) {
      setConnectionStatus(evt.status as 'connecting' | 'connected' | 'reconnecting' | 'disconnected');
    }
  }, [activeAccountId, setConnectionStatus]));

  // Cancel pending flushes on unmount
  useEffect(() => {
    return () => {
      if (flushRef.current) cancelAnimationFrame(flushRef.current);
      if (avatarFlushRef.current) cancelAnimationFrame(avatarFlushRef.current);
    };
  }, []);

  // Load folders from DB on mount
  useEffect(() => {
    if (!foldersLoaded) loadFoldersFromDb();
  }, [foldersLoaded, loadFoldersFromDb]);

  // Clear streaming state on account switch
  useEffect(() => {
    if (flushRef.current) {
      cancelAnimationFrame(flushRef.current);
      flushRef.current = 0;
    }
    if (avatarFlushRef.current) {
      cancelAnimationFrame(avatarFlushRef.current);
      avatarFlushRef.current = 0;
    }
    pendingAvatarsRef.current.clear();
    chatIdsSet.clear();
    loadedChatsArr.length = 0;
  }, [activeAccountId, chatIdsSet, loadedChatsArr]);

  // Load cached chats + start background sync
  useEffect(() => {
    if (!activeAccount) {
      setError('No active account');
      return;
    }

    const loadAndSync = async () => {
      try {
        const cached = await invoke<Chat[]>('get_cached_chats', { accountId: activeAccount.id });
        if (cached && cached.length > 0) {
          setChats(cached);
          setLoading(false);
        } else {
          setLoading(true);
        }
      } catch {
        setLoading(true);
      }

      try {
        await invoke('start_loading_chats', { accountId: activeAccount.id });
        // start_loading_chats returned successfully → connection is alive
        useConnectionStore.getState().setConnected();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg || 'Failed to load chats');
        setLoading(false);
      }
    };

    loadAndSync();
  }, [activeAccountId]);

  // Unread counts per folder tab — memoized
  const unreadCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    const unreadChats = chats.filter(c => c.unreadCount > 0);

    // "all" — all chats with unread
    counts['all'] = unreadChats.length;

    // "contacts" — user chats that aren't bots
    counts['contacts'] = unreadChats.filter(
      c => c.chatType === 'user' && !c.username?.toLowerCase().includes('bot')
    ).length;

    // "chats" — groups + channels
    counts['chats'] = unreadChats.filter(
      c => c.chatType === 'group' || c.chatType === 'channel'
    ).length;

    // "favorites"
    counts['favorites'] = unreadChats.filter(c => favorites.has(c.id)).length;

    // Custom folders
    for (const folder of folders) {
      counts[folder.id] = unreadChats.filter(chat => {
        if (folder.excludedChatIds.includes(chat.id)) return false;
        if (folder.includedChatIds.includes(chat.id)) return true;

        let chatType: 'contacts' | 'non_contacts' | 'groups' | 'channels' | 'bots' = 'non_contacts';
        if (chat.chatType === 'user') {
          chatType = chat.username?.toLowerCase().includes('bot') ? 'bots' : 'contacts';
        } else if (chat.chatType === 'group') {
          chatType = 'groups';
        } else if (chat.chatType === 'channel') {
          chatType = 'channels';
        }

        if (folder.excludedChatTypes.includes(chatType)) return false;
        if (folder.includedChatTypes.includes(chatType)) return true;

        return false;
      }).length;
    }

    return counts;
  }, [chats, favorites, folders]);

  // Filtered chats — memoized with debounced search
  const filteredChats = useMemo(() => {
    const filtered = chats.filter((chat) => {
      if (debouncedSearch.trim()) {
        const q = debouncedSearch.toLowerCase();
        if (
          !chat.title.toLowerCase().includes(q) &&
          !chat.username?.toLowerCase().includes(q)
        ) {
          return false;
        }
      }
      switch (activeFilter) {
        case 'all':
          return true;
        case 'contacts':
          return chat.chatType === 'user' && !chat.username?.toLowerCase().includes('bot');
        case 'chats':
          return chat.chatType === 'group' || chat.chatType === 'channel';
        case 'favorites':
          return favorites.has(chat.id);
        default: {
          const folder = folders.find(f => f.id === activeFilter);
          if (folder) {
            if (folder.excludedChatIds.includes(chat.id)) return false;
            if (folder.includedChatIds.includes(chat.id)) return true;

            let chatType: 'contacts' | 'non_contacts' | 'groups' | 'channels' | 'bots' = 'non_contacts';
            if (chat.chatType === 'user') {
              chatType = chat.username?.toLowerCase().includes('bot') ? 'bots' : 'contacts';
            } else if (chat.chatType === 'group') {
              chatType = 'groups';
            } else if (chat.chatType === 'channel') {
              chatType = 'channels';
            }

            if (folder.excludedChatTypes.includes(chatType)) return false;
            if (folder.includedChatTypes.includes(chatType)) return true;

            return false;
          }
          return true;
        }
      }
    });

    // All folders except "all": unread chats first, preserving relative order within each group
    if (activeFilter !== 'all') {
      const unread = filtered.filter(c => c.unreadCount > 0);
      const read = filtered.filter(c => c.unreadCount === 0);
      return [...unread, ...read];
    }

    return filtered;
  }, [chats, debouncedSearch, activeFilter, favorites, folders]);

  // Global search effect (contacts.Search)
  useEffect(() => {
    if (!debouncedSearch.trim() || !activeAccount) {
      setGlobalResults([]);
      setGlobalLoading(false);
      return;
    }

    let cancelled = false;
    setGlobalLoading(true);

    invoke<GlobalSearchResult[]>('global_search', {
      accountId: activeAccount.id,
      query: debouncedSearch.trim(),
      limit: globalSearchLimit,
    })
      .then((results) => {
        if (!cancelled) {
          setGlobalResults(results);
          setGlobalLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          console.error('Global search failed:', err);
          setGlobalResults([]);
          setGlobalLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [debouncedSearch, activeAccount, globalSearchLimit]);

  // Cross-chat message search effect (messages.SearchGlobal)
  useEffect(() => {
    if (!debouncedSearch.trim() || !activeAccount) {
      setMessageResults([]);
      setMessagesLoading(false);
      return;
    }

    let cancelled = false;
    setMessagesLoading(true);

    invoke<GlobalMessageResult[]>('search_all_messages', {
      accountId: activeAccount.id,
      query: debouncedSearch.trim(),
      limit: 10,
    })
      .then((results) => {
        if (!cancelled) {
          setMessageResults(results);
          setMessagesLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          console.error('Message search failed:', err);
          setMessageResults([]);
          setMessagesLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [debouncedSearch, activeAccount]);

  const handleGlobalResultClick = useCallback((result: GlobalSearchResult) => {
    // Open the chat by ID — for global results, use the result id directly
    setSelectedChatId(result.id);
    setSelectedTopic(null);
    setSearchQuery('');
    setIsSearchExpanded(false);
  }, []);

  const handleMessageResultClick = useCallback((result: GlobalMessageResult) => {
    setSelectedChatId(result.chatId);
    setSelectedTopic(null);
    setSearchQuery('');
    setIsSearchExpanded(false);
    // Scroll to message after a short delay to let the chat load
    setTimeout(() => {
      setHighlightedMessageId(result.messageId);
      messageListRef.current?.scrollToMessage(result.messageId);
      setTimeout(() => setHighlightedMessageId(null), 2000);
    }, 500);
  }, []);

  const handleShowMoreGlobal = useCallback(() => {
    setGlobalSearchLimit((prev) => prev + 20);
  }, []);

  // Mark chat as read locally (optimistic update for unread badge)
  const clearUnreadCount = useCallback((chatId: number) => {
    if (!activeAccount) return;
    const chat = chatsRef.current.find((c) => c.id === chatId);
    if (!chat || chat.unreadCount === 0) return;

    // Update local state immediately (optimistic)
    setChats((prev) => prev.map((c) =>
      c.id === chatId ? { ...c, unreadCount: 0 } : c
    ));
    // Also update the loadedChatsArr for consistency
    const idx = loadedChatsArr.findIndex((c) => c.id === chatId);
    if (idx !== -1) {
      loadedChatsArr[idx] = { ...loadedChatsArr[idx], unreadCount: 0 };
    }
    // Update persisted chats store
    useChatsStore.getState().updateUnreadCount(activeAccount.id, chatId, 0);
  }, [activeAccount, loadedChatsArr]);

  // Mark messages as read via context menu (without opening the chat)
  const markChatAsRead = useCallback(async (chatId: number) => {
    if (!activeAccount) return;
    clearUnreadCount(chatId);

    // Use max_id=2147483647 (i32::MAX) to mark all messages as read
    try {
      await invoke('mark_messages_read', {
        accountId: activeAccount.id,
        chatId,
        maxId: 2147483647,
      });
    } catch (err) {
      console.error('[MainLayout] Failed to mark messages as read:', err);
    }
  }, [activeAccount, clearUnreadCount]);

  // Read All chats in a folder/filter
  const handleReadAllFolder = useCallback((folderId: string) => {
    const unreadChats = chats.filter(c => c.unreadCount > 0);
    const chatsInFolder = unreadChats.filter(chat => {
      switch (folderId) {
        case 'all': return true;
        case 'contacts': return chat.chatType === 'user' && !chat.username?.toLowerCase().includes('bot');
        case 'chats': return chat.chatType === 'group' || chat.chatType === 'channel';
        case 'favorites': return favorites.has(chat.id);
        default: {
          const folder = folders.find(f => f.id === folderId);
          if (!folder) return false;
          if (folder.excludedChatIds.includes(chat.id)) return false;
          if (folder.includedChatIds.includes(chat.id)) return true;
          let chatType: 'contacts' | 'non_contacts' | 'groups' | 'channels' | 'bots' = 'non_contacts';
          if (chat.chatType === 'user') chatType = chat.username?.toLowerCase().includes('bot') ? 'bots' : 'contacts';
          else if (chat.chatType === 'group') chatType = 'groups';
          else if (chat.chatType === 'channel') chatType = 'channels';
          if (folder.excludedChatTypes.includes(chatType)) return false;
          if (folder.includedChatTypes.includes(chatType)) return true;
          return false;
        }
      }
    });
    chatsInFolder.forEach(chat => markChatAsRead(chat.id));
  }, [chats, favorites, folders, markChatAsRead]);

  // Mute All chats in a folder/filter
  const handleMuteAllFolder = useCallback((folderId: string) => {
    const chatsInFolder = chats.filter(chat => {
      switch (folderId) {
        case 'all': return true;
        case 'contacts': return chat.chatType === 'user' && !chat.username?.toLowerCase().includes('bot');
        case 'chats': return chat.chatType === 'group' || chat.chatType === 'channel';
        case 'favorites': return favorites.has(chat.id);
        default: {
          const folder = folders.find(f => f.id === folderId);
          if (!folder) return false;
          if (folder.excludedChatIds.includes(chat.id)) return false;
          if (folder.includedChatIds.includes(chat.id)) return true;
          let chatType: 'contacts' | 'non_contacts' | 'groups' | 'channels' | 'bots' = 'non_contacts';
          if (chat.chatType === 'user') chatType = chat.username?.toLowerCase().includes('bot') ? 'bots' : 'contacts';
          else if (chat.chatType === 'group') chatType = 'groups';
          else if (chat.chatType === 'channel') chatType = 'channels';
          if (folder.excludedChatTypes.includes(chatType)) return false;
          if (folder.includedChatTypes.includes(chatType)) return true;
          return false;
        }
      }
    });
    const { toggleMute, isMuted } = useMuteStore.getState();
    chatsInFolder.forEach(chat => {
      if (!isMuted(chat.id)) toggleMute(chat.id);
    });
  }, [chats, favorites, folders]);

  const handleChatClick = useCallback((chatId: number) => {
    setSelectedChatId(chatId);
    setSelectedTopic(null); // Reset topic when switching chats
    prioritizeChat(chatId);
    // Clear unread badge immediately; the actual read acknowledgement
    // will be sent by MessageList after messages load with the correct max_id
    clearUnreadCount(chatId);
  }, [clearUnreadCount]);

  const toggleFavorite = useCallback((chatId: number) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(chatId)) next.delete(chatId);
      else next.add(chatId);
      localStorage.setItem('favorites', JSON.stringify([...next]));
      return next;
    });
    setContextMenu(null);
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent, chatId: number) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, chatId });
  }, []);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const selectedChat = useMemo(
    () => chats.find((c) => c.id === selectedChatId) ?? null,
    [chats, selectedChatId]
  );

  const handleTopicClick = useCallback((topic: ForumTopic) => {
    setSelectedTopic(topic);
  }, []);

  const handleBackToTopics = useCallback(() => {
    setSelectedTopic(null);
  }, []);

  const handleScrollToMessage = useCallback((messageId: number) => {
    setHighlightedMessageId(messageId);
    messageListRef.current?.scrollToMessage(messageId);
    // Clear highlight after animation
    setTimeout(() => setHighlightedMessageId(null), 2000);
  }, []);

  // Reset highlighted index and global search limit when search query changes
  useEffect(() => {
    setHighlightedIndex(-1);
    setGlobalSearchLimit(5);
  }, [debouncedSearch, activeFilter]);

  // Global Hotkeys Listener
  const hotkeys = useHotkeysStore((s) => s.hotkeys);
  const toggleMute = useMuteStore((s) => s.toggleMute);
  const isSelectionMode = useSelectionStore((s) => s.isSelectionMode);
  const exitSelectionMode = useSelectionStore((s) => s.exitSelectionMode);
  // Subscribe to the underlying tab/folder data (not the stable getter), so the
  // component actually re-renders — and hotkeys see the current tab list — when
  // tab visibility changes in settings.
  const tabs = useFolderStore((s) => s.tabs);
  const getVisibleTabs = useFolderStore((s) => s.getVisibleTabs);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const visibleTabs = useMemo(() => getVisibleTabs(), [getVisibleTabs, tabs, folders]);

  const handleGlobalKeydown = (e: KeyboardEvent) => {
      // Helper: Check if hotkey matches
      const isMatch = (id: string): boolean => {
        const config = hotkeys.find((h) => h.id === id);
        if (!config) return false;

        const keys = config.keys;
        const configModifiers = keys.filter(k => ['Meta', 'Ctrl', 'Alt', 'Shift'].includes(k));
        const configNonModifiers = keys.filter(k => !['Meta', 'Ctrl', 'Alt', 'Shift'].includes(k));

        if (configModifiers.includes('Meta') !== e.metaKey) return false;
        if (configModifiers.includes('Ctrl') !== e.ctrlKey) return false;
        if (configModifiers.includes('Alt') !== e.altKey) return false;
        if (configModifiers.includes('Shift') !== e.shiftKey) return false;

        if (configNonModifiers.length === 0) return false;
        const targetKey = configNonModifiers[0];
        if (targetKey.toLowerCase() !== e.key.toLowerCase()) return false;

        return true;
      };

      // --- Search result keyboard navigation (Arrow keys + Enter in search input) ---
      const isSearchInputFocused = document.activeElement === searchInputRef.current;
      const isSearchActive = isSearchExpanded && searchQuery.trim().length > 0;

      if (isSearchInputFocused && isSearchActive && filteredChats.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setHighlightedIndex((prev) => {
            const next = prev < filteredChats.length - 1 ? prev + 1 : 0;
            // Scroll highlighted item into view
            setTimeout(() => {
              chatListRef.current?.querySelector('.chat-item.keyboard-highlighted')?.scrollIntoView({ block: 'nearest' });
            }, 0);
            return next;
          });
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setHighlightedIndex((prev) => {
            const next = prev > 0 ? prev - 1 : filteredChats.length - 1;
            setTimeout(() => {
              chatListRef.current?.querySelector('.chat-item.keyboard-highlighted')?.scrollIntoView({ block: 'nearest' });
            }, 0);
            return next;
          });
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          const idx = highlightedIndex >= 0 ? highlightedIndex : 0;
          if (filteredChats[idx]) {
            handleChatClick(filteredChats[idx].id);
            setSearchQuery('');
            setIsSearchExpanded(false);
            setHighlightedIndex(-1);
            searchInputRef.current?.blur();
          }
          return;
        }
      }

      // --- Escape: context-sensitive close ---
      if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        if (showSettings) {
          e.preventDefault();
          setShowSettings(false);
          return;
        }
        if (isSearchExpanded) {
          e.preventDefault();
          setSearchQuery('');
          setIsSearchExpanded(false);
          setHighlightedIndex(-1);
          return;
        }
        if (showChatInfo) {
          e.preventDefault();
          setShowChatInfo(false);
          return;
        }
        if (selectedTopic) {
          e.preventDefault();
          setSelectedTopic(null);
          return;
        }
        if (isSelectionMode) {
          e.preventDefault();
          exitSelectionMode();
          return;
        }
        if (selectedChatId) {
          e.preventDefault();
          setSelectedChatId(null);
          return;
        }
        return;
      }

      // --- Don't process other hotkeys when typing in an input/textarea ---
      const tag = (e.target as HTMLElement)?.tagName;
      const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable;

      // Focus search (Cmd+K / Ctrl+K)
      if (isMatch('focus_search')) {
        e.preventDefault();
        setIsSearchExpanded(true);
        setTimeout(() => searchInputRef.current?.focus(), 50);
        return;
      }

      // Search in chat (Cmd+F / Ctrl+F)
      if (isMatch('search_in_chat')) {
        e.preventDefault();
        if (selectedChatId) {
          chatHeaderRef.current?.toggleSearch();
        } else {
          // No chat open: focus sidebar search instead
          setIsSearchExpanded(true);
          setTimeout(() => searchInputRef.current?.focus(), 50);
        }
        return;
      }

      // Open settings
      if (isMatch('open_settings')) {
        e.preventDefault();
        setShowSettings((prev) => !prev);
        return;
      }

      // Close panel (Ctrl+W)
      if (isMatch('close_panel')) {
        e.preventDefault();
        if (showSettings) { setShowSettings(false); return; }
        if (showChatInfo) { setShowChatInfo(false); return; }
        if (selectedTopic) { setSelectedTopic(null); return; }
        if (selectedChatId) { setSelectedChatId(null); return; }
        return;
      }

      // Skip navigation/action hotkeys when typing
      if (isTyping) return;

      // Arrow Down/Up without modifiers: navigate chat list
      if (e.key === 'ArrowDown' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        if (filteredChats.length > 0) {
          const idx = selectedChatId ? filteredChats.findIndex(c => c.id === selectedChatId) : -1;
          const nextIdx = idx < filteredChats.length - 1 ? idx + 1 : 0;
          handleChatClick(filteredChats[nextIdx].id);
        }
        return;
      }
      if (e.key === 'ArrowUp' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        if (filteredChats.length > 0) {
          const idx = selectedChatId ? filteredChats.findIndex(c => c.id === selectedChatId) : -1;
          const prevIdx = idx <= 0 ? filteredChats.length - 1 : idx - 1;
          handleChatClick(filteredChats[prevIdx].id);
        }
        return;
      }

      // Next chat (Alt+Down)
      if (isMatch('next_chat') || isMatch('next_chat_tab')) {
        e.preventDefault();
        if (filteredChats.length > 0) {
          const idx = selectedChatId ? filteredChats.findIndex(c => c.id === selectedChatId) : -1;
          const nextIdx = (idx + 1) % filteredChats.length;
          handleChatClick(filteredChats[nextIdx].id);
        }
        return;
      }

      // Prev chat (Alt+Up)
      if (isMatch('prev_chat') || isMatch('prev_chat_tab')) {
        e.preventDefault();
        if (filteredChats.length > 0) {
          const idx = selectedChatId ? filteredChats.findIndex(c => c.id === selectedChatId) : -1;
          const prevIdx = idx <= 0 ? filteredChats.length - 1 : idx - 1;
          handleChatClick(filteredChats[prevIdx].id);
        }
        return;
      }

      // Next unread chat (Alt+Shift+Down)
      if (isMatch('next_unread_chat')) {
        e.preventDefault();
        if (filteredChats.length > 0) {
          const startIdx = selectedChatId ? filteredChats.findIndex(c => c.id === selectedChatId) : -1;
          for (let i = 1; i <= filteredChats.length; i++) {
            const idx = (startIdx + i) % filteredChats.length;
            if (filteredChats[idx].unreadCount > 0) {
              handleChatClick(filteredChats[idx].id);
              break;
            }
          }
        }
        return;
      }

      // Prev unread chat (Alt+Shift+Up)
      if (isMatch('prev_unread_chat')) {
        e.preventDefault();
        if (filteredChats.length > 0) {
          const startIdx = selectedChatId ? filteredChats.findIndex(c => c.id === selectedChatId) : filteredChats.length;
          for (let i = 1; i <= filteredChats.length; i++) {
            const idx = (startIdx - i + filteredChats.length) % filteredChats.length;
            if (filteredChats[idx].unreadCount > 0) {
              handleChatClick(filteredChats[idx].id);
              break;
            }
          }
        }
        return;
      }

      // Mute/unmute chat (Ctrl+Shift+M)
      if (isMatch('mute_chat')) {
        e.preventDefault();
        if (selectedChatId) {
          toggleMute(selectedChatId);
        }
        return;
      }

      // Folder/tab switching (Ctrl+1-9)
      for (let n = 1; n <= 9; n++) {
        if (isMatch(`folder_${n}`)) {
          e.preventDefault();
          const tab = visibleTabs[n - 1];
          if (tab) {
            setActiveFilter(tab.id);
          }
          return;
        }
      }

      // Scroll to top (Ctrl+Home)
      if (isMatch('scroll_to_top')) {
        e.preventDefault();
        messageListRef.current?.scrollToMessage(0);
        return;
      }

      // Scroll to bottom (Ctrl+End)
      if (isMatch('scroll_to_bottom')) {
        e.preventDefault();
        // Scroll the messages area to the bottom
        const messagesArea = document.querySelector('.messages-area');
        if (messagesArea) {
          const scrollable = messagesArea.querySelector('.message-list');
          if (scrollable) scrollable.scrollTop = scrollable.scrollHeight;
        }
        return;
      }
    };

  // Install a single keydown listener; it always calls the latest handler via a
  // ref, so we no longer remove/re-add the window listener on every render
  // (previously triggered by every keystroke, stream flush and tab change).
  const keydownHandlerRef = useRef(handleGlobalKeydown);
  keydownHandlerRef.current = handleGlobalKeydown;
  useEffect(() => {
    const listener = (e: KeyboardEvent) => keydownHandlerRef.current(e);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  return (
    <div className={`main-layout ${selectedChatId ? 'chat-open' : ''} layout-${folderLayout}`}>
      {folderLayout === 'vertical' && (
        <aside className="folder-sidebar">
          <ChatFilters activeFilter={activeFilter} onFilterChange={setActiveFilter} unreadCounts={unreadCounts} onReadAll={handleReadAllFolder} onMuteAll={handleMuteAllFolder} />
        </aside>
      )}
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className={`sidebar-header-top ${isSearchExpanded ? 'search-active' : ''}`}>
            {!isSearchExpanded && <AccountSwitcher />}
            <div className={`sidebar-actions ${isSearchExpanded ? 'full-width' : ''}`}>
              {!isSearchExpanded && (
                <NewChatButton accountId={activeAccountId} onChatCreated={(chatId) => handleChatClick(chatId)} />
              )}
              <div className={`search-container-inline ${isSearchExpanded || searchQuery ? 'expanded' : ''}`}>
                <button
                  className="icon-button search-toggle"
                  onClick={() => {
                    setIsSearchExpanded(!isSearchExpanded);
                    if (!isSearchExpanded) {
                      setTimeout(() => searchInputRef.current?.focus(), 100);
                    } else {
                      setSearchQuery('');
                    }
                  }}
                  title={isSearchExpanded ? t('close_search') : t('search')}
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    {isSearchExpanded ? (
                      <>
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                      </>
                    ) : (
                      <>
                        <circle cx="11" cy="11" r="8"></circle>
                        <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                      </>
                    )}
                  </svg>
                </button>
                <input
                  ref={searchInputRef}
                  type="text"
                  className="inline-search-input"
                  placeholder={t('search_chats')}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onBlur={() => { if (!searchQuery) setIsSearchExpanded(false); }}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                />
              </div>
              {!isSearchExpanded && (
                <button className="icon-button" title={t('my_qr_code' as any)} onClick={() => setShowMyQr(true)}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="7" height="7" rx="1" />
                    <rect x="14" y="3" width="7" height="7" rx="1" />
                    <rect x="3" y="14" width="7" height="7" rx="1" />
                    <path d="M14 14h3v3h-3z" />
                    <path d="M21 14v.01M14 21v.01M21 21h-3.5" />
                  </svg>
                </button>
              )}
              {!isSearchExpanded && (
                <button className="icon-button" title={t('settings')} onClick={() => setShowSettings(true)}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.1a2 2 0 011 1.72v.51a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.39a2 2 0 00-.73-2.73l-.15-.08a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                </button>
              )}
            </div>
          </div>
          {folderLayout === 'horizontal' && (
            <ChatFilters activeFilter={activeFilter} onFilterChange={setActiveFilter} unreadCounts={unreadCounts} onReadAll={handleReadAllFolder} onMuteAll={handleMuteAllFolder} />
          )}
          <div ref={chatListRef} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <ChatList
              chats={filteredChats}
              loading={loading}
              error={error}
              selectedChatId={selectedChatId}
              favorites={favorites}
              searchQuery={searchQuery}
              highlightedIndex={highlightedIndex}
              onChatClick={handleChatClick}
              onContextMenu={handleContextMenu}
              globalResults={globalResults}
              globalLoading={globalLoading}
              messageResults={messageResults}
              messagesLoading={messagesLoading}
              onGlobalResultClick={handleGlobalResultClick}
              onMessageResultClick={handleMessageResultClick}
              onShowMoreGlobal={handleShowMoreGlobal}
            />
          </div>
        </div>
      </aside>

      <main className="content">
        <div className="content-bg" />
        <ChatHeader
          ref={chatHeaderRef}
          chat={selectedChat}
          accountId={activeAccount?.id}
          onScrollToMessage={handleScrollToMessage}
          onShowInfo={() => setShowChatInfo(true)}
          onDeleteChat={() => setSelectedChatId(null)}
          onBack={() => setSelectedChatId(null)}
        />

        <div className="messages-area">
          {selectedChat && activeAccount ? (
            selectedChat.isForum && !selectedTopic ? (
              <TopicList
                accountId={activeAccount.id}
                chatId={selectedChat.id}
                onTopicClick={handleTopicClick}
              />
            ) : (
              <MessageList
                key={selectedTopic ? `${selectedChat.id}-${selectedTopic.id}` : selectedChat.id}
                ref={messageListRef}
                accountId={activeAccount.id}
                chatId={selectedChat.id}
                chatTitle={selectedTopic ? selectedTopic.title : selectedChat.title}
                chatType={selectedChat.chatType}
                highlightedMessageId={highlightedMessageId}
                topicId={selectedTopic?.id}
                onBackToTopics={selectedChat.isForum ? handleBackToTopics : undefined}
              />
            )
          ) : (
            <div className="empty-chat">
              <div className="empty-chat-bubble">
                {t('select_chat')}
              </div>
            </div>
          )}
        </div>

        {showChatInfo && selectedChat && (
          <ChatInfoPanel chat={selectedChat} accountId={activeAccountId!} onClose={() => setShowChatInfo(false)} />
        )}
      </main>

      {showSettings && <AccountSettings onClose={() => setShowSettings(false)} />}
      {showMyQr && <MyQrCode onClose={() => setShowMyQr(false)} />}

      {
        contextMenu && (() => {
          const chat = chats.find(c => c.id === contextMenu.chatId);
          return (
            <ChatContextMenu
              x={contextMenu.x}
              y={contextMenu.y}
              chatId={contextMenu.chatId}
              chatType={chat?.chatType}
              chatTitle={chat?.title}
              unreadCount={chat?.unreadCount}
              isFavorite={favorites.has(contextMenu.chatId)}
              onToggleFavorite={toggleFavorite}
              onMarkAsRead={(id) => { markChatAsRead(id); }}
              onDelete={(id) => { console.log('Delete/Leave chat:', id); }}
              onClose={closeContextMenu}
            />
          );
        })()
      }
    </div >
  );
};
