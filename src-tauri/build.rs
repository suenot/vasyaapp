fn main() {
    // Embed secrets into the binary at compile time via option_env!()
    // Priority: environment variable > .env file
    // DEEPGRAM_API_KEY is intentionally NOT embedded: users provide their own
    // key via Settings → STT. Baking a secret into the distributed binary leaks
    // it to anyone who runs `strings` on the build.
    let keys = [
        "TELEGRAM_API_ID",
        "TELEGRAM_API_HASH",
    ];

    // Try loading from .env file first (for local dev)
    let mut from_file = std::collections::HashMap::new();
    let env_path = std::path::Path::new("../.env");
    // Always watch .env so build reruns when it appears or changes
    println!("cargo:rerun-if-changed=../.env");
    if env_path.exists() {
        if let Ok(contents) = std::fs::read_to_string(env_path) {
            for line in contents.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }
                if let Some((key, value)) = line.split_once('=') {
                    from_file.insert(key.trim().to_string(), value.trim().to_string());
                }
            }
        }
    }

    // For each key: use env var if set, otherwise fall back to .env file value
    for key in &keys {
        if let Ok(val) = std::env::var(key) {
            if !val.is_empty() {
                println!("cargo:rustc-env={}={}", key, val);
                continue;
            }
        }
        if let Some(val) = from_file.get(*key) {
            if !val.is_empty() {
                println!("cargo:rustc-env={}={}", key, val);
            }
        }
    }

    tauri_build::build()
}
