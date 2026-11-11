import { Chat } from '../../types/telegram';
import { useTranslation } from '../../i18n';
import { useChatSelectionStore, isBulkLeavable } from '../../store/chatSelectionStore';

interface Props {
  /** Chats currently shown (current folder + search), in list order. */
  visibleChats: Chat[];
  onLeave: () => void;
}

export const BulkLeaveBar = ({ visibleChats, onLeave }: Props) => {
  const { t } = useTranslation();
  const count = useChatSelectionStore((s) => s.ids.size);
  const { exit, selectMany, clear } = useChatSelectionStore.getState();
  const channels = visibleChats.filter((c) => c.chatType === 'channel');
  const leavable = visibleChats.filter((c) => isBulkLeavable(c.chatType));

  return (
    <div className="bulk-bar">
      <div className="bulk-bar-top">
        <span className="bulk-bar-count">{t('bulk_selected', { n: String(count) })}</span>
        <button className="bulk-bar-link" onClick={exit}>{t('cancel')}</button>
      </div>
      <div className="bulk-bar-actions">
        <button className="bulk-bar-chip" disabled={channels.length === 0} onClick={() => selectMany(channels.map((c) => c.id))}>
          {t('bulk_all_channels', { n: String(channels.length) })}
        </button>
        <button className="bulk-bar-chip" disabled={leavable.length === 0} onClick={() => selectMany(leavable.map((c) => c.id))}>
          {t('bulk_all_groups_channels', { n: String(leavable.length) })}
        </button>
        <button className="bulk-bar-chip" disabled={count === 0} onClick={clear}>{t('bulk_clear')}</button>
      </div>
      <button className="bulk-bar-leave" disabled={count === 0} onClick={onLeave}>
        {t('bulk_leave', { n: String(count) })}
      </button>
    </div>
  );
};
