import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import { useTranslationStore } from '../../store/translationStore';
import './TranslationSettings.css';

export const TranslationSettings = () => {
  const { t } = useTranslation();
  const settings = useTranslationStore((state) => state.settings);
  const loading = useTranslationStore((state) => state.loading);
  const loadError = useTranslationStore((state) => state.error);
  const loadSettings = useTranslationStore((state) => state.loadSettings);
  const saveSettings = useTranslationStore((state) => state.saveSettings);
  const [baseUrl, setBaseUrl] = useState(settings?.base_url ?? '');
  const [model, setModel] = useState(settings?.model ?? '');
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => { void loadSettings(); }, [loadSettings]);
  useEffect(() => {
    if (!dirty && settings) {
      setBaseUrl(settings.base_url);
      setModel(settings.model);
    }
  }, [settings?.base_url, settings?.model, dirty]);

  const edited = () => { setDirty(true); setSaved(false); setError(null); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSaved(false);
    try {
      const url = new URL(baseUrl.trim());
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error();
    } catch {
      setError(t('translation_url_invalid'));
      return;
    }
    if (!model.trim()) { setError(t('translation_model_required')); return; }
    setSaving(true);
    try {
      await saveSettings({
        base_url: baseUrl.trim(),
        model: model.trim(),
        ...(clearKey ? { api_key: '' } : apiKey.trim() ? { api_key: apiKey.trim() } : {}),
      });
      setApiKey('');
      setClearKey(false);
      setDirty(false);
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setSaving(false); }
  };

  return (
    <div className="settings-content translation-settings">
      <h2>{t('translation_title')}</h2>
      <p className="translation-description">{t('translation_provider_description')}</p>
      <p className="translation-description">{t('translation_disclosure')}</p>
      {!settings && loading && <p role="status">{t('loading')}</p>}
      {!settings && loadError && (
        <div className="translation-error" role="alert">
          <p>{t('translation_load_error')}</p>
          <p>{loadError}</p>
          <button type="button" className="translation-button" onClick={() => void loadSettings()} disabled={loading}>{t('translation_retry_load')}</button>
        </div>
      )}
      <form onSubmit={submit}>
        <fieldset className="translation-fields" disabled={saving || loading || !settings}>
          <label className="translation-field" htmlFor="translation-base-url">
            <span>{t('translation_base_url')}</span>
            <input id="translation-base-url" aria-label={t('translation_base_url')} type="url" value={baseUrl} placeholder="https://api.openai.com/v1"
              autoComplete="off" autoCapitalize="off" spellCheck={false} required
              onChange={(event) => { setBaseUrl(event.target.value); edited(); }} />
            <small>{t('translation_base_url_help')}</small>
          </label>
          <label className="translation-field" htmlFor="translation-model">
            <span>{t('translation_model')}</span>
            <input id="translation-model" aria-label={t('translation_model')} value={model} placeholder={t('translation_model_placeholder')}
              autoComplete="off" autoCapitalize="off" spellCheck={false} required
              onChange={(event) => { setModel(event.target.value); edited(); }} />
          </label>
          <label className="translation-field" htmlFor="translation-api-key">
            <span>{t('translation_api_key')}</span>
            <input id="translation-api-key" aria-label={t('translation_api_key')} type="password" value={apiKey}
              placeholder={settings?.api_key_set && !clearKey ? t('translation_key_keep') : t('translation_key_placeholder')}
              autoComplete="new-password" autoCapitalize="off" spellCheck={false}
              onChange={(event) => { setApiKey(event.target.value); setClearKey(false); edited(); }} />
            <small role="status">{clearKey ? t('translation_key_clear_pending') : settings?.api_key_set ? t('translation_key_configured') : t('translation_key_not_set')}</small>
            <small>{t('translation_key_help')}</small>
          </label>
          {settings?.api_key_set && (
            <button type="button" className="translation-button translation-button-subtle"
              onClick={() => { setClearKey(!clearKey); setApiKey(''); edited(); }}>
              {clearKey ? t('translation_key_undo_clear') : t('translation_key_clear')}
            </button>
          )}
          <div className="translation-actions">
            <button type="submit" className="translation-button translation-button-primary" disabled={!dirty}>
              {saving ? t('translation_saving') : t('save')}
            </button>
            {saved && <span className="translation-saved" role="status">{t('translation_saved')}</span>}
          </div>
        </fieldset>
      </form>
      {error && <div className="translation-error" role="alert"><p>{error}</p><p>{t('translation_save_error_help')}</p></div>}
      <p className="translation-description">{t('translation_chat_setup_help')}</p>
    </div>
  );
};
