import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { invoke, convertFileSrc } from '../../transport';
import './AvatarViewer.css';

interface AvatarViewerProps {
  chatId: number;
  chatTitle: string;
  accountId: string;
  initialPhotoSrc?: string;
  onClose: () => void;
}

export const AvatarViewer = ({
  chatId,
  chatTitle,
  accountId,
  initialPhotoSrc,
  onClose,
}: AvatarViewerProps) => {
  const [photos, setPhotos] = useState<string[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [closing, setClosing] = useState(false);
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const translateStart = useRef({ x: 0, y: 0 });
  const contentRef = useRef<HTMLDivElement>(null);

  const handleClose = useCallback(() => {
    setClosing(true);
    setTimeout(onClose, 200);
  }, [onClose]);

  // Fetch all profile photos on mount
  useEffect(() => {
    let cancelled = false;
    invoke<string[]>('get_user_photos', { accountId, chatId })
      .then((paths) => {
        if (cancelled) return;
        const srcs = paths.map((p) => convertFileSrc(p));
        setPhotos(srcs);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        // If fetch fails but we have initialPhotoSrc, show just that
        if (initialPhotoSrc) {
          setPhotos([initialPhotoSrc]);
        }
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, chatId, initialPhotoSrc]);

  // Navigate photos
  const goToPrev = useCallback(() => {
    setCurrentIndex((i) => (i > 0 ? i - 1 : i));
    setScale(1);
    setTranslate({ x: 0, y: 0 });
  }, []);

  const goToNext = useCallback(() => {
    setCurrentIndex((i) => (i < photos.length - 1 ? i + 1 : i));
    setScale(1);
    setTranslate({ x: 0, y: 0 });
  }, [photos.length]);

  // Keyboard navigation
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
      else if (e.key === 'ArrowLeft') goToPrev();
      else if (e.key === 'ArrowRight') goToNext();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleClose, goToPrev, goToNext]);

  // Lock body scroll
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, []);

  // Zoom with mouse wheel
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.stopPropagation();
    const delta = e.deltaY > 0 ? -0.15 : 0.15;
    setScale((prev) => {
      const next = Math.min(Math.max(prev + delta, 0.5), 5);
      if (next <= 1) setTranslate({ x: 0, y: 0 });
      return next;
    });
  }, []);

  // Double-click to toggle zoom
  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (scale > 1) {
        setScale(1);
        setTranslate({ x: 0, y: 0 });
      } else {
        setScale(2.5);
      }
    },
    [scale],
  );

  // Drag to pan when zoomed
  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (scale <= 1) return;
      e.stopPropagation();
      setDragging(true);
      dragStart.current = { x: e.clientX, y: e.clientY };
      translateStart.current = { ...translate };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [scale, translate],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - dragStart.current.x;
      const dy = e.clientY - dragStart.current.y;
      setTranslate({
        x: translateStart.current.x + dx,
        y: translateStart.current.y + dy,
      });
    },
    [dragging],
  );

  const handlePointerUp = useCallback(() => {
    setDragging(false);
  }, []);

  // Click content area (outside image) to close
  const handleContentClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === contentRef.current) {
        handleClose();
      }
    },
    [handleClose],
  );

  // Determine current image src
  const currentSrc =
    photos.length > 0 ? photos[currentIndex] : initialPhotoSrc || '';

  return createPortal(
    <div
      className={`avatar-viewer-overlay${closing ? ' avatar-viewer-closing' : ''}`}
    >
      {/* Title — top left */}
      <div className="avatar-viewer-title">{chatTitle}</div>

      {/* Counter — top center */}
      {photos.length > 1 && (
        <div className="avatar-viewer-counter">
          {currentIndex + 1} of {photos.length}
        </div>
      )}

      {/* Close button — top right */}
      <button
        className="avatar-viewer-close"
        onClick={handleClose}
        aria-label="Close"
      >
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>

      {/* Left arrow */}
      {photos.length > 1 && currentIndex > 0 && (
        <button
          className="avatar-viewer-nav left"
          onClick={goToPrev}
          aria-label="Previous photo"
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
      )}

      {/* Right arrow */}
      {photos.length > 1 && currentIndex < photos.length - 1 && (
        <button
          className="avatar-viewer-nav right"
          onClick={goToNext}
          aria-label="Next photo"
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      )}

      {/* Image */}
      <div
        ref={contentRef}
        className="avatar-viewer-content"
        onClick={handleContentClick}
      >
        {loading && !initialPhotoSrc && (
          <div className="avatar-viewer-spinner" />
        )}
        {currentSrc && (
          <img
            className="avatar-viewer-img"
            src={currentSrc}
            alt={chatTitle}
            draggable={false}
            style={{
              transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
              cursor:
                scale > 1 ? (dragging ? 'grabbing' : 'grab') : 'default',
            }}
            onWheel={handleWheel}
            onDoubleClick={handleDoubleClick}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
          />
        )}
      </div>
    </div>,
    document.body,
  );
};
