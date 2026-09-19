import { useEffect, useId, useState } from 'react';
import { useTranslation } from '../../i18n';
import { DEFAULT_CHAT_TRANSLATION, translationChatKey, useTranslationStore } from '../../store/translationStore';
import { AccountSettings } from '../Settings/AccountSettings';
import '../Settings/TranslationSettings.css';

interface DirectionProps {
  direction: 'incoming' | 'outgoing';
  enabled: boolean;
  target: string;
  providerReady: boolean;
  onEnabled: (enabled: boolean, target: string) => void;
  onTarget: (target: string) => void;
}
const DirectionSettings = ({ direction, enabled, target, providerReady, onEnabled, onTarget }: DirectionProps) => {
  const { t } = useTranslation();
  const id = useId();
  const [draft, setDraft] = useState(target);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => { setDraft(target); setInvalid(false); }, [target]);
  const commitTarget = () => {
    const value = draft.trim();
    if (!value) { setInvalid(true); return; }
    setDraft(value);
    setInvalid(false);
    if (value !== target) onTarget(value);
  };
  return (
    <div>
      <div className="chat-translation-toggle">
        <span id={`${id}-label`}>{t(direction === 'incoming' ? 'translation_incoming' : 'translation_outgoing')}</span>
        <label className="toggle-switch">
          <input type="checkbox" checked={enabled} aria-labelledby={`${id}-label`}
            disabled={!enabled && (!providerReady || !draft.trim())}
            onChange={(event) => {
              const value = draft.trim();
              if (event.target.checked && !value) { setInvalid(true); return; }
              onEnabled(event.target.checked, value || target);
            }} />
          <span className="toggle-slider" />
        </label>
      </div>
      <p className="translation-description">{t(direction === 'incoming' ? 'translation_incoming_help' : 'translation_outgoing_help')}</p>
      <label className="translation-field" htmlFor={`${id}-target`}>
        <span>{t('translation_target_language')}</span>
        <input id={`${id}-target`} list={`${id}-languages`} value={draft}
          placeholder={t('translation_target_placeholder')} aria-label={t('translation_target_language')} autoComplete="off" maxLength={80}
          aria-invalid={invalid} aria-describedby={invalid ? `${id}-error` : undefined}
          onChange={(event) => { setDraft(event.target.value); setInvalid(false); }}
          onBlur={commitTarget}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }} />
        <datalist id={`${id}-languages`}>
          <option value="en">{t('translation_lang_english')}</option>
          <option value="ru">{t('translation_lang_russian')}</option>
          <option value="zh">{t('translation_lang_chinese')}</option>
          <option value="es">{t('translation_lang_spanish')}</option>
          <option value="de">{t('translation_lang_german')}</option>
          <option value="fr">{t('translation_lang_french')}</option>
        </datalist>
        {invalid && <span id={`${id}-error`} className="chat-translation-target-error" role="alert">{t('translation_target_required')}</span>}
      </label>
    </div>
  );
};

export const ChatTranslationSettings = ({ accountId, chatId }: { accountId: string; chatId: number }) => {
  const { t } = useTranslation();
  const key = translationChatKey(accountId, chatId);
  const preferences = useTranslationStore((state) => state.chats[key] ?? DEFAULT_CHAT_TRANSLATION);
  const settings = useTranslationStore((state) => state.settings);
  const loading = useTranslationStore((state) => state.loading);
  const setPreferences = useTranslationStore((state) => state.setChatPreferences);
  const loadSettings = useTranslationStore((state) => state.loadSettings);
  const [showProvider, setShowProvider] = useState(false);
  useEffect(() => { void loadSettings(); }, [loadSettings]);
  const providerReady = Boolean(settings?.base_url && settings.model);
  return (
    <>
      <section className="chat-info-section chat-translation-controls" aria-label={t('translation_title')}>
        <div className="chat-info-section-title">{t('translation_title')}</div>
        <p className="translation-description">{t('translation_chat_disclosure')}</p>
        {!providerReady && <p className="translation-description" role="status">{loading ? t('loading') : t('translation_provider_needed')}</p>}
        <DirectionSettings key={`${key}:incoming`} direction="incoming" enabled={preferences.incomingEnabled}
          target={preferences.incomingTarget} providerReady={providerReady}
          onEnabled={(incomingEnabled, incomingTarget) => setPreferences(accountId, chatId, { incomingEnabled, incomingTarget })}
          onTarget={(incomingTarget) => setPreferences(accountId, chatId, { incomingTarget })} />
        <DirectionSettings key={`${key}:outgoing`} direction="outgoing" enabled={preferences.outgoingEnabled}
          target={preferences.outgoingTarget} providerReady={providerReady}
          onEnabled={(outgoingEnabled, outgoingTarget) => setPreferences(accountId, chatId, { outgoingEnabled, outgoingTarget })}
          onTarget={(outgoingTarget) => setPreferences(accountId, chatId, { outgoingTarget })} />
        <button type="button" className="translation-button" onClick={() => setShowProvider(true)}>{t('translation_configure_provider')}</button>
      </section>
      {showProvider && <AccountSettings initialSection="translation" onClose={() => setShowProvider(false)} />}
    </>
  );
};
