# Automatic chat translation

In application Settings, open Translation and set your provider's OpenAI-compatible API base URL (including `/v1` when required), model identifier and API token. The client appends `/chat/completions`. Local providers may use a loopback HTTP address; remote providers must use HTTPS. Providers that expose only a different API protocol need a compatible gateway.

The token is write-only: settings display whether one is configured, not its value. Leaving the token field blank preserves it; the explicit clear action removes it. On desktop the encrypted settings use the existing session master-key provider. In remote mode settings are stored per authenticated user on the selected Vasya server, and that server calls the LLM provider. The token is not saved in browser localStorage.

Open a chat's information/settings panel to configure either direction:

- **Outgoing**: choose the language the recipient should receive, e.g. Chinese. Write normally in Russian; translation completes before sending. Text and attachment captions follow this setting. If translation fails, nothing is sent automatically and the draft remains available.
- **Incoming**: choose the language you want to read, e.g. Russian. Incoming text is translated asynchronously when displayed. The original remains accessible. An incoming translation failure does not hide the original message.

Both directions are off by default and can be enabled independently. Preferences belong to the chat and account on the selected connection. They are local client preferences, not Telegram settings synchronized to other devices. Enabling translation allows message text to be sent to your configured model provider. Voice transcription is a separate feature; forwarding existing messages does not rewrite their content.

LLM translations can be imperfect, including names and specialized terminology. The application preserves original incoming text so it can be checked.

## API

Human-authenticated remote clients use:

- `GET /api/v1/translation/settings` -> `{base_url, model, api_key_set}`
- `PUT /api/v1/translation/settings` with `{base_url, model, api_key?}`; omit `api_key` to preserve it, use an empty string to clear it.
- `POST /api/v1/translation/translate` with `{text, targetLanguage}` -> `{text}`

The same contracts are exposed through `get_translation_settings`, `set_translation_settings` and `translate_text` desktop commands. Provider requests have bounded input/output sizes, concurrency and timeouts. Provider failures do not expose tokens or raw upstream response bodies.

## Verification

- `npm run test:translation` (Node 22.6+): five failure, stale-result, provider-change, draft-revision, deduplication and queue/cache-bound tests.
- `npm run build`: TypeScript and production frontend build.
- `cargo test --manifest-path src-tauri/Cargo.toml --workspace`: 136 Rust tests, including encrypted settings, mock provider responses and authenticated translation routes.
- Browser acceptance exercised the actual UI with a synthetic account and mocked REST provider: save settings without overwriting the token, incoming translation/original toggle, Russian input sent as Chinese output, failed translation preserving the draft without sending, new draft preservation while a prior request completes, per-chat isolation, automatic translation of a newly received SSE message, and translated attachment captions. This does not claim translation quality against a live paid model.

The macOS Apple Silicon application was built with `npm run tauri build -- --bundles app`, locally ad-hoc signed and launched successfully to its Telegram setup screen. No real Telegram credentials or paid LLM tokens were entered during validation.
