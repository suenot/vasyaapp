import { useEffect, useRef, useState } from 'react';
import { getTransport } from '../../transport';
import { DEFAULT_CHAT_TRANSLATION, translationSessionKey, translationChatKey, useTranslationStore } from '../../store/translationStore';
import { TranslationScheduler, type TranslationResult } from '../../services/translationRuntime';
import { MarkdownRenderer } from './MarkdownRenderer';
import { useTranslation } from '../../i18n';

const scheduler = new TranslationScheduler();
export function TranslatedText({ accountId, chatId, messageId, text, outgoing, markdown }: {
  accountId: string; chatId: number; messageId: number; text: string; outgoing: boolean; markdown: boolean;
}) {
  const { t } = useTranslation();
  const scope = translationChatKey(accountId, chatId);
  const preferences = useTranslationStore(state => state.chats[scope] ?? DEFAULT_CHAT_TRANSLATION);
  const generation = useTranslationStore(state => state.generation);
  const target = !outgoing && preferences.incomingEnabled ? preferences.incomingTarget.trim() : '';
  const element = useRef<HTMLDivElement>(null);
  const visibilityKey = JSON.stringify([scope, messageId, target]);
  const [seen, setSeen] = useState<string | null>(null);
  const visible = seen === visibilityKey;
  const [result, setResult] = useState<{ key: string; value: TranslationResult } | null>(null);
  const [original, setOriginal] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([translationSessionKey(), scope, messageId, text, target, generation]);
  useEffect(() => {
    const node = element.current;
    if (!node || !target) return;
    // Virtualized overscan is mounted but is not permission to translate hidden history.
    const observer = new IntersectionObserver(entries => setSeen(entries.some(entry => entry.isIntersecting) ? visibilityKey : null), { root: node.closest('.messages-container') });
    observer.observe(node); return () => observer.disconnect();
  }, [visibilityKey, target]);
  useEffect(() => {
    setOriginal(false);
    if (!target || !visible || !text.trim()) return;
    const backend = translationSessionKey();
    const transport = getTransport();
    return scheduler.subscribe(key, async () => {
      if (translationSessionKey() !== backend || useTranslationStore.getState().generation !== generation) throw new Error('Translation settings or connection changed. Retry translation.');
      const response = await transport.call<{ text: string }>('translate_text', { text, targetLanguage: target });
      return response.text;
    }, value => setResult({ key, value }));
  }, [key, target, visible, text, attempt]);
  const current = result?.key === key ? result.value : null;
  const translated = target && !original && current?.text;
  const display = translated || text;
  return <div ref={element}>
    {markdown ? <MarkdownRenderer text={display} /> : display}
    {target && <div className="translation-message-status" style={{ fontSize: '0.8em', opacity: 0.85, marginTop: 6 }}>
      {current?.text ? <button type="button" onClick={event => { event.stopPropagation(); setOriginal(value => !value); }}>{t(original ? 'translation_result' : 'translation_original')}</button> : current?.error ? <>
        <span title={current.error}>{t('translation_failed')}: {current.error}</span>{' '}
        <button type="button" onClick={event => { event.stopPropagation(); scheduler.forget(key); setResult(null); setAttempt(value => value + 1); }}>{t('translation_retry')}</button>
      </> : visible ? t('translation_translating') : null}
    </div>}
  </div>;
}
