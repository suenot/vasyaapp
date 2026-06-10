import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { getCurrentWindow } from '@tauri-apps/api/window';
import './ImageViewer.css';

interface ImageViewerProps {
  src: string;
  alt?: string;
  caption?: string;
  senderName?: string;
  senderColor?: string;
  date?: string;
  onClose: () => void;
}

export const ImageViewer = ({ src, alt, caption, senderName, senderColor, date, onClose }: ImageViewerProps) => {
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [closing, setClosing] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const translateStart = useRef({ x: 0, y: 0 });
  const contentRef = useRef<HTMLDivElement>(null);

  const handleClose = useCallback(() => {
    setClosing(true);
    setTimeout(onClose, 200);
  }, [onClose]);

  // Escape to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleClose]);

  // Fullscreen on open, restore on close (Tauri only — in a browser the
  // overlay itself is the viewer, there is no app window to toggle)
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    if (!('__TAURI_INTERNALS__' in window)) {
      return () => {
        document.body.style.overflow = '';
      };
    }
    const win = getCurrentWindow();
    let wasFullscreen = false;
    win.isFullscreen().then((fs) => {
      wasFullscreen = fs;
      if (!fs) win.setFullscreen(true);
    });
    return () => {
      document.body.style.overflow = '';
      if (!wasFullscreen) win.setFullscreen(false);
    };
  }, []);

  // Zoom with wheel
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.stopPropagation();
    const delta = e.deltaY > 0 ? -0.15 : 0.15;
    setScale(prev => {
      const next = Math.min(Math.max(prev + delta, 0.5), 5);
      if (next <= 1) setTranslate({ x: 0, y: 0 });
      return next;
    });
  }, []);

  // Double-click to toggle zoom
  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (scale > 1) {
      setScale(1);
      setTranslate({ x: 0, y: 0 });
    } else {
      setScale(2.5);
    }
  }, [scale]);

  // Drag to pan when zoomed
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (scale <= 1) return;
    e.stopPropagation();
    setDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY };
    translateStart.current = { ...translate };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [scale, translate]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    setTranslate({
      x: translateStart.current.x + dx,
      y: translateStart.current.y + dy,
    });
  }, [dragging]);

  const handlePointerUp = useCallback(() => {
    setDragging(false);
  }, []);

  // Click content area (outside image) to close
  const handleContentClick = useCallback((e: React.MouseEvent) => {
    if (e.target === contentRef.current) {
      handleClose();
    }
  }, [handleClose]);

  // Get sender initials
  const getInitials = (name?: string) => {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return name[0]?.toUpperCase() || '?';
  };

  const handleDownload = useCallback(() => {
    const a = document.createElement('a');
    a.href = src;
    a.download = alt || 'image';
    a.click();
  }, [src, alt]);

  return createPortal(
    <div className={`image-viewer-overlay${closing ? ' image-viewer-closing' : ''}`}>
      {/* Top bar */}
      <div className="image-viewer-topbar">
        <div className="image-viewer-sender">
          {senderName && (
            <div
              className="image-viewer-sender-avatar"
              style={{ backgroundColor: senderColor || '#65AADD' }}
            >
              {getInitials(senderName)}
            </div>
          )}
          <div className="image-viewer-sender-info">
            {senderName && <div className="image-viewer-sender-name">{senderName}</div>}
            {date && <div className="image-viewer-sender-date">{date}</div>}
          </div>
        </div>

        <button className="image-viewer-close" onClick={handleClose} aria-label="Close">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Image */}
      <div
        ref={contentRef}
        className="image-viewer-content"
        onClick={handleContentClick}
      >
        <img
          className="image-viewer-img"
          src={src}
          alt={alt || 'Image'}
          draggable={false}
          style={{
            transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
            cursor: scale > 1 ? (dragging ? 'grabbing' : 'grab') : 'default',
          }}
          onWheel={handleWheel}
          onDoubleClick={handleDoubleClick}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        />
      </div>

      {/* Caption */}
      {caption && <div className="image-viewer-caption">{caption}</div>}

      {/* Bottom action bar */}
      <div className="image-viewer-bottombar">
        {/* Forward */}
        <button className="image-viewer-action" title="Forward" onClick={handleClose}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 17 20 12 15 7" />
            <path d="M4 18v-2a4 4 0 0 1 4-4h12" />
          </svg>
        </button>
        {/* Zoom in */}
        <button className="image-viewer-action" title="Zoom in" onClick={() => setScale(s => Math.min(s + 0.5, 5))}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
            <line x1="11" y1="8" x2="11" y2="14" />
            <line x1="8" y1="11" x2="14" y2="11" />
          </svg>
        </button>
        {/* Zoom out */}
        <button className="image-viewer-action" title="Zoom out" onClick={() => { setScale(s => Math.max(s - 0.5, 0.5)); if (scale <= 1.5) setTranslate({ x: 0, y: 0 }); }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
            <line x1="8" y1="11" x2="14" y2="11" />
          </svg>
        </button>
        {/* Download */}
        <button className="image-viewer-action" title="Download" onClick={handleDownload}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </button>
        {/* Delete */}
        <button className="image-viewer-action" title="Delete" onClick={handleClose}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </button>
      </div>
    </div>,
    document.body
  );
};
