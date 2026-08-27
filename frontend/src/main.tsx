import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AuthProvider } from "./auth";
import "./styles.css";

// Production only: in dev the worker would sit in front of Vite's module
// graph and serve yesterday's app back to HMR.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    // Registration failing is not worth reporting — it costs the install
    // prompt and nothing else.
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

// AuthProvider wraps the whole app rather than just the Talk tab, so the
// session is fetched once on load instead of on every visit to that tab.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </React.StrictMode>
);
