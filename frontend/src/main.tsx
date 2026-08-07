import React from "react";
import ReactDOM from "react-dom/client";
import { Analytics } from "@vercel/analytics/react";
import App from "./App";
import { AuthProvider } from "./auth";
import "./styles.css";

// AuthProvider wraps the whole app rather than just the Talk tab, so the
// session is fetched once on load instead of on every visit to that tab.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthProvider>
      <App />
      <Analytics />
    </AuthProvider>
  </React.StrictMode>
);
