import { StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import "./index.css";
import i18n, { i18nReady } from "./i18n";
import { router } from "./app/router";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useUiStore, applyTheme } from "./lib/ui";
import { queryClient } from "./lib/client/query-client";
import { FeedbackProvider } from "./components/feedback/FeedbackProvider";
import { resolveEffectiveLocale } from "./i18n/config";

const initialUi = useUiStore.getState();
applyTheme(initialUi.theme);
document.documentElement.lang = resolveEffectiveLocale(initialUi.locale);

// Translation resources load in a separate chunk. Mount immediately so a slow
// or failed locale request never leaves the webview as an unexplained blank page.
void i18nReady.catch(() => undefined);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary
      fallback={
        <div style={{ padding: "2rem", textAlign: "center", fontFamily: "system-ui, sans-serif" }}>
          <h2 style={{ color: "#e24b4a" }}>{i18n.t("errors.applicationTitle")}</h2>
          <p style={{ color: "#666" }}>{i18n.t("errors.applicationUnexpected")}</p>
          <button
            onClick={() => window.location.reload()}
            style={{ marginTop: "1rem", padding: "0.5rem 1rem", cursor: "pointer", borderRadius: "6px", border: "1px solid #ccc" }}
          >
            {i18n.t("errors.reloadApplication")}
          </button>
        </div>
      }
    >
      <Suspense fallback={<div role="status" style={{ padding: "2rem", color: "#666", fontFamily: "system-ui, sans-serif" }}>Loading Pi-Science…</div>}>
        <QueryClientProvider client={queryClient}>
          <FeedbackProvider>
            <RouterProvider router={router} />
          </FeedbackProvider>
        </QueryClientProvider>
      </Suspense>
    </ErrorBoundary>
  </StrictMode>,
);
