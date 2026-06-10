import { memo, useCallback } from 'react';
import { convertFileSrc } from '../../transport';
import { Chat } from '../../types/telegram';
import { useTranslation } from '../../i18n';

interface ChatListItemProps {
  chat: Chat;
  isSelected: boolean;
  isFavorite: boolean;
  isHighlighted?: boolean;
  onChatClick: (chatId: number) => void;
  onContextMenu: (e: React.MouseEvent, chatId: number) => void;
}

export const ChatListItem = memo(({
  chat,
  isSelected,
  isFavorite,
  isHighlighted,
  onChatClick,
  onContextMenu,
}: ChatListItemProps) => {
  const { t } = useTranslation();
  const handleClick = useCallback(() => {
    onChatClick(chat.id);
  }, [onChatClick, chat.id]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    onContextMenu(e, chat.id);
  }, [onContextMenu, chat.id]);

  const classNames = [
    'chat-item',
    isSelected ? 'selected' : '',
    isFavorite ? 'favorite' : '',
    isHighlighted ? 'keyboard-highlighted' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={classNames}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
    >
      <div className="chat-avatar">
        {chat.avatarPath ? (
          <img
            src={convertFileSrc(chat.avatarPath)}
            alt={chat.title}
            className="avatar-image"
          />
        ) : (
          <span className="avatar-placeholder">
            {chat.title.substring(0, 1).toUpperCase()}
          </span>
        )}
      </div>
      <div className="chat-info">
        <div className="chat-info-top">
          <div className="chat-title-row">
            {chat.isForum && (
              <span className="chat-forum-badge" title={t('forum_group')}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
                  <line x1="9" y1="10" x2="15" y2="10" />
                  <line x1="9" y1="14" x2="13" y2="14" />
                </svg>
              </span>
            )}
            <div className="chat-title">{chat.title}</div>
          </div>
          <div className="chat-meta-right">
            <div className="chat-time"></div>
          </div>
        </div>
        <div className="chat-info-bottom">
          <div className="chat-preview">
            {chat.lastMessage || t('no_messages')}
          </div>
          {chat.unreadCount > 0 && (
            <div className={`unread-count${chat.isMuted ? ' muted' : ''}`}>
              {chat.unreadCount > 999 ? '999+' : chat.unreadCount}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
