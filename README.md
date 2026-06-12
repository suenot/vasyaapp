# VasyApp - Telegram Client

![Vasya and the "Vasya.app, not WhatsApp" story](docs/assets/vasya-comic.jpg)

Cross-platform Telegram client built with Tauri 2.0 + React 19 + TypeScript. Features voice transcription, media handling, and optimized message loading.

## 🌐 Web version

The same UI also runs in the browser against a remote **`vasya-server`** (the Telegram session host) — no Tauri runtime required. Self-hosted: bring your own server and domain.

- **Connect:** open the web app, enter your vasya-server URL, then sign in with email + password (issues a JWT) or paste an access token. Builds can pre-fill the API origin via the `VITE_VASYA_API_URL` build var.
- **Build:** `VITE_VASYA_API_URL=https://your-api.example.com npm run build` → serve `dist/`.
- The engine transport is abstracted (`src/transport/`): Tauri IPC on desktop, HTTP/SSE in the browser. The production stack (vasya-server + sync backend + Caddy) lives in `backend/deploy/` — see its README to deploy your own.

## ✨ Features

- **Messaging UX**: Telegram-style date separators, rich link previews, and message grouping

- **Telegram Integration**: Full MTProto support via grammers-client v0.8
- **Voice Transcription (STT)**:
  - Cloud: Deepgram Nova-2 — bring your own API key (Settings → STT); no key is embedded in the build
  - Local: Whisper.cpp via sidecar (~1 GB RAM)
  - Auto-transcribe incoming voice messages
  - Multi-language support (Russian, English, Ukrainian, German, French, Spanish)
- **Media Handling**:
  - Auto-download for photos/stickers/voice — viewport-scoped (only media actually on screen is fetched)
  - Click-to-download for videos/documents (user downloads jump the queue)
  - Media caching and queue management
  - Paste images directly (Ctrl+V)
- **Performance**:
  - Message virtualization with @tanstack/react-virtual
  - Optimistic updates with Zustand 5
  - Connection state monitoring
- **Multi-account**: Switch between multiple Telegram accounts

## 🛠 Tech Stack

**Frontend:**
- React 19 + TypeScript
- Zustand 5 (state management)
- @tanstack/react-virtual (virtualization)
- Vite (build tool)

**Backend:**
- Tauri 2.0 (Rust + system APIs)
- grammers-client 0.8 (Telegram MTProto)
- whisper-rs + whisper.cpp (local STT)
- reqwest (HTTP client for Deepgram)

## 🚀 Development

### Prerequisites
- Node.js 20+
- Rust (latest stable)
- Xcode Command Line Tools (macOS)

### Setup
```bash
# Install dependencies
npm install

# Create .env file (Deepgram key is NOT a build input — users add it in Settings → STT)
echo "TELEGRAM_API_ID=your_api_id" >> .env
echo "TELEGRAM_API_HASH=your_api_hash" >> .env

# Run in development mode
npm run tauri dev

# Build for production
npm run tauri build
```

### STT Sidecar (Optional - for local Whisper)
```bash
cd src-tauri/stt-sidecar
cargo build --release
cp target/release/stt-sidecar target/release/stt-sidecar-aarch64-apple-darwin
```

## 📱 Android Build

### GitHub Actions (Recommended)
1. Add repository secrets:
   - `TELEGRAM_API_ID`
   - `TELEGRAM_API_HASH`
2. Push to `main` or trigger workflow manually
3. Download APK from Artifacts (~15-30 minutes)

See [.github/ANDROID_BUILD.md](.github/ANDROID_BUILD.md) for details.

### Local Android Build
```bash
# Install Android Studio + SDK + NDK r25c
export ANDROID_HOME=$HOME/Library/Android/sdk
export NDK_HOME=$ANDROID_HOME/ndk/25.0.8775105

# Add Rust targets
rustup target add aarch64-linux-android armv7-linux-androideabi

# Build
npm run tauri android init
npm run tauri android build
```

## 🔐 Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `TELEGRAM_API_ID` | Telegram API ID from my.telegram.org | Yes |
| `TELEGRAM_API_HASH` | Telegram API Hash | Yes |

The Deepgram API key is a runtime user setting (Settings → STT), not a build
input — it is never embedded in the binary.

## 📝 License

MIT

## 👤 Author

**Евгений (suenot)**
- GitHub: [@suenot](https://github.com/suenot)
