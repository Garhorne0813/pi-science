import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { expect, it } from "vitest";
import { LegacyWorkspaceRedirect } from "./LegacyWorkspaceRedirect";
function Location() { const location = useLocation(); return <output>{location.pathname + location.search}</output>; }
it.each(["research", "research/old-loop"])("redirects a historical %s bookmark to the archive access path", (path) => {
  render(<MemoryRouter initialEntries={[`/workspace/project/${path}`]}><Routes><Route path="/workspace/:cwd/*" element={<LegacyWorkspaceRedirect />} /><Route path="/workspace/:cwd/knowledge" element={<Location />} /></Routes></MemoryRouter>);
  expect(screen.getByRole("status")).toHaveTextContent("/workspace/project/knowledge?tab=research");
});
