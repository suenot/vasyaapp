import { useState } from 'react';
import { setServerConfig } from '../../transport';
import { useSettingsStore } from '../../store/settingsStore';
import './LoginForm.css';

/**
 * Web-only gate shown before anything else when no vasya-server connection
 * is configured. Two ways in: paste an access token directly (embedded-mode
 * VASYA_LOCAL_TOKEN or an existing JWT), or sign in with email + password
 * against the sync backend's /api/auth/login, which issues a JWT the API
 * accepts when both share JWT_SECRET.
 */
/** Hosted builds set VITE_VASYA_API_URL so the field pre-fills the public API
 * origin; desktop/dev builds leave it unset and keep the loopback default. */
const DEFAULT_SERVER_URL =
  (import.meta.env as Record<string, string | undefined>).VITE_VASYA_API_URL ??
  'http://127.0.0.1:8787';

export const ServerConnect = () => {
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [method, setMethod] = useState<'token' | 'password'>('token');
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    const baseUrl = serverUrl.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(baseUrl)) {
      setError('Server URL must start with http:// or https://');
      return;
    }

    setSubmitting(true);
    try {
      let bearer = token.trim();
      if (method === 'password') {
        const resp = await fetch(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: email.trim(), password }),
        });
        if (!resp.ok) {
          const data = await resp.json().catch(() => null);
          throw new Error(data?.error ?? `Login failed (HTTP ${resp.status})`);
        }
        const data = await resp.json();
        if (typeof data?.token !== 'string') throw new Error('Login response had no token');
        bearer = data.token;
      }
      if (!bearer) {
        setError('Enter an access token');
        return;
      }

      // Validate against an authenticated route before persisting.
      const check = await fetch(`${baseUrl}/api/v1/accounts`, {
        headers: { Authorization: `Bearer ${bearer}` },
      });
      if (check.status === 401) throw new Error('The server rejected this token');
      if (!check.ok) throw new Error(`Server check failed (HTTP ${check.status})`);

      setServerConfig({ baseUrl, token: bearer });
      // Full reload so every store and listener boots against the server.
      window.location.reload();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // fetch() network failures surface as an unhelpful 'Failed to fetch'.
      setError(msg === 'Failed to fetch'
        ? 'Could not reach the server — check the URL and that CORS allows this origin'
        : msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-card">
        <div className="login-logo-container">
          <img src="/vasyapp.svg" alt="Vasyapp Logo" className="login-logo" />
        </div>
        <h1 className="login-title">Vasyapp</h1>

        <form onSubmit={handleSubmit} className="login-form">
          <p className="login-subtitle">Connect to your vasya-server</p>
          <input
            type="url"
            className="login-input"
            placeholder="Server URL, e.g. http://127.0.0.1:8787"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            disabled={submitting}
          />

          <div className="login-lang-selector" style={{ position: 'static', display: 'flex', gap: 8 }}>
            <button
              type="button"
              className={method === 'token' ? 'login-button' : 'login-button-secondary'}
              onClick={() => setMethod('token')}
              disabled={submitting}
            >
              Access token
            </button>
            <button
              type="button"
              className={method === 'password' ? 'login-button' : 'login-button-secondary'}
              onClick={() => setMethod('password')}
              disabled={submitting}
            >
              Email &amp; password
            </button>
          </div>

          {method === 'token' ? (
            <input
              type="password"
              className="login-input"
              placeholder="Access token (VASYA_LOCAL_TOKEN or JWT)"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              disabled={submitting}
            />
          ) : (
            <>
              <input
                type="email"
                className="login-input"
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={submitting}
              />
              <input
                type="password"
                className="login-input"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={submitting}
              />
            </>
          )}

          {error && <p className="login-error">{error}</p>}

          <button type="submit" className="login-button" disabled={submitting}>
            {submitting ? 'Connecting…' : 'Connect'}
          </button>

          {/* Desktop escape hatch: this gate covers the whole UI, so the way
              back to the embedded engine must be available right here. */}
          {'__TAURI_INTERNALS__' in window && (
            <button
              type="button"
              className="login-button-secondary"
              disabled={submitting}
              onClick={() => {
                useSettingsStore.getState().switchTransportMode('embedded').catch((err) => {
                  setError(err instanceof Error ? err.message : String(err));
                });
              }}
            >
              Use the embedded engine instead
            </button>
          )}
        </form>
      </div>
    </div>
  );
};
