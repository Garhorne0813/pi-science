import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import "./index.css";
import { router } from "./app/router";
import { ErrorBoundary } from "./components/ErrorBoundary";

// Initialize theme from localStorage
const theme = localStorage.getItem("pi-science.theme");
if (theme) {
  document.documentElement.setAttribute("data-theme", JSON.parse(theme));
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary
      fallback={
        <div style={{ padding: "2rem", textAlign: "center", fontFamily: "system-ui, sans-serif" }}>
          <h2 style={{ color: "#e24b4a" }}>Application Error</h2>
          <p style={{ color: "#666" }}>An unexpected error occurred.</p>
          <button
            onClick={() => window.location.reload()}
            style={{ marginTop: "1rem", padding: "0.5rem 1rem", cursor: "pointer", borderRadius: "6px", border: "1px solid #ccc" }}
          >
            Reload Application
          </button>
        </div>
      }
    >
      <RouterProvider router={router} />
    </ErrorBoundary>
  </StrictMode>
);
