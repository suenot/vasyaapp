/**
 * Hook that shows native OS notifications for incoming Telegram messages.
 *
 * Conditions for showing a notification:
 * - The message is NOT outgoing (i.e. it's from someone else)
 * - The message is NOT from the currently selected/visible chat
 * - The app window is NOT focused
 * - The chat is NOT muted (respects useMuteStore)
 *
 * Uses @tauri-apps/plugin-notification for native notifications.
 */
import { useCallback, useEffect, useRef } from 'react';
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useTauriEvent } from './useTauriEvent';
import { useMuteStore } from '../store/muteStore';
import { useSettingsStore } from '../store/settingsStore';

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
}

/**
 * @param selectedChatId - The chat ID currently visible to the user (null if none)
 */
export function useNotifications(selectedChatId: number | null) {
  const permissionGranted = useRef(false);
  const isMuted = useMuteStore((s) => s.isMuted);
  const notificationsEnabled = useSettingsStore((s) => s.notificationsEnabled);
  const notificationSound = useSettingsStore((s) => s.notificationSound);
  const messagePreview = useSettingsStore((s) => s.messagePreview);

  // Request notification permission on mount
  useEffect(() => {
    (async () => {
      let granted = await isPermissionGranted();
      if (!granted) {
        const permission = await requestPermission();
        granted = permission === 'granted';
      }
      permissionGranted.current = granted;
    })().catch((err) => {
      console.warn('[Notifications] Failed to check/request permission:', err);
    });
  }, []);

  // Use refs to always have the latest values in the callback
  const selectedChatIdRef = useRef(selectedChatId);
  selectedChatIdRef.current = selectedChatId;
  const notificationsEnabledRef = useRef(notificationsEnabled);
  notificationsEnabledRef.current = notificationsEnabled;
  const notificationSoundRef = useRef(notificationSound);
  notificationSoundRef.current = notificationSound;
  const messagePreviewRef = useRef(messagePreview);
  messagePreviewRef.current = messagePreview;

  const handleNewMessage = useCallback(async (evt: NewMessageEvent) => {
    // Master switch: notifications disabled in settings
    if (!notificationsEnabledRef.current) return;

    // Skip outgoing messages
    if (evt.isOutgoing) return;

    // Skip if the message is from the currently viewed chat
    if (evt.chatId === selectedChatIdRef.current) return;

    // Skip if chat is muted
    if (isMuted(evt.chatId)) return;

    // Skip if permission not granted
    if (!permissionGranted.current) return;

    // Skip if the app window is focused
    try {
      const appWindow = getCurrentWindow();
      const focused = await appWindow.isFocused();
      if (focused) return;
    } catch {
      // If we can't determine focus state, still show the notification
    }

    // Build notification content
    const title = evt.senderName || 'New message';
    let body: string;

    if (!messagePreviewRef.current) {
      // When message preview is disabled, hide the actual content
      body = 'New message';
    } else if (evt.text) {
      // Truncate long messages
      body = evt.text.length > 200 ? evt.text.slice(0, 200) + '...' : evt.text;
    } else if (evt.hasMedia) {
      const mediaLabels: Record<string, string> = {
        photo: 'Photo',
        video: 'Video',
        document: 'Document',
        audio: 'Audio',
        voice: 'Voice message',
        video_note: 'Video message',
        sticker: 'Sticker',
        animation: 'GIF',
      };
      body = mediaLabels[evt.mediaType || ''] || 'Media';
    } else {
      body = 'New message';
    }

    // When notification sound is disabled, send a silent notification
    sendNotification({ title, body, silent: !notificationSoundRef.current });
  }, [isMuted]);

  useTauriEvent<NewMessageEvent>('telegram:new-message', handleNewMessage);
}
