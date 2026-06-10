import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { invoke, convertFileSrc } from '../../transport';
import { useTranslation } from '../../i18n';
import { Chat } from '../../types/telegram';
import './NewChatDialog.css';

interface NewChatButtonProps {
  accountId?: string | null;
  onChatCreated?: (chatId: number) => void;
}

type DialogType = 'group' | 'secret' | 'channel' | null;

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

// --- Close button SVG (shared) ---
const CloseIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

// --- Check icon for checkbox ---
const CheckIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

// --- Contact item component ---
interface ContactItemProps {
  contact: Chat;
  selected?: boolean;
  showCheckbox?: boolean;
  onClick: () => void;
}

const ContactItem = ({ contact, selected, showCheckbox, onClick }: ContactItemProps) => (
  <button
    className={`new-chat-dialog-contact${selected ? ' selected' : ''}`}
    onClick={onClick}
  >
    <div className="new-chat-dialog-avatar-wrapper">
      {contact.avatarPath ? (
        <img
          className="new-chat-dialog-avatar"
          src={convertFileSrc(contact.avatarPath)}
          alt=""
        />
      ) : (
        <div
          className="new-chat-dialog-avatar new-chat-dialog-avatar-initial"
          style={{ backgroundColor: getAvatarColor(contact.id) }}
        >
          {getInitial(contact.title)}
        </div>
      )}
    </div>
    <div className="new-chat-dialog-info">
      <span className="new-chat-dialog-name">{contact.title}</span>
      {contact.username && (
        <span className="new-chat-dialog-username">@{contact.username}</span>
      )}
    </div>
    {showCheckbox && (
      <div className={`new-chat-dialog-checkbox${selected ? ' checked' : ''}`}>
        <CheckIcon />
      </div>
    )}
  </button>
);

// =============================================================================
// Create Group Dialog
// =============================================================================
interface CreateGroupDialogProps {
  accountId: string;
  onClose: () => void;
  onCreated: (chatId: number) => void;
}

const CreateGroupDialog = ({ accountId, onClose, onCreated }: CreateGroupDialogProps) => {
  const { t } = useTranslation();
  const [groupName, setGroupName] = useState('');
  const [contacts, setContacts] = useState<Chat[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingContacts, setLoadingContacts] = useState(true);

  // Load contacts
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await invoke<Chat[]>('get_contacts', { accountId });
        if (!cancelled) {
          setContacts(result);
          setLoadingContacts(false);
        }
      } catch (err) {
        console.error('Failed to load contacts:', err);
        if (!cancelled) setLoadingContacts(false);
      }
    })();
    return () => { cancelled = true; };
  }, [accountId]);

  // Escape to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Prevent body scroll
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  const filteredContacts = useMemo(() => {
    if (!search.trim()) return contacts;
    const q = search.toLowerCase();
    return contacts.filter(
      (c) => c.title.toLowerCase().includes(q) ||
        (c.username && c.username.toLowerCase().includes(q))
    );
  }, [contacts, search]);

  const toggleContact = useCallback((id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleCreate = useCallback(async () => {
    if (!groupName.trim() || creating) return;
    setCreating(true);
    setError(null);
    try {
      const chatId = await invoke<number>('create_group', {
        accountId,
        title: groupName.trim(),
        userIds: Array.from(selectedIds),
      });
      onCreated(chatId);
      onClose();
    } catch (err) {
      console.error('Failed to create group:', err);
      setError(String(err));
      setCreating(false);
    }
  }, [accountId, groupName, selectedIds, creating, onCreated, onClose]);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => { if (e.target === e.currentTarget) onClose(); },
    [onClose]
  );

  const selectedContacts = useMemo(
    () => contacts.filter((c) => selectedIds.has(c.id)),
    [contacts, selectedIds]
  );

  return createPortal(
    <div className="new-chat-dialog-overlay" onClick={handleOverlayClick}>
      <div className="new-chat-dialog">
        {/* Header */}
        <div className="new-chat-dialog-header">
          <span className="new-chat-dialog-title">{t('create_group_title')}</span>
          <button className="new-chat-dialog-close" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>

        {/* Group name input */}
        <div className="new-chat-dialog-body">
          <div className="new-chat-dialog-field">
            <label className="new-chat-dialog-label">{t('group_name')}</label>
            <input
              className="new-chat-dialog-input"
              type="text"
              placeholder={t('group_name_placeholder')}
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              autoFocus
            />
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="new-chat-dialog-status new-chat-dialog-status-error">{error}</div>
        )}

        {/* Selected contacts chips */}
        {selectedContacts.length > 0 && (
          <div className="new-chat-dialog-chips">
            {selectedContacts.map((c) => (
              <button
                key={c.id}
                className="new-chat-dialog-chip"
                onClick={() => toggleContact(c.id)}
              >
                {c.title}
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            ))}
          </div>
        )}

        {/* Section label */}
        <div className="new-chat-dialog-section-label">{t('select_contacts')}</div>

        {/* Search contacts */}
        <div className="new-chat-dialog-search-wrapper">
          <input
            className="new-chat-dialog-search"
            type="text"
            placeholder={t('search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {/* Contact list */}
        <div className="new-chat-dialog-list">
          {loadingContacts ? (
            <div className="new-chat-dialog-empty">{t('loading')}</div>
          ) : filteredContacts.length === 0 ? (
            <div className="new-chat-dialog-empty">{t('no_contacts_found')}</div>
          ) : (
            filteredContacts.map((contact) => (
              <ContactItem
                key={contact.id}
                contact={contact}
                selected={selectedIds.has(contact.id)}
                showCheckbox
                onClick={() => toggleContact(contact.id)}
              />
            ))
          )}
        </div>

        {/* Footer */}
        <div className="new-chat-dialog-footer">
          <button
            className="new-chat-dialog-btn new-chat-dialog-btn-secondary"
            onClick={onClose}
          >
            {t('cancel')}
          </button>
          <button
            className="new-chat-dialog-btn new-chat-dialog-btn-primary"
            disabled={!groupName.trim() || creating}
            onClick={handleCreate}
          >
            {creating ? t('creating') : t('create')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

// =============================================================================
// Create Channel Dialog
// =============================================================================
interface CreateChannelDialogProps {
  accountId: string;
  onClose: () => void;
  onCreated: (chatId: number) => void;
}

const CreateChannelDialog = ({ accountId, onClose, onCreated }: CreateChannelDialogProps) => {
  const { t } = useTranslation();
  const [channelName, setChannelName] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Escape to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Prevent body scroll
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  const handleCreate = useCallback(async () => {
    if (!channelName.trim() || creating) return;
    setCreating(true);
    setError(null);
    try {
      const chatId = await invoke<number>('create_channel', {
        accountId,
        title: channelName.trim(),
        about: description.trim(),
        isMegagroup: false,
      });
      onCreated(chatId);
      onClose();
    } catch (err) {
      console.error('Failed to create channel:', err);
      setError(String(err));
      setCreating(false);
    }
  }, [accountId, channelName, description, creating, onCreated, onClose]);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => { if (e.target === e.currentTarget) onClose(); },
    [onClose]
  );

  return createPortal(
    <div className="new-chat-dialog-overlay" onClick={handleOverlayClick}>
      <div className="new-chat-dialog">
        {/* Header */}
        <div className="new-chat-dialog-header">
          <span className="new-chat-dialog-title">{t('create_channel_title')}</span>
          <button className="new-chat-dialog-close" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>

        {/* Form */}
        <div className="new-chat-dialog-body">
          <div className="new-chat-dialog-field">
            <label className="new-chat-dialog-label">{t('channel_name')}</label>
            <input
              className="new-chat-dialog-input"
              type="text"
              placeholder={t('channel_name_placeholder')}
              value={channelName}
              onChange={(e) => setChannelName(e.target.value)}
              autoFocus
            />
          </div>
          <div className="new-chat-dialog-field">
            <label className="new-chat-dialog-label">{t('channel_description')}</label>
            <textarea
              className="new-chat-dialog-textarea"
              placeholder={t('channel_description_placeholder')}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="new-chat-dialog-status new-chat-dialog-status-error">{error}</div>
        )}

        {/* Footer */}
        <div className="new-chat-dialog-footer">
          <button
            className="new-chat-dialog-btn new-chat-dialog-btn-secondary"
            onClick={onClose}
          >
            {t('cancel')}
          </button>
          <button
            className="new-chat-dialog-btn new-chat-dialog-btn-primary"
            disabled={!channelName.trim() || creating}
            onClick={handleCreate}
          >
            {creating ? t('creating') : t('create')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

// =============================================================================
// Secret Chat Dialog (shows not-supported notice + contact picker)
// =============================================================================
interface SecretChatDialogProps {
  accountId: string;
  onClose: () => void;
  onCreated: (chatId: number) => void;
}

const SecretChatDialog = ({ accountId, onClose, onCreated: _onCreated }: SecretChatDialogProps) => {
  const { t } = useTranslation();
  const [contacts, setContacts] = useState<Chat[]>([]);
  const [search, setSearch] = useState('');
  const [loadingContacts, setLoadingContacts] = useState(true);

  // Load contacts
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await invoke<Chat[]>('get_contacts', { accountId });
        if (!cancelled) {
          setContacts(result);
          setLoadingContacts(false);
        }
      } catch (err) {
        console.error('Failed to load contacts:', err);
        if (!cancelled) setLoadingContacts(false);
      }
    })();
    return () => { cancelled = true; };
  }, [accountId]);

  // Escape to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Prevent body scroll
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  const filteredContacts = useMemo(() => {
    if (!search.trim()) return contacts;
    const q = search.toLowerCase();
    return contacts.filter(
      (c) => c.title.toLowerCase().includes(q) ||
        (c.username && c.username.toLowerCase().includes(q))
    );
  }, [contacts, search]);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => { if (e.target === e.currentTarget) onClose(); },
    [onClose]
  );

  return createPortal(
    <div className="new-chat-dialog-overlay" onClick={handleOverlayClick}>
      <div className="new-chat-dialog">
        {/* Header */}
        <div className="new-chat-dialog-header">
          <span className="new-chat-dialog-title">{t('create_secret_chat_title')}</span>
          <button className="new-chat-dialog-close" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>

        {/* Notice about secret chats not being supported */}
        <div className="new-chat-dialog-notice">
          {t('secret_chat_not_supported')}
        </div>

        {/* Section label */}
        <div className="new-chat-dialog-section-label">{t('select_contact')}</div>

        {/* Search contacts */}
        <div className="new-chat-dialog-search-wrapper">
          <input
            className="new-chat-dialog-search"
            type="text"
            placeholder={t('search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {/* Contact list - disabled since secret chats not supported */}
        <div className="new-chat-dialog-list">
          {loadingContacts ? (
            <div className="new-chat-dialog-empty">{t('loading')}</div>
          ) : filteredContacts.length === 0 ? (
            <div className="new-chat-dialog-empty">{t('no_contacts_found')}</div>
          ) : (
            filteredContacts.map((contact) => (
              <ContactItem
                key={contact.id}
                contact={contact}
                onClick={() => {
                  // Secret chats not yet implemented
                  // When implemented: invoke('create_secret_chat', { accountId, userId: contact.id })
                }}
              />
            ))
          )}
        </div>

        {/* Footer */}
        <div className="new-chat-dialog-footer">
          <button
            className="new-chat-dialog-btn new-chat-dialog-btn-secondary"
            onClick={onClose}
          >
            {t('close')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

// =============================================================================
// Main NewChatButton
// =============================================================================
export const NewChatButton = ({ accountId, onChatCreated }: NewChatButtonProps) => {
  const { t } = useTranslation();
  const [showMenu, setShowMenu] = useState(false);
  const [activeDialog, setActiveDialog] = useState<DialogType>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click
  useEffect(() => {
    if (!showMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowMenu(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [showMenu]);

  const handleNewGroup = useCallback(() => {
    setShowMenu(false);
    setActiveDialog('group');
  }, []);

  const handleNewSecretChat = useCallback(() => {
    setShowMenu(false);
    setActiveDialog('secret');
  }, []);

  const handleNewChannel = useCallback(() => {
    setShowMenu(false);
    setActiveDialog('channel');
  }, []);

  const handleDialogClose = useCallback(() => {
    setActiveDialog(null);
  }, []);

  const handleChatCreated = useCallback((chatId: number) => {
    onChatCreated?.(chatId);
  }, [onChatCreated]);

  return (
    <>
      <div style={{ position: 'relative' }} ref={menuRef}>
        <button
          className="icon-button"
          title={t('new_chat')}
          onClick={() => setShowMenu((p) => !p)}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
          </svg>
        </button>
        {showMenu && (
          <div className="new-chat-menu">
            <button className="new-chat-menu-item" onClick={handleNewGroup}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 00-3-3.87" />
                <path d="M16 3.13a4 4 0 010 7.75" />
              </svg>
              {t('new_group')}
            </button>
            <button className="new-chat-menu-item" onClick={handleNewSecretChat}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0110 0v4" />
              </svg>
              {t('new_secret_chat')}
            </button>
            <button className="new-chat-menu-item" onClick={handleNewChannel}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 2L11 13" />
                <path d="M22 2l-7 20-4-9-9-4 20-7z" />
              </svg>
              {t('new_channel')}
            </button>
          </div>
        )}
      </div>

      {/* Dialogs */}
      {activeDialog === 'group' && accountId && (
        <CreateGroupDialog
          accountId={accountId}
          onClose={handleDialogClose}
          onCreated={handleChatCreated}
        />
      )}
      {activeDialog === 'channel' && accountId && (
        <CreateChannelDialog
          accountId={accountId}
          onClose={handleDialogClose}
          onCreated={handleChatCreated}
        />
      )}
      {activeDialog === 'secret' && accountId && (
        <SecretChatDialog
          accountId={accountId}
          onClose={handleDialogClose}
          onCreated={handleChatCreated}
        />
      )}
    </>
  );
};
