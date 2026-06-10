import { useEffect, useState, useRef, useCallback } from 'react';
import { convertFileSrc } from '../../transport';
import { useMediaQueue, cancelQueuedDownload } from '../../hooks/useMediaQueue';
import { MediaInfo } from '../../types/telegram';
import { VoiceMessage } from './VoiceMessage';
import { ImageViewer } from './ImageViewer';
import { useTranslation } from '../../i18n';
import './MediaAttachment.css';

interface MediaAttachmentProps {
  media: MediaInfo;
  accountId: string;
  chatId: number;
  messageId: number;
  messageText?: string;
}

const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

// Types that auto-download when visible
const AUTO_DOWNLOAD_TYPES = new Set(['photo', 'sticker', 'voice']);



export const MediaAttachment = ({
  media,
  accountId,
  chatId,
  messageId,
  messageText,
}: MediaAttachmentProps) => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [loadedMedia, setLoadedMedia] = useState<MediaInfo | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [inViewport, setInViewport] = useState(false);
  const placeholderRef = useRef<HTMLDivElement>(null);
  const downloadingRef = useRef(false);
  const downloadMedia = useMediaQueue();

  const shouldAutoDownload = AUTO_DOWNLOAD_TYPES.has(media.media_type);
  const needsDownload = (!media.file_path || media.file_path.trim() === '') && !loadedMedia;

  const doDownload = useCallback(async () => {
    if (downloadingRef.current || loadedMedia) return;
    downloadingRef.current = true;
    setLoading(true);
    try {
      // User asked for this file explicitly — jump ahead of queued auto-downloads.
      const result = await downloadMedia(accountId, chatId, messageId, { front: true }) as MediaInfo[] | null;
      if (result && result.length > 0) {
        setLoadedMedia(result[0]);
      }
    } catch {
      // Download failed — placeholder will show
    } finally {
      downloadingRef.current = false;
      setLoading(false);
    }
  }, [accountId, chatId, messageId, loadedMedia, downloadMedia]);

  // Auto-download is viewport-scoped: track whether the placeholder is actually
  // on screen. Virtualized rows also mount in the overscan area and transiently
  // while jumping/flinging through a chat — those must NOT trigger downloads.
  useEffect(() => {
    if (!shouldAutoDownload || !needsDownload || failed) return;
    const el = placeholderRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => setInViewport(entries.some((e) => e.isIntersecting)),
      { rootMargin: '100px 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [shouldAutoDownload, needsDownload, failed]);

  // Auto-download for photos/stickers/voice — only while visible (or just off-screen).
  useEffect(() => {
    if (media.media_type === 'webpage') return;
    if (!shouldAutoDownload || !needsDownload || !inViewport || failed) return;
    if (downloadingRef.current) return;

    let cancelled = false;
    // Small debounce so scrolling past a photo doesn't enqueue it.
    const timer = setTimeout(() => {
      if (cancelled) return;
      downloadingRef.current = true;
      setLoading(true);
      downloadMedia(accountId, chatId, messageId)
        .then((result: MediaInfo[] | null) => {
          if (!cancelled && result && result.length > 0) setLoadedMedia(result[0]);
        })
        .catch((err) => {
          if (!cancelled && err !== 'cancelled') setFailed(true);
        })
        .finally(() => {
          downloadingRef.current = false;
          if (!cancelled) setLoading(false);
        });
    }, 150);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      // Left the viewport: if the download is still waiting in the queue, drop it.
      // An already-active download finishes and lands in the queue's result cache.
      cancelQueuedDownload(chatId, messageId);
    };
  }, [inViewport, media.media_type, shouldAutoDownload, needsDownload, failed, accountId, chatId, messageId, downloadMedia]);

  const currentMedia = loadedMedia || media;
  const hasFile = currentMedia.file_path && currentMedia.file_path.trim() !== '';

  // WebPage preview
  if (media.media_type === 'webpage') {
    const urlMatch = messageText?.match(/(https?:\/\/[^\s]+)/);
    const url = urlMatch ? urlMatch[1] : null;
    return (
      <div className="media-webpage">
        <div className="webpage-icon">🔗</div>
        <div className="webpage-content">
          <div className="webpage-title">{t('link_preview')}</div>
          {url && (
            <a href={url} target="_blank" rel="noopener noreferrer" className="webpage-url">
              {url.length > 50 ? url.substring(0, 50) + '...' : url}
            </a>
          )}
        </div>
      </div>
    );
  }

  // Click-to-download placeholder for video/audio/document/videonote
  if (!hasFile && !shouldAutoDownload) {
    return (
      <div className="media-click-download" onClick={loading ? undefined : doDownload}>
        {loading ? (
          <div className="media-download-progress">
            <div className="media-download-spinner" />
            <span>{t('downloading_type', { type: media.media_type })}</span>
          </div>
        ) : (
          <div className="media-download-prompt">
            <div className="media-download-icon">
              {media.media_type === 'video' || media.media_type === 'videonote' ? (
                <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>
              ) : media.media_type === 'audio' ? (
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>
              ) : (
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
              )}
            </div>
            <span className="media-download-label">
              {media.media_type === 'video' ? 'Video' :
                media.media_type === 'videonote' ? 'Video message' :
                  media.media_type === 'audio' ? 'Audio' :
                    media.media_type === 'document' ? (media.file_name || 'Document') :
                      media.media_type}
              {media.file_size ? ` (${formatFileSize(media.file_size)})` : ''}
            </span>
            <span className="media-download-tap">{t('tap_to_download')}</span>
          </div>
        )}
      </div>
    );
  }

  // Auto-download placeholder (waiting-for-viewport / loading state for photo/sticker/voice)
  if (!hasFile) {
    return (
      <div className="media-placeholder" ref={placeholderRef}>
        {failed ? (
          <div>{t('failed_to_load', { type: media.media_type })}</div>
        ) : (
          <div className="media-download-progress">
            <div className="media-download-spinner" />
            <span>{t('loading_type', { type: media.media_type })}</span>
          </div>
        )}
      </div>
    );
  }

  const fileSrc = convertFileSrc(currentMedia.file_path!);

  switch (media.media_type) {
    case 'photo':
      return (
        <div className="media-photo">
          <img
            src={fileSrc}
            alt={currentMedia.file_name || 'Photo'}
            loading="lazy"
            style={{ maxWidth: '100%', borderRadius: '8px' }}
            onClick={() => setViewerOpen(true)}
          />
          {viewerOpen && (
            <ImageViewer
              src={fileSrc}
              alt={currentMedia.file_name || 'Photo'}
              caption={messageText}
              onClose={() => setViewerOpen(false)}
            />
          )}
        </div>
      );
    case 'video':
    case 'videonote':
      return (
        <div className="media-video">
          <video src={fileSrc} controls style={{ maxWidth: '100%', borderRadius: '8px' }} />
        </div>
      );

    case 'audio':
    case 'voice':
      if (media.media_type === 'voice') {
        return (
          <VoiceMessage
            fileSrc={fileSrc}
            filePath={currentMedia.file_path!}
            chatId={chatId}
            messageId={messageId}
          />
        );
      }
      // Fallback for regular audio files (music) -> keep using default or maybe enhance later
      return (
        <div className="media-audio">
          <audio src={fileSrc} controls style={{ width: '100%' }} />
          {currentMedia.file_name && <div className="file-name">{currentMedia.file_name}</div>}
        </div>
      );
    case 'document':
      return (
        <div className="media-document">
          <a href={fileSrc} download={currentMedia.file_name} className="document-link">
            📄 {currentMedia.file_name || 'Document'}
            {currentMedia.file_size && ` (${formatFileSize(currentMedia.file_size)})`}
          </a>
        </div>
      );
    case 'sticker':
      return (
        <div className="media-sticker">
          <img src={fileSrc} alt="Sticker" style={{ maxWidth: '200px', maxHeight: '200px' }} />
        </div>
      );
    default:
      return (
        <div className="media-other">
          <a href={fileSrc} download={currentMedia.file_name}>
            📎 {currentMedia.file_name || currentMedia.media_type}
          </a>
        </div>
      );
  }
};
