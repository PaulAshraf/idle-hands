import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App.tsx";
import { initTheme } from "./lib/hooks.ts";
import "./styles/fonts.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/pages.css";

async function boot() {
  initTheme();
  // The mock backend lives behind a dynamic import gated on a build-time constant, so a production
  // build (without VITE_MOCK) drops it entirely.
  if (import.meta.env.VITE_MOCK === "1") {
    const { installMock } = await import("./mock/install.ts");
    installMock();
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </StrictMode>,
  );
}

void boot();
