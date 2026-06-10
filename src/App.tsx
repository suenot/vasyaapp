import { useEffect, useCallback, useMemo, useRef } from 'react';
import { LoginForm } from './components/Auth/LoginForm';
import { ServerConnect } from './components/Auth/ServerConnect';
import { getTransportMode, isServerConfigured } from './transport';
import { MainLayout } from './components/Layout/MainLayout';
import { ApiSettings } from './components/Settings/ApiSettings';
import { CallOverlay } from './components/Call';
import { useSettingsStore } from './store/settingsStore';
import { useAccountsStore } from './store/accountsStore';
import { useThemeStore } from './store/themeStore';
import { useConnectionStore } from './store/connectionStore';
import { useSttStore } from './store/sttStore';
import { useCallStore } from './store/callStore';
import { useGroupCallStore } from './store/groupCallStore';
import { useSystemTheme } from './hooks/useSystemTheme';
import { useTauriEvent } from './hooks/useTauriEvent';
import { useTauriCommand } from './hooks/useTauriCommand';
import { ErrorBoundary } from './components/ErrorBoundary';
import "./App.css";

interface ConnectionStatusEvent {
  accountId: string;
  status: 'connected' | 'disconnected' | 'reconnecting';
}

function App() {
  // Individual selectors — only re-render when the selected value changes
  const isConfigured = useSettingsStore((s) => s.isConfigured);
  const setApiCredentials = useSettingsStore((s) => s.setApiCredentials);
  const accounts = useAccountsStore((s) => s.accounts);
  const activeAccountId = useAccountsStore((s) => s.activeAccountId);
  const themeSetting = useThemeStore((s) => s.themeSetting);
  const setEffectiveTheme = useThemeStore((s) => s.setEffectiveTheme);
  const setConnected = useConnectionStore((s) => s.setConnected);
  const setDisconnected = useConnectionStore((s) => s.setDisconnected);
  const setReconnecting = useConnectionStore((s) => s.setReconnecting);
  const loadSttSettings = useSttStore((s) => s.loadSettings);
  const systemTheme = useSystemTheme();
  const updateApiCredentials = useTauriCommand<void, { apiId: number; apiHash: string }>('update_api_credentials');
  const hasApiCredentials = useTauriCommand<boolean>('has_api_credentials');
  const markConfigured = useSettingsStore((s) => s.markConfigured);

  // On mount: check if backend already has credentials (from bundled .env)
  useEffect(() => {
    if (!isConfigured) {
      hasApiCredentials().then((hasCredentials) => {
        if (hasCredentials) {
          markConfigured();
        }
      }).catch(() => {
        // Backend not ready yet, user will see setup screen
      });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load STT settings on mount
  useEffect(() => {
    loadSttSettings();
  }, [loadSttSettings]);

  // Re-arm the local API server if its toggle was left on (desktop only;
  // a no-op when disabled or when the backend lacks the command).
  useEffect(() => {
    useSettingsStore.getState().syncLocalApi();
  }, []);

  // Setup call event listeners
  useEffect(() => {
    const cleanup = useCallStore.getState().setupListeners();
    const cleanupGroupCalls = useGroupCallStore.getState().setupListeners();
    return () => {
      cleanup();
      cleanupGroupCalls();
    };
  }, []);

  // Track connection status from Rust backend
  useTauriEvent<ConnectionStatusEvent>('connection-status', useCallback((evt) => {
    switch (evt.status) {
      case 'connected': setConnected(); break;
      case 'disconnected': setDisconnected(); break;
      case 'reconnecting': setReconnecting(); break;
    }
  }, [setConnected, setDisconnected, setReconnecting]));

  // Apply interface scale
  const interfaceScale = useSettingsStore((s) => s.interfaceScale);
  useEffect(() => {
    document.documentElement.style.zoom = `${interfaceScale / 100}`;
  }, [interfaceScale]);

  // Apply message text size
  const messageTextSize = useSettingsStore((s) => s.messageTextSize);
  useEffect(() => {
    const sizes = { small: '13px', medium: '14.5px', large: '16px' };
    document.documentElement.style.setProperty('--message-font-size', sizes[messageTextSize]);
  }, [messageTextSize]);

  // Применяем тему при монтировании и изменении настроек
  useEffect(() => {
    const effectiveTheme = themeSetting === 'system' ? systemTheme : themeSetting;
    setEffectiveTheme(effectiveTheme as any);

    // Устанавливаем data-theme атрибут на :root
    if (effectiveTheme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else if (effectiveTheme === 'blue') {
      document.documentElement.setAttribute('data-theme', 'blue');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }, [themeSetting, systemTheme, setEffectiveTheme]);

  const handleApiSave = async (apiId: string, apiHash: string) => {
    try {
      // Отправить в backend
      await updateApiCredentials({
        apiId: parseInt(apiId),
        apiHash: apiHash,
      });

      // Сохранить в localStorage
      setApiCredentials(apiId, apiHash);
    } catch (err) {
      console.error('Failed to update API credentials:', err);
      alert(`Ошибка при сохранении API credentials: ${err}`);
    }
  };

  const activeAccount = useMemo(
    () => accounts.find((a) => a.id === activeAccountId) ?? null,
    [accounts, activeAccountId]
  );

  // Remember previous active account ID so we can restore it on cancel
  const prevAccountIdRef = useRef<string | null>(activeAccountId);
  useEffect(() => {
    if (activeAccountId) {
      prevAccountIdRef.current = activeAccountId;
    }
  }, [activeAccountId]);

  const setActiveAccount = useAccountsStore((s) => s.setActiveAccount);

  const handleLoginCancel = useCallback(() => {
    const fallbackId = prevAccountIdRef.current || accounts[0]?.id;
    if (fallbackId) {
      setActiveAccount(fallbackId);
    }
  }, [accounts, setActiveAccount]);

  // Web build talking to a remote server: connection gate comes first.
  if (getTransportMode() === 'remote' && !isServerConfigured()) {
    return (
      <div className="app">
        <ServerConnect />
      </div>
    );
  }

  // Если API не настроен - показываем экран настройки
  if (!isConfigured) {
    return (
      <>
        <div className="app">
          <ApiSettings onSave={handleApiSave} />
        </div>
        <CallOverlay />
      </>
    );
  }

  // Если есть активный аккаунт - показываем главный интерфейс
  if (activeAccount) {
    return (
      <>
        <div className="app">
          <ErrorBoundary><MainLayout /></ErrorBoundary>
        </div>
        <CallOverlay />
      </>
    );
  }

  // Иначе - показываем форму входа
  return (
    <>
      <div className="app">
        <ErrorBoundary><LoginForm onCancel={accounts.length > 0 ? handleLoginCancel : undefined} /></ErrorBoundary>
      </div>
      <CallOverlay />
    </>
  );
}

export default App;
