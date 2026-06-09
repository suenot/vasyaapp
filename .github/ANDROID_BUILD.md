# Android Build via GitHub Actions

## Setup Instructions

### 1. Add Repository Secrets

Go to your repository → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

Add these secrets:
- `TELEGRAM_API_ID` - Your Telegram API ID (e.g., `35898`)
- `TELEGRAM_API_HASH` - Your Telegram API Hash

### 2. Trigger Build

**Automatic:**
- Push to `main` or `develop` branch
- Create a pull request to `main`

**Manual:**
- Go to **Actions** tab
- Select "Android Build (Deepgram only)" workflow
- Click "Run workflow"
- Choose branch and click "Run workflow"

### 3. Download APK

After the build completes (~15-30 minutes):
1. Go to the workflow run page
2. Scroll down to **Artifacts**
3. Download `vasyapp-android.zip`
4. Extract and install the APK on your Android device

## Build Variants

### Simple Build (Recommended for Android)
- Workflow: `android-build-simple.yml`
- Uses only **Deepgram** STT (cloud)
- Smaller APK size (~30-50 MB)
- Faster build time (~15-20 minutes)

### Full Build (with Whisper sidecar)
- Workflow: `android-build.yml`
- Includes both Deepgram and local Whisper
- Larger APK size (~60-80 MB)
- Longer build time (~25-40 minutes)
- **Note:** Whisper sidecar may need additional configuration for Android

## Free Tier Limits

**GitHub Actions (Free tier for private repos):**
- 2000 minutes/month
- ~40-80 Android builds per month (depending on variant)

**Public repositories:** Unlimited minutes ✨

## Signing APK (Optional - for production)

To create a signed release APK, add these secrets:
- `ANDROID_KEYSTORE_FILE` - Base64 encoded keystore file
- `ANDROID_KEYSTORE_PASSWORD` - Keystore password
- `ANDROID_KEY_ALIAS` - Key alias
- `ANDROID_KEY_PASSWORD` - Key password

Then modify the workflow to include signing steps.

## Troubleshooting

### Build fails with "NDK not found"
- The workflow automatically installs NDK r25c
- Check if `nttld/setup-ndk@v1` action succeeded

### Build fails with "Rust target not found"
- The workflow installs Android Rust targets automatically
- Check if `dtolnay/rust-toolchain@stable` step succeeded

### APK not generated
- Check the build logs for Rust compilation errors
- Ensure all secrets are set correctly
- Try the "simple" workflow first (Deepgram only)

## Local Android Build (alternative)

If you want to build locally:

```bash
# 1. Install Android Studio and SDK
brew install --cask android-studio

# 2. Install NDK via Android Studio SDK Manager
# Tools → SDK Manager → SDK Tools → NDK (Side by side)

# 3. Set environment variables
export ANDROID_HOME=$HOME/Library/Android/sdk
export NDK_HOME=$ANDROID_HOME/ndk/25.0.8775105

# 4. Add Rust Android targets
rustup target add aarch64-linux-android armv7-linux-androideabi

# 5. Initialize Tauri Android
npm run tauri android init

# 6. Build APK
npm run tauri android build
```

APK will be in: `src-tauri/gen/android/app/build/outputs/apk/`
