import { useState, useEffect, useRef, useCallback, useImperativeHandle, forwardRef, memo, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { invoke } from '../../transport';
import { useMessagesStore, MessageBase } from '../../store/messagesStore';
import { useSelectionStore } from '../../store/selectionStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useTauriEvent } from '../../hooks/useTauriEvent';
import { useMergedMessages, MergedMessageGroup } from '../../hooks/useMergedMessages';
import { Message } from '../../types/telegram';
import { MediaAttachment } from './MediaAttachment';
import { MessageInput } from './MessageInput';
import { MessageContextMenu } from './MessageContextMenu';
import { SelectionBar } from './SelectionBar';
import { MarkdownRenderer, hasMarkdown } from './MarkdownRenderer';
import { ForwardDialog } from './ForwardDialog';
import { useTranslation } from '../../i18n';
import './MessageList.css';

interface MessageListProps {
  accountId: string;
  chatId: number;
  chatTitle: string;
  chatType?: 'user' | 'group' | 'channel';
  highlightedMessageId?: number | null;
  topicId?: number;
  onBackToTopics?: () => void;
}

export interface MessageListHandle {
  scrollToMessage: (messageId: number) => void;
}

// Media info from real-time events (no file_path — not downloaded yet)
interface MediaInfoEvent {
  mediaType: string;
  fileSize?: number;
  mimeType?: string;
}

// Event payload types matching Rust updates.rs (camelCase via serde rename_all)
interface NewMessageEvent {
  accountId: string;
  chatId: number;
  id: number;
  text: string | null;
  date: number;
  isOutgoing: boolean;
  fromUserId?: number;
  senderName?: string;
  hasMedia: boolean;
  mediaType?: string;
  media?: MediaInfoEvent[];
}

interface MessageDeletedEvent {
  accountId: string;
  chatId: number;
  messageIds: number[];
}

const formatTime = (timestamp: number) =>
  new Date(timestamp * 1000).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  });

// Local midnight (ms) for a unix-seconds timestamp — used to bucket messages by day.
const startOfDay = (timestamp: number) => {
  const d = new Date(timestamp * 1000);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

const isSameDay = (a: number, b: number) => startOfDay(a) === startOfDay(b);

// Telegram-style day divider label: Today / Yesterday / "10 June" / "10 June 2024".
const formatDaySeparator = (
  timestamp: number,
  language: string,
  todayLabel: string,
  yesterdayLabel: string,
): string => {
  const diffDays = Math.round((startOfDay(Date.now() / 1000) - startOfDay(timestamp)) / 86400000);
  if (diffDays === 0) return todayLabel;
  if (diffDays === 1) return yesterdayLabel;
  const d = new Date(timestamp * 1000);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(language === 'ru' ? 'ru-RU' : 'en-US', {
    day: 'numeric',
    month: 'long',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
};

// 8 sender colors for group chats (Telegram-style palette)
const SENDER_COLORS = [
  '#E17076', // red
  '#7BC862', // green
  '#E5CA77', // yellow
  '#65AADD', // blue
  '#A695E7', // purple
  '#EE7AE6', // pink
  '#6EC9CB', // cyan
  '#FAA774', // orange
];

function getSenderColor(userId: number): string {
  return SENDER_COLORS[Math.abs(userId) % SENDER_COLORS.length];
}

// Generate initials for avatar fallback
function getInitials(name?: string, userId?: number): string {
  if (name) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return name[0]?.toUpperCase() || '?';
  }
  if (userId) {
    return String.fromCharCode(65 + (Math.abs(userId) % 26));
  }
  return '?';
}

// Message grouping: messages from same sender within 3 minutes
const GROUP_TIME_THRESHOLD = 3 * 60; // seconds

interface GroupInfo {
  isFirstInGroup: boolean;
  isLastInGroup: boolean;
}

function computeGrouping(messages: MessageBase[]): GroupInfo[] {
  const result: GroupInfo[] = new Array(messages.length);
  for (let i = 0; i < messages.length; i++) {
    const curr = messages[i];
    const prev = i > 0 ? messages[i - 1] : null;
    const next = i < messages.length - 1 ? messages[i + 1] : null;

    const sameSenderAsPrev = prev
      && prev.is_outgoing === curr.is_outgoing
      && prev.from_user_id === curr.from_user_id
      && Math.abs(curr.date - prev.date) < GROUP_TIME_THRESHOLD;

    const sameSenderAsNext = next
      && next.is_outgoing === curr.is_outgoing
      && next.from_user_id === curr.from_user_id
      && Math.abs(next.date - curr.date) < GROUP_TIME_THRESHOLD;

    result[i] = {
      isFirstInGroup: !sameSenderAsPrev,
      isLastInGroup: !sameSenderAsNext,
    };
  }
  return result;
}

// Memoized message item — only re-renders when its own props change
const MessageItem = memo(({ message, accountId, chatId, isHighlighted, isGroupChat, isFirstInGroup, isLastInGroup, isSelected, isSelectionMode, renderMarkdown, onToggleSelect, onContextMenu }: {
  message: MessageBase;
  accountId: string;
  chatId: number;
  isHighlighted?: boolean;
  isGroupChat: boolean;
  // Grouping flags are passed as primitives (not a per-render object) so memo
  // does not break — a new message no longer re-renders the whole list.
  isFirstInGroup: boolean;
  isLastInGroup: boolean;
  isSelected: boolean;
  isSelectionMode: boolean;
  renderMarkdown: boolean;
  onToggleSelect: (id: number) => void;
  onContextMenu: (e: React.MouseEvent, message: MessageBase) => void;
}) => {
  const showSenderName = isGroupChat && !message.is_outgoing && isFirstInGroup && message.from_user_id;
  const showAvatar = isGroupChat && !message.is_outgoing && isLastInGroup;
  const senderColor = message.from_user_id ? getSenderColor(message.from_user_id) : SENDER_COLORS[0];

  // Build bubble corner class
  let cornerClass = '';
  if (message.is_outgoing) {
    if (isFirstInGroup && isLastInGroup) cornerClass = 'bubble-single-out';
    else if (isFirstInGroup) cornerClass = 'bubble-first-out';
    else if (isLastInGroup) cornerClass = 'bubble-last-out';
    else cornerClass = 'bubble-mid-out';
  } else {
    if (isFirstInGroup && isLastInGroup) cornerClass = 'bubble-single-in';
    else if (isFirstInGroup) cornerClass = 'bubble-first-in';
    else if (isLastInGroup) cornerClass = 'bubble-last-in';
    else cornerClass = 'bubble-mid-in';
  }

  const groupSpacingClass = isFirstInGroup ? 'group-start' : 'group-continue';

  const handleClick = (e: React.MouseEvent) => {
    // Modifier clicks are handled at the container level (mousedown)
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    if (isSelectionMode) {
      onToggleSelect(message.id);
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    onContextMenu(e, message);
  };

  return (
    <div
      className={`message ${message.is_outgoing ? 'outgoing' : 'incoming'} ${groupSpacingClass}${isHighlighted ? ' highlighted' : ''}${isSelected ? ' selected' : ''}${isSelectionMode ? ' selection-mode' : ''}`}
      data-message-id={message.id}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
    >
      {/* Avatar column for incoming group messages */}
      {isGroupChat && !message.is_outgoing && (
        <div className="message-avatar-col">
          {showAvatar && message.from_user_id ? (
            <div className="message-avatar" style={{ backgroundColor: senderColor }}>
              {getInitials(message.sender_name, message.from_user_id)}
            </div>
          ) : (
            <div className="message-avatar-spacer" />
          )}
        </div>
      )}

      <div className="message-content">
        {/* Sender name for group chats */}
        {showSenderName && (
          <div className="message-sender-name" style={{ color: senderColor }}>
            {message.sender_name || `User ${message.from_user_id}`}
          </div>
        )}

        {message.media && message.media.length > 0 && (
          <div className={`message-media-standalone ${cornerClass}`}>
            {message.media.map((media: any, index: number) => (
              <MediaAttachment
                key={index}
                media={media}
                accountId={accountId}
                chatId={chatId}
                messageId={message.id}
                messageText={message.text}
              />
            ))}
          </div>
        )}

        {message.text && (
          <div className={`message-bubble ${cornerClass}`}>
            <div className="message-text">
              {renderMarkdown ? <MarkdownRenderer text={message.text} /> : message.text}
            </div>
            <div className="message-meta">
              <span className="message-time">{formatTime(message.date)}</span>
              {message.is_outgoing && (
                <span className="message-status">
                  {message._status === 'sending' ? (
                    <svg className="status-icon" viewBox="0 0 16 16" width="16" height="16">
                      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="25" strokeDashoffset="8">
                        <animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="1s" repeatCount="indefinite"/>
                      </circle>
                    </svg>
                  ) : message._status === 'failed' ? (
                    <span className="status-failed">!</span>
                  ) : (
                    <svg className="status-icon status-sent" viewBox="0 0 16 11" width="16" height="11">
                      <path d="M11.5 0.5L4.5 7.5L1.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                      <path d="M14.5 0.5L7.5 7.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.5"/>
                    </svg>
                  )}
                </span>
              )}
            </div>
          </div>
        )}

        {!message.text && message.media && message.media.length > 0 && (
          <div className="message-meta-standalone">{formatTime(message.date)}</div>
        )}

        {!message.text && (!message.media || message.media.length === 0) && (
          <div className={`message-bubble ${cornerClass}`}>
            <div className="message-text text-muted">(empty message)</div>
            <div className="message-meta">
              <span className="message-time">{formatTime(message.date)}</span>
            </div>
          </div>
        )}
      </div>

      {/* Selection checkbox (right side) */}
      {isSelectionMode && (
        <div className="message-checkbox-col">
          <div className={`message-checkbox ${isSelected ? 'checked' : ''}`}>
            {isSelected && (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

// Memoized merged message item — renders a group of merged messages as one bubble
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const MergedMessageItem = memo(({ group, accountId: _aid, chatId: _cid, isHighlighted, isGroupChat, isFirstInGroup, isLastInGroup, isSelected, isSelectionMode, renderMarkdown, onToggleSelect, onContextMenu }: {
  group: MergedMessageGroup;
  accountId: string;
  chatId: number;
  isHighlighted?: boolean;
  isGroupChat: boolean;
  isFirstInGroup: boolean;
  isLastInGroup: boolean;
  isSelected: boolean;
  isSelectionMode: boolean;
  renderMarkdown: boolean;
  onToggleSelect: (id: number) => void;
  onContextMenu: (e: React.MouseEvent, message: MessageBase) => void;
}) => {
  const [expanded, setExpanded] = useState(false);
  const message = group.display;
  const mergeCount = group.messages.length;
  const showSenderName = isGroupChat && !message.is_outgoing && isFirstInGroup && message.from_user_id;
  const showAvatar = isGroupChat && !message.is_outgoing && isLastInGroup;
  const senderColor = message.from_user_id ? getSenderColor(message.from_user_id) : SENDER_COLORS[0];

  let cornerClass = '';
  if (message.is_outgoing) {
    if (isFirstInGroup && isLastInGroup) cornerClass = 'bubble-single-out';
    else if (isFirstInGroup) cornerClass = 'bubble-first-out';
    else if (isLastInGroup) cornerClass = 'bubble-last-out';
    else cornerClass = 'bubble-mid-out';
  } else {
    if (isFirstInGroup && isLastInGroup) cornerClass = 'bubble-single-in';
    else if (isFirstInGroup) cornerClass = 'bubble-first-in';
    else if (isLastInGroup) cornerClass = 'bubble-last-in';
    else cornerClass = 'bubble-mid-in';
  }

  const groupSpacingClass = isFirstInGroup ? 'group-start' : 'group-continue';

  const handleClick = (e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    if (isSelectionMode) {
      // In selection mode, toggle all messages in the group
      for (const m of group.messages) {
        onToggleSelect(m.id);
      }
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    // Context menu uses the first message but with merged text
    onContextMenu(e, { ...message, text: group.mergedText });
  };

  const handleToggleExpanded = (e: React.MouseEvent) => {
    e.stopPropagation();
    setExpanded(!expanded);
  };

  return (
    <div
      className={`message ${message.is_outgoing ? 'outgoing' : 'incoming'} ${groupSpacingClass}${isHighlighted ? ' highlighted' : ''}${isSelected ? ' selected' : ''}${isSelectionMode ? ' selection-mode' : ''}`}
      data-message-id={message.id}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
    >
      {isGroupChat && !message.is_outgoing && (
        <div className="message-avatar-col">
          {showAvatar && message.from_user_id ? (
            <div className="message-avatar" style={{ backgroundColor: senderColor }}>
              {getInitials(message.sender_name, message.from_user_id)}
            </div>
          ) : (
            <div className="message-avatar-spacer" />
          )}
        </div>
      )}

      <div className="message-content">
        {showSenderName && (
          <div className="message-sender-name" style={{ color: senderColor }}>
            {message.sender_name || `User ${message.from_user_id}`}
          </div>
        )}

        <div className={`message-bubble ${cornerClass}`}>
          {expanded ? (
            <div className="merged-expanded">
              {group.messages.map((m, i) => (
                <div key={m.id} className="merged-expanded-part">
                  <div className="message-text">
                    {renderMarkdown && m.text ? <MarkdownRenderer text={m.text} /> : m.text}
                  </div>
                  {i < group.messages.length - 1 && <div className="merged-separator" />}
                </div>
              ))}
            </div>
          ) : (
            <div className="message-text">
              {renderMarkdown ? <MarkdownRenderer text={group.mergedText} /> : group.mergedText}
            </div>
          )}
          <div className="message-meta">
            <span
              className="merged-indicator"
              title={`Merged ${mergeCount} messages`}
              onClick={handleToggleExpanded}
            >
              <span className="merged-dot" />
              <span className="merged-count">{mergeCount}</span>
            </span>
            <span className="message-time">{formatTime(message.date)}</span>
            {message.is_outgoing && (
              <span className="message-status">
                {message._status === 'sending' ? (
                  <svg className="status-icon" viewBox="0 0 16 16" width="16" height="16">
                    <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="25" strokeDashoffset="8">
                      <animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="1s" repeatCount="indefinite"/>
                    </circle>
                  </svg>
                ) : message._status === 'failed' ? (
                  <span className="status-failed">!</span>
                ) : (
                  <svg className="status-icon status-sent" viewBox="0 0 16 11" width="16" height="11">
                    <path d="M11.5 0.5L4.5 7.5L1.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    <path d="M14.5 0.5L7.5 7.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.5"/>
                  </svg>
                )}
              </span>
            )}
          </div>
        </div>
      </div>

      {isSelectionMode && (
        <div className="message-checkbox-col">
          <div className={`message-checkbox ${isSelected ? 'checked' : ''}`}>
            {isSelected && (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

// Stable empty array — prevents Zustand from scheduling re-renders
// when messagesByChat[chatId] is undefined (Object.is([], []) === false)
const EMPTY_MESSAGES: any[] = [];

// Context menu state
interface ContextMenuState {
  x: number;
  y: number;
  message: MessageBase;
}

export const MessageList = forwardRef<MessageListHandle, MessageListProps>(({ accountId, chatId, chatTitle, chatType, highlightedMessageId, topicId, onBackToTopics }, ref) => {
  const messages = useMessagesStore((s) => s.messagesByChat[chatId] ?? EMPTY_MESSAGES);
  const mergeEnabled = useSettingsStore((s) => s.mergeMessages);
  const mergedGroups = useMergedMessages(messages, mergeEnabled);
  const { t, language } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const pendingScrollRef = useRef<number | null>(null);

  // Latest groups accessible from stable callbacks without re-creating them.
  const mergedGroupsRef = useRef(mergedGroups);
  mergedGroupsRef.current = mergedGroups;

  // Virtualize the message list: only on-screen bubbles are in the DOM.
  // Heights vary wildly (text/media/voice/merged/markdown) so each row is
  // measured (measureElement); the estimate only seeds the initial scrollbar.
  const rowVirtualizer = useVirtualizer({
    count: mergedGroups.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => 72,
    overscan: 6,
    getItemKey: (index) => {
      const g = mergedGroups[index];
      return g.messages.length > 1 ? `merged-${g.display.id}` : g.display.id;
    },
  });

  // Scroll to the newest message (bottom of the list).
  const scrollToBottom = useCallback((behavior: 'auto' | 'smooth' = 'auto') => {
    const count = mergedGroupsRef.current.length;
    if (count === 0) return;
    rowVirtualizer.scrollToIndex(count - 1, { align: 'end', behavior });
  }, [rowVirtualizer]);

  // When prepending older history, remember the previously-top message id so we
  // can restore the scroll anchor once the list grows (avoids a jump).
  const prependAnchorRef = useRef<number | null>(null);

  const isGroupChat = chatType === 'group';

  // Selection state
  const isSelectionMode = useSelectionStore((s) => s.isSelectionMode);
  const selectedIds = useSelectionStore((s) => s.selectedMessageIds);
  const lastSelectedId = useSelectionStore((s) => s.lastSelectedId);
  const toggleMessage = useSelectionStore((s) => s.toggleMessage);
  const selectMessage = useSelectionStore((s) => s.selectMessage);
  const enterSelectionMode = useSelectionStore((s) => s.enterSelectionMode);
  const exitSelectionMode = useSelectionStore((s) => s.exitSelectionMode);
  const selectRange = useSelectionStore((s) => s.selectRange);

  // Drag selection state
  const isDraggingRef = useRef(false);
  const dragSelectedIdsRef = useRef<Set<number>>(new Set());

  // Context menu state
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  // Forward dialog state
  const [forwardMessageIds, setForwardMessageIds] = useState<number[] | null>(null);

  // Markdown rendering state
  const markdownMode = useSettingsStore((s) => s.markdownMode);
  // Per-message overrides: messageId -> true (force render) | false (force plain)
  const [markdownOverrides, setMarkdownOverrides] = useState<Record<number, boolean>>({});

  const handleToggleMarkdown = useCallback((messageId: number) => {
    setMarkdownOverrides((prev) => {
      const current = prev[messageId];
      if (current === undefined) {
        // No override yet — toggle opposite of global mode
        return { ...prev, [messageId]: markdownMode !== 'rendered' };
      }
      // Remove override (revert to global)
      const { [messageId]: _, ...rest } = prev;
      return rest;
    });
  }, [markdownMode]);

  // Determine if a specific message should render markdown
  const shouldRenderMarkdown = useCallback((messageId: number, text?: string): boolean => {
    if (!text || !hasMarkdown(text)) return false;
    const override = markdownOverrides[messageId];
    if (override !== undefined) return override;
    return markdownMode === 'rendered';
  }, [markdownMode, markdownOverrides]);

  // Exit selection mode when switching chats
  useEffect(() => {
    exitSelectionMode();
  }, [chatId, exitSelectionMode]);

  // Helper: find message ID from a DOM element at coordinates
  const getMessageIdFromPoint = useCallback((x: number, y: number): number | null => {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    const messageEl = (el as HTMLElement).closest('[data-message-id]');
    if (!messageEl) return null;
    const id = Number(messageEl.getAttribute('data-message-id'));
    return isNaN(id) ? null : id;
  }, []);

  // Drag selection: mousedown on a message starts drag
  const handleContainerMouseDown = useCallback((e: React.MouseEvent) => {
    // Only left mouse button, ignore if target is interactive
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('a, button, input, textarea, video, audio')) return;

    const messageId = getMessageIdFromPoint(e.clientX, e.clientY);
    if (messageId === null) return;

    // Cmd/Ctrl+Click: toggle single message
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      if (!isSelectionMode) {
        enterSelectionMode(messageId);
      } else {
        toggleMessage(messageId);
      }
      return;
    }

    // Shift+Click: range select
    if (e.shiftKey) {
      e.preventDefault();
      const orderedIds = messages.map((m) => m.id);
      if (!isSelectionMode) {
        enterSelectionMode(messageId);
      } else if (lastSelectedId !== null) {
        selectRange(orderedIds, lastSelectedId, messageId);
      } else {
        selectMessage(messageId);
      }
      return;
    }

    // Plain mousedown: start drag selection (only if already in selection mode
    // or will enter on drag). We start tracking but only commit on move.
    isDraggingRef.current = true;
    dragSelectedIdsRef.current = new Set();
    dragSelectedIdsRef.current.add(messageId);

    // Add container class to prevent text selection during drag
    containerRef.current?.classList.add('dragging-selection');
  }, [isSelectionMode, lastSelectedId, messages, getMessageIdFromPoint, enterSelectionMode, toggleMessage, selectMessage, selectRange]);

  // Drag selection: mousemove adds messages under cursor
  const handleContainerMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDraggingRef.current) return;
    const messageId = getMessageIdFromPoint(e.clientX, e.clientY);
    if (messageId === null) return;

    if (!dragSelectedIdsRef.current.has(messageId)) {
      dragSelectedIdsRef.current.add(messageId);

      // Enter selection mode on first drag over a second message
      if (!isSelectionMode && dragSelectedIdsRef.current.size >= 2) {
        // Enter with all dragged IDs
        const store = useSelectionStore.getState();
        store.enterSelectionMode();
        for (const id of dragSelectedIdsRef.current) {
          store.selectMessage(id);
        }
      } else if (isSelectionMode) {
        selectMessage(messageId);
      }
    }
  }, [isSelectionMode, getMessageIdFromPoint, selectMessage]);

  // Drag selection: mouseup ends drag
  useEffect(() => {
    const handleMouseUp = () => {
      if (!isDraggingRef.current) return;
      isDraggingRef.current = false;
      containerRef.current?.classList.remove('dragging-selection');

      // If we only clicked one message without dragging and we're in selection mode,
      // the normal click handler in MessageItem will handle toggling.
      // If we dragged and entered selection mode, the messages are already selected.
      dragSelectedIdsRef.current = new Set();
    };

    window.addEventListener('mouseup', handleMouseUp);
    return () => window.removeEventListener('mouseup', handleMouseUp);
  }, []);

  // Ctrl+C: copy selected messages text
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Escape exits selection mode
      if (e.key === 'Escape' && isSelectionMode) {
        exitSelectionMode();
        return;
      }

      // Ctrl+C / Cmd+C copies selected messages
      if ((e.ctrlKey || e.metaKey) && e.key === 'c' && isSelectionMode && selectedIds.size > 0) {
        e.preventDefault();
        const selectedMessages = messages
          .filter((m) => selectedIds.has(m.id))
          .sort((a, b) => a.date - b.date);

        const text = selectedMessages
          .map((m) => {
            const name = m.sender_name || (m.is_outgoing ? 'You' : `User ${m.from_user_id || ''}`);
            const time = formatTime(m.date);
            return `[${time}] ${name}: ${m.text || '(media)'}`;
          })
          .join('\n');

        navigator.clipboard.writeText(text);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isSelectionMode, selectedIds, messages, exitSelectionMode]);

  // Context menu handlers
  const handleContextMenu = useCallback((e: React.MouseEvent, message: MessageBase) => {
    setContextMenu({ x: e.clientX, y: e.clientY, message });
  }, []);

  const handleCloseContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const handleContextReply = useCallback((_messageId: number) => {
    // TODO: implement reply
    console.log('Reply to message:', _messageId);
  }, []);

  const handleContextForward = useCallback((messageId: number) => {
    setForwardMessageIds([messageId]);
  }, []);

  const handleContextSelect = useCallback((messageId: number) => {
    enterSelectionMode(messageId);
  }, [enterSelectionMode]);

  const handleContextDelete = useCallback((_messageId: number) => {
    // TODO: implement delete
    console.log('Delete message:', _messageId);
  }, []);

  const handleContextPin = useCallback((_messageId: number) => {
    // TODO: implement pin
    console.log('Pin message:', _messageId);
  }, []);

  const handleContextEdit = useCallback((_messageId: number) => {
    // TODO: implement edit
    console.log('Edit message:', _messageId);
  }, []);

  const handleContextCopyText = useCallback((text: string) => {
    navigator.clipboard.writeText(text);
  }, []);

  // Selection bar handlers
  const handleSelectionCopy = useCallback((ids: number[]) => {
    const selected = messages
      .filter((m) => ids.includes(m.id))
      .sort((a, b) => a.date - b.date);
    const text = selected
      .map((m) => {
        const name = m.sender_name || (m.is_outgoing ? 'You' : `User ${m.from_user_id || ''}`);
        const time = formatTime(m.date);
        return `[${time}] ${name}: ${m.text || '(media)'}`;
      })
      .join('\n');
    navigator.clipboard.writeText(text);
    exitSelectionMode();
  }, [messages, exitSelectionMode]);

  const handleSelectionForward = useCallback((ids: number[]) => {
    setForwardMessageIds(ids);
    exitSelectionMode();
  }, [exitSelectionMode]);

  const handleSelectionDelete = useCallback((_ids: number[]) => {
    // TODO: implement bulk delete
    console.log('Delete messages:', _ids);
    exitSelectionMode();
  }, [exitSelectionMode]);

  // Compute grouping info based on merged groups (use display messages for grouping)
  const displayMessages = useMemo(() => mergedGroups.map((g) => g.display), [mergedGroups]);
  const groupInfos = useMemo(() => computeGrouping(displayMessages), [displayMessages]);

  // Expose scrollToMessage to parent
  useImperativeHandle(ref, () => ({
    scrollToMessage: (messageId: number) => {
      // If the message is already loaded, scroll its virtualized row into view.
      const idx = mergedGroupsRef.current.findIndex((g) => g.messages.some((m) => m.id === messageId));
      if (idx >= 0) {
        rowVirtualizer.scrollToIndex(idx, { align: 'center' });
        return;
      }
      // Not loaded — fetch messages around this ID; the pending effect scrolls.
      pendingScrollRef.current = messageId;
      invoke<Message[]>('get_messages', {
        accountId,
        chatId,
        offsetId: messageId + 1,
        limit: 50,
        topicId,
      }).then((fetched) => {
        if (fetched.length > 0) {
          useMessagesStore.getState().setMessages(chatId, fetched.reverse());
          useMessagesStore.getState().setHasMore(chatId, true);
        }
      }).catch((err) => {
        console.error('[MessageList] Failed to load messages for search:', err);
        pendingScrollRef.current = null;
      });
    },
  }), [accountId, chatId, topicId, rowVirtualizer]);

  // Scroll to a pending target (search jump) once its message is loaded.
  useEffect(() => {
    if (pendingScrollRef.current == null) return;
    const targetId = pendingScrollRef.current;
    const idx = mergedGroups.findIndex((g) => g.messages.some((m) => m.id === targetId));
    if (idx >= 0) {
      pendingScrollRef.current = null;
      requestAnimationFrame(() => rowVirtualizer.scrollToIndex(idx, { align: 'center' }));
    }
  }, [messages, mergedGroups, rowVirtualizer]);

  // After prepending older history, restore the scroll anchor to the message
  // that was at the top before the prepend.
  useEffect(() => {
    if (prependAnchorRef.current == null) return;
    const anchorId = prependAnchorRef.current;
    prependAnchorRef.current = null;
    const idx = mergedGroups.findIndex((g) => g.messages.some((m) => m.id === anchorId));
    if (idx >= 0) {
      rowVirtualizer.scrollToIndex(idx, { align: 'start' });
    }
  }, [mergedGroups, rowVirtualizer]);

  const hasMore = useMessagesStore((s) => s.hasMoreByChat[chatId] ?? true);
  const setMessages = useMessagesStore((s) => s.setMessages);
  const prependMessages = useMessagesStore((s) => s.prependMessages);
  const addMessage = useMessagesStore((s) => s.addMessage);
  const removeMessage = useMessagesStore((s) => s.removeMessage);
  const setHasMore = useMessagesStore((s) => s.setHasMore);

  const loadingRef = useRef(false);
  const loadingMoreRef = useRef(false);
  const initialLoadDone = useRef(false);

  // Load initial messages
  useEffect(() => {
    // Reset state for new chat
    initialLoadDone.current = false;
    loadingRef.current = true;
    prevMessagesLength.current = 0; // Reset length tracker so it triggers auto-scroll on load


    const load = async () => {
      try {
        const fetched = await invoke<Message[]>('get_messages', {
          accountId,
          chatId,
          limit: 50,
          topicId,
        });
        setMessages(chatId, fetched.reverse());
        setHasMore(chatId, fetched.length === 50);

        // Mark messages as read after loading (send read acknowledgement to Telegram)
        if (fetched.length > 0) {
          const maxId = Math.max(...fetched.map((m) => m.id));
          invoke('mark_messages_read', {
            accountId,
            chatId,
            maxId,
          }).catch((err: unknown) => {
            console.error('[MessageList] Failed to mark as read on load:', err);
          });
        }
      } catch (err) {
        console.error('[MessageList] Failed to load messages:', err);
      } finally {
        loadingRef.current = false;
        initialLoadDone.current = true;
        // Force scroll to bottom after initial load, regardless of useEffect race conditions
        setTimeout(() => {
          scrollToBottom('auto');
          prevMessagesLength.current = useMessagesStore.getState().messagesByChat[chatId]?.length || 0;
        }, 50);
      }
    };

    load();
  }, [chatId, accountId, setMessages, setHasMore, scrollToBottom]);

  // Scroll to bottom only on initial load (not on prepend)
  const prevMessagesLength = useRef(0);
  useEffect(() => {
    if (!initialLoadDone.current) return;

    // Only auto-scroll when it's the initial load for this chat
    // (length went from 0 to N) — NOT on prepend (length grows at start)
    // Also scroll if we were waiting for initial load and now we have messages
    if (prevMessagesLength.current === 0 && messages.length > 0) {
      // Use setTimeout to ensure DOM is fully painted
      setTimeout(() => {
        scrollToBottom('auto');
      }, 0);
    }
    prevMessagesLength.current = messages.length;
  }, [messages.length, scrollToBottom]);

  // Real-time: new message
  useTauriEvent<NewMessageEvent>('telegram:new-message', useCallback((evt) => {
    if (evt.chatId !== chatId) return;
    // Decide whether to follow the bottom BEFORE the new message grows the list:
    // only auto-scroll if it's our own message or the user is already near the
    // bottom — otherwise reading older history is no longer interrupted.
    const c = containerRef.current;
    const nearBottom = c ? c.scrollHeight - c.scrollTop - c.clientHeight < 150 : true;
    // Convert event media info to the format expected by the store
    const media = evt.media?.map((m) => ({
      media_type: m.mediaType as any,
      file_size: m.fileSize,
      mime_type: m.mimeType,
    }));
    addMessage(chatId, {
      id: evt.id,
      chat_id: evt.chatId,
      from_user_id: evt.fromUserId,
      sender_name: evt.senderName || undefined,
      text: evt.text || undefined,
      date: evt.date,
      is_outgoing: evt.isOutgoing,
      media,
    });
    if (evt.isOutgoing || nearBottom) {
      setTimeout(() => scrollToBottom('smooth'), 50);
    }

    // Auto-mark incoming messages as read since the user is viewing this chat
    if (!evt.isOutgoing) {
      invoke('mark_messages_read', {
        accountId,
        chatId,
        maxId: evt.id,
      }).catch((err: unknown) => {
        console.error('[MessageList] Failed to auto-mark as read:', err);
      });
    }
  }, [chatId, accountId, addMessage, scrollToBottom]));

  // Real-time: message deleted
  useTauriEvent<MessageDeletedEvent>('telegram:message-deleted', useCallback((evt) => {
    if (evt.chatId !== chatId) return;
    for (const id of evt.messageIds) {
      removeMessage(chatId, id);
    }
  }, [chatId, removeMessage]));

  // Load older messages on scroll to top
  const handleScroll = useCallback(async (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    if (target.scrollTop > 0 || !hasMore || loadingMoreRef.current || messages.length === 0) return;

    loadingMoreRef.current = true;
    try {
      const oldest = messages[0];
      const older = await invoke<Message[]>('get_messages', {
        accountId,
        chatId,
        offsetId: oldest.id,
        limit: 50,
        topicId,
      });
      if (older.length === 0) {
        setHasMore(chatId, false);
      } else {
        // Remember the current top message so the virtualizer can restore the
        // scroll anchor after the prepended rows grow the list.
        prependAnchorRef.current = oldest.id;
        prependMessages(chatId, older.reverse());
        setHasMore(chatId, older.length === 50);
      }
    } catch (err) {
      console.error('[MessageList] Failed to load more:', err);
    } finally {
      loadingMoreRef.current = false;
    }
  }, [hasMore, messages, accountId, chatId, prependMessages, setHasMore]);

  // Callback for MessageInput
  const handleMessageSent = useCallback((newMessage: Message) => {
    addMessage(chatId, newMessage);
    setTimeout(() => scrollToBottom('smooth'), 100);
  }, [chatId, addMessage, scrollToBottom]);

  return (
    <div className="messages-wrapper">
      {onBackToTopics && (
        <button className="back-to-topics" onClick={onBackToTopics}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6"></polyline>
          </svg>
          {chatTitle}
        </button>
      )}
      <div
        className="messages-container"
        ref={containerRef}
        onScroll={handleScroll}
        onMouseDown={handleContainerMouseDown}
        onMouseMove={handleContainerMouseMove}
      >
        {loadingRef.current && messages.length === 0 ? (
          <div className="messages-loading"><p>Loading messages...</p></div>
        ) : messages.length === 0 ? (
          <div className="messages-empty"><p>No messages in {chatTitle}</p></div>
        ) : (
          <div
            className="messages-list"
            style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: 'relative', width: '100%' }}
          >
            {rowVirtualizer.getVirtualItems().map((vi) => {
              const group = mergedGroups[vi.index];
              const index = vi.index;
              const isMerged = group.messages.length > 1;
              const message = group.display;
              // For merged groups, consider selected if ANY constituent is selected
              const isGroupSelected = isMerged
                ? group.messages.some((m) => selectedIds.has(m.id))
                : selectedIds.has(message.id);
              const isGroupHighlighted = isMerged
                ? group.messages.some((m) => highlightedMessageId === m.id)
                : highlightedMessageId === message.id;
              // Day divider above the first message of each calendar day.
              const prevGroup = index > 0 ? mergedGroups[index - 1] : null;
              const showDaySeparator = !prevGroup || !isSameDay(prevGroup.display.date, message.date);

              return (
                <div
                  key={vi.key}
                  data-index={index}
                  ref={rowVirtualizer.measureElement}
                  // flow-root contains the bubbles' margins so measureElement
                  // captures the full row height (incl. group spacing).
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${vi.start}px)`,
                    display: 'flow-root',
                  }}
                >
                  {showDaySeparator && (
                    <div className="day-separator">
                      <span>{formatDaySeparator(message.date, language, t('today'), t('yesterday'))}</span>
                    </div>
                  )}
                  {isMerged ? (
                    <MergedMessageItem
                      group={group}
                      accountId={accountId}
                      chatId={chatId}
                      isHighlighted={isGroupHighlighted}
                      isGroupChat={isGroupChat}
                      isFirstInGroup={groupInfos[index].isFirstInGroup}
                      isLastInGroup={groupInfos[index].isLastInGroup}
                      isSelected={isGroupSelected}
                      isSelectionMode={isSelectionMode}
                      renderMarkdown={shouldRenderMarkdown(message.id, group.mergedText)}
                      onToggleSelect={toggleMessage}
                      onContextMenu={handleContextMenu}
                    />
                  ) : (
                    <MessageItem
                      message={message}
                      accountId={accountId}
                      chatId={chatId}
                      isHighlighted={isGroupHighlighted}
                      isGroupChat={isGroupChat}
                      isFirstInGroup={groupInfos[index].isFirstInGroup}
                      isLastInGroup={groupInfos[index].isLastInGroup}
                      isSelected={isGroupSelected}
                      isSelectionMode={isSelectionMode}
                      renderMarkdown={shouldRenderMarkdown(message.id, message.text)}
                      onToggleSelect={toggleMessage}
                      onContextMenu={handleContextMenu}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Selection bar replaces input when in selection mode */}
      {isSelectionMode ? (
        <SelectionBar
          onCopy={handleSelectionCopy}
          onForward={handleSelectionForward}
          onDelete={handleSelectionDelete}
        />
      ) : (
        <MessageInput
          accountId={accountId}
          chatId={chatId}
          topicId={topicId}
          onMessageSent={handleMessageSent}
        />
      )}

      {/* Context menu */}
      {contextMenu && (
        <MessageContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          messageId={contextMenu.message.id}
          messageText={contextMenu.message.text}
          isOutgoing={contextMenu.message.is_outgoing}
          hasMedia={!!(contextMenu.message.media && contextMenu.message.media.length > 0)}
          isMarkdownRendered={shouldRenderMarkdown(contextMenu.message.id, contextMenu.message.text)}
          hasMarkdownContent={!!(contextMenu.message.text && hasMarkdown(contextMenu.message.text))}
          onClose={handleCloseContextMenu}
          onReply={handleContextReply}
          onForward={handleContextForward}
          onSelect={handleContextSelect}
          onDelete={handleContextDelete}
          onPin={handleContextPin}
          onEdit={handleContextEdit}
          onCopyText={handleContextCopyText}
          onToggleMarkdown={handleToggleMarkdown}
        />
      )}

      {forwardMessageIds && (
        <ForwardDialog
          accountId={accountId}
          fromChatId={chatId}
          messageIds={forwardMessageIds}
          onClose={() => setForwardMessageIds(null)}
        />
      )}
    </div>
  );
});
