import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import "./index.css";
import i18n, { i18nReady } from "./i18n";
import { router } from "./app/router";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useUiStore } from "./lib/ui";
import { queryClient } from "./lib/client/query-client";
import { FeedbackProvider } from "./components/feedback/FeedbackProvider";

const initialUi = useUiStore.getState();
document.documentElement.setAttribute("data-theme", initialUi.theme);
document.documentElement.lang = initialUi.locale;

void i18nReady.then(() => {
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
        <QueryClientProvider client={queryClient}>
          <FeedbackProvider>
            <RouterProvider router={router} />
          </FeedbackProvider>
        </QueryClientProvider>
      </ErrorBoundary>
    </StrictMode>,
  );
});
