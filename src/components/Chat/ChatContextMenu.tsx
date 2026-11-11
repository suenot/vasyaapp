import { useEffect, useState, useRef, useMemo } from 'react';
import { useTranslation } from '../../i18n';
import { useFolderStore } from '../../store/folderStore';
import { useMuteStore } from '../../store/muteStore';

interface ChatContextMenuProps {
  x: number;
  y: number;
  chatId: number;
  chatType?: 'user' | 'group' | 'channel';
  chatTitle?: string;
  unreadCount?: number;
  isFavorite: boolean;
  isPinned?: boolean;
  onToggleFavorite: (chatId: number) => void;
  onMarkAsRead?: (chatId: number) => void;
  onDelete?: (chatId: number) => void;
  /** Enter bulk-select mode with this chat checked (channels and groups only). */
  onSelect?: (chatId: number) => void;
  onClose: () => void;
}

const MENU_WIDTH = 220;
const VIEWPORT_PADDING = 8;

export const ChatContextMenu = ({
  x, y, chatId, chatType, chatTitle: _chatTitle, unreadCount,
  isFavorite, isPinned,
  onToggleFavorite, onMarkAsRead, onDelete, onSelect, onClose,
}: ChatContextMenuProps) => {
  const { t } = useTranslation();
  const [showFolders, setShowFolders] = useState(false);
  const folders = useFolderStore((s) => s.folders);
  const addChatToFolder = useFolderStore((s) => s.addChatToFolder);
  const removeChatFromFolder = useFolderStore((s) => s.removeChatFromFolder);
  const isMuted = useMuteStore((s) => s.isMuted(chatId));
  const toggleMute = useMuteStore((s) => s.toggleMute);
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);

  // Calculate position to stay within viewport
  const position = useMemo(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let posX = x;
    let posY = y;

    if (posX + MENU_WIDTH > vw - VIEWPORT_PADDING) {
      posX = vw - MENU_WIDTH - VIEWPORT_PADDING;
    }
    if (posX < VIEWPORT_PADDING) posX = VIEWPORT_PADDING;

    // Estimate menu height (~400px max)
    const estimatedHeight = 400;
    if (posY + estimatedHeight > vh - VIEWPORT_PADDING) {
      posY = vh - estimatedHeight - VIEWPORT_PADDING;
    }
    if (posY < VIEWPORT_PADDING) posY = VIEWPORT_PADDING;

    return { left: posX, top: posY };
  }, [x, y]);

  // Close on click outside
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      if (submenuRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  // Adjust position after render
  useEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const vh = window.innerHeight;
    if (rect.bottom > vh - VIEWPORT_PADDING) {
      menuRef.current.style.top = `${vh - rect.height - VIEWPORT_PADDING}px`;
    }
  }, []);

  const isChatInFolder = (folderId: string) =>
    folders.find(f => f.id === folderId)?.includedChatIds.includes(chatId) ?? false;

  const handleFolderToggle = (folderId: string) => {
    if (isChatInFolder(folderId)) {
      removeChatFromFolder(folderId, chatId);
    } else {
      addChatToFolder(folderId, chatId);
    }
  };

  const isChannel = chatType === 'channel';
  const isGroup = chatType === 'group';

  // Determine destructive action label
  const getLeaveLabel = () => {
    if (isChannel) return 'Leave Channel';
    if (isGroup) return 'Leave Group';
    return 'Delete Chat';
  };

  return (
    <div ref={menuRef} className="context-menu" style={{ left: position.left, top: position.top }}>
      {/* Pin / Unpin */}
      <button className="context-menu-item" onClick={() => { /* TODO: implement pin */ onClose(); }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="17" x2="12" y2="22" />
          <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24z" />
        </svg>
        {isPinned ? 'Unpin' : 'Pin'}
      </button>

      {/* Add to Favorites / Remove from Favorites */}
      <button className="context-menu-item" onClick={() => { onToggleFavorite(chatId); onClose(); }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill={isFavorite ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
        {isFavorite ? t('remove_from_favorites') : t('add_to_favorites')}
      </button>

      {/* Mute / Unmute */}
      <button className="context-menu-item" onClick={() => { toggleMute(chatId); onClose(); }}>
        {isMuted ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
          </svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
            <line x1="23" y1="9" x2="17" y2="15" />
            <line x1="17" y1="9" x2="23" y2="15" />
          </svg>
        )}
        {isMuted ? 'Unmute' : 'Mute'}
      </button>

      {/* Mark As Read */}
      {(unreadCount ?? 0) > 0 && (
        <button className="context-menu-item" onClick={() => { onMarkAsRead?.(chatId); onClose(); }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 11 12 14 22 4" />
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
          </svg>
          Mark As Read
        </button>
      )}

      {/* Archive */}
      <button className="context-menu-item" onClick={() => { /* TODO: implement archive */ onClose(); }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="21 8 21 21 3 21 3 8" />
          <rect x="1" y="3" width="22" height="5" />
          <line x1="10" y1="12" x2="14" y2="12" />
        </svg>
        Archive
      </button>

      {/* Add to folder */}
      {folders.length > 0 && (
        <div
          className="context-menu-item context-menu-submenu-trigger"
          onMouseEnter={() => setShowFolders(true)}
          onMouseLeave={() => setShowFolders(false)}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          <span style={{ flex: 1 }}>{t('add_to_folder' as any) || 'Add to folder...'}</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>

          {showFolders && (
            <div ref={submenuRef} className="context-menu context-submenu">
              {folders.map(folder => {
                const isIn = isChatInFolder(folder.id);
                return (
                  <button
                    key={folder.id}
                    className="context-menu-item"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleFolderToggle(folder.id);
                    }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      {isIn
                        ? <><rect x="3" y="3" width="18" height="18" rx="2" /><polyline points="9 11 12 14 22 4" /></>
                        : <rect x="3" y="3" width="18" height="18" rx="2" />
                      }
                    </svg>
                    {folder.name}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Divider before destructive action */}
      <div className="context-menu-divider" />

      {onSelect && (isChannel || isGroup) && (
        <button
          className="context-menu-item"
          onClick={() => { onSelect(chatId); onClose(); }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 11 12 14 22 4" />
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
          </svg>
          {t('bulk_context_select')}
        </button>
      )}

      {/* Leave / Delete */}
      <button
        className="context-menu-item context-menu-item--danger"
        onClick={() => { onDelete?.(chatId); onClose(); }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {(isChannel || isGroup) ? (
            <>
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </>
          ) : (
            <>
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </>
          )}
        </svg>
        {getLeaveLabel()}
      </button>
    </div>
  );
};
