import { useState } from 'react';
import { convertFileSrc } from '../../transport';
import { Chat } from '../../types/telegram';
import { useTranslation, TranslationKey } from '../../i18n';
import { AvatarViewer } from './AvatarViewer';

interface ChatInfoPanelProps {
  chat: Chat;
  accountId: string;
  onClose: () => void;
}

const TYPE_LABEL_KEYS: Record<string, TranslationKey> = {
  user: 'chat_type_user',
  group: 'chat_type_group',
  channel: 'chat_type_channel',
};

export const ChatInfoPanel = ({ chat, accountId, onClose }: ChatInfoPanelProps) => {
  const { t } = useTranslation();
  const avatarSrc = chat.avatarPath ? convertFileSrc(chat.avatarPath) : null;
  const initial = chat.title.charAt(0).toUpperCase();
  const typeLabel = TYPE_LABEL_KEYS[chat.chatType] ? t(TYPE_LABEL_KEYS[chat.chatType]) : chat.chatType;
  const [showAvatarViewer, setShowAvatarViewer] = useState(false);

  return (
    <div className="chat-info-panel">
      <div className="chat-info-panel-header">
        <h3>{t('chat_info')}</h3>
        <button className="icon-button" onClick={onClose} title={t('close')}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      <div className="chat-info-panel-body">
        <div
          className="chat-info-avatar"
          style={{ cursor: avatarSrc ? 'pointer' : 'default' }}
          onClick={() => { if (avatarSrc) setShowAvatarViewer(true); }}
          title={avatarSrc ? t('photo_viewer') : undefined}
        >
          {avatarSrc ? <img src={avatarSrc} alt={chat.title} /> : initial}
        </div>
        <div className="chat-info-details">
          <div className="chat-info-title">{chat.title}</div>
          {chat.username && <div className="chat-info-username">@{chat.username}</div>}
          <div className="chat-info-type">{typeLabel}</div>
        </div>
        <div className="chat-info-section">
          <div className="chat-info-section-title">{t('details')}</div>
          <div className="chat-info-row">
            <span className="chat-info-row-label">{t('type')}</span>
            <span className="chat-info-row-value">{typeLabel}</span>
          </div>
          {chat.username && (
            <div className="chat-info-row">
              <span className="chat-info-row-label">{t('username')}</span>
              <span className="chat-info-row-value">@{chat.username}</span>
            </div>
          )}
          <div className="chat-info-row">
            <span className="chat-info-row-label">{t('id')}</span>
            <span className="chat-info-row-value">{chat.id}</span>
          </div>
        </div>
      </div>

      {showAvatarViewer && (
        <AvatarViewer
          chatId={chat.id}
          chatTitle={chat.title}
          accountId={accountId}
          initialPhotoSrc={avatarSrc || undefined}
          onClose={() => setShowAvatarViewer(false)}
        />
      )}
    </div>
  );
};
