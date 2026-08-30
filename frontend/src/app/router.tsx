import { createBrowserRouter, Navigate, useParams } from "react-router-dom";
import { Suspense, lazy, type ReactElement } from "react";
import { ProjectsLayout } from "./layout/ProjectsLayout";
import { RoutedErrorBoundary } from "../components/ErrorBoundary";
import { WorkspaceProvider } from "../lib/workspace";
import { useTranslation } from "react-i18next";

const ProjectsPage = lazy(() => import("./routes/ProjectsPage").then((m) => ({ default: m.ProjectsPage })));
const LiveSessionPage = lazy(() => import("./routes/LiveSessionPage").then((m) => ({ default: m.LiveSessionPage })));
const SettingsPage = lazy(() => import("./routes/SettingsPage").then((m) => ({ default: m.SettingsPage })));
const FilesPage = lazy(() => import("./routes/FilesPage").then((m) => ({ default: m.FilesPage })));
const RunsPage = lazy(() => import("./routes/RunsPage").then((m) => ({ default: m.RunsPage })));
const KnowledgePage = lazy(() => import("./routes/KnowledgePage").then((m) => ({ default: m.KnowledgePage })));
const ResearchPage = lazy(() => import("./routes/ResearchPage").then((m) => ({ default: m.ResearchPage })));
const ScheduledTasksPage = lazy(() => import("./routes/ScheduledTasksPage").then((m) => ({ default: m.ScheduledTasksPage })));

function LoadingFallback() {
  const { t } = useTranslation();
  return <div style={{ padding: "2rem", color: "var(--muted)" }}>{t("common.loading")}</div>;
}
const wrap = (element: ReactElement) => <Suspense fallback={<LoadingFallback />}>{element}</Suspense>;

function LegacyNotebooksRedirect() {
  const { cwd = "" } = useParams<{ cwd: string }>();
  return <Navigate replace to={`/workspace/${encodeURIComponent(cwd)}/files?type=notebook`} />;
}

export const router = createBrowserRouter([
  {
    path: "/",
    element: <RoutedErrorBoundary><WorkspaceProvider><ProjectsLayout /></WorkspaceProvider></RoutedErrorBoundary>,
    children: [
      { index: true, element: wrap(<ProjectsPage />) },
      { path: "settings", element: wrap(<SettingsPage />) },
      { path: "workspace/:cwd", element: wrap(<LiveSessionPage />) },
      { path: "workspace/:cwd/session/:sessionId", element: wrap(<LiveSessionPage />) },
      { path: "workspace/:cwd/files", element: wrap(<FilesPage />) },
      { path: "workspace/:cwd/notebooks", element: <LegacyNotebooksRedirect /> },
      { path: "workspace/:cwd/runs", element: wrap(<RunsPage />) },
      { path: "workspace/:cwd/scheduled-tasks", element: wrap(<ScheduledTasksPage />) },
      { path: "workspace/:cwd/knowledge", element: wrap(<KnowledgePage />) },
      { path: "workspace/:cwd/research", element: wrap(<ResearchPage />) },
      { path: "workspace/:cwd/settings", element: wrap(<SettingsPage />) },
    ],
  },
]);
