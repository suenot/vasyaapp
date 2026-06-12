// TypeScript типы для Telegram клиента

export interface UserInfo {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  phone: string;
}

export interface Chat {
  id: number;
  title: string;
  username?: string;
  unreadCount: number;
  chatType: 'user' | 'group' | 'channel';
  lastMessage?: string;
  avatarPath?: string;
  isForum?: boolean;
  isMuted?: boolean;
}

export interface ForumTopic {
  id: number;
  title: string;
  iconColor: number;
  iconEmojiId?: number;
  unreadCount: number;
  topMessage: number;
  isPinned: boolean;
  isClosed: boolean;
}

export interface MediaInfo {
  media_type: 'photo' | 'video' | 'audio' | 'voice' | 'document' | 'sticker' | 'videonote' | 'webpage' | 'other';
  file_path?: string;
  file_name?: string;
  file_size?: number;
  mime_type?: string;
  thumbnail_path?: string;
  // Link preview metadata (media_type === 'webpage')
  webpage_url?: string;
  webpage_site_name?: string;
  webpage_title?: string;
  webpage_description?: string;
}

export interface Message {
  id: number;
  chat_id: number;
  account_id: string;
  from_user_id?: number;
  sender_name?: string;
  text?: string;
  date: number;
  edit_date?: number;
  is_outgoing: boolean;
  reply_to_message_id?: number;
  has_media: boolean;
  media_type?: string;
  media_id?: string;
  media?: MediaInfo[];
}

export interface AccountInfo {
  id: string;
  phone: string;
  first_name?: string;
  last_name?: string;
  username?: string;
  is_authorized: boolean;
}

export interface GlobalSearchResult {
  id: number;
  title: string;
  username?: string;
  resultType: 'user' | 'group' | 'channel';
  subscribersCount?: number;
}

export interface GlobalMessageResult {
  messageId: number;
  chatId: number;
  chatTitle: string;
  senderName?: string;
  text?: string;
  date: number;
}

export type ChatFilter = 'all' | 'focus';
