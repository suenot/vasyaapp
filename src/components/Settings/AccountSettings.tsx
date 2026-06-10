import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ProfileSettings } from './ProfileSettings';
import { useAccountsStore } from '../../store/accountsStore';
import { useAuthStore } from '../../store/authStore';
import { useThemeStore, ThemeSetting } from '../../store/themeStore';
import { useDownloadStore } from '../../store/downloadStore';
import { useSttStore, SttProvider } from '../../store/sttStore';
import { useHotkeysStore } from '../../store/hotkeysStore';
import { useFolderStore, ChatTypeFilter, BUILTIN_TAB_IDS, TabEntry } from '../../store/folderStore';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, DragEndEvent } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useTranslation, useLanguageStore, LANGUAGE_LABELS, Language } from '../../i18n';
import { useSettingsStore, StorageMode } from '../../store/settingsStore';
import { Icon, IconName } from '../UI/Icon';
import './AccountSettings.css';

interface AccountSettingsProps {
  onClose: () => void;
}

type SettingsSection = 'general' | 'privacy' | 'data' | 'downloads' | 'stt' | 'hotkeys' | 'folders' | 'devices' | 'language' | 'storage';

/** Sortable drag-handle tab row */
const SortableTabItem = ({ tab, label, icon, isBuiltin, onToggle, onDelete }: {
  tab: TabEntry;
  label: string;
  icon?: string;
  isBuiltin: boolean;
  onToggle: (visible: boolean) => void;
  onDelete?: () => void;
}) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className="settings-item sortable-tab-item">
      <div className="drag-handle" {...attributes} {...listeners}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="8" y1="6" x2="16" y2="6" /><line x1="8" y1="12" x2="16" y2="12" /><line x1="8" y1="18" x2="16" y2="18" />
        </svg>
      </div>
      <label className="tab-toggle-label">
        <input
          type="checkbox"
          checked={tab.visible}
          onChange={(e) => onToggle(e.target.checked)}
        />
        {icon && <Icon name={icon} size={18} className="filter-icon" style={{ opacity: 0.6 }} />}
        <span className="settings-item-title">{label}</span>
        {isBuiltin && <span className="tab-badge builtin">built-in</span>}
      </label>
      {onDelete && (
        <button className="icon-button delete-folder" style={{ color: '#e74c3c', marginLeft: 'auto' }} onClick={onDelete}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h18m-2 0v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6m3 0V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
          </svg>
        </button>
      )}
    </div>
  );
};

export const AccountSettings = ({ onClose }: AccountSettingsProps) => {
  const { t } = useTranslation();
  const { language, setLanguage } = useLanguageStore();
  const { getActiveAccount, accounts, removeAccount, setActiveAccount, clearActiveAccount } = useAccountsStore();
  const [loggingOut, setLoggingOut] = useState(false);
  const { themeSetting, setThemeSetting } = useThemeStore();
  const [activeSection, setActiveSection] = useState<SettingsSection>('general');
  const [mobileContentOpen, setMobileContentOpen] = useState(false);
  const [showProfileEdit, setShowProfileEdit] = useState(false);

  const { queued, active, completed, failed, activeItems, queuedItems } = useDownloadStore();
  const sttSettings = useSttStore((s) => s.settings);
  const sttLoading = useSttStore((s) => s.loading);
  const whisperModels = useSttStore((s) => s.whisperModels);
  const loadSttSettings = useSttStore((s) => s.loadSettings);
  const saveSttSettings = useSttStore((s) => s.saveSettings);
  const loadWhisperModels = useSttStore((s) => s.loadWhisperModels);
  const downloadModel = useSttStore((s) => s.downloadModel);
  const [downloadingModel, setDownloadingModel] = useState<string | null>(null);

  const { hotkeys, updateHotkey, resetDefaults } = useHotkeysStore();
  const [listeningForKey, setListeningForKey] = useState<string | null>(null);

  const folders = useFolderStore((s) => s.folders);
  const addFolder = useFolderStore((s) => s.addFolder);
  const deleteFolder = useFolderStore((s) => s.deleteFolder);
  const tabs = useFolderStore((s) => s.tabs);
  const setTabVisible = useFolderStore((s) => s.setTabVisible);
  const reorderTabs = useFolderStore((s) => s.reorderTabs);
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [selectedChatTypes, setSelectedChatTypes] = useState<ChatTypeFilter[]>([]);
  const [selectedIcon, setSelectedIcon] = useState<string>('folder');

  const { folderLayout, setFolderLayout, chatDensity, setChatDensity, mergeMessages, setMergeMessages, interfaceScale, setInterfaceScale, notificationsEnabled, setNotificationsEnabled, notificationSound, setNotificationSound, messagePreview, setMessagePreview, messageTextSize, setMessageTextSize, experimentalCalls, setExperimentalCalls } = useSettingsStore();

  const folderIcons: IconName[] = [
    'folder', 'all', 'contacts', 'chats', 'favorites', 
    'bitcoin', 'ethereum', 'trending-up', 'hash', 'book', 
    'trophy', 'layers', 'archive'
  ];

  // Storage mode
  const { storageMode, backendUrl, backendApiKey, storageSwitching, storageError, setStorageMode } = useSettingsStore();
  const [tempBackendUrl, setTempBackendUrl] = useState(backendUrl);
  const [tempApiKey, setTempApiKey] = useState(backendApiKey);
  const [tempStorageMode, setTempStorageMode] = useState<StorageMode>(storageMode);
  const [urlValidationError, setUrlValidationError] = useState<string | null>(null);
  // Backend user account (per-user sync isolation): login/register issues a JWT
  // that is used as the Bearer token instead of the legacy shared API key.
  const [backendEmail, setBackendEmail] = useState('');
  const [backendPassword, setBackendPassword] = useState('');
  const [backendAuthBusy, setBackendAuthBusy] = useState(false);
  const [backendAuthMessage, setBackendAuthMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const backendAuth = async (mode: 'login' | 'register') => {
    const base = tempBackendUrl.trim().replace(/\/+$/, '');
    if (!base) {
      setBackendAuthMessage({ ok: false, text: t('storage_backend_url_placeholder' as any) });
      return;
    }
    setBackendAuthBusy(true);
    setBackendAuthMessage(null);
    try {
      const res = await fetch(`${base}/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: backendEmail.trim(), password: backendPassword }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setBackendAuthMessage({ ok: false, text: body?.error || `HTTP ${res.status}` });
        return;
      }
      if (body?.token) {
        setTempApiKey(body.token);
        setBackendPassword('');
        setBackendAuthMessage({ ok: true, text: t('backend_auth_token_filled' as any) });
      } else {
        setBackendAuthMessage({ ok: false, text: 'No token in response' });
      }
    } catch (err) {
      setBackendAuthMessage({ ok: false, text: String(err) });
    } finally {
      setBackendAuthBusy(false);
    }
  };

  useEffect(() => {
    if (activeSection === 'stt') {
      loadSttSettings();
      loadWhisperModels();
    }
  }, [activeSection, loadSttSettings, loadWhisperModels]);
  const activeAccount = getActiveAccount();

  useEffect(() => {
    if (!listeningForKey) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const keys: string[] = [];
      if (e.metaKey) keys.push('Meta');
      if (e.ctrlKey) keys.push('Ctrl');
      if (e.altKey) keys.push('Alt');
      if (e.shiftKey) keys.push('Shift');

      if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return;

      keys.push(e.key);
      updateHotkey(listeningForKey, keys);
      setListeningForKey(null);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [listeningForKey, updateHotkey]);

  const handleThemeChange = (newTheme: ThemeSetting) => {
    setThemeSetting(newTheme);
  };

  const handleLogout = async () => {
    const account = getActiveAccount();
    if (!account || loggingOut) return;

    setLoggingOut(true);
    try {
      await invoke('logout', { accountId: account.id });
      removeAccount(account.id);
      const remaining = accounts.filter(a => a.id !== account.id);
      if (remaining.length > 0) {
        setActiveAccount(remaining[0].id);
      } else {
        useAuthStore.getState().logout();
        clearActiveAccount();
      }
      onClose();
    } catch (err) {
      console.error('Logout failed:', err);
    } finally {
      setLoggingOut(false);
    }
  };

  const renderGeneralSettings = () => (
    <div className="settings-content">
      <h2>{t('general_settings')}</h2>

      <div className="settings-group">
        <h3>{t('appearance')}</h3>

        <div className="settings-item">
          <div className="settings-item-label">
            <div className="settings-item-title">{t('theme')}</div>
            <div className="settings-item-description">
            {themeSetting === 'system' ? t('system_default') : themeSetting === 'light' ? t('light') : themeSetting === 'dark' ? t('dark') : t('blue')}
            </div>
          </div>
        </div>

        <div className="theme-options">
          <label className={`theme-option ${themeSetting === 'system' ? 'active' : ''}`}>
            <input type="radio" name="theme" value="system" checked={themeSetting === 'system'} onChange={(e) => handleThemeChange(e.target.value as ThemeSetting)} />
            <div className="theme-preview system">
              <div className="theme-preview-half light"></div>
              <div className="theme-preview-half dark"></div>
            </div>
            <span>{t('system_default')}</span>
          </label>

          <label className={`theme-option ${themeSetting === 'light' ? 'active' : ''}`}>
            <input type="radio" name="theme" value="light" checked={themeSetting === 'light'} onChange={(e) => handleThemeChange(e.target.value as ThemeSetting)} />
            <div className="theme-preview light"></div>
            <span>{t('light')}</span>
          </label>

          <label className={`theme-option ${themeSetting === 'dark' ? 'active' : ''}`}>
            <input type="radio" name="theme" value="dark" checked={themeSetting === 'dark'} onChange={(e) => handleThemeChange(e.target.value as ThemeSetting)} />
            <div className="theme-preview dark"></div>
            <span>{t('dark')}</span>
          </label>

          <label className={`theme-option ${themeSetting === 'blue' ? 'active' : ''}`}>
            <input type="radio" name="theme" value="blue" checked={themeSetting === 'blue'} onChange={(e) => handleThemeChange(e.target.value as ThemeSetting)} />
            <div className="theme-preview blue"></div>
            <span>{t('blue')}</span>
          </label>
        </div>
      </div>

      <div className="settings-group">
        <h3>{t('interface')}</h3>
        <div className="settings-item">
          <div className="settings-item-label">
            <div className="settings-item-title">{t('chat_density' as any)}</div>
          </div>
        </div>
        <div className="stt-provider-options" style={{ marginTop: '0', padding: '0 0 12px 0' }}>
          <label className={`stt-provider-option ${chatDensity === 'normal' ? 'active' : ''}`} style={{ padding: '8px 12px' }}>
            <input type="radio" name="chat-density" value="normal" checked={chatDensity === 'normal'} onChange={() => setChatDensity('normal')} />
            <div className="stt-provider-info">
              <div className="stt-provider-name" style={{ fontSize: '14px' }}>{t('density_normal' as any)}</div>
            </div>
          </label>
          <label className={`stt-provider-option ${chatDensity === 'compact' ? 'active' : ''}`} style={{ padding: '8px 12px' }}>
            <input type="radio" name="chat-density" value="compact" checked={chatDensity === 'compact'} onChange={() => setChatDensity('compact')} />
            <div className="stt-provider-info">
              <div className="stt-provider-name" style={{ fontSize: '14px' }}>{t('density_compact' as any)}</div>
            </div>
          </label>
          <label className={`stt-provider-option ${chatDensity === 'very-compact' ? 'active' : ''}`} style={{ padding: '8px 12px' }}>
            <input type="radio" name="chat-density" value="very-compact" checked={chatDensity === 'very-compact'} onChange={() => setChatDensity('very-compact')} />
            <div className="stt-provider-info">
              <div className="stt-provider-name" style={{ fontSize: '14px' }}>{t('density_very_compact' as any)}</div>
            </div>
          </label>
        </div>

        <div className="settings-item">
          <div className="settings-item-label">
            <div className="settings-item-title">{t('interface_scale')}</div>
            <div className="settings-item-description">{interfaceScale}%</div>
          </div>
        </div>
        <div className="interface-scale-slider" style={{ padding: '0 16px 12px' }}>
          <input
            type="range"
            min={50}
            max={200}
            step={10}
            value={interfaceScale}
            onChange={(e) => setInterfaceScale(Number(e.target.value))}
            style={{ width: '100%' }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>
            <span>50%</span>
            <span
              style={{ cursor: 'pointer', textDecoration: 'underline' }}
              onClick={() => setInterfaceScale(100)}
            >100%</span>
            <span>200%</span>
          </div>
        </div>
        <div className="settings-item">
          <div className="settings-item-label">
            <div className="settings-item-title">{t('message_text_size')}</div>
          </div>
        </div>
        <div className="stt-provider-options" style={{ marginTop: '0', padding: '0 0 12px 0' }}>
          <label className={`stt-provider-option ${messageTextSize === 'small' ? 'active' : ''}`} style={{ padding: '8px 12px' }}>
            <input type="radio" name="text-size" value="small" checked={messageTextSize === 'small'} onChange={() => setMessageTextSize('small')} />
            <div className="stt-provider-info">
              <div className="stt-provider-name" style={{ fontSize: '13px' }}>{t('text_size_small' as any)}</div>
            </div>
          </label>
          <label className={`stt-provider-option ${messageTextSize === 'medium' ? 'active' : ''}`} style={{ padding: '8px 12px' }}>
            <input type="radio" name="text-size" value="medium" checked={messageTextSize === 'medium'} onChange={() => setMessageTextSize('medium')} />
            <div className="stt-provider-info">
              <div className="stt-provider-name" style={{ fontSize: '14px' }}>{t('text_size_medium' as any)}</div>
            </div>
          </label>
          <label className={`stt-provider-option ${messageTextSize === 'large' ? 'active' : ''}`} style={{ padding: '8px 12px' }}>
            <input type="radio" name="text-size" value="large" checked={messageTextSize === 'large'} onChange={() => setMessageTextSize('large')} />
            <div className="stt-provider-info">
              <div className="stt-provider-name" style={{ fontSize: '16px' }}>{t('text_size_large' as any)}</div>
            </div>
          </label>
        </div>

        <div className="settings-item toggle">
          <div className="settings-item-label">
            <div className="settings-item-title">{t('merge_split_messages' as any)}</div>
            <div className="settings-item-description">{t('merge_split_messages_desc' as any)}</div>
          </div>
          <label className="toggle-switch">
            <input type="checkbox" checked={mergeMessages} onChange={(e) => setMergeMessages(e.target.checked)} />
            <span className="toggle-slider"></span>
          </label>
        </div>
      </div>

      <div className="settings-group">
        <h3>{t('notifications')}</h3>
        <div className="settings-item toggle">
          <div className="settings-item-label">
            <div className="settings-item-title">{t('notifications_enabled')}</div>
          </div>
          <label className="toggle-switch">
            <input type="checkbox" checked={notificationsEnabled} onChange={(e) => setNotificationsEnabled(e.target.checked)} />
            <span className="toggle-slider"></span>
          </label>
        </div>
        <div className="settings-item toggle" style={{ opacity: notificationsEnabled ? 1 : 0.4 }}>
          <div className="settings-item-label">
            <div className="settings-item-title">{t('notification_sound')}</div>
          </div>
          <label className="toggle-switch">
            <input type="checkbox" checked={notificationSound} disabled={!notificationsEnabled} onChange={(e) => setNotificationSound(e.target.checked)} />
            <span className="toggle-slider"></span>
          </label>
        </div>
        <div className="settings-item toggle" style={{ opacity: notificationsEnabled ? 1 : 0.4 }}>
          <div className="settings-item-label">
            <div className="settings-item-title">{t('message_preview')}</div>
          </div>
          <label className="toggle-switch">
            <input type="checkbox" checked={messagePreview} disabled={!notificationsEnabled} onChange={(e) => setMessagePreview(e.target.checked)} />
            <span className="toggle-slider"></span>
          </label>
        </div>
      </div>

      <div className="settings-group">
        <h3>{t('experimental' as any)}</h3>
        <div className="settings-item toggle">
          <div className="settings-item-label">
            <div className="settings-item-title">{t('experimental_calls' as any)}</div>
            <div className="settings-item-description">{t('experimental_calls_desc' as any)}</div>
          </div>
          <label className="toggle-switch">
            <input type="checkbox" checked={experimentalCalls} onChange={(e) => setExperimentalCalls(e.target.checked)} />
            <span className="toggle-slider"></span>
          </label>
        </div>
      </div>
    </div>
  );

  const renderPrivacySettings = () => (
    <div className="settings-content">
      <h2>{t('privacy_security')}</h2>
      <div className="settings-group">
        <h3>{t('privacy')}</h3>
        <div className="settings-item clickable">
          <div className="settings-item-label">
            <div className="settings-item-title">{t('phone_number')}</div>
            <div className="settings-item-description">{t('my_contacts')}</div>
          </div>
          <div className="settings-item-arrow">›</div>
        </div>
        <div className="settings-item clickable">
          <div className="settings-item-label">
            <div className="settings-item-title">{t('last_seen')}</div>
            <div className="settings-item-description">{t('everybody')}</div>
          </div>
          <div className="settings-item-arrow">›</div>
        </div>
        <div className="settings-item clickable">
          <div className="settings-item-label">
            <div className="settings-item-title">{t('profile_photo')}</div>
            <div className="settings-item-description">{t('everybody')}</div>
          </div>
          <div className="settings-item-arrow">›</div>
        </div>
      </div>
      <div className="settings-group">
        <h3>{t('security')}</h3>
        <div className="settings-item clickable">
          <div className="settings-item-label">
            <div className="settings-item-title">{t('active_sessions')}</div>
          </div>
          <div className="settings-item-arrow">›</div>
        </div>
        <div className="settings-item toggle">
          <div className="settings-item-label">
            <div className="settings-item-title">{t('two_step_verification')}</div>
          </div>
          <label className="toggle-switch">
            <input type="checkbox" />
            <span className="toggle-slider"></span>
          </label>
        </div>
      </div>
    </div>
  );

  const renderDataSettings = () => (
    <div className="settings-content">
      <h2>{t('data_storage')}</h2>
      <div className="settings-group">
        <h3>{t('storage_usage')}</h3>
        <div className="settings-item clickable">
          <div className="settings-item-label">
            <div className="settings-item-title">{t('manage_storage')}</div>
            <div className="settings-item-description">{t('clear_cache')}</div>
          </div>
          <div className="settings-item-arrow">›</div>
        </div>
        <div className="settings-item clickable">
          <div className="settings-item-label">
            <div className="settings-item-title">{t('network_usage')}</div>
          </div>
          <div className="settings-item-arrow">›</div>
        </div>
      </div>
      <div className="settings-group">
        <h3>{t('auto_media_download')}</h3>
        <div className="settings-item toggle">
          <div className="settings-item-label"><div className="settings-item-title">{t('photos')}</div></div>
          <label className="toggle-switch"><input type="checkbox" defaultChecked /><span className="toggle-slider"></span></label>
        </div>
        <div className="settings-item toggle">
          <div className="settings-item-label"><div className="settings-item-title">{t('videos')}</div></div>
          <label className="toggle-switch"><input type="checkbox" /><span className="toggle-slider"></span></label>
        </div>
        <div className="settings-item toggle">
          <div className="settings-item-label"><div className="settings-item-title">{t('files')}</div></div>
          <label className="toggle-switch"><input type="checkbox" /><span className="toggle-slider"></span></label>
        </div>
      </div>
    </div>
  );

  const renderDownloadsSettings = () => {
    const total = active + queued;
    return (
      <div className="settings-content">
        <h2>{t('downloads')}</h2>
        <div className="settings-group">
          <h3>{t('status')}</h3>
          <div className="downloads-stats-grid">
            <div className="downloads-stat-card">
              <span className="downloads-stat-value stat-active">{active}</span>
              <span className="downloads-stat-label">{t('active')}</span>
            </div>
            <div className="downloads-stat-card">
              <span className="downloads-stat-value stat-queued">{queued}</span>
              <span className="downloads-stat-label">{t('queued')}</span>
            </div>
            <div className="downloads-stat-card">
              <span className="downloads-stat-value stat-done">{completed}</span>
              <span className="downloads-stat-label">{t('completed')}</span>
            </div>
            {failed > 0 && (
              <div className="downloads-stat-card">
                <span className="downloads-stat-value stat-failed">{failed}</span>
                <span className="downloads-stat-label">{t('failed')}</span>
              </div>
            )}
          </div>
        </div>

        {activeItems.length > 0 && (
          <div className="settings-group">
            <h3>{t('downloading')}</h3>
            {activeItems.map((item) => (
              <div key={`${item.chatId}_${item.messageId}`} className="settings-item">
                <div className="settings-item-label">
                  <div className="settings-item-title downloads-item-active">
                    <div className="download-item-spinner" />
                    Chat {item.chatId} / msg {item.messageId}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {queuedItems.length > 0 && (
          <div className="settings-group">
            <h3>{t('queue')} ({queued})</h3>
            {queuedItems.map((item) => (
              <div key={`${item.chatId}_${item.messageId}`} className="settings-item">
                <div className="settings-item-label">
                  <div className="settings-item-title downloads-item-queued">
                    <div className="download-item-dot" />
                    Chat {item.chatId} / msg {item.messageId}
                  </div>
                </div>
              </div>
            ))}
            {queued > 20 && (
              <div className="settings-item">
                <div className="settings-item-label">
                  <div className="settings-item-description">+{queued - 20} more in queue</div>
                </div>
              </div>
            )}
          </div>
        )}

        {total === 0 && completed === 0 && (
          <p className="settings-placeholder">{t('no_downloads')}</p>
        )}
        {total === 0 && completed > 0 && (
          <p className="settings-placeholder">{t('all_downloads_completed')}</p>
        )}
      </div>
    );
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  };

  const handleDownloadModel = async (name: string) => {
    setDownloadingModel(name);
    try {
      await downloadModel(name);
    } catch {
      // error logged in store
    } finally {
      setDownloadingModel(null);
    }
  };

  const renderSttSettings = () => (
    <div className="settings-content">
      <h2>{t('voice_stt')}</h2>
      <div className="settings-group">
        <h3>{t('provider')}</h3>
        <div className="stt-provider-options">
          <label className={`stt-provider-option ${sttSettings.provider === 'deepgram' ? 'active' : ''}`}>
            <input type="radio" name="stt-provider" value="deepgram" checked={sttSettings.provider === 'deepgram'} onChange={() => saveSttSettings({ provider: 'deepgram' as SttProvider })} />
            <div className="stt-provider-info">
              <div className="stt-provider-name">{t('deepgram_cloud')}</div>
              <div className="stt-provider-desc">{t('deepgram_desc')}</div>
            </div>
          </label>
          <label className={`stt-provider-option ${sttSettings.provider === 'local_whisper' ? 'active' : ''}`}>
            <input type="radio" name="stt-provider" value="local_whisper" checked={sttSettings.provider === 'local_whisper'} onChange={() => saveSttSettings({ provider: 'local_whisper' as SttProvider })} />
            <div className="stt-provider-info">
              <div className="stt-provider-name">{t('whisper_local')}</div>
              <div className="stt-provider-desc">{t('whisper_desc')}</div>
              <div className="stt-provider-warning">{t('whisper_warning')}</div>
            </div>
          </label>
        </div>
      </div>

      {sttSettings.provider === 'deepgram' && (
        <div className="settings-group">
          <h3>{t('deepgram_api_key')}</h3>
          <input
            type="password"
            className="stt-language-select"
            value={sttSettings.deepgram_api_key ?? ''}
            onChange={(e) => saveSttSettings({ deepgram_api_key: e.target.value || null })}
            placeholder={t('deepgram_api_key_placeholder')}
            autoComplete="off"
            spellCheck={false}
          />
          <p className="stt-provider-desc">{t('deepgram_api_key_help')}</p>
        </div>
      )}

      <div className="settings-group">
        <h3>{t('recognition_language')}</h3>
        <select className="stt-language-select" value={sttSettings.language} onChange={(e) => saveSttSettings({ language: e.target.value })} autoComplete="off">
          <option value="ru">{t('lang_russian')}</option>
          <option value="en">{t('lang_english')}</option>
          <option value="uk">{t('lang_ukrainian')}</option>
          <option value="de">{t('lang_german')}</option>
          <option value="fr">{t('lang_french')}</option>
          <option value="es">{t('lang_spanish')}</option>
          <option value="multi">{t('lang_auto')}</option>
        </select>
      </div>

      {sttSettings.provider === 'local_whisper' && (
        <div className="settings-group">
          <h3>{t('whisper_models')}</h3>
          <div className="stt-models-list">
            {whisperModels.map((model) => (
              <div key={model.name} className="stt-model-item">
                <div className="stt-model-info">
                  <div className="stt-model-name">
                    {model.name}
                    {sttSettings.whisper_model === model.name && (
                      <span className="stt-model-active"> {t('model_active')}</span>
                    )}
                  </div>
                  <div className="stt-model-size">
                    {model.downloaded && model.size ? formatSize(model.size) : (
                      model.name === 'tiny' ? '~75 MB' : model.name === 'base' ? '~142 MB' : '~466 MB'
                    )}
                  </div>
                </div>
                <div className="stt-model-actions">
                  {model.downloaded ? (
                    <>
                      <span className="stt-model-downloaded">{t('downloaded')}</span>
                      {sttSettings.whisper_model !== model.name && (
                        <button className="stt-model-select-btn" onClick={() => saveSttSettings({ whisper_model: model.name })}>{t('select')}</button>
                      )}
                    </>
                  ) : (
                    <button className="stt-model-download-btn" disabled={sttLoading || downloadingModel !== null} onClick={() => handleDownloadModel(model.name)}>
                      {downloadingModel === model.name ? t('downloading_model') : t('download')}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  const renderHotkeysSettings = () => {
    const categories = ['search', 'navigation', 'chat', 'folders', 'messages'] as const;
    const categoryKeys: Record<string, string> = {
      search: 'hotkey_category_search',
      navigation: 'hotkey_category_navigation',
      chat: 'hotkey_category_chat',
      folders: 'hotkey_category_folders',
      messages: 'hotkey_category_messages',
    };

    const formatKey = (k: string) => {
      const map: Record<string, string> = {
        Meta: navigator.platform.includes('Mac') ? '⌘' : 'Win',
        Ctrl: navigator.platform.includes('Mac') ? '⌃' : 'Ctrl',
        Alt: navigator.platform.includes('Mac') ? '⌥' : 'Alt',
        Shift: '⇧',
        ArrowUp: '↑',
        ArrowDown: '↓',
        ArrowLeft: '←',
        ArrowRight: '→',
        Escape: 'Esc',
        Tab: 'Tab',
        Enter: 'Enter',
        PageUp: 'PgUp',
        PageDown: 'PgDn',
        Home: 'Home',
        End: 'End',
      };
      return map[k] || k.toUpperCase();
    };

    return (
      <div className="settings-content">
        <div className="settings-header-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2>{t('hotkeys')}</h2>
          <button className="text-button" onClick={resetDefaults}>{t('reset_defaults')}</button>
        </div>
        {categories.map((cat) => {
          const catHotkeys = hotkeys.filter((h) => h.category === cat);
          if (catHotkeys.length === 0) return null;
          return (
            <div className="settings-group" key={cat}>
              <h3>{t(categoryKeys[cat] as any)}</h3>
              {catHotkeys.map((hotkey) => (
                <div
                  key={hotkey.id}
                  className={`settings-item ${hotkey.readonly ? '' : 'clickable'} ${listeningForKey === hotkey.id ? 'active-listening' : ''}`}
                  onClick={() => {
                    if (!hotkey.readonly) {
                      setListeningForKey(listeningForKey === hotkey.id ? null : hotkey.id);
                    }
                  }}
                >
                  <div className="settings-item-label">
                    <div className="settings-item-title">{t(hotkey.label as any)}</div>
                    <div className="settings-item-description">{t(hotkey.description as any)}</div>
                  </div>
                  <div className="settings-item-value hotkey-badge">
                    {listeningForKey === hotkey.id ? (
                      <span className="listening-text">{t('press_keys')}</span>
                    ) : (
                      <>
                        {hotkey.keys.map((k, i) => (
                          <span key={i}>
                            {i > 0 && ' + '}
                            <kbd>{formatKey(k)}</kbd>
                          </span>
                        ))}
                        {hotkey.readonly && (
                          <span className="hotkey-readonly-badge" style={{ marginLeft: 8, fontSize: 11, opacity: 0.5 }}>
                            {t('hotkey_readonly' as any)}
                          </span>
                        )}
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    );
  };

  const renderLanguageSettings = () => (
    <div className="settings-content">
      <h2>{t('language')}</h2>
      <div className="settings-group">
        {(Object.keys(LANGUAGE_LABELS) as Language[]).map((lang) => (
          <div
            key={lang}
            className={`settings-item clickable ${lang === language ? 'active-listening' : ''}`}
            onClick={() => setLanguage(lang)}
          >
            <div className="settings-item-label">
              <div className="settings-item-title">{LANGUAGE_LABELS[lang]}</div>
            </div>
            {lang === language && (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent-color)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
          </div>
        ))}
      </div>
    </div>
  );

  const renderFoldersSettings = () => {
    const chatTypeOptions: { type: ChatTypeFilter; label: string }[] = [
      { type: 'contacts', label: t('filter_contacts') },
      { type: 'groups', label: t('chat_type_group') },
      { type: 'channels', label: t('chat_type_channel') },
      { type: 'bots', label: 'Bots' },
    ];

    const toggleChatType = (type: ChatTypeFilter) => {
      setSelectedChatTypes(prev =>
        prev.includes(type) ? prev.filter(ct => ct !== type) : [...prev, type]
      );
    };

    const handleCreateFolder = () => {
      if (!newFolderName.trim()) return;
      addFolder({
        name: newFolderName,
        icon: selectedIcon,
        includedChatTypes: selectedChatTypes,
        excludedChatTypes: [],
        includedChatIds: [],
        excludedChatIds: [],
      });
      setNewFolderName('');
      setSelectedChatTypes([]);
      setSelectedIcon('folder');
      setEditingFolderId(null);
    };

    const BUILTIN_LABELS: Record<string, string> = {
      all: 'all_chats',
      contacts: 'filter_contacts',
      chats: 'filter_chats',
      favorites: 'filter_favorites',
    };

    const getTabInfo = (tabId: string) => {
      const builtinLabel = BUILTIN_LABELS[tabId];
      if (builtinLabel) {
        const iconMap: Record<string, string> = {
          all: 'all',
          contacts: 'contacts',
          chats: 'chats',
          favorites: 'favorites',
        };
        return {
          label: t(builtinLabel as any) || tabId,
          icon: iconMap[tabId] || 'folder'
        };
      }
      const folder = folders.find(f => f.id === tabId);
      return {
        label: folder?.name ?? tabId,
        icon: folder?.icon ?? 'folder'
      };
    };

    const isBuiltin = (tabId: string): boolean =>
      (BUILTIN_TAB_IDS as readonly string[]).includes(tabId);

    // Sync: ensure all current tabs are present
    const folderIds = new Set(folders.map(f => f.id));
    const allValidIds = new Set([...BUILTIN_TAB_IDS, ...folderIds]);
    const currentTabs = tabs.filter(tab => allValidIds.has(tab.id));

    const handleDragEnd = (event: DragEndEvent) => {
      const { active, over } = event;
      if (over && active.id !== over.id) {
        const oldIndex = currentTabs.findIndex(tab => tab.id === active.id);
        const newIndex = currentTabs.findIndex(tab => tab.id === over.id);
        if (oldIndex !== -1 && newIndex !== -1) {
          const newTabs = [...currentTabs];
          const [moved] = newTabs.splice(oldIndex, 1);
          newTabs.splice(newIndex, 0, moved);
          reorderTabs(newTabs.map(tab => tab.id));
        }
      }
    };

    return (
      <div className="settings-content">
        <h2>{t('nav_folders')}</h2>

        {/* Layout Selection */}
        <div className="settings-group">
          <h3>{t('folder_layout' as any)}</h3>
          <div className="stt-provider-options" style={{ marginTop: '12px' }}>
            <label className={`stt-provider-option ${folderLayout === 'horizontal' ? 'active' : ''}`}>
              <input type="radio" name="folder-layout" value="horizontal" checked={folderLayout === 'horizontal'} onChange={() => setFolderLayout('horizontal')} />
              <div className="stt-provider-info">
                <div className="stt-provider-name">{t('folder_layout_horizontal' as any)}</div>
              </div>
            </label>
            <label className={`stt-provider-option ${folderLayout === 'vertical' ? 'active' : ''}`}>
              <input type="radio" name="folder-layout" value="vertical" checked={folderLayout === 'vertical'} onChange={() => setFolderLayout('vertical')} />
              <div className="stt-provider-info">
                <div className="stt-provider-name">{t('folder_layout_vertical' as any)}</div>
              </div>
            </label>
          </div>
        </div>

        {/* Tab visibility & ordering */}
        <div className="settings-group">
          <h3>{t('tabs_order_title' as any) || 'Tabs'}</h3>
          <p className="settings-item-description" style={{ marginBottom: 12 }}>
            {t('tabs_order_desc' as any) || 'Drag to reorder, toggle to show/hide'}
          </p>

          <DndContext
            sensors={dndSensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={currentTabs.map(tab => tab.id)} strategy={verticalListSortingStrategy}>
              <div className="folders-list">
                {currentTabs.map(tab => {
                  const info = getTabInfo(tab.id);
                  return (
                    <SortableTabItem
                      key={tab.id}
                      tab={tab}
                      label={info.label}
                      icon={info.icon}
                      isBuiltin={isBuiltin(tab.id)}
                      onToggle={(visible) => setTabVisible(tab.id, visible)}
                      onDelete={!isBuiltin(tab.id) ? () => {
                        if (confirm(t('delete_folder_confirm' as any))) {
                          deleteFolder(tab.id);
                        }
                      } : undefined}
                    />
                  );
                })}
              </div>
            </SortableContext>
          </DndContext>
        </div>

        {/* Create new folder */}
        <div className="settings-group">
          <div className="settings-header-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <h3>{t('folders_title')}</h3>
            {!editingFolderId && (
              <button className="text-button" onClick={() => setEditingFolderId('new')}>
                + {t('create_new_folder')}
              </button>
            )}
          </div>

          {editingFolderId === 'new' && (
            <div className="folder-edit-box">
              <div className="input-group">
                <label className="settings-item-title">{t('folder_name')}</label>
                <input
                  type="text"
                  className="stt-language-select"
                  style={{ margin: '8px 0 16px', width: '100%' }}
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  placeholder={t('folder_name')}
                  autoFocus
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                />
              </div>

              <div className="input-group">
                <label className="settings-item-title">{t('choose_icon' as any)}</label>
                <div className="chat-type-chips" style={{ marginTop: '8px' }}>
                  {folderIcons.map(icon => (
                    <button
                      key={icon}
                      className={`type-chip icon-chip ${selectedIcon === icon ? 'active' : ''}`}
                      onClick={() => setSelectedIcon(icon)}
                      title={icon}
                    >
                      <Icon name={icon} size={20} />
                    </button>
                  ))}
                </div>
              </div>

              <div className="input-group">
                <label className="settings-item-title">{t('chat_types')}</label>
                <div className="chat-type-chips">
                  {chatTypeOptions.map(opt => (
                    <button
                      key={opt.type}
                      className={`type-chip ${selectedChatTypes.includes(opt.type) ? 'active' : ''}`}
                      onClick={() => toggleChatType(opt.type)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="folder-actions">
                <button className="settings-nav-item logout-button" style={{ display: 'inline-flex', padding: '8px 24px', width: 'auto' }} onClick={() => setEditingFolderId(null)}>{t('cancel')}</button>
                <button
                  className="stt-model-download-btn"
                  onClick={handleCreateFolder}
                  disabled={!newFolderName.trim()}
                >
                  {t('save_folder')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  const handleStorageApply = async () => {
    setUrlValidationError(null);

    if (tempStorageMode === 'remote') {
      try {
        const parsed = new URL(tempBackendUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          setUrlValidationError('URL must use http:// or https:// scheme');
          return;
        }
      } catch {
        setUrlValidationError('Please enter a valid URL (e.g. https://example.com)');
        return;
      }
    }

    try {
      await setStorageMode(tempStorageMode, tempStorageMode === 'remote' ? tempBackendUrl : undefined, tempStorageMode === 'remote' ? tempApiKey : undefined);
    } catch {
      // error stored in storageError
    }
  };

  const renderStorageSettings = () => (
    <div className="settings-content">
      <h2>{t('storage_mode_title' as any)}</h2>
      <p className="settings-item-description" style={{ marginBottom: 16 }}>
        {t('storage_mode_desc' as any)}
      </p>

      <div className="settings-group">
        <div className="stt-provider-options">
          <label className={`stt-provider-option ${tempStorageMode === 'local' ? 'active' : ''}`}>
            <input
              type="radio"
              name="storage-mode"
              value="local"
              checked={tempStorageMode === 'local'}
              onChange={() => setTempStorageMode('local')}
            />
            <div className="stt-provider-info">
              <div className="stt-provider-name">{t('storage_mode_local' as any)}</div>
              <div className="stt-provider-desc">{t('storage_mode_local_desc' as any)}</div>
            </div>
          </label>
          <label className={`stt-provider-option ${tempStorageMode === 'remote' ? 'active' : ''}`}>
            <input
              type="radio"
              name="storage-mode"
              value="remote"
              checked={tempStorageMode === 'remote'}
              onChange={() => setTempStorageMode('remote')}
            />
            <div className="stt-provider-info">
              <div className="stt-provider-name">{t('storage_mode_remote' as any)}</div>
              <div className="stt-provider-desc">{t('storage_mode_remote_desc' as any)}</div>
            </div>
          </label>
        </div>
      </div>

      {tempStorageMode === 'remote' && (
        <>
          <div className="settings-group">
            <h3>{t('storage_backend_url' as any)}</h3>
            <input
              type="text"
              className="stt-language-select"
              style={{ width: '100%', margin: '8px 0' }}
              value={tempBackendUrl}
              onChange={(e) => setTempBackendUrl(e.target.value)}
              placeholder={t('storage_backend_url_placeholder' as any)}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            {urlValidationError && (
              <div className="form-error" style={{ marginTop: 4, fontSize: 13 }}>
                {urlValidationError}
              </div>
            )}
            {!urlValidationError && tempBackendUrl.startsWith('http://') && (
              <div className="form-error" style={{ marginTop: 4, fontSize: 13, color: '#e8a838' }}>
                Warning: this connection is not encrypted. Use https:// for production servers.
              </div>
            )}
          </div>
          <div className="settings-group">
            <h3>{t('storage_api_key' as any)}</h3>
            <input
              type="password"
              className="stt-language-select"
              style={{ width: '100%', margin: '8px 0' }}
              value={tempApiKey}
              onChange={(e) => setTempApiKey(e.target.value)}
              placeholder="Bearer token"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          </div>
          <div className="settings-group">
            <h3>{t('backend_account' as any)}</h3>
            <p className="stt-provider-desc" style={{ marginTop: 4 }}>{t('backend_account_desc' as any)}</p>
            <input
              type="email"
              className="stt-language-select"
              style={{ width: '100%', margin: '8px 0' }}
              value={backendEmail}
              onChange={(e) => setBackendEmail(e.target.value)}
              placeholder="email@example.com"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            <input
              type="password"
              className="stt-language-select"
              style={{ width: '100%', margin: '8px 0' }}
              value={backendPassword}
              onChange={(e) => setBackendPassword(e.target.value)}
              placeholder={t('backend_password_placeholder' as any)}
              autoComplete="new-password"
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="stt-model-download-btn"
                disabled={backendAuthBusy || !backendEmail.trim() || backendPassword.length < 8}
                onClick={() => backendAuth('login')}
              >
                {t('backend_sign_in' as any)}
              </button>
              <button
                className="stt-model-download-btn"
                disabled={backendAuthBusy || !backendEmail.trim() || backendPassword.length < 8}
                onClick={() => backendAuth('register')}
              >
                {t('backend_register' as any)}
              </button>
            </div>
            {backendAuthMessage && (
              <div
                className={backendAuthMessage.ok ? 'stt-model-downloaded' : 'form-error'}
                style={{ marginTop: 8, fontSize: 13 }}
              >
                {backendAuthMessage.text}
              </div>
            )}
          </div>
        </>
      )}

      {storageError && (
        <div className="form-error" style={{ marginBottom: 12 }}>
          {t('storage_error' as any)}: {storageError}
        </div>
      )}

      <button
        className="stt-model-download-btn"
        onClick={handleStorageApply}
        disabled={storageSwitching}
        style={{ marginTop: 8 }}
      >
        {storageSwitching ? t('storage_testing' as any) : t('storage_save' as any)}
      </button>

      {storageMode === tempStorageMode && !storageSwitching && !storageError && storageMode === 'remote' && (
        <span className="stt-model-downloaded" style={{ marginLeft: 12 }}>
          {t('storage_connected' as any)}
        </span>
      )}
    </div>
  );

  const renderContent = () => {
    switch (activeSection) {
      case 'general': return renderGeneralSettings();
      case 'privacy': return renderPrivacySettings();
      case 'data': return renderDataSettings();
      case 'downloads': return renderDownloadsSettings();
      case 'stt': return renderSttSettings();
      case 'hotkeys': return renderHotkeysSettings();
      case 'language': return renderLanguageSettings();
      case 'folders': return renderFoldersSettings();
      case 'storage': return renderStorageSettings();
      case 'devices':
        return (<div className="settings-content"><h2>{t('nav_devices')}</h2><p className="settings-placeholder">{t('feature_in_dev')}</p></div>);
      default: return null;
    }
  };

  return (
    <>
      <div className="account-settings-overlay" onClick={onClose}>
        <div className={`account-settings ${mobileContentOpen ? 'mobile-content-open' : ''}`} onClick={(e) => e.stopPropagation()}>
          <aside className="settings-sidebar">
            <div className="settings-sidebar-header">
              <button className="icon-button" onClick={onClose} title={t('close')}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
              </button>
              <h2>{t('settings')}</h2>
            </div>

            <div className="settings-profile" onClick={() => setShowProfileEdit(true)} style={{ cursor: 'pointer' }}>
              <div className="settings-profile-avatar">
                {activeAccount?.userInfo?.first_name?.substring(0, 1)?.toUpperCase() || 'ME'}
              </div>
              <div className="settings-profile-info">
                <div className="settings-profile-name">{activeAccount?.userInfo?.first_name || 'User'}</div>
                <div className="settings-profile-phone">{activeAccount?.userInfo?.phone || ''}</div>
              </div>
            </div>

            <nav className="settings-nav">
              <button className={`settings-nav-item ${activeSection === 'general' ? 'active' : ''}`} onClick={() => { setActiveSection('general'); setMobileContentOpen(true); }}>
                <span className="settings-nav-icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3"></circle>
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                  </svg>
                </span>
                {t('nav_general')}
              </button>
              <button className={`settings-nav-item ${activeSection === 'privacy' ? 'active' : ''}`} onClick={() => { setActiveSection('privacy'); setMobileContentOpen(true); }}>
                <span className="settings-nav-icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                    <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                  </svg>
                </span>
                {t('nav_privacy')}
              </button>
              <button className={`settings-nav-item ${activeSection === 'data' ? 'active' : ''}`} onClick={() => { setActiveSection('data'); setMobileContentOpen(true); }}>
                <span className="settings-nav-icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <ellipse cx="12" cy="5" rx="9" ry="3"></ellipse>
                    <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path>
                    <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path>
                  </svg>
                </span>
                {t('nav_data')}
              </button>
              <button className={`settings-nav-item ${activeSection === 'downloads' ? 'active' : ''}`} onClick={() => { setActiveSection('downloads'); setMobileContentOpen(true); }}>
                <span className="settings-nav-icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                </span>
                {t('nav_downloads')}
                {(active + queued > 0) && <span className="settings-nav-badge">{active + queued}</span>}
              </button>
              <button className={`settings-nav-item ${activeSection === 'stt' ? 'active' : ''}`} onClick={() => { setActiveSection('stt'); setMobileContentOpen(true); }}>
                <span className="settings-nav-icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" /><path d="M19 10v2a7 7 0 01-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" />
                  </svg>
                </span>
                {t('nav_voice')}
              </button>
              <button className={`settings-nav-item ${activeSection === 'hotkeys' ? 'active' : ''}`} onClick={() => { setActiveSection('hotkeys'); setMobileContentOpen(true); }}>
                <span className="settings-nav-icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 6h18v12H3z"></path>
                    <path d="M7 10h.01"></path>
                    <path d="M11 10h.01"></path>
                    <path d="M15 10h.01"></path>
                    <path d="M7 14h.01"></path>
                    <path d="M11 14h.01"></path>
                    <path d="M15 14h.01"></path>
                  </svg>
                </span>
                {t('nav_hotkeys')}
              </button>
              <button className={`settings-nav-item ${activeSection === 'folders' ? 'active' : ''}`} onClick={() => { setActiveSection('folders'); setMobileContentOpen(true); }}>
                <span className="settings-nav-icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                  </svg>
                </span>
                {t('nav_folders')}
              </button>
              <button className={`settings-nav-item ${activeSection === 'devices' ? 'active' : ''}`} onClick={() => { setActiveSection('devices'); setMobileContentOpen(true); }}>
                <span className="settings-nav-icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="5" y="2" width="14" height="20" rx="2" ry="2"></rect>
                    <line x1="12" y1="18" x2="12.01" y2="18"></line>
                  </svg>
                </span>
                {t('nav_devices')}
              </button>
              <button className={`settings-nav-item ${activeSection === 'storage' ? 'active' : ''}`} onClick={() => { setActiveSection('storage'); setMobileContentOpen(true); }}>
                <span className="settings-nav-icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 7V4a2 2 0 0 1 2-2h8.5L20 7.5V20a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3" />
                    <polyline points="14 2 14 8 20 8" />
                    <path d="M2 15h10" />
                    <path d="M9 18l3-3-3-3" />
                  </svg>
                </span>
                {t('nav_storage_mode' as any)}
              </button>
              <button className={`settings-nav-item ${activeSection === 'language' ? 'active' : ''}`} onClick={() => { setActiveSection('language'); setMobileContentOpen(true); }}>
                <span className="settings-nav-icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="2" y1="12" x2="22" y2="12"></line>
                    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
                  </svg>
                </span>
                {t('nav_language')}
              </button>
            </nav>

            <div className="settings-sidebar-footer">
              <button className="settings-nav-item logout-button" onClick={handleLogout} disabled={loggingOut}>
                <span className="settings-nav-icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
                  </svg>
                </span>
                {loggingOut ? t('logging_out') : t('log_out')}
              </button>
            </div>
          </aside>

          <main className="settings-main">
            <button className="settings-back-mobile" onClick={() => setMobileContentOpen(false)}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
            </button>
            <button className="settings-close" onClick={onClose}>✕</button>
            {renderContent()}
          </main>
        </div>
      </div>

      {showProfileEdit && <ProfileSettings onClose={() => setShowProfileEdit(false)} />}
    </>
  );
};
