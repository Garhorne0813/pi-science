import { createBrowserRouter } from "react-router-dom";
import { ProjectsPage } from "./routes/ProjectsPage";
import { LiveSessionPage } from "./routes/LiveSessionPage";
import { SettingsPage } from "./routes/SettingsPage";
import { SkillsPage } from "./routes/SkillsPage";
import { FilesPage } from "./routes/FilesPage";
import { NotebooksPage } from "./routes/NotebooksPage";
import { RunsPage } from "./routes/RunsPage";
import { ProjectsLayout } from "./layout/ProjectsLayout";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <ProjectsLayout />,
    children: [
      { index: true, element: <ProjectsPage /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "skills", element: <SkillsPage /> },
      { path: "workspace/:cwd", element: <LiveSessionPage /> },
      { path: "workspace/:cwd/session/:sessionId", element: <LiveSessionPage /> },
      { path: "workspace/:cwd/files", element: <FilesPage /> },
      { path: "workspace/:cwd/notebooks", element: <NotebooksPage /> },
      { path: "workspace/:cwd/runs", element: <RunsPage /> },
    ],
  },
]);
