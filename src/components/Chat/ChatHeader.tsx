import { useState, useCallback, useRef, useEffect, forwardRef, useImperativeHandle } from 'react';
import { invoke } from '../../transport';
import { Chat, Message } from '../../types/telegram';
import { useConnectionStore } from '../../store/connectionStore';
import { useMuteStore } from '../../store/muteStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useCallStore } from '../../store/callStore';
import { useDebounce } from '../../hooks/useDebounce';
import { useTranslation, TranslationKey } from '../../i18n';

interface ChatHeaderProps {
  chat: Chat | null;
  accountId?: string;
  onScrollToMessage?: (messageId: number) => void;
  onShowInfo?: () => void;
  onDeleteChat?: () => void;
  onBack?: () => void;
}

const STATUS_KEYS: Record<string, TranslationKey> = {
  connected: 'status_online',
  connecting: 'status_connecting',
  reconnecting: 'status_reconnecting',
  disconnected: 'status_offline',
};

export interface ChatHeaderHandle {
  toggleSearch: () => void;
}

export const ChatHeader = forwardRef<ChatHeaderHandle, ChatHeaderProps>(({ chat, accountId, onScrollToMessage, onShowInfo, onDeleteChat, onBack }, ref) => {
  const { t } = useTranslation();
  const connectionStatus = useConnectionStore((s) => s.status);
  // Subscribe to the data (Set identity changes on toggle), not the getter
  // function — otherwise the Mute/Unmute label never updates reactively.
  const mutedChats = useMuteStore((s) => s.mutedChats);
  const toggleMute = useMuteStore((s) => s.toggleMute);
  const experimentalCalls = useSettingsStore((s) => s.experimentalCalls);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Message[]>([]);
  const [currentResultIndex, setCurrentResultIndex] = useState(0);
  const [searching, setSearching] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const debouncedQuery = useDebounce(searchQuery, 400);

  // Search when debounced query changes
  useEffect(() => {
    if (!debouncedQuery.trim() || !chat || !accountId) {
      setSearchResults([]);
      setCurrentResultIndex(0);
      return;
    }

    let cancelled = false;
    const doSearch = async () => {
      setSearching(true);
      try {
        const results = await invoke<Message[]>('search_messages', {
          accountId,
          chatId: chat.id,
          query: debouncedQuery,
          limit: 100,
        });
        if (!cancelled) {
          setSearchResults(results);
          setCurrentResultIndex(0);
          if (results.length > 0 && onScrollToMessage) {
            onScrollToMessage(results[0].id);
          }
        }
      } catch {
        if (!cancelled) setSearchResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    };
    doSearch();
    return () => { cancelled = true; };
  }, [debouncedQuery, chat, accountId, onScrollToMessage]);

  // Focus search input when opened
  useEffect(() => {
    if (showSearch) {
      searchInputRef.current?.focus();
    }
  }, [showSearch]);

  // Close menu on outside click
  useEffect(() => {
    if (!showMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showMenu]);

  const toggleSearch = useCallback(() => {
    setShowSearch((prev) => {
      if (prev) {
        setSearchQuery('');
        setSearchResults([]);
      }
      return !prev;
    });
    setShowMenu(false);
  }, []);

  useImperativeHandle(ref, () => ({ toggleSearch }), [toggleSearch]);

  const navigateResult = useCallback((direction: 'prev' | 'next') => {
    if (searchResults.length === 0) return;
    setCurrentResultIndex((prev) => {
      const next = direction === 'next'
        ? (prev + 1) % searchResults.length
        : (prev - 1 + searchResults.length) % searchResults.length;
      if (onScrollToMessage) {
        onScrollToMessage(searchResults[next].id);
      }
      return next;
    });
  }, [searchResults, onScrollToMessage]);

  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      navigateResult(e.shiftKey ? 'prev' : 'next');
    } else if (e.key === 'Escape') {
      toggleSearch();
    }
  }, [navigateResult, toggleSearch]);

  if (!chat) {
    return <div style={{ height: '56px' }} />;
  }

  return (
    <>
      <header className="content-header">
        {showSearch ? (
          <div className="header-search">
            <div className="header-search-nav">
              <button className="icon-button icon-button-sm" onClick={() => navigateResult('prev')} title={t('previous')}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="18 15 12 9 6 15" /></svg>
              </button>
              <button className="icon-button icon-button-sm" onClick={() => navigateResult('next')} title={t('next')}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
              </button>
            </div>
            <input
              ref={searchInputRef}
              type="text"
              className="header-search-input"
              placeholder={t('search')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            <div className="header-search-info">
              {searching ? (
                <span className="search-status">...</span>
              ) : searchQuery.trim() && searchResults.length > 0 ? (
                <span className="search-status">{currentResultIndex + 1} / {searchResults.length}</span>
              ) : searchQuery.trim() ? (
                <span className="search-status">0</span>
              ) : null}
            </div>
            <button className="icon-button" onClick={toggleSearch} title={t('close_search_header')}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
          </div>
        ) : (
          <>
            <div className="header-left" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <button className="back-button" onClick={onBack}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="19" y1="12" x2="5" y2="12"></line>
                  <polyline points="12 19 5 12 12 5"></polyline>
                </svg>
              </button>
              <div className="content-header-info">
                <h3>{chat.title}</h3>
                <span className={`status status-${connectionStatus}`}>
                  {STATUS_KEYS[connectionStatus] ? t(STATUS_KEYS[connectionStatus]) : connectionStatus}
                </span>
              </div>
            </div>
            <div className="content-header-actions">
              {!experimentalCalls ? null : chat.chatType === 'user' ? (
                <>
                  <button
                    className="icon-button"
                    title={t('call_audio')}
                    onClick={() => {
                      if (accountId) {
                        useCallStore.getState().requestCall(accountId, chat.id, chat.title, false);
                      }
                    }}
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z" />
                    </svg>
                  </button>
                  <button
                    className="icon-button"
                    title={t('call_video')}
                    onClick={() => {
                      if (accountId) {
                        useCallStore.getState().requestCall(accountId, chat.id, chat.title, true);
                      }
                    }}
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polygon points="23 7 16 12 23 17 23 7" />
                      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                    </svg>
                  </button>
                </>
              ) : (
                <>
                  <button
                    className="icon-button"
                    title={t('call_coming_soon')}
                    disabled
                    style={{ opacity: 0.4, cursor: 'not-allowed' }}
                    onClick={() => {}}
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z" />
                    </svg>
                  </button>
                  <button
                    className="icon-button"
                    title={t('call_coming_soon')}
                    disabled
                    style={{ opacity: 0.4, cursor: 'not-allowed' }}
                    onClick={() => {}}
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polygon points="23 7 16 12 23 17 23 7" />
                      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                    </svg>
                  </button>
                </>
              )}
              <button className="icon-button" title={t('search_messages')} onClick={toggleSearch}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </button>
              <div style={{ position: 'relative' }} ref={menuRef}>
                <button className="icon-button" title={t('more_options')} onClick={() => setShowMenu((p) => !p)}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="6" r="1" fill="currentColor" stroke="none" />
                    <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
                    <circle cx="12" cy="18" r="1" fill="currentColor" stroke="none" />
                  </svg>
                </button>
                {showMenu && (
                  <div className="chat-options-menu">
                    <button className="chat-options-menu-item" onClick={() => { onShowInfo?.(); setShowMenu(false); }}>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></svg>
                      {t('info')}
                    </button>
                    <button className="chat-options-menu-item" onClick={() => { if (chat) toggleMute(chat.id); setShowMenu(false); }}>
                      {chat && mutedChats.has(chat.id) ? (
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07" /></svg>
                      ) : (
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 5L6 9H2v6h4l5 4V5z" /><line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" /></svg>
                      )}
                      {chat && mutedChats.has(chat.id) ? t('unmute') : t('mute')}
                    </button>
                    <div className="chat-options-menu-separator" />
                    <button className="chat-options-menu-item danger" onClick={() => { setShowDeleteConfirm(true); setShowMenu(false); }}>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" /></svg>
                      {t('delete_and_leave')}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </header>
      {showDeleteConfirm && chat && (
        <div className="confirm-dialog-overlay" onClick={() => setShowDeleteConfirm(false)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>{t('delete_and_leave')}</h3>
            <p>{t('delete_confirm')}</p>
            <div className="confirm-dialog-actions">
              <button className="confirm-dialog-btn cancel" onClick={() => setShowDeleteConfirm(false)}>
                {t('cancel')}
              </button>
              <button className="confirm-dialog-btn danger" onClick={async () => {
                try {
                  await invoke('delete_and_leave_chat', { accountId, chatId: chat.id });
                  onDeleteChat?.();
                } catch (err) {
                  console.error('Failed to delete chat:', err);
                }
                setShowDeleteConfirm(false);
              }}>
                {t('delete_and_leave')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
});
