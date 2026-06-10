import { useState, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { invoke, convertFileSrc } from '../../transport';
import { useChatsStore } from '../../store/chatsStore';
import { useTranslation } from '../../i18n';
import './ForwardDialog.css';

interface ForwardDialogProps {
  accountId: string;
  fromChatId: number;
  messageIds: number[];
  onClose: () => void;
  onForwarded?: () => void;
}

const AVATAR_COLORS = [
  '#E17076', '#7BC862', '#E5CA77', '#65AADD',
  '#A695E7', '#EE7AE6', '#6EC9CB', '#FAA774',
];

function getAvatarColor(id: number): string {
  return AVATAR_COLORS[Math.abs(id) % AVATAR_COLORS.length];
}

function getInitial(title: string): string {
  return title.trim()[0]?.toUpperCase() || '?';
}

export const ForwardDialog = ({
  accountId,
  fromChatId,
  messageIds,
  onClose,
  onForwarded,
}: ForwardDialogProps) => {
  const { t } = useTranslation();
  const chats = useChatsStore((s) => s.getChats(accountId)) || [];
  const [search, setSearch] = useState('');
  const [forwarding, setForwarding] = useState(false);
  const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle');

  // Escape to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Prevent body scroll while open
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, []);

  const filteredChats = useMemo(() => {
    if (!search.trim()) return chats;
    const q = search.toLowerCase();
    return chats.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        (c.username && c.username.toLowerCase().includes(q))
    );
  }, [chats, search]);

  const handleForward = useCallback(
    async (toChatId: number) => {
      if (forwarding) return;
      setForwarding(true);
      try {
        await invoke('forward_messages', {
          accountId,
          fromChatId,
          toChatId,
          messageIds,
        });
        setStatus('success');
        setTimeout(() => {
          onForwarded?.();
          onClose();
        }, 600);
      } catch (err) {
        console.error('Forward failed:', err);
        setStatus('error');
        setTimeout(() => setStatus('idle'), 1500);
        setForwarding(false);
      }
    },
    [accountId, fromChatId, messageIds, forwarding, onClose, onForwarded]
  );

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose]
  );

  return createPortal(
    <div className="forward-dialog-overlay" onClick={handleOverlayClick}>
      <div className="forward-dialog">
        {/* Header */}
        <div className="forward-dialog-header">
          <span className="forward-dialog-title">{t('forward_to')}</span>
          <button className="forward-dialog-close" onClick={onClose} aria-label="Close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Search */}
        <div className="forward-dialog-search-wrapper">
          <input
            className="forward-dialog-search"
            type="text"
            placeholder={t('search_chats')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
        </div>

        {/* Status banner */}
        {status === 'success' && (
          <div className="forward-dialog-status forward-dialog-status-success">{t('forwarded')}</div>
        )}
        {status === 'error' && (
          <div className="forward-dialog-status forward-dialog-status-error">Forward failed</div>
        )}

        {/* Chat list */}
        <div className="forward-dialog-list">
          {filteredChats.map((chat) => (
            <button
              key={chat.id}
              className="forward-dialog-item"
              onClick={() => handleForward(chat.id)}
              disabled={forwarding}
            >
              <div className="forward-dialog-avatar-wrapper">
                {chat.avatarPath ? (
                  <img
                    className="forward-dialog-avatar"
                    src={convertFileSrc(chat.avatarPath)}
                    alt=""
                  />
                ) : (
                  <div
                    className="forward-dialog-avatar forward-dialog-avatar-initial"
                    style={{ backgroundColor: getAvatarColor(chat.id) }}
                  >
                    {getInitial(chat.title)}
                  </div>
                )}
              </div>
              <div className="forward-dialog-info">
                <span className="forward-dialog-name">{chat.title}</span>
                {chat.username && (
                  <span className="forward-dialog-username">@{chat.username}</span>
                )}
              </div>
            </button>
          ))}
          {filteredChats.length === 0 && (
            <div className="forward-dialog-empty">{t('no_chats_found')}</div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};
