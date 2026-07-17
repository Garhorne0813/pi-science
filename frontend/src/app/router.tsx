import { createBrowserRouter } from "react-router-dom";
import { Suspense, lazy } from "react";
import { ProjectsLayout } from "./layout/ProjectsLayout";
import { RoutedErrorBoundary } from "../components/ErrorBoundary";

// Lazy-load all route components for code splitting
const ProjectsPage = lazy(() => import("./routes/ProjectsPage").then(m => ({ default: m.ProjectsPage })));
const LiveSessionPage = lazy(() => import("./routes/LiveSessionPage").then(m => ({ default: m.LiveSessionPage })));
const SettingsPage = lazy(() => import("./routes/SettingsPage").then(m => ({ default: m.SettingsPage })));
const SkillsPage = lazy(() => import("./routes/SkillsPage").then(m => ({ default: m.SkillsPage })));
const FilesPage = lazy(() => import("./routes/FilesPage").then(m => ({ default: m.FilesPage })));
const NotebooksPage = lazy(() => import("./routes/NotebooksPage").then(m => ({ default: m.NotebooksPage })));
const RunsPage = lazy(() => import("./routes/RunsPage").then(m => ({ default: m.RunsPage })));
const KnowledgePage = lazy(() => import("./routes/KnowledgePage").then(m => ({ default: m.KnowledgePage })));

const fallback = <div style={{ padding: "2rem", color: "#888" }}>Loading…</div>;
const wrap = (el: React.ReactElement) => <Suspense fallback={fallback}>{el}</Suspense>;

export const router = createBrowserRouter([
  {
    path: "/",
    element: <RoutedErrorBoundary><ProjectsLayout /></RoutedErrorBoundary>,
    children: [
      { index: true, element: wrap(<ProjectsPage />) },
      { path: "settings", element: wrap(<SettingsPage />) },
      { path: "skills", element: wrap(<SkillsPage />) },
      { path: "workspace/:cwd", element: wrap(<LiveSessionPage />) },
      { path: "workspace/:cwd/session/:sessionId", element: wrap(<LiveSessionPage />) },
      { path: "workspace/:cwd/files", element: wrap(<FilesPage />) },
      { path: "workspace/:cwd/notebooks", element: wrap(<NotebooksPage />) },
      { path: "workspace/:cwd/runs", element: wrap(<RunsPage />) },
      { path: "workspace/:cwd/knowledge", element: wrap(<KnowledgePage />) },
    ],
  },
]);
