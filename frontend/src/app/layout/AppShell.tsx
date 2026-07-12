import { Outlet, useNavigate, useLocation } from "react-router-dom";
import { useState, useEffect } from "react";
import { PanelLeft, Settings, MessageSquare, Plus, Trash2 } from "lucide-react";
import { useUiStore } from "../../lib/store";
import { useRuntimeStore } from "../../lib/runtime-store";
import { InspectorShell } from "../../components/inspector/InspectorShell";
import { RightPane } from "../../components/inspector/RightPane";
import { cn } from "../../lib/cn";
import { getClient, type SessionInfo } from "../../lib/pi-science-client";

export function AppShell() {
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const setSidebarCollapsed = useUiStore((s) => s.setSidebarCollapsed);
  const inspectorOpen = useUiStore((s) => s.inspectorOpen);
  const inspectorData = useUiStore((s) => s.inspectorData);
  const closeInspector = useUiStore((s) => s.closeInspector);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg text-text">
      {/* Sidebar */}
      {sidebarCollapsed ? (
        <button
          className="fade-in rounded p-1 text-text hover:bg-surface-2 absolute left-0 top-3 z-10"
          onClick={() => setSidebarCollapsed(false)}
          aria-label="Expand sidebar"
        >
          <PanelLeft size={16} />
        </button>
      ) : (
        <aside
          className="h-full flex-col border-r border-border bg-surface flex shrink-0 overflow-hidden"
          style={{ width: sidebarWidth }}
        >
          <div className="flex flex-col h-full px-3 py-4">
            {/* Header: Brand + Collapse */}
            <div className="flex items-center justify-between mb-4 px-2">
              <h1 className="font-serif text-[20px] font-semibold tracking-tight text-text">
                Pi-Science
              </h1>
              <button
                className="rounded p-1 text-muted hover:text-text hover:bg-surface-2"
                onClick={() => setSidebarCollapsed(true)}
                title="Collapse sidebar"
              >
                <PanelLeft size={14} />
              </button>
            </div>

            {/* Session history */}
            <SessionList />

            {/* Bottom: Status + Settings */}
            <div className="mt-auto">
              <div className="border-t border-faint my-3" />
              <StatusPills />
              <div className="mt-2">
                <SidebarNavItem to="/settings" label="Settings" icon={<Settings size={16} />} toggle="/" />
              </div>
            </div>
          </div>
        </aside>
      )}

      {/* Main */}
      <main className="flex-1 flex flex-col overflow-hidden min-w-0">
        <Outlet />
      </main>

      {/* Inspector */}
      {inspectorOpen && inspectorData && (
        <RightPane onClose={closeInspector}>
          <InspectorShell inspector={inspectorData} onClose={closeInspector} />
        </RightPane>
      )}
    </div>
  );
}

/* ── Session List ── */

function SessionList() {
  const sessions = useRuntimeStore((s) => s.sessions);
  const activeSessionId = useRuntimeStore((s) => s.activeSessionId);
  const loadSession = useRuntimeStore((s) => s.loadSession);
  const createNewSession = useRuntimeStore((s) => s.createNewSession);
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState<string | null>(null);

  const handleDelete = async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    if (deleting) return;
    setDeleting(sessionId);
    try {
      await getClient().deleteSession(sessionId);
      await useRuntimeStore.getState().loadSessions();
      if (activeSessionId === sessionId) {
        const newId = await createNewSession();
        navigate(`/session/${newId}`);
      }
    } catch (err) {
      console.error("Delete failed:", err);
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto flex flex-col min-h-0">
      <div className="flex items-center justify-between px-2 mb-1">
        <span className="text-xs font-medium uppercase tracking-wider text-muted">
          Sessions
        </span>
        <button
          onClick={async () => {
            const newId = await createNewSession();
            navigate(`/session/${newId}`);
          }}
          className="rounded p-0.5 text-muted hover:text-text hover:bg-surface-2"
          title="New session"
        >
          <Plus size={14} />
        </button>
      </div>
      <div className="flex flex-col gap-0.5 overflow-y-auto">
        {sessions.length === 0 ? (
          <p className="px-2 text-[12px] text-muted/60 italic">No sessions yet</p>
        ) : (
          sessions.slice(0, 30).map((s) => (
            <div key={s.id} className="group relative flex items-center rounded-input hover:bg-surface-2">
              <button
                onClick={() => {
                  loadSession(s.id);
                  navigate(`/session/${s.id}`);
                }}
                className={cn(
                  "flex items-center gap-2 min-w-0 flex-1 py-1 pl-2 pr-1 text-[13px] text-left",
                  activeSessionId === s.id
                    ? "text-text font-medium"
                    : "text-text/90",
                )}
                title={s.id}
              >
                <MessageSquare size={12} className="shrink-0 text-muted" />
                <span className="truncate flex-1">{s.name || s.id.slice(0, 8)}</span>
                {/* Time — hidden on hover, replaced by delete button */}
                {(s.updated_at || s.created_at) && (
                  <span className="text-[10px] text-muted/60 shrink-0 mr-1 group-hover:hidden">
                    {relativeTime(s.updated_at || s.created_at!)}
                  </span>
                )}
              </button>
              {/* Delete button — shown on hover in place of time */}
              <button
                onClick={(e) => handleDelete(e, s.id)}
                className={cn(
                  "shrink-0 rounded p-1 mr-1",
                  "text-muted hover:text-error hover:bg-error/10",
                  "hidden group-hover:block",
                  deleting === s.id && "block",
                )}
                title="Delete session"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/* ── Nav Item ── */

function SidebarNavItem({ to, label, icon, toggle }: { to: string; label: string; icon?: React.ReactNode; toggle?: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const active = location.pathname === to || (to !== "/" && location.pathname.startsWith(to));

  return (
    <button
      onClick={() => {
        if (active && toggle) {
          navigate(toggle);
        } else {
          navigate(to);
        }
      }}
      className={cn(
        "flex items-center gap-2.5 rounded-input px-2 py-1 text-[13px] text-left w-full",
        active ? "bg-surface-2 text-text font-medium" : "text-text/90 hover:bg-surface-2 hover:text-text",
      )}
    >
      {icon && <span className="shrink-0 text-muted">{icon}</span>}
      {label}
    </button>
  );
}

/* ── Status Pills ── */

function StatusPills() {
  const [health, setHealth] = useState<{ active_pi_processes: number; active_kernels: number } | null>(null);

  useEffect(() => {
    const poll = () => {
      fetch("/api/health")
        .then((r) => r.json())
        .then((d) => setHealth(d))
        .catch(() => setHealth(null));
    };
    poll();
    const i = setInterval(poll, 8000);
    return () => clearInterval(i);
  }, []);

  const runtimeTone = health ? "bg-ok" : "bg-muted";
  const runtimeLabel = health ? "Ready" : "Offline";
  const kernelTone = health?.active_kernels ? "bg-ok" : "bg-muted";
  const kernelLabel = health ? `${health.active_kernels ?? 0}` : "—";

  return (
    <div className="flex flex-col gap-1 text-xs text-muted">
      <Pill dot={runtimeTone} label="Agent" value={runtimeLabel} />
      <Pill dot={kernelTone} label="Kernel" value={kernelLabel} />
    </div>
  );
}

/* ── Helpers ── */

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function Pill({ dot, label, value }: { dot: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 px-2">
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot)} />
      <span className="shrink-0">{label}</span>
      <span className="ml-auto min-w-0 truncate text-text/70" title={value}>
        {value}
      </span>
    </div>
  );
}
