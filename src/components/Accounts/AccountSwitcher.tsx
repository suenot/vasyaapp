import { useState, useEffect, useCallback } from 'react';
import { invoke, convertFileSrc } from '../../transport';
import { useAccountsStore } from '../../store/accountsStore';
import { useAuthStore } from '../../store/authStore';
import { useTranslation } from '../../i18n';
import './AccountSwitcher.css';

interface ContextMenu {
  accountId: string;
  x: number;
  y: number;
}

export const AccountSwitcher = () => {
  const { t } = useTranslation();
  // Individual selectors — avoid subscribing to the whole store.
  const accounts = useAccountsStore((s) => s.accounts);
  const activeAccountId = useAccountsStore((s) => s.activeAccountId);
  const setActiveAccount = useAccountsStore((s) => s.setActiveAccount);
  const clearActiveAccount = useAccountsStore((s) => s.clearActiveAccount);
  const removeAccount = useAccountsStore((s) => s.removeAccount);
  const [avatars, setAvatars] = useState<Record<string, string>>({});
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [loggingOut, setLoggingOut] = useState<string | null>(null);

  // Fetch avatars only for accounts we don't already have, and only when the
  // *set* of accounts changes — switching the active account rebuilds the
  // account objects but not their ids, so this no longer refetches every avatar.
  const accountIdsKey = accounts.map((a) => a.id).join(',');
  useEffect(() => {
    accounts.forEach(acc => {
      if (avatars[acc.id]) return;
      invoke<string | null>('get_my_avatar', { accountId: acc.id })
        .then((path) => {
          if (path) {
            setAvatars(prev => ({ ...prev, [acc.id]: path }));
          }
        })
        .catch(() => { });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountIdsKey]);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  useEffect(() => {
    if (contextMenu) {
      const handler = () => closeContextMenu();
      window.addEventListener('click', handler);
      return () => window.removeEventListener('click', handler);
    }
  }, [contextMenu, closeContextMenu]);

  const handleSwitch = (accountId: string) => {
    if (accountId === activeAccountId) return;
    setActiveAccount(accountId);
  };

  const handleAddAccount = () => {
    clearActiveAccount();
  };

  const handleContextMenu = (e: React.MouseEvent, accountId: string) => {
    e.preventDefault();
    setContextMenu({ accountId, x: e.clientX, y: e.clientY });
  };

  const handleLogout = async (accountId: string) => {
    setContextMenu(null);
    setLoggingOut(accountId);
    try {
      await invoke('logout', { accountId });
      removeAccount(accountId);
      if (accountId === activeAccountId) {
        const remaining = accounts.filter(a => a.id !== accountId);
        if (remaining.length > 0) {
          setActiveAccount(remaining[0].id);
        } else {
          useAuthStore.getState().logout();
          clearActiveAccount();
        }
      }
    } catch (err) {
      console.error('Logout failed:', err);
    } finally {
      setLoggingOut(null);
    }
  };

  if (accounts.length === 0) {
    return (
      <div className="account-circles">
        <button
          className="account-circle add-account"
          onClick={handleAddAccount}
          title={t('add_account')}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
        </button>
      </div>
    );
  }

  // Sort accounts so active is last (on top) or first? 
  // User says "группа кружочков раздвигается". Usually they overlap and then spread.
  return (
    <div className="account-circles">
      <div className="circles-group">
        {accounts.map((account, index) => (
          <button
            key={account.id}
            className={`account-circle ${account.id === activeAccountId ? 'active' : ''} ${loggingOut === account.id ? 'logging-out' : ''}`}
            onClick={() => handleSwitch(account.id)}
            onContextMenu={(e) => handleContextMenu(e, account.id)}
            style={{ '--index': index } as React.CSSProperties}
            title={`${account.userInfo.first_name} ${account.userInfo.last_name || ''}`}
          >
            {avatars[account.id] ? (
              <img src={convertFileSrc(avatars[account.id])} alt="" className="avatar-image" />
            ) : (
              <div className="avatar-placeholder">
                {account.userInfo.first_name.charAt(0).toUpperCase()}
              </div>
            )}
          </button>
        ))}
        <button
          className="account-circle add-account"
          onClick={handleAddAccount}
          style={{ '--index': accounts.length } as React.CSSProperties}
          title={t('add_account')}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
        </button>
      </div>

      {contextMenu && (
        <div
          className="account-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="account-context-menu-item logout"
            onClick={() => handleLogout(contextMenu.accountId)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            {t('log_out')}
          </button>
        </div>
      )}
    </div>
  );
};
