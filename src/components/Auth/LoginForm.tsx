import { useState } from 'react';
import { AsYouType } from 'libphonenumber-js';
import { useTauriCommand } from '../../hooks/useTauriCommand';
import { useAuthStore } from '../../store/authStore';
import { useAccountsStore } from '../../store/accountsStore';
import { useTranslation, useLanguageStore, LANGUAGE_LABELS, Language } from '../../i18n';
import { UserInfo } from '../../types/telegram';
import './LoginForm.css';

interface AuthToken {
  token_data: string;
  phone: string;
}

interface LoginFormProps {
  onCancel?: () => void;
}

/**
 * Format an international phone number as-you-type using per-country grouping
 * (libphonenumber, same rules as the native Telegram apps). A fixed mask like
 * `+X XXX XXX XX XX` mis-groups most countries — e.g. UZ `+998 90 829 55 93`
 * came out as `+9 989 082 95 59 3`.
 */
const formatPhone = (value: string): string => {
  const nums = value.replace(/\D/g, '');
  if (!nums) return value.includes('+') ? '+' : '';
  // AsYouType is stateful; use a fresh instance per call for a controlled input.
  return new AsYouType().input('+' + nums);
};

/** Strip formatting, return raw phone for API */
const stripPhone = (formatted: string): string => {
  const nums = formatted.replace(/\D/g, '');
  return nums ? '+' + nums : '';
};

export const LoginForm = ({ onCancel }: LoginFormProps) => {
  const { t } = useTranslation();
  const { language, setLanguage } = useLanguageStore();
  const [showLangMenu, setShowLangMenu] = useState(false);

  const [phone, setPhone] = useState('+');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [step, setStep] = useState<'phone' | 'code' | '2fa'>('phone');
  const [error, setError] = useState('');
  const [authToken, setAuthToken] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);

  const { setUser, setLoading } = useAuthStore();
  const { addAccount } = useAccountsStore();
  const requestLoginCode = useTauriCommand<AuthToken, { phone: string }>('request_login_code');
  const verifyCode = useTauriCommand<UserInfo, { token: string; code: string }>('verify_code');
  const checkPassword = useTauriCommand<UserInfo, { accountId: string; password: string }>('check_password');

  const handlePhoneChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const formatted = formatPhone(e.target.value);
    setPhone(formatted);
  };

  const handlePhoneSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    const raw = stripPhone(phone);
    if (raw.length < 8) {
      setError(t('login_phone_error'));
      return;
    }

    try {
      setSubmitting(true);
      setLoading(true);
      const result = await requestLoginCode({ phone: raw });
      setAuthToken(result.token_data);
      setStep('code');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Login code request failed:', msg);
      setError(msg || t('login_request_error'));
    } finally {
      setSubmitting(false);
      setLoading(false);
    }
  };

  const handleCodeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value.replace(/\D/g, '').slice(0, 6);
    setCode(val);
  };

  const handleCodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!code.trim()) {
      setError(t('login_code_error'));
      return;
    }

    try {
      setSubmitting(true);
      setLoading(true);
      const user = await verifyCode({ token: authToken, code });
      addAccount(authToken, user);
      setUser(user);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (errorMsg.includes('2FA') || errorMsg.includes('password required')) {
        setStep('2fa');
        setError('');
      } else {
        setError(errorMsg);
      }
    } finally {
      setSubmitting(false);
      setLoading(false);
    }
  };

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!password.trim()) {
      setError(t('login_2fa_error'));
      return;
    }

    try {
      setSubmitting(true);
      setLoading(true);
      const user = await checkPassword({ accountId: authToken, password });
      addAccount(authToken, user);
      setUser(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('login_2fa_wrong'));
    } finally {
      setSubmitting(false);
      setLoading(false);
    }
  };

  const handleBack = () => {
    if (step === '2fa') {
      setStep('code');
      setPassword('');
    } else if (step === 'code') {
      setStep('phone');
      setCode('');
      setAuthToken('');
    }
    setError('');
  };

  return (
    <div className="login-container">
      {/* Back button — only when cancellable (adding an account). Pinned to the top so it
          stays reachable even while the keyboard covers the Cancel button in the card. */}
      {onCancel && (
        <button className="login-back-button" onClick={onCancel} aria-label={t('cancel')} title={t('cancel')}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="19" y1="12" x2="5" y2="12" />
            <polyline points="12 19 5 12 12 5" />
          </svg>
        </button>
      )}
      {/* Language selector */}
      <div className="login-lang-selector">
        <button
          className="login-lang-button"
          onClick={() => setShowLangMenu((p) => !p)}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="2" y1="12" x2="22" y2="12" />
            <path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
          </svg>
          {LANGUAGE_LABELS[language]}
        </button>
        {showLangMenu && (
          <div className="login-lang-menu">
            {(Object.keys(LANGUAGE_LABELS) as Language[]).map((lang) => (
              <button
                key={lang}
                className={`login-lang-menu-item ${lang === language ? 'active' : ''}`}
                onClick={() => { setLanguage(lang); setShowLangMenu(false); }}
              >
                {LANGUAGE_LABELS[lang]}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="login-card">
        <div className="login-logo-container">
          <img src="/vasyapp.svg" alt="Vasyapp Logo" className="login-logo" />
        </div>
        <h1 className="login-title">Vasyapp</h1>

        {step === 'phone' && (
          <form onSubmit={handlePhoneSubmit} className="login-form">
            <p className="login-subtitle">{t('login_title')}</p>
            <input
              type="tel"
              className="login-input"
              placeholder={t('login_phone_placeholder')}
              value={phone}
              onChange={handlePhoneChange}
              disabled={submitting}
              autoFocus
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            {error && <div className="login-error">{error}</div>}
            <button type="submit" className="login-button" disabled={submitting}>
              {submitting ? t('login_sending') : t('login_continue')}
            </button>
            {onCancel && <button type="button" className="login-button-secondary" onClick={onCancel} disabled={submitting}>{t('cancel')}</button>}
          </form>
        )}

        {step === 'code' && (
          <form onSubmit={handleCodeSubmit} className="login-form">
            <p className="login-subtitle">{t('login_code_sent')}<br /><strong>{phone}</strong></p>
            <input
              type="text"
              className="login-input login-input-code"
              placeholder={t('login_code_placeholder')}
              value={code}
              onChange={handleCodeChange}
              disabled={submitting}
              inputMode="numeric"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              autoFocus
            />
            {error && <div className="login-error">{error}</div>}
            <button type="submit" className="login-button" disabled={submitting}>
              {submitting ? t('login_checking') : t('login_sign_in')}
            </button>
            <button type="button" className="login-button-secondary" onClick={handleBack} disabled={submitting}>{t('login_change_number')}</button>
          </form>
        )}

        {step === '2fa' && (
          <form onSubmit={handlePasswordSubmit} className="login-form">
            <p className="login-subtitle">{t('login_2fa_title')}<br />{t('login_2fa_subtitle')}</p>
            <input
              type="password"
              className="login-input"
              placeholder={t('login_2fa_placeholder')}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
              autoFocus
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            {error && <div className="login-error">{error}</div>}
            <button type="submit" className="login-button" disabled={submitting}>
              {submitting ? t('login_checking') : t('login_2fa_confirm')}
            </button>
            <button type="button" className="login-button-secondary" onClick={handleBack} disabled={submitting}>{t('back')}</button>
          </form>
        )}
      </div>
    </div>
  );
};
