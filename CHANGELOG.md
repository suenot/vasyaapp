# Changelog

## [0.7.6] - 2026-06-10
### Security
- Deepgram API key is no longer embedded in the binary — add your own key in Settings → STT (or use local Whisper)
- Validate transcription file paths (must stay inside app data dir)
- Mask phone numbers in logs; remove stale `.bak`/patch files
- Allowlist URL schemes in rendered messages (`http/https/tg/mailto`) — blocks `javascript:`/`data:`/`file:` links
- Narrow asset protocol scope to the media directory; disable devtools and `withGlobalTauri`

### Performance
- Virtualized chat list and message list (`@tanstack/react-virtual`) — long chats no longer render thousands of DOM nodes
- Chat list updates live on incoming messages: preview, unread badge, chat moves to top
- Fixed re-render hotspots: proper Zustand selectors, rAF-throttled call audio levels, batched avatar updates, memoized translations, stable hotkey handlers
- Autoscroll on new messages only when already near the bottom

### Mobile (iOS/Android)
- The app can no longer be dragged down past the top (document rubber-band) — native `WKWebView` bounce disabled + CSS `overscroll-behavior`
- Pinch/double-tap zoom of the UI is disabled (in-app image viewer zoom still works)
- Media auto-download is viewport-scoped: only photos/stickers/voice actually on screen are fetched; scrolling away cancels queued downloads; tap-to-download jumps the queue

## [0.7.5] - 2026-04-02
### Bug Fixes
- Fix settings page on Android — sidebar and content no longer overlap on mobile
- Settings sections now show one at a time with back navigation on small screens

## [0.7.4] - 2026-04-02
### Bug Fixes
- Fix Android keyboard gap — move keyboard height compensation from input padding to container height
- Chat no longer jumps up with empty space above keyboard on Android

## [0.7.3] - 2026-03-16
### Bug Fixes
- Fix Android keyboard squishing entire app — switch from `resizes-content` to `overlays-content`
- Keyboard now overlays content instead of compressing it; input lifts above keyboard via `--keyboard-height` CSS var
- Auto-scroll messages to bottom when keyboard opens on mobile

## [0.7.2] - 2026-03-15
### Bug Fixes
- Fix Android keyboard pushing content up (visualViewport API + CSS var)
- Fix MessageInput safe-area-inset-bottom being overridden

## [0.7.1] - 2026-03-15
### Improvements
- Landing: replaced two-button language switcher with single toggle button

## [0.7.0] - 2026-03-15
### Features
- Create group chats, channels, and supergroups from sidebar
- New Chat button with dropdown menu (group, channel, secret chat)
- Interface scale slider (50%–200%) with live zoom
- Message text size selector (small / medium / large)
- Notification sound toggle (silent notifications)
- Message preview toggle (hide text in notifications)
- Markdown rendering in merged message groups

### Improvements
- Settings controls fully wired to persistent store
- i18n translations for all new features (en/ru)

## [0.6.0] - 2026-03-15
### Features
- Voice & video calls with E2E encryption (DH key exchange)
- Group calls (create, join, leave, mute)
- Message forwarding with chat picker dialog
- Avatar viewer with photo gallery and navigation
- Native OS notifications (macOS, Windows, Linux)
- Folder context menu (Read All, Mute All, Delete)
- Message context menu & multi-select mode
- Markdown rendering in messages
- Chat sorting: unread first in all folders except "All Chats"

### Improvements
- Fullscreen image viewer with zoom, pan, download
- Message grouping (consecutive messages from same sender)
- Theme-aware styling for all new components
- i18n support for all new features (en/ru)
- Sidebar scroll fix
- Call debug logging

## [0.5.0] - 2026-03-10
### Features
- Message bubbles with Telegram-style design
- Unread badges and folder counters
- Enhanced search with global results
- Media UI improvements

## [0.4.0] - 2026-03-05
### Features
- Telegram forum topics support
- Hotkeys and keyboard navigation
- Media attachments and voice recording
- Call placeholders
