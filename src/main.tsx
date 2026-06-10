import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { setTransportMode } from "./transport";
import { useSettingsStore } from "./store/settingsStore";

// Web build: no Tauri runtime means the engine must be a remote vasya-server.
// Desktop: honor the persisted opt-in (the Rust side reads its own marker
// file at startup and leaves the embedded engine cold in remote mode).
if (!("__TAURI_INTERNALS__" in window)) {
  setTransportMode("remote");
} else if (useSettingsStore.getState().transportMode === "remote") {
  setTransportMode("remote");
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
