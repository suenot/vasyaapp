import { useEffect, useRef, useState } from 'react';
import { invoke } from '../../transport';
import { Chat } from '../../types/telegram';
import { useTranslation } from '../../i18n';
import { parseFloodWait } from '../../utils/floodWait';

type Phase = 'confirm' | 'running' | 'done';
interface Failure { chat: Chat; reason: string }

interface Props {
  accountId: string;
  chats: Chat[];
  /** Called after each batch of successful leaves so the list updates live. */
  onLeft: (ids: number[]) => void;
  onClose: () => void;
}

const PAUSE_MS = 1000; // gentle pacing: Telegram throttles bursts of leaves
const MAX_FLOOD_RETRIES = 2;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const BulkLeaveDialog = ({ accountId, chats, onLeft, onClose }: Props) => {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>('confirm');
  const [done, setDone] = useState(0);
  const [current, setCurrent] = useState('');
  const [waitLeft, setWaitLeft] = useState(0);
  const [failures, setFailures] = useState<Failure[]>([]);
  const [leftCount, setLeftCount] = useState(0);
  const stop = useRef(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; stop.current = true; }, []);

  const run = async (list: Chat[]) => {
    stop.current = false;
    setPhase('running');
    setDone(0);
    setFailures([]);
    const failed: Failure[] = [];
    let ok = 0;
    for (let i = 0; i < list.length; i++) {
      if (stop.current) break;
      const chat = list[i];
      setCurrent(chat.title);
      let attempt = 0;
      for (;;) {
        try {
          await invoke('delete_and_leave_chat', { accountId, chatId: chat.id });
          ok++;
          onLeft([chat.id]);
          break;
        } catch (err) {
          const wait = parseFloodWait(err);
          if (wait != null && attempt < MAX_FLOOD_RETRIES && !stop.current) {
            attempt++;
            for (let s = wait + 1; s > 0 && !stop.current; s--) {
              if (mounted.current) setWaitLeft(s);
              await sleep(1000);
            }
            if (mounted.current) setWaitLeft(0);
            continue;
          }
          failed.push({ chat, reason: wait != null ? t('bulk_flood') : String(err).replace(/^Error:\s*/, '') });
          break;
        }
      }
      if (mounted.current) setDone(i + 1);
      if (i < list.length - 1 && !stop.current) await sleep(PAUSE_MS);
    }
    if (!mounted.current) return;
    setLeftCount((n) => n + ok);
    setFailures(failed);
    setPhase('done');
  };

  const preview = chats.slice(0, 5).map((c) => c.title).join(', ');
  const total = chats.length;

  return (
    <div className="confirm-dialog-overlay" onClick={phase === 'running' ? undefined : onClose}>
      <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
        {phase === 'confirm' && (
          <>
            <h3>{t('bulk_confirm_title', { n: String(total) })}</h3>
            <p>
              {preview}{total > 5 ? ` +${total - 5}` : ''}
              <br />
              {t('bulk_confirm_note')}
            </p>
            <div className="confirm-dialog-actions">
              <button className="confirm-dialog-btn cancel" onClick={onClose}>{t('cancel')}</button>
              <button className="confirm-dialog-btn danger" onClick={() => run(chats)}>
                {t('bulk_leave', { n: String(total) })}
              </button>
            </div>
          </>
        )}
        {phase === 'running' && (
          <>
            <h3>{t('bulk_running', { done: String(done), n: String(total) })}</h3>
            <div className="bulk-progress"><div style={{ width: `${(done / total) * 100}%` }} /></div>
            <p>
              {waitLeft > 0 ? t('bulk_waiting', { s: String(waitLeft) }) : current}
            </p>
            <div className="confirm-dialog-actions">
              <button className="confirm-dialog-btn cancel" onClick={() => { stop.current = true; }}>
                {t('bulk_stop')}
              </button>
            </div>
          </>
        )}
        {phase === 'done' && (
          <>
            <h3>{t('bulk_done', { ok: String(leftCount), n: String(total) })}</h3>
            {failures.length > 0 && (
              <ul className="bulk-failures">
                {failures.map((f) => (
                  <li key={f.chat.id}><b>{f.chat.title}</b>: {f.reason}</li>
                ))}
              </ul>
            )}
            <div className="confirm-dialog-actions">
              {failures.length > 0 && (
                <button className="confirm-dialog-btn danger" onClick={() => run(failures.map((f) => f.chat))}>
                  {t('bulk_retry', { n: String(failures.length) })}
                </button>
              )}
              <button className="confirm-dialog-btn cancel" onClick={onClose}>{t('bulk_close')}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
