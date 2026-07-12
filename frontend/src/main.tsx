import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import "./index.css";
import { router } from "./app/router";

// Initialize theme from localStorage
const theme = localStorage.getItem("pi-science.theme");
if (theme) {
  document.documentElement.setAttribute("data-theme", JSON.parse(theme));
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
);
