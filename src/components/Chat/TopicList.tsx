import { useEffect, useState, useCallback, memo } from 'react';
import { invoke } from '../../transport';
import { ForumTopic } from '../../types/telegram';
import { useTranslation } from '../../i18n';
import './TopicList.css';

interface TopicListProps {
  accountId: string;
  chatId: number;
  onTopicClick: (topic: ForumTopic) => void;
}

// Topic icon colors from Telegram's palette
const TOPIC_COLORS: Record<number, string> = {
  0x6FB9F0: '#6FB9F0',
  0xFFD67E: '#FFD67E',
  0xCB86DB: '#CB86DB',
  0x8EEE98: '#8EEE98',
  0xFF93B2: '#FF93B2',
  0xFB6F5F: '#FB6F5F',
};

function getTopicColor(iconColor: number): string {
  return TOPIC_COLORS[iconColor] || `#${iconColor.toString(16).padStart(6, '0')}`;
}

const TopicItem = memo(({ topic, onClick }: { topic: ForumTopic; onClick: (topic: ForumTopic) => void }) => {
  const { t } = useTranslation();
  const handleClick = useCallback(() => onClick(topic), [onClick, topic]);

  return (
    <div className={`topic-item${topic.isClosed ? ' closed' : ''}`} onClick={handleClick}>
      <div className="topic-icon" style={{ backgroundColor: getTopicColor(topic.iconColor) }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
        </svg>
      </div>
      <div className="topic-info">
        <div className="topic-title-row">
          <span className="topic-title">{topic.title}</span>
          {topic.isPinned && <span className="topic-badge pinned">{t('topic_pinned')}</span>}
          {topic.isClosed && <span className="topic-badge closed">{t('topic_closed')}</span>}
        </div>
      </div>
      {topic.unreadCount > 0 && (
        <div className="topic-unread">{topic.unreadCount}</div>
      )}
    </div>
  );
});

export const TopicList = memo(({ accountId, chatId, onTopicClick }: TopicListProps) => {
  const { t } = useTranslation();
  const [topics, setTopics] = useState<ForumTopic[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    setError('');
    invoke<ForumTopic[]>('get_forum_topics', { accountId, chatId })
      .then((result) => {
        // Sort: pinned first, then by topMessage descending
        const sorted = result.sort((a, b) => {
          if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
          return b.topMessage - a.topMessage;
        });
        setTopics(sorted);
      })
      .catch((err) => {
        console.error('[TopicList] Failed to load topics:', err);
        setError(String(err));
      })
      .finally(() => setLoading(false));
  }, [accountId, chatId]);

  if (loading) {
    return (
      <div className="topic-list">
        <div className="topic-list-empty">{t('topics_loading')}</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="topic-list">
        <div className="topic-list-empty" style={{ color: 'var(--error-color)' }}>{error}</div>
      </div>
    );
  }

  if (topics.length === 0) {
    return (
      <div className="topic-list">
        <div className="topic-list-empty">{t('topics_empty')}</div>
      </div>
    );
  }

  return (
    <div className="topic-list">
      {topics.map((topic) => (
        <TopicItem key={topic.id} topic={topic} onClick={onTopicClick} />
      ))}
    </div>
  );
});
