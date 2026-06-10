import { useState, useCallback, useRef, useEffect, KeyboardEvent, ClipboardEvent, DragEvent } from 'react';
import { invoke, sendMedia } from '../../transport';
import { readImage } from '@tauri-apps/plugin-clipboard-manager';
import { useMessagesStore } from '../../store/messagesStore';
import { Message } from '../../types/telegram';
import { useTranslation } from '../../i18n';
import { VoiceRecorder } from './VoiceRecorder';
import { AttachmentMenu } from './AttachmentMenu';
import { CameraCapture } from './CameraCapture';
import './MessageInput.css';

interface MessageInputProps {
  accountId: string;
  chatId: number;
  topicId?: number;
  onMessageSent?: (message: Message) => void;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const MessageInput = ({ accountId, chatId, topicId, onMessageSent }: MessageInputProps) => {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [mediaPreview, setMediaPreview] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // When virtual keyboard opens on mobile, scroll messages to bottom after layout adjusts
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const handleResize = () => {
      // Scroll the nearest scrollable ancestor (.messages-container) to bottom
      const wrapper = textareaRef.current?.closest('.content');
      const container = wrapper?.querySelector('.messages-container');
      if (container) {
        requestAnimationFrame(() => {
          container.scrollTop = container.scrollHeight;
        });
      }
    };
    vv.addEventListener('resize', handleResize);
    return () => vv.removeEventListener('resize', handleResize);
  }, []);

  const addOptimisticMessage = useMessagesStore((s) => s.addOptimisticMessage);
  const confirmOptimisticMessage = useMessagesStore((s) => s.confirmOptimisticMessage);
  const failOptimisticMessage = useMessagesStore((s) => s.failOptimisticMessage);

  const [dragOver, setDragOver] = useState(false);

  const clearMedia = useCallback(() => {
    if (mediaPreview) URL.revokeObjectURL(mediaPreview);
    setMediaFile(null);
    setMediaPreview(null);
  }, [mediaPreview]);

  /** Set media from a File object */
  const applyMediaFile = useCallback((file: File) => {
    clearMedia();
    setMediaFile(file);
    setMediaPreview(URL.createObjectURL(file));
  }, [clearMedia]);

  /** Convert RGBA pixel data to PNG Blob via OffscreenCanvas */
  const rgbaToPngBlob = useCallback(async (rgba: Uint8Array, width: number, height: number): Promise<Blob> => {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d')!;
    const imageData = new ImageData(new Uint8ClampedArray(rgba), width, height);
    ctx.putImageData(imageData, 0, 0);
    return canvas.convertToBlob({ type: 'image/png' });
  }, []);

  /** Try reading image from native Tauri clipboard */
  const tryNativeClipboard = useCallback(async () => {
    try {
      const img = await readImage();
      const { width, height } = await img.size();
      if (width === 0 || height === 0) return false;
      const rgba = await img.rgba();
      const blob = await rgbaToPngBlob(rgba, width, height);
      const file = new File([blob], `clipboard_${Date.now()}.png`, { type: 'image/png' });
      applyMediaFile(file);
      return true;
    } catch {
      return false;
    }
  }, [applyMediaFile, rgbaToPngBlob]);

  const handlePaste = useCallback(async (e: ClipboardEvent<HTMLTextAreaElement>) => {
    // Layer 1: standard clipboardData.items (works in Chromium-based webviews)
    const items = e.clipboardData?.items;
    if (items) {
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
          const file = items[i].getAsFile();
          if (file) {
            e.preventDefault();
            applyMediaFile(file);
            return;
          }
        }
      }
    }

    // Layer 2: clipboardData.files (some WebViews put images here instead)
    const files = e.clipboardData?.files;
    if (files && files.length > 0) {
      for (let i = 0; i < files.length; i++) {
        if (files[i].type.startsWith('image/')) {
          e.preventDefault();
          applyMediaFile(files[i]);
          return;
        }
      }
    }

    // Layer 3: native Tauri clipboard API (reads system clipboard directly)
    const found = await tryNativeClipboard();
    if (found) {
      e.preventDefault();
    }
  }, [applyMediaFile, tryNativeClipboard]);

  /** Handle drag-and-drop files */
  const handleDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      applyMediaFile(files[0]);
    }
  }, [applyMediaFile]);

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOver(false);
  }, []);

  const sendMediaBytes = useCallback(async (file: File, captionText: string) => {
    // Raw IPC body: bytes go over the bridge as-is instead of a JSON number
    // array (~4x smaller payload, no per-byte parsing). Metadata rides in
    // headers; values are percent-encoded because headers must be ASCII.
    const buffer = await file.arrayBuffer();
    const headers: Record<string, string> = {
      'x-account-id': accountId,
      'x-chat-id': String(chatId),
      'x-file-name': encodeURIComponent(file.name),
      'x-mime-type': file.type || 'application/octet-stream',
    };
    if (captionText) headers['x-caption'] = encodeURIComponent(captionText);

    return sendMedia<Message>(new Uint8Array(buffer), headers);
  }, [accountId, chatId]);

  const handleSend = useCallback(async () => {
    const trimmedText = text.trim();
    if ((!trimmedText && !mediaFile) || sending) return;

    const tempId = `temp_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    addOptimisticMessage(chatId, tempId, trimmedText);
    setText('');
    const currentMedia = mediaFile;
    clearMedia();
    setSending(true);

    try {
      let sentMessage: Message;
      if (currentMedia) {
        sentMessage = await sendMediaBytes(currentMedia, trimmedText);
      } else {
        sentMessage = await invoke<Message>('send_message', {
          accountId,
          chatId,
          text: trimmedText,
          topicId,
        });
      }

      confirmOptimisticMessage(chatId, tempId, sentMessage);
      onMessageSent?.(sentMessage);
    } catch (error) {
      console.error('[MessageInput] Failed to send:', error);
      failOptimisticMessage(chatId, tempId);
    } finally {
      setSending(false);
    }
  }, [text, sending, mediaFile, accountId, chatId, topicId, addOptimisticMessage, confirmOptimisticMessage, failOptimisticMessage, onMessageSent, clearMedia, sendMediaBytes]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  // Voice recording handlers
  const handleVoiceRecordingComplete = useCallback(async (blob: Blob, _duration: number) => {
    setIsRecording(false);
    const voiceFile = new File([blob], `voice_${Date.now()}.ogg`, { type: 'audio/ogg' });

    const tempId = `temp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    addOptimisticMessage(chatId, tempId, t('voice_recording'));
    setSending(true);

    try {
      const sentMessage = await sendMediaBytes(voiceFile, '');
      confirmOptimisticMessage(chatId, tempId, sentMessage);
      onMessageSent?.(sentMessage);
    } catch (error) {
      console.error('[MessageInput] Failed to send voice message:', error);
      failOptimisticMessage(chatId, tempId);
    } finally {
      setSending(false);
    }
  }, [chatId, addOptimisticMessage, confirmOptimisticMessage, failOptimisticMessage, onMessageSent, sendMediaBytes, t]);

  const handleVoiceCancel = useCallback(() => {
    setIsRecording(false);
  }, []);

  const handleStartRecording = useCallback(() => {
    setIsRecording(true);
  }, []);

  // Attachment menu handlers
  const handleAttachToggle = useCallback(() => {
    setAttachMenuOpen((prev) => !prev);
  }, []);

  const handleSelectPhoto = useCallback(() => {
    setAttachMenuOpen(false);
    photoInputRef.current?.click();
  }, []);

  const handleSelectDocument = useCallback(() => {
    setAttachMenuOpen(false);
    fileInputRef.current?.click();
  }, []);

  const handleSelectCamera = useCallback(() => {
    setAttachMenuOpen(false);
    setCameraOpen(true);
  }, []);

  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      applyMediaFile(file);
    }
    // Reset input so the same file can be selected again
    e.target.value = '';
  }, [applyMediaFile]);

  const handleCameraCapture = useCallback((file: File) => {
    applyMediaFile(file);
  }, [applyMediaFile]);

  return (
    <div
      className={`message-input-wrapper${dragOver ? ' drag-over' : ''}`}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
    >
      {dragOver && (
        <div className="drop-overlay">{t('drop_to_attach')}</div>
      )}
      {mediaPreview && (
        <div className="media-preview-container">
          <div className="media-preview-item">
            {mediaFile?.type.startsWith('image/') ? (
              <img src={mediaPreview} alt="Preview" />
            ) : mediaFile?.type.startsWith('video/') ? (
              <video src={mediaPreview} className="media-preview-video" muted />
            ) : (
              <div className="file-preview">
                <span className="file-icon">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                </span>
                <span className="file-name">{mediaFile?.name}</span>
                {mediaFile && <span className="file-size">{formatFileSize(mediaFile.size)}</span>}
              </div>
            )}
            <button className="remove-media" onClick={clearMedia} title={t('cancel')}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>
      )}
      <div className="message-input-container">
        {/* Attachment button */}
        <div className="attach-btn-wrapper">
          <button
            className={`attach-btn${attachMenuOpen ? ' active' : ''}`}
            onClick={handleAttachToggle}
            title={t('attach_file')}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          <AttachmentMenu
            isOpen={attachMenuOpen}
            onClose={() => setAttachMenuOpen(false)}
            onSelectPhoto={handleSelectPhoto}
            onSelectDocument={handleSelectDocument}
            onSelectCamera={handleSelectCamera}
          />
        </div>

        {isRecording ? (
          <VoiceRecorder
            onRecordingComplete={handleVoiceRecordingComplete}
            onCancel={handleVoiceCancel}
            isRecording={isRecording}
            onStartRecording={handleStartRecording}
          />
        ) : (
          <>
            <textarea
              ref={textareaRef}
              className="message-input"
              placeholder={mediaPreview ? t('add_caption') : t('write_message')}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              rows={1}
              autoFocus
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            {/* Show mic button when no text/media, send button otherwise */}
            {!text.trim() && !mediaFile ? (
              <VoiceRecorder
                onRecordingComplete={handleVoiceRecordingComplete}
                onCancel={handleVoiceCancel}
                isRecording={false}
                onStartRecording={handleStartRecording}
              />
            ) : (
              <button
                className="send-button"
                onClick={handleSend}
                disabled={(!text.trim() && !mediaFile) || sending}
                title={t('send_enter')}
              >
                {sending ? (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="spin">
                    <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                  </svg>
                ) : (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 2L11 13" />
                    <path d="M22 2L15 22L11 13L2 9L22 2Z" />
                  </svg>
                )}
              </button>
            )}
          </>
        )}
      </div>

      {/* Hidden file inputs */}
      <input
        ref={photoInputRef}
        type="file"
        accept="image/*,video/*"
        style={{ display: 'none' }}
        onChange={handleFileInputChange}
      />
      <input
        ref={fileInputRef}
        type="file"
        style={{ display: 'none' }}
        onChange={handleFileInputChange}
      />

      {/* Camera capture modal */}
      <CameraCapture
        isOpen={cameraOpen}
        onCapture={handleCameraCapture}
        onClose={() => setCameraOpen(false)}
      />
    </div>
  );
};
