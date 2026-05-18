import {
  Archive,
  ChevronUp,
  ChevronsDown,
  Folder,
  FolderGit2,
  GitFork,
  Home,
  LogOut,
  MessageSquarePlus,
  Minimize2,
  PauseCircle,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  X
} from "lucide-react";
import { SignInButton, SignUpButton, UserButton, useAuth, useClerk } from "@clerk/react";
import { FormEvent, memo, MouseEvent, PointerEvent, UIEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, RefObject } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  browseRepositories,
  createClerkSession,
  createRepository,
  deleteThreadLog,
  getAuth,
  getStatus,
  login,
  logout,
  openEventStream,
  restartServer,
  rpc
} from "./api";
import type { AuthState, JsonValue, RepositoryBrowser, ServerEvent, ServerStatus, Thread, ThreadItem, Turn, UiSettings } from "./types";
import { CLERK_PUBLISHABLE_KEY } from "./authConfig";

const defaultSettings: UiSettings = {
  cwd: "",
  model: "gpt-5.5",
  effort: "high",
  approvalPolicy: "on-request",
  sandbox: "danger-full-access"
};

type ComposerAction = "send" | "steer";
type MobilePane = "sessions" | "thread";
type ThreadPaneCount = 1 | 2 | 4;

const DEFAULT_RENDERED_TURNS = 40;
const SESSION_PAGE_SIZE = 50;
const mobilePanes: MobilePane[] = ["sessions", "thread"];

export default function App() {
  const [authInfo, setAuthInfo] = useState<AuthState | null>(null);
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [serverStatus, setServerStatus] = useState<ServerStatus>({ state: "stopped" });
  const [sessions, setSessions] = useState<Thread[]>([]);
  const [loadedThreadIds, setLoadedThreadIds] = useState<Set<string>>(new Set());
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [selectedThread, setSelectedThread] = useState<Thread | null>(null);
  const [openThreadIds, setOpenThreadIds] = useState<(string | null)[]>([null]);
  const [openThreads, setOpenThreads] = useState<Record<string, Thread>>({});
  const [activePaneIndex, setActivePaneIndex] = useState(0);
  const [sessionPreviews, setSessionPreviews] = useState<Record<string, string>>({});
  const [sessionPage, setSessionPage] = useState(1);
  const [hasMoreSessions, setHasMoreSessions] = useState(false);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(new Set());
  const [sidebarWidth, setSidebarWidth] = useState(330);
  const [showArchived, setShowArchived] = useState(false);
  const [recentOnly, setRecentOnly] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [mobilePane, setMobilePane] = useState<MobilePane>("sessions");
  const [threadPaneCount, setThreadPaneCount] = useState<ThreadPaneCount>(1);
  const [toast, setToast] = useState("");
  const [settings, setSettings] = useState<UiSettings>({ ...defaultSettings });
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [activeTurns, setActiveTurns] = useState<Record<string, string>>({});

  const eventSourceRef = useRef<EventSource | null>(null);
  const refreshTimerRef = useRef<number | null>(null);
  const listTimerRef = useRef<number | null>(null);
  const openThreadIdsRef = useRef<(string | null)[]>([null]);
  const touchStartRef = useRef<{ x: number; y: number; paneSwipeBlocked: boolean } | null>(null);
  const resizingSidebarRef = useRef(false);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressActivatedRef = useRef(false);
  const sessionClickTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      clearSessionLongPress();
      clearSessionClickTimer();
    };
  }, []);

  useEffect(() => {
    getAuth()
      .then(applyAuth)
      .catch(() => setAuthenticated(false));
  }, []);

  useEffect(() => {
    if (!authenticated) {
      return;
    }
    getStatus().then(setServerStatus).catch(showToast);
    loadSessions();
    eventSourceRef.current?.close();
    const source = openEventStream(
      (event) => {
        handleServerEvent(event);
      },
      () => undefined
    );
    source.onerror = () => setServerStatus((current) => ({ ...current, state: "disconnected", error: "Event stream disconnected" }));
    eventSourceRef.current = source;
    return () => {
      source.close();
    };
  }, [authenticated]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (authenticated) {
        loadSessions();
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [showArchived, searchTerm, sessionPage]);

  const mergedSessions = useMemo(() => [...sessions].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)), [sessions]);
  const visibleThreads = useMemo(() => (recentOnly ? mostRecentThreadsByFolder(mergedSessions) : mergedSessions), [mergedSessions, recentOnly]);
  const groupedThreads = useMemo(() => groupThreadsByFolder(visibleThreads), [visibleThreads]);
  const paneThreadIds = useMemo(
    () => Array.from({ length: threadPaneCount }, (_, index) => openThreadIds[index] ?? null),
    [openThreadIds, threadPaneCount]
  );
  const selectionActive = selectedSessionIds.size > 0;

  useEffect(() => {
    setOpenThreadIds((current) => Array.from({ length: threadPaneCount }, (_, index) => current[index] ?? null));
    setActivePaneIndex((current) => Math.min(current, threadPaneCount - 1));
  }, [threadPaneCount]);

  useEffect(() => {
    openThreadIdsRef.current = openThreadIds;
  }, [openThreadIds]);

  if (authenticated === null) {
    return <div className="boot">Loading</div>;
  }

  if (!authenticated) {
    return (
      <main className="login-screen">
        {authInfo?.mode === "clerk" ? (
          <ClerkLoginPanel
            error={loginError}
            onError={setLoginError}
            onAuthenticated={async () => {
              applyAuth(await getAuth());
            }}
          />
        ) : (
        <form className="login-panel" onSubmit={handleLogin}>
          <div>
            <p className="eyebrow">Remote control</p>
            <h1>Codex Web UI</h1>
          </div>
          <label className="field">
            <span>Password</span>
            <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoFocus />
          </label>
          <button className="primary-button" type="submit">
            Sign in
          </button>
          <p className="error-text">{loginError}</p>
        </form>
        )}
      </main>
    );
  }

  return (
    <main className={`app-shell ${authInfo?.warning ? "auth-warning-mode" : ""}`}>
      <header className="topbar">
        <div className="brand-block">
          <div className="mark">CX</div>
          <div>
            <strong>Codex Web UI</strong>
            <span>{serverStatus.error || `${serverStatus.command ?? "codex"} in ${serverStatus.cwd ?? ""}`}</span>
            {authInfo?.warning && <span className="auth-warning-text">{authInfo.warning}</span>}
          </div>
        </div>
        <div className="top-actions">
          <StatusBadge value={serverStatus.state} />
          <button className="ghost-button" type="button" onClick={handleRestart}>
            <RefreshCw size={16} /> Reconnect
          </button>
          <LogoutButton authMode={authInfo?.mode ?? "password"} onLogout={handleLogout} />
        </div>
      </header>

      <nav className="mobile-pane-tabs" aria-label="Panes">
        <button className={mobilePane === "sessions" ? "selected" : ""} type="button" onClick={() => setMobilePane("sessions")}>
          Threads
        </button>
        <button className={mobilePane === "thread" ? "selected" : ""} type="button" onClick={() => setMobilePane("thread")}>
          Thread
        </button>
      </nav>

      <section
        style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
        className={`layout mobile-pane-${mobilePane}`}
        onTouchStart={(event) => {
          const touch = event.touches[0];
          touchStartRef.current = touch
            ? { x: touch.clientX, y: touch.clientY, paneSwipeBlocked: isWithinHorizontalScroller(event.target, event.currentTarget) }
            : null;
        }}
        onTouchEnd={(event) => {
          const start = touchStartRef.current;
          const touch = event.changedTouches[0];
          touchStartRef.current = null;
          if (!start || !touch) {
            return;
          }
          if (start.paneSwipeBlocked) {
            return;
          }
          const deltaX = touch.clientX - start.x;
          const deltaY = touch.clientY - start.y;
          if (Math.abs(deltaX) < 70 || Math.abs(deltaX) < Math.abs(deltaY) * 1.3) {
            return;
          }
          switchMobilePane(deltaX < 0 ? 1 : -1);
        }}
      >
        <aside className="sessions-panel">
          <div className="panel-heading">
            <div>
              <h2>Threads</h2>
              <span>{visibleThreads.length}{hasMoreSessions ? "+" : ""} loaded</span>
            </div>
            <div className="panel-actions">
              <label className="compact-checkbox" title="Show only recent threads">
                <input type="checkbox" checked={recentOnly} onChange={(event) => setRecentOnlyFilter(event.target.checked)} />
                <span>Recent</span>
              </label>
              <label className="compact-checkbox" title="Show archived threads">
                <input type="checkbox" checked={showArchived} onChange={(event) => switchArchiveFilter(event.target.checked)} />
                <span>Archived</span>
              </label>
              <button className="icon-button" type="button" onClick={() => loadSessions()} title="Refresh threads" aria-label="Refresh threads">
                <RefreshCw size={17} />
              </button>
              <button className="icon-button" type="button" onClick={() => setNewSessionOpen(true)} title="New thread" aria-label="New thread">
                <MessageSquarePlus size={18} />
              </button>
            </div>
          </div>
          <div className="session-tools">
            <label className="field">
              <span>Search</span>
              <input
                value={searchTerm}
                onChange={(event) => {
                  setSessionPage(1);
                  clearSessionSelection();
                  setSearchTerm(event.target.value);
                }}
                placeholder="Title, preview, cwd"
              />
            </label>
            {selectionActive && (
              <div className="selection-tools">
                <span>{selectedSessionIds.size} selected</span>
                <button className="secondary-button" type="button" onClick={archiveSelectedSessions}>
                  <Archive size={15} /> {showArchived ? "Unarchive" : "Archive"}
                </button>
                {showArchived && (
                  <button className="danger-button" type="button" onClick={deleteSelectedArchiveFiles}>
                    <Trash2 size={15} /> Delete file
                  </button>
                )}
                <button className="icon-button" type="button" onClick={clearSessionSelection} title="Clear selection" aria-label="Clear selection">
                  <X size={16} />
                </button>
              </div>
            )}
          </div>
          <div className={`sessions-list ${selectionActive ? "selecting" : ""}`} onScroll={handleSessionsScroll}>
            {mergedSessions.length === 0 ? (
              <p className="muted empty-pad">No threads found.</p>
            ) : (
              groupedThreads.map((group) => (
                <section className="thread-group" key={group.key}>
                  <div className="thread-group-heading">
                    <strong>{group.label}</strong>
                    <span>{group.threads.length}</span>
                  </div>
                  {group.threads.map((thread) => (
                    <button
                      key={thread.id}
                      type="button"
                      className={`session-row ${thread.id === selectedThreadId ? "selected" : ""} ${selectedSessionIds.has(thread.id) ? "multi-selected" : ""}`}
                      aria-pressed={selectedSessionIds.has(thread.id)}
                      onClick={(event) => handleSessionRowClick(event, thread.id)}
                      onContextMenu={(event) => event.preventDefault()}
                      onPointerDown={(event) => startSessionLongPress(event, thread.id)}
                      onPointerUp={clearSessionLongPress}
                      onPointerCancel={clearSessionLongPress}
                      onPointerLeave={clearSessionLongPress}
                    >
                      <span className="session-check" aria-hidden="true" />
                      <strong>{titleForThread(thread)}</strong>
                      <p>{sessionPreviews[thread.id] || thread.preview || thread.id}</p>
                      <div className="session-meta-row">
                        <StatusBadge value={statusType(thread)} />
                        <span className="muted">{formatDate(thread.updatedAt)}</span>
                      </div>
                    </button>
                  ))}
                </section>
              ))
            )}
            {hasMoreSessions && (
              <button className="load-more-button" type="button" onClick={loadMoreSessions} disabled={sessionsLoading}>
                {sessionsLoading ? "Loading" : "Load more"}
              </button>
            )}
          </div>
        </aside>
        <div
          className="sidebar-resizer"
          role="separator"
          aria-label="Resize threads sidebar"
          aria-orientation="vertical"
          onPointerDown={(event) => {
            resizingSidebarRef.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (!resizingSidebarRef.current) {
              return;
            }
            setSidebarWidth(Math.min(520, Math.max(240, event.clientX)));
          }}
          onPointerUp={(event) => {
            resizingSidebarRef.current = false;
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => {
            resizingSidebarRef.current = false;
          }}
        />

        <section className={`thread-workspace panes-${threadPaneCount}`}>
          <div className="thread-view-controls" aria-label="Thread layout">
            {[1, 2, 4].map((count) => (
              <button
                className={threadPaneCount === count ? "selected" : ""}
                key={count}
                type="button"
                onClick={() => setThreadPaneCount(count as ThreadPaneCount)}
              >
                {count}
              </button>
            ))}
          </div>
          <div className="thread-grid">
            {paneThreadIds.map((threadId, paneIndex) => {
              const thread = threadId ? openThreads[threadId] ?? null : null;
              return (
                <ThreadPane
                  activeTurnId={thread ? activeTurnFromThread(thread) || activeTurns[thread.id] || null : null}
                  allThreads={mergedSessions}
                  archiveLabel={showArchived ? "Unarchive" : "Archive"}
                  isActive={paneIndex === activePaneIndex}
                  key={paneIndex}
                  onActivate={() => setActivePaneIndex(paneIndex)}
                  onArchive={() => thread && archiveThread(thread, paneIndex)}
                  onCompact={() => thread && compactThread(thread)}
                  onFork={() => thread && forkThread(thread, paneIndex)}
                  onInterrupt={() => thread && interruptThread(thread)}
                  onRename={(name) => (thread ? renameThread(thread, name) : Promise.resolve())}
                  onSelectThread={(nextThreadId) => selectThread(nextThreadId, paneIndex)}
                  onSend={(text, action) => (thread ? sendMessageText(thread, text, action) : Promise.resolve(false))}
                  paneCount={threadPaneCount}
                  thread={thread}
                />
              );
            })}
          </div>
        </section>

      </section>

      {newSessionOpen && (
        <SessionModal
          title="New Thread"
          settings={settings}
          onClose={() => setNewSessionOpen(false)}
          onSubmit={createSession}
          includePrompt
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </main>
  );

  async function handleLogin(event: FormEvent) {
    event.preventDefault();
    setLoginError("");
    try {
      await login(password);
      setPassword("");
      applyAuth(await getAuth());
    } catch (error) {
      setLoginError(messageFromError(error));
    }
  }

  async function handleLogout() {
    await logout().catch(() => undefined);
    eventSourceRef.current?.close();
    applyAuth(await getAuth().catch(() => ({ authenticated: false, mode: "password" })));
  }

  function applyAuth(nextAuth: AuthState) {
    setAuthInfo(nextAuth);
    setAuthenticated(nextAuth.authenticated);
  }

  async function handleRestart() {
    try {
      setServerStatus(await restartServer());
      showToast("App server reconnected");
      await loadSessions();
    } catch (error) {
      showToast(error);
    }
  }

  async function loadSessions(page = sessionPage) {
    setSessionsLoading(true);
    try {
      const limit = page * SESSION_PAGE_SIZE;
      const params: Record<string, JsonValue> = {
        archived: showArchived,
        limit,
        sortKey: "updated_at",
        sortDirection: "desc"
      };
      if (searchTerm.trim()) {
        params.searchTerm = searchTerm.trim();
      }
      const [threadResult, loadedResult] = await Promise.allSettled([
        rpc<{ data: Thread[] }>("thread/list", params),
        rpc<{ data: string[] }>("thread/loaded/list", { limit: 500 })
      ]);
      if (threadResult.status === "fulfilled") {
        const nextSessions = threadResult.value.data ?? [];
        setSessions(nextSessions);
        setHasMoreSessions(nextSessions.length >= limit);
        setSessionPreviews((current) => {
          const next = { ...current };
          for (const thread of nextSessions) {
            if (!next[thread.id] && thread.preview) {
              next[thread.id] = thread.preview;
            }
          }
          return next;
        });
      }
      if (loadedResult.status === "fulfilled") {
        setLoadedThreadIds(new Set(loadedResult.value.data ?? []));
      }
      if (threadResult.status === "rejected") {
        throw threadResult.reason;
      }
    } catch (error) {
      showToast(error);
    } finally {
      setSessionsLoading(false);
    }
  }

  function switchArchiveFilter(archived: boolean) {
    setShowArchived(archived);
    setSessionPage(1);
    clearSessionSelection();
  }

  function setRecentOnlyFilter(enabled: boolean) {
    clearSessionSelection();
    setRecentOnly(enabled);
  }

  function loadMoreSessions() {
    if (sessionsLoading || !hasMoreSessions) {
      return;
    }
    setSessionsLoading(true);
    setSessionPage((current) => current + 1);
  }

  function handleSessionsScroll(event: UIEvent<HTMLDivElement>) {
    const element = event.currentTarget;
    if (element.scrollHeight - element.scrollTop - element.clientHeight < 120) {
      loadMoreSessions();
    }
  }

  function handleSessionRowClick(event: MouseEvent<HTMLButtonElement>, threadId: string) {
    if (longPressActivatedRef.current) {
      longPressActivatedRef.current = false;
      return;
    }
    if (selectionActive) {
      toggleSessionSelection(threadId);
      return;
    }
    if (event.detail > 1) {
      clearSessionClickTimer();
      toggleSessionSelection(threadId);
      return;
    }
    clearSessionClickTimer();
    sessionClickTimerRef.current = window.setTimeout(() => {
      sessionClickTimerRef.current = null;
      selectThread(threadId, activePaneIndex);
    }, 220);
  }

  function startSessionLongPress(event: PointerEvent<HTMLButtonElement>, threadId: string) {
    if (event.pointerType === "mouse") {
      return;
    }
    clearSessionLongPress();
    longPressActivatedRef.current = false;
    longPressTimerRef.current = window.setTimeout(() => {
      longPressActivatedRef.current = true;
      toggleSessionSelection(threadId);
    }, 550);
  }

  function clearSessionLongPress() {
    if (longPressTimerRef.current) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }

  function clearSessionClickTimer() {
    if (sessionClickTimerRef.current) {
      window.clearTimeout(sessionClickTimerRef.current);
      sessionClickTimerRef.current = null;
    }
  }

  function toggleSessionSelection(threadId: string) {
    setSelectedSessionIds((current) => {
      const next = new Set(current);
      if (next.has(threadId)) {
        next.delete(threadId);
      } else {
        next.add(threadId);
      }
      return next;
    });
  }

  function clearSessionSelection() {
    setSelectedSessionIds(new Set());
  }

  async function archiveSelectedSessions() {
    const threadIds = [...selectedSessionIds];
    if (threadIds.length === 0) {
      return;
    }
    const method = showArchived ? "thread/unarchive" : "thread/archive";
    try {
      await Promise.all(threadIds.map((threadId) => rpc(method, { threadId })));
      if (!showArchived) {
        closeOpenThreads(threadIds);
      }
      clearSessionSelection();
      await loadSessions(1);
      setSessionPage(1);
    } catch (error) {
      showToast(error);
    }
  }

  async function deleteSelectedArchiveFiles() {
    const threadIds = [...selectedSessionIds];
    if (threadIds.length === 0 || !window.confirm(`Delete ${threadIds.length} selected archive file${threadIds.length === 1 ? "" : "s"}?`)) {
      return;
    }
    try {
      await Promise.all(threadIds.map(async (threadId) => {
        await rpc("thread/delete", { threadId }).catch(() => undefined);
        await deleteThreadLog(threadId);
      }));
      closeOpenThreads(threadIds);
      clearSessionSelection();
      await loadSessions(1);
      setSessionPage(1);
    } catch (error) {
      showToast(error);
    }
  }

  function rememberOpenThread(thread: Thread, paneIndex = activePaneIndex) {
    const targetPaneIndex = Math.min(threadPaneCount - 1, Math.max(0, paneIndex));
    setOpenThreads((current) => ({ ...current, [thread.id]: thread }));
    setOpenThreadIds((current) => {
      const next = Array.from({ length: threadPaneCount }, (_, index) => current[index] ?? null);
      next[targetPaneIndex] = thread.id;
      return next;
    });
    if (targetPaneIndex === activePaneIndex) {
      setSelectedThreadId(thread.id);
      setSelectedThread(thread);
    }
  }

  function closeOpenThreads(threadIds: string[]) {
    const closing = new Set(threadIds);
    setOpenThreadIds((current) => current.map((id) => (id && closing.has(id) ? null : id)));
    setOpenThreads((current) => {
      const next = { ...current };
      for (const threadId of closing) {
        delete next[threadId];
      }
      return next;
    });
    setSelectedThread((current) => (current && closing.has(current.id) ? null : current));
    setSelectedThreadId((current) => (current && closing.has(current) ? null : current));
  }

  async function selectThread(threadId: string, paneIndex = activePaneIndex) {
    setActivePaneIndex(paneIndex);
    setSelectedThreadId(threadId);
    setMobilePane("thread");
    const thread = await resumeThread(threadId, paneIndex);
    if (thread) {
      setSelectedThread(thread);
    }
  }

  async function readThread(threadId: string, paneIndex = openThreadIds.indexOf(threadId)): Promise<Thread | null> {
    try {
      const result = await rpc<{ thread: Thread }>("thread/read", { threadId, includeTurns: true });
      rememberOpenThread(result.thread, paneIndex >= 0 ? paneIndex : activePaneIndex);
      rememberSessionPreview(result.thread);
      rememberActiveTurn(result.thread);
      return result.thread;
    } catch (error) {
      showToast(error);
      return null;
    }
  }

  async function resumeThread(threadId: string, paneIndex = activePaneIndex): Promise<Thread | null> {
    try {
      const result = await rpc<{ thread: Thread }>("thread/resume", buildThreadLoadParams(threadId));
      rememberOpenThread(result.thread, paneIndex);
      rememberSessionPreview(result.thread);
      rememberActiveTurn(result.thread);
      setLoadedThreadIds((current) => new Set([...current, result.thread.id]));
      scheduleThreadRefresh(result.thread.id, 700);
      scheduleListRefresh(1000);
      return result.thread;
    } catch (error) {
      return readThread(threadId, paneIndex);
    }
  }

  async function sendMessageText(selected: Thread, text: string, action: ComposerAction = "send"): Promise<boolean> {
    const trimmedText = text.trim();
    if (!trimmedText) {
      return false;
    }
    try {
      let thread = selected;
      if (!loadedThreadIds.has(thread.id) || statusType(thread) === "notLoaded") {
        const resumed = await rpc<{ thread: Thread }>("thread/resume", buildThreadLoadParams(thread.id));
        thread = resumed.thread;
        const paneIndex = openThreadIds.indexOf(thread.id);
        rememberOpenThread(thread, paneIndex >= 0 ? paneIndex : activePaneIndex);
        setLoadedThreadIds((current) => new Set([...current, thread.id]));
      }

      const currentActiveTurn = activeTurnFromThread(thread) || activeTurns[thread.id];
      if (action === "steer") {
        if (!currentActiveTurn) {
          throw new Error("No active turn is available to steer");
        }
        await rpc("turn/steer", {
          threadId: thread.id,
          expectedTurnId: currentActiveTurn,
          input: [{ type: "text", text: trimmedText }]
        });
      } else {
        await rpc("turn/start", buildTurnStartParams(thread.id, trimmedText));
      }
      scheduleThreadRefresh(thread.id, 800);
      scheduleListRefresh(1200);
      return true;
    } catch (error) {
      showToast(error);
      return false;
    }
  }

  async function interruptThread(thread: Thread) {
    const turnId = activeTurnFromThread(thread) || activeTurns[thread.id];
    if (!turnId) {
      return;
    }
    try {
      await rpc("turn/interrupt", { threadId: thread.id, turnId });
      scheduleThreadRefresh(thread.id, 600);
    } catch (error) {
      showToast(error);
    }
  }

  async function renameThread(thread: Thread, name: string) {
    const trimmed = name.trim();
    if (!trimmed || trimmed === titleForThread(thread)) {
      return;
    }
    try {
      await rpc("thread/name/set", { threadId: thread.id, name: trimmed });
      setOpenThreads((current) => ({ ...current, [thread.id]: { ...thread, name: trimmed } }));
      setSelectedThread((current) => (current?.id === thread.id ? { ...current, name: trimmed } : current));
      setSessions((current) => current.map((item) => (item.id === thread.id ? { ...item, name: trimmed } : item)));
      await readThread(thread.id);
      await loadSessions();
    } catch (error) {
      showToast(error);
    }
  }

  async function forkThread(thread: Thread, paneIndex = activePaneIndex) {
    try {
      const result = await rpc<{ thread: Thread }>("thread/fork", { ...buildThreadLoadParams(thread.id), ephemeral: false, threadSource: "user" });
      rememberOpenThread(result.thread, paneIndex);
      setShowArchived(false);
      await loadSessions();
    } catch (error) {
      showToast(error);
    }
  }

  async function compactThread(thread: Thread) {
    if (!window.confirm("Start context compaction for this thread?")) {
      return;
    }
    try {
      await rpc("thread/compact/start", { threadId: thread.id });
      showToast("Compaction started");
    } catch (error) {
      showToast(error);
    }
  }

  async function archiveThread(thread: Thread, paneIndex = activePaneIndex) {
    try {
      if (showArchived) {
        const result = await rpc<{ thread: Thread }>("thread/unarchive", { threadId: thread.id });
        rememberOpenThread(result.thread, paneIndex);
        setShowArchived(false);
      } else {
        await rpc("thread/archive", { threadId: thread.id });
        setOpenThreadIds((current) => current.map((id) => (id === thread.id ? null : id)));
        setOpenThreads((current) => {
          const next = { ...current };
          delete next[thread.id];
          return next;
        });
        if (selectedThreadId === thread.id) {
          setSelectedThread(null);
          setSelectedThreadId(null);
        }
      }
      await loadSessions();
    } catch (error) {
      showToast(error);
    }
  }

  async function createSession(input: { settings: UiSettings; prompt: string }) {
    try {
      setSettings(input.settings);
      const params = compact({
        cwd: input.settings.cwd || null,
        model: input.settings.model || null,
        approvalPolicy: input.settings.approvalPolicy || null,
        sandbox: input.settings.sandbox || null,
        threadSource: "user"
      });
      const result = await rpc<{ thread: Thread }>("thread/start", params);
      rememberOpenThread(result.thread, activePaneIndex);
      setNewSessionOpen(false);
      setShowArchived(false);
      await loadSessions();
      if (input.prompt.trim()) {
        await rpc("turn/start", buildTurnStartParams(result.thread.id, input.prompt.trim(), input.settings));
        scheduleThreadRefresh(result.thread.id, 900);
      }
    } catch (error) {
      showToast(error);
    }
  }

  function handleServerEvent(event: ServerEvent) {
    if (event.type === "server-status") {
      setServerStatus(event.payload as ServerStatus);
      return;
    }
    if (event.type !== "notification") {
      return;
    }
    const payload = asRecord(event.payload);
    const method = typeof payload.method === "string" ? payload.method : "";
    const params = asRecord(payload.params);
    const threadId = typeof params.threadId === "string" ? params.threadId : threadIdFromThread(params.thread);

    if (method === "turn/started" && threadId) {
      const turn = asRecord(params.turn);
      if (typeof turn.id === "string") {
        setActiveTurns((current) => ({ ...current, [threadId]: turn.id as string }));
      }
      scheduleThreadRefresh(threadId, 800);
    }
    if (method === "turn/completed" && threadId) {
      setActiveTurns((current) => {
        const next = { ...current };
        delete next[threadId];
        return next;
      });
      scheduleThreadRefresh(threadId, 600);
      scheduleListRefresh(1200);
    }
    if (method === "thread/status/changed" && threadId) {
      const status = params.status;
      setSessions((current) => current.map((thread) => (thread.id === threadId ? { ...thread, status: status as Thread["status"] } : thread)));
      setOpenThreads((current) => (current[threadId] ? { ...current, [threadId]: { ...current[threadId], status: status as Thread["status"] } } : current));
      setSelectedThread((current) => (current?.id === threadId ? { ...current, status: status as Thread["status"] } : current));
    }
    if (threadId && openThreadIdsRef.current.includes(threadId) && method.startsWith("item/")) {
      scheduleThreadRefresh(threadId, 800);
    }
  }

  function rememberActiveTurn(thread: Thread) {
    const turnId = activeTurnFromThread(thread);
    if (turnId) {
      setActiveTurns((current) => ({ ...current, [thread.id]: turnId }));
    }
  }

  function rememberSessionPreview(thread: Thread) {
    const preview = lastMessagePreview(thread);
    if (!preview) {
      return;
    }
    setSessionPreviews((current) => ({ ...current, [thread.id]: preview }));
  }

  function scheduleThreadRefresh(threadId: string, delay: number) {
    const paneIndex = openThreadIdsRef.current.indexOf(threadId);
    if (paneIndex < 0) {
      return;
    }
    if (refreshTimerRef.current) {
      window.clearTimeout(refreshTimerRef.current);
    }
    refreshTimerRef.current = window.setTimeout(() => readThread(threadId, paneIndex), delay);
  }

  function scheduleListRefresh(delay: number) {
    if (listTimerRef.current) {
      window.clearTimeout(listTimerRef.current);
    }
    listTimerRef.current = window.setTimeout(() => loadSessions(), delay);
  }

  function buildThreadLoadParams(threadId: string): Record<string, JsonValue> {
    return compact({
      threadId,
      cwd: settings.cwd || null,
      model: settings.model || null,
      sandbox: settings.sandbox || null
    });
  }

  function buildTurnStartParams(threadId: string, text: string, overrides: UiSettings = settings): Record<string, JsonValue> {
    return compact({
      threadId,
      input: [{ type: "text", text }],
      cwd: overrides.cwd || null,
      model: overrides.model || null,
      effort: overrides.effort || null,
      approvalPolicy: overrides.approvalPolicy || null,
      sandboxPolicy: sandboxPolicyFor(overrides.sandbox)
    });
  }

  function showToast(error: unknown) {
    setToast(messageFromError(error));
    window.setTimeout(() => setToast(""), 4200);
  }

  function switchMobilePane(direction: 1 | -1) {
    setMobilePane((current) => {
      const index = mobilePanes.indexOf(current);
      const nextIndex = Math.min(mobilePanes.length - 1, Math.max(0, index + direction));
      return mobilePanes[nextIndex] ?? current;
    });
  }
}

const ThreadPane = memo(function ThreadPane({
  activeTurnId,
  allThreads,
  archiveLabel,
  isActive,
  onActivate,
  onArchive,
  onCompact,
  onFork,
  onInterrupt,
  onRename,
  onSelectThread,
  onSend,
  paneCount,
  thread
}: {
  activeTurnId: string | null;
  allThreads: Thread[];
  archiveLabel: string;
  isActive: boolean;
  onActivate: () => void;
  onArchive: () => void;
  onCompact: () => void;
  onFork: () => void;
  onInterrupt: () => void;
  onRename: (name: string) => Promise<void>;
  onSelectThread: (threadId: string) => void;
  onSend: (text: string, action?: ComposerAction) => Promise<boolean>;
  paneCount: ThreadPaneCount;
  thread: Thread | null;
}) {
  const [topHidden, setTopHidden] = useState(false);
  const conversationRef = useRef<HTMLDivElement | null>(null);
  const conversationScrollTopRef = useRef(0);
  const lastThreadViewRef = useRef("");
  const lastItemCountRef = useRef(0);
  const itemCount = useMemo(() => (thread?.turns ?? []).reduce((count, turn) => count + (turn.items?.length ?? 0), 0), [thread?.turns]);

  useEffect(() => {
    if (!thread) {
      lastThreadViewRef.current = "";
      lastItemCountRef.current = 0;
      setTopHidden(false);
      return;
    }
    if (lastThreadViewRef.current !== thread.id) {
      lastThreadViewRef.current = thread.id;
      lastItemCountRef.current = itemCount;
      setTopHidden(false);
      scrollToEnd();
      return;
    }
    if (itemCount > lastItemCountRef.current) {
      scrollToEnd();
    }
    lastItemCountRef.current = itemCount;
  }, [itemCount, thread]);

  function handleConversationScroll(event: UIEvent<HTMLDivElement>) {
    const nextTop = event.currentTarget.scrollTop;
    const previousTop = conversationScrollTopRef.current;
    conversationScrollTopRef.current = nextTop;
    if (nextTop < 24) {
      setTopHidden(false);
      return;
    }
    if (nextTop > previousTop + 8) {
      setTopHidden(true);
    } else if (nextTop < previousTop - 8) {
      setTopHidden(false);
    }
  }

  function scrollToEnd() {
    window.requestAnimationFrame(() => {
      const element = conversationRef.current;
      if (!element) {
        return;
      }
      element.scrollTop = element.scrollHeight;
      conversationScrollTopRef.current = element.scrollTop;
    });
  }

  return (
    <section className={`thread-panel ${topHidden ? "top-hidden" : ""} ${isActive ? "active" : ""}`} onPointerDown={onActivate}>
      <header className="thread-header">
        {paneCount > 1 && (
          <select className="thread-select" value={thread?.id ?? ""} onChange={(event) => event.target.value && onSelectThread(event.target.value)}>
            <option value="">Select thread</option>
            {allThreads.map((item) => (
              <option key={item.id} value={item.id}>{projectNameForThread(item)} - {titleForThread(item)}</option>
            ))}
          </select>
        )}
        {thread ? (
          <div className="thread-title-block">
            <StatusBadge value={statusType(thread)} />
            <EditableThreadTitle thread={thread} onRename={onRename} />
            <p>{thread.cwd || "cwd unavailable"} | {thread.id}</p>
          </div>
        ) : (
          <div className="thread-title-block empty">
            <h2>Select a thread</h2>
            <p>Choose a thread from the list or selector.</p>
          </div>
        )}
      </header>
      {thread ? (
        <>
          <div className="conversation" ref={conversationRef} onScroll={handleConversationScroll}>
            <TurnHistory threadId={thread.id} turns={thread.turns ?? []} scrollContainerRef={conversationRef} />
          </div>
          <Composer
            activeTurnId={activeTurnId}
            onInterrupt={onInterrupt}
            onSend={onSend}
            onFork={onFork}
            onCompact={onCompact}
            onArchive={onArchive}
            archiveLabel={archiveLabel}
          />
        </>
      ) : (
        <div className="empty-state">
          <h2>Select a thread</h2>
          <p>Choose an existing thread or start a new one.</p>
        </div>
      )}
    </section>
  );
});

function ClerkLoginPanel({
  error,
  onAuthenticated,
  onError
}: {
  error: string;
  onAuthenticated: () => Promise<void>;
  onError: (error: string) => void;
}) {
  if (!CLERK_PUBLISHABLE_KEY) {
    return (
      <div className="login-panel auth-error-panel">
        <div>
          <p className="eyebrow">Clerk auth</p>
          <h1>Missing publishable key</h1>
        </div>
        <p className="error-text">Set VITE_CLERK_PUBLISHABLE_KEY for the client when Clerk auth is enabled on the server.</p>
      </div>
    );
  }
  return <ClerkLoginPanelInner error={error} onAuthenticated={onAuthenticated} onError={onError} />;
}

function ClerkLoginPanelInner({
  error,
  onAuthenticated,
  onError
}: {
  error: string;
  onAuthenticated: () => Promise<void>;
  onError: (error: string) => void;
}) {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const exchangeInFlightRef = useRef(false);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || exchangeInFlightRef.current) {
      return;
    }
    exchangeInFlightRef.current = true;
    onError("");
    getToken()
      .then((token) => {
        if (!token) {
          throw new Error("Clerk did not return a session token.");
        }
        return createClerkSession(token);
      })
      .then(onAuthenticated)
      .catch((err) => {
        exchangeInFlightRef.current = false;
        onError(messageFromError(err));
      });
  }, [getToken, isLoaded, isSignedIn, onAuthenticated, onError]);

  return (
    <div className="login-panel">
      <div>
        <p className="eyebrow">Clerk OAuth</p>
        <h1>Codex Web UI</h1>
      </div>
      <p className="muted">Sign in with Clerk. Access is allowed only for users with active Clerk metadata.</p>
      <div className="clerk-login-actions">
        <SignInButton mode="modal">
          <button className="primary-button" type="button">Sign in</button>
        </SignInButton>
        <SignUpButton mode="modal">
          <button className="secondary-button" type="button">Register</button>
        </SignUpButton>
        {isSignedIn && <UserButton />}
      </div>
      <p className="error-text">{error || (isSignedIn ? "Checking account access..." : "")}</p>
    </div>
  );
}

function LogoutButton({ authMode, onLogout }: { authMode: AuthState["mode"]; onLogout: () => Promise<void> }) {
  if (authMode === "clerk" && CLERK_PUBLISHABLE_KEY) {
    return <ClerkLogoutButton onLogout={onLogout} />;
  }
  return (
    <button className="ghost-button" type="button" onClick={onLogout}>
      <LogOut size={16} /> Logout
    </button>
  );
}

function ClerkLogoutButton({ onLogout }: { onLogout: () => Promise<void> }) {
  const { signOut } = useClerk();
  return (
    <button
      className="ghost-button"
      type="button"
      onClick={async () => {
        await onLogout();
        await signOut();
      }}
    >
      <LogOut size={16} /> Logout
    </button>
  );
}

const TurnHistory = memo(function TurnHistory({
  scrollContainerRef,
  threadId,
  turns
}: {
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  threadId: string;
  turns: Turn[];
}) {
  const [visibleCount, setVisibleCount] = useState(DEFAULT_RENDERED_TURNS);
  const pendingScrollHeightRef = useRef<number | null>(null);
  const visibleTurns = useMemo(() => turns.slice(-visibleCount), [turns, visibleCount]);
  const hiddenCount = Math.max(0, turns.length - visibleTurns.length);

  useEffect(() => {
    setVisibleCount(DEFAULT_RENDERED_TURNS);
    pendingScrollHeightRef.current = null;
  }, [threadId]);

  useEffect(() => {
    const element = scrollContainerRef.current;
    if (!element || hiddenCount === 0) {
      return;
    }
    const handleScroll = () => {
      if (element.scrollTop > 80 || pendingScrollHeightRef.current !== null) {
        return;
      }
      pendingScrollHeightRef.current = element.scrollHeight;
      setVisibleCount((current) => Math.min(turns.length, current + DEFAULT_RENDERED_TURNS));
    };
    element.addEventListener("scroll", handleScroll);
    return () => element.removeEventListener("scroll", handleScroll);
  }, [hiddenCount, scrollContainerRef, turns.length]);

  useLayoutEffect(() => {
    const previousHeight = pendingScrollHeightRef.current;
    const element = scrollContainerRef.current;
    if (previousHeight === null || !element) {
      return;
    }
    element.scrollTop += element.scrollHeight - previousHeight;
    pendingScrollHeightRef.current = null;
  }, [scrollContainerRef, visibleCount]);

  if (turns.length === 0) {
    return (
      <div className="empty-state inline">
        <h2>No turns loaded</h2>
        <p>Select a thread or send a message.</p>
      </div>
    );
  }
  return (
    <>
      {hiddenCount > 0 && (
        <div className="history-limit">
          Showing latest {visibleTurns.length} of {turns.length} turns.
          <button
            type="button"
            onClick={() => {
              const element = scrollContainerRef.current;
              pendingScrollHeightRef.current = element?.scrollHeight ?? null;
              setVisibleCount((current) => Math.min(turns.length, current + DEFAULT_RENDERED_TURNS));
            }}
          >
            Load earlier
          </button>
        </div>
      )}
      {visibleTurns.map((turn) => (
        <section className="turn-block" key={turn.id}>
          <div className="turn-heading">
            <StatusBadge value={turn.status} />
            <span>{turn.id}</span>
            <span>{formatDate(turn.startedAt)}</span>
          </div>
          {(turn.items ?? []).map((item) => <ThreadItemView item={item} key={item.id} />)}
        </section>
      ))}
    </>
  );
});

const ThreadItemView = memo(function ThreadItemView({ item, compact = false }: { item: ThreadItem; compact?: boolean }) {
  return (
    <article className={`item ${kindClass(item.type)} ${compact ? "compact" : ""}`}>
      <div className="item-kind">{labelForKind(item.type)}</div>
      <div className="item-body">{renderItemBody(item)}</div>
    </article>
  );
});

function renderItemBody(item: ThreadItem) {
  if (item.type === "userMessage") {
    return <MarkdownText text={userInputText(item.content)} />;
  }
  if (item.type === "agentMessage") {
    return (
      <>
        {typeof item.phase === "string" && <p className="muted">{item.phase}</p>}
        <MarkdownText text={typeof item.text === "string" ? item.text : ""} />
      </>
    );
  }
  if (item.type === "reasoning") {
    const summary = Array.isArray(item.summary) ? item.summary.join("\n\n") : "";
    const content = Array.isArray(item.content) ? item.content.join("\n\n") : "";
    return <MarkdownText text={[summary, content].filter(Boolean).join("\n\n") || "Reasoning"} />;
  }
  if (item.type === "plan") {
    return <MarkdownText text={typeof item.text === "string" ? item.text : "Plan updated"} />;
  }
  if (item.type === "commandExecution") {
    return (
      <>
        <p className="command-line">$ {typeof item.command === "string" ? item.command : commandFromActions(item.commandActions)}</p>
        <p className="muted">{[item.status, exitText(item.exitCode), item.cwd].filter(Boolean).join(" | ")}</p>
        {typeof item.aggregatedOutput === "string" && item.aggregatedOutput && <pre className="code-block">{truncate(item.aggregatedOutput, 16000)}</pre>}
      </>
    );
  }
  if (item.type === "fileChange") {
    return (
      <>
        <p>{String(item.status ?? "changed")}</p>
        <pre className="json-block">{JSON.stringify(item.changes ?? [], null, 2)}</pre>
      </>
    );
  }
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
    return (
      <>
        <p>{[item.server, item.namespace, item.tool].filter(Boolean).join(".")} <span className="muted">{String(item.status ?? "")}</span></p>
        <details>
          <summary>Details</summary>
          <pre className="json-block">{JSON.stringify(item, null, 2)}</pre>
        </details>
      </>
    );
  }
  if (item.type === "webSearch") {
    return <MarkdownText text={typeof item.query === "string" ? item.query : "Web search"} />;
  }
  if (item.type === "imageView") {
    return <p>{String(item.path ?? "Image viewed")}</p>;
  }
  return <pre className="json-block">{JSON.stringify(item, null, 2)}</pre>;
}

const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
});

function SessionModal({
  title,
  settings,
  includePrompt = false,
  onClose,
  onSubmit
}: {
  title: string;
  settings: UiSettings;
  includePrompt?: boolean;
  onClose: () => void;
  onSubmit: (value: { settings: UiSettings; prompt: string }) => void;
}) {
  const [draft, setDraft] = useState(settings);
  const [prompt, setPrompt] = useState("");
  return (
    <div className="modal-backdrop">
      <form
        className="modal"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit({ settings: draft, prompt });
        }}
      >
        <header className="modal-header">
          <h2>{title}</h2>
          <button className="icon-button" type="button" onClick={onClose} title="Close">
            <X size={16} />
          </button>
        </header>
        <div className="form-grid">
          {includePrompt ? (
            <DirectoryPicker value={draft.cwd} onChange={(cwd) => setDraft({ ...draft, cwd })} />
          ) : (
            <label className="field">
              <span>Working directory</span>
              <input value={draft.cwd} onChange={(event) => setDraft({ ...draft, cwd: event.target.value })} placeholder="/path/to/project" />
            </label>
          )}
          <label className="field">
            <span>Model</span>
            <select value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })}>
              <option value="gpt-5.5">GPT-5.5</option>
              <option value="gpt-5.4">GPT-5.4</option>
            </select>
          </label>
          <label className="field">
            <span>Reasoning effort</span>
            <select value={draft.effort} onChange={(event) => setDraft({ ...draft, effort: event.target.value })}>
              <option value="minimal">minimal</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="xhigh">xhigh</option>
            </select>
          </label>
          <label className="field">
            <span>Approval policy</span>
            <select value={draft.approvalPolicy} onChange={(event) => setDraft({ ...draft, approvalPolicy: event.target.value })}>
              <option value="on-request">on-request</option>
              <option value="on-failure">on-failure</option>
              <option value="untrusted">untrusted</option>
              <option value="never">never</option>
            </select>
          </label>
          <label className="field">
            <span>Sandbox</span>
            <select value={draft.sandbox} onChange={(event) => setDraft({ ...draft, sandbox: event.target.value })}>
              <option value="workspace-write">workspace-write</option>
              <option value="read-only">read-only</option>
              <option value="danger-full-access">danger-full-access</option>
            </select>
          </label>
        </div>
        {includePrompt && (
          <label className="field">
            <span>Initial message</span>
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={7} />
          </label>
        )}
        <footer className="modal-actions">
          <button className="ghost-button" type="button" onClick={onClose}>Cancel</button>
          <button className="primary-button" type="submit">{includePrompt ? "Start" : "Save"}</button>
        </footer>
      </form>
    </div>
  );
}

function DirectoryPicker({ value, onChange }: { value: string; onChange: (cwd: string) => void }) {
  const [browser, setBrowser] = useState<RepositoryBrowser | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [newRepoName, setNewRepoName] = useState("");

  useEffect(() => {
    void loadPath(value || undefined);
  }, []);

  async function loadPath(path?: string | null) {
    setLoading(true);
    setError("");
    try {
      setBrowser(await browseRepositories(path || undefined));
    } catch (error) {
      setError(messageFromError(error));
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateRepo() {
    if (!browser || !newRepoName.trim()) {
      return;
    }
    setLoading(true);
    setError("");
    try {
      const next = await createRepository(browser.path, newRepoName.trim());
      setBrowser(next);
      setNewRepoName("");
      onChange(next.path);
    } catch (error) {
      setError(messageFromError(error));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="directory-picker">
      <div className="field">
        <span>Working directory</span>
        <div className="path-pill">
          <strong>{browser?.displayPath || value || "~"}</strong>
          {browser?.isGitRepo && <StatusBadge value="git repo" />}
        </div>
      </div>
      <div className="directory-toolbar">
        <button className="ghost-button" type="button" onClick={() => loadPath(browser?.homePath)} disabled={loading}>
          <Home size={16} /> Home
        </button>
        <button className="ghost-button" type="button" onClick={() => loadPath(browser?.parentPath)} disabled={loading || !browser?.parentPath}>
          <ChevronUp size={16} /> Up
        </button>
        <button className="primary-button" type="button" onClick={() => browser && onChange(browser.path)} disabled={!browser?.isGitRepo}>
          <FolderGit2 size={16} /> Select
        </button>
      </div>
      <div className="directory-list">
        {loading && <p className="muted empty-pad">Loading</p>}
        {!loading && browser?.entries.map((entry) => (
          <div className={`directory-row ${entry.isGitRepo ? "git-repo" : ""}`} key={entry.path}>
            <button type="button" onClick={() => loadPath(entry.path)}>
              {entry.isGitRepo ? <FolderGit2 size={17} /> : <Folder size={17} />}
              <span>{entry.name}</span>
            </button>
            <button className="ghost-button" type="button" onClick={() => onChange(entry.path)} disabled={!entry.isGitRepo}>
              Select
            </button>
          </div>
        ))}
        {!loading && browser?.entries.length === 0 && <p className="muted empty-pad">No folders</p>}
      </div>
      <div className="new-repo-form">
        <label className="field">
          <span>Create repository</span>
          <input
            value={newRepoName}
            onChange={(event) => setNewRepoName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void handleCreateRepo();
              }
            }}
            placeholder="folder-name"
          />
        </label>
        <button className="secondary-button" type="button" onClick={handleCreateRepo} disabled={loading || !browser || !newRepoName.trim()}>
          <Plus size={16} /> Create
        </button>
      </div>
      {value && <p className="selected-path">Selected: {value}</p>}
      {error && <p className="error-text">{error}</p>}
    </section>
  );
}

function EditableThreadTitle({ thread, onRename }: { thread: Thread; onRename: (name: string) => Promise<void> }) {
  const [draft, setDraft] = useState(titleForThread(thread));
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    setDraft(titleForThread(thread));
  }, [thread.id, thread.name, thread.preview]);

  async function commit() {
    setEditing(false);
    await onRename(draft);
  }

  return (
    <input
      className="thread-title-input"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={() => setEditing(true)}
      onBlur={() => void commit()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        }
        if (event.key === "Escape") {
          setDraft(titleForThread(thread));
          setEditing(false);
          event.currentTarget.blur();
        }
      }}
      aria-label="Thread title"
      title={editing ? "Press Enter to save" : "Click to rename"}
    />
  );
}

const StatusBadge = memo(function StatusBadge({ value }: { value: string | undefined | null }) {
  const text = value || "unknown";
  return <span className={`status-badge ${statusClass(text)}`}>{text}</span>;
});

function statusType(thread: Thread | null): string {
  if (!thread?.status) {
    return "unknown";
  }
  return typeof thread.status === "string" ? thread.status : thread.status.type;
}

const Composer = memo(function Composer({
  activeTurnId,
  archiveLabel,
  onArchive,
  onCompact,
  onFork,
  onInterrupt,
  onSend
}: {
  activeTurnId: string | null;
  archiveLabel: string;
  onArchive: () => void;
  onCompact: () => void;
  onFork: () => void;
  onInterrupt: () => void;
  onSend: (text: string, action?: ComposerAction) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  async function submitDraft(action: ComposerAction) {
    const sent = await onSend(draft, action);
    if (sent) {
      setDraft("");
    }
  }

  if (collapsed) {
    return (
      <div className="composer collapsed">
        <button className="primary-button" type="button" onClick={() => setCollapsed(false)}>
          <Send size={16} /> Compose
        </button>
      </div>
    );
  }

  return (
    <form
      className="composer"
      onSubmit={async (event) => {
        event.preventDefault();
        await submitDraft("send");
      }}
    >
      <div className="composer-top">
        <button className="icon-button" type="button" onClick={() => setCollapsed(true)} title="Collapse composer" aria-label="Collapse composer">
          <ChevronsDown size={17} />
        </button>
        <button className="icon-button danger-icon-button" type="button" onClick={onInterrupt} disabled={!activeTurnId} title="Interrupt" aria-label="Interrupt">
          <PauseCircle size={17} />
        </button>
        <button className="icon-button" type="button" onClick={onFork} title="Fork thread" aria-label="Fork thread">
          <GitFork size={17} />
        </button>
        <button className="icon-button" type="button" onClick={onCompact} title="Compact thread" aria-label="Compact thread">
          <Minimize2 size={17} />
        </button>
      </div>
      <textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={5} placeholder="Send a new message or steer the active turn" />
      <div className="composer-bottom">
        <span>{activeTurnId ? `Active turn ${shortId(activeTurnId)}` : "Ready"}</span>
        <div className="composer-actions">
          <button className={activeTurnId ? "queue-button" : "primary-button"} type="submit">
            <Send size={16} /> {activeTurnId ? "Enqueue" : "Send"}
          </button>
          <button className="secondary-button" type="button" onClick={() => void submitDraft("steer")} disabled={!activeTurnId}>
            <Send size={16} /> Steer
          </button>
          <button className="ghost-button" type="button" onClick={onArchive}>
            <Archive size={16} /> {archiveLabel}
          </button>
        </div>
      </div>
    </form>
  );
});

function statusClass(status: string): string {
  if (["running", "idle", "completed"].includes(status)) return "good";
  if (["starting", "active", "inProgress", "waitingOnApproval", "waitingOnUserInput", "turn started"].includes(status)) return "busy";
  if (["failed", "error", "systemError", "exited", "disconnected", "stderr"].includes(status)) return "bad";
  if (["notLoaded", "interrupted", "stdout"].includes(status)) return "info";
  return "neutral";
}

function titleForThread(thread: Thread): string {
  return thread.name || thread.preview || thread.id;
}

function projectNameForThread(thread: Thread): string {
  if (thread.cwd) {
    const parts = thread.cwd.split(/[\\/]+/).filter(Boolean);
    return parts.at(-1) || thread.cwd;
  }
  return titleForThread(thread);
}

function mostRecentThreadsByFolder(threads: Thread[]): Thread[] {
  const latest = new Map<string, Thread>();
  for (const thread of threads) {
    const key = thread.cwd || "unknown";
    const current = latest.get(key);
    if (!current || (thread.updatedAt ?? 0) > (current.updatedAt ?? 0)) {
      latest.set(key, thread);
    }
  }
  return [...latest.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

function groupThreadsByFolder(threads: Thread[]): { key: string; label: string; threads: Thread[] }[] {
  const groups = new Map<string, { key: string; label: string; threads: Thread[] }>();
  for (const thread of threads) {
    const key = thread.cwd || "unknown";
    const label = thread.cwd ? projectNameForThread(thread) : "No folder";
    const group = groups.get(key) ?? { key, label, threads: [] };
    group.threads.push(thread);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function lastMessagePreview(thread: Thread): string {
  const items = [...(thread.turns ?? [])].flatMap((turn) => turn.items ?? []);
  const message = [...items].reverse().find((item) => item.type === "userMessage" || item.type === "agentMessage");
  if (!message) {
    return thread.preview || "";
  }
  if (message.type === "userMessage") {
    return userInputText(message.content);
  }
  if (typeof message.text === "string") {
    return message.text;
  }
  return thread.preview || "";
}

function isWithinHorizontalScroller(target: EventTarget | null, stopAt: Element): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  for (let element: Element | null = target; element && element !== stopAt; element = element.parentElement) {
    if (canScrollHorizontally(element)) {
      return true;
    }
  }
  return false;
}

function canScrollHorizontally(element: Element): boolean {
  const overflowX = window.getComputedStyle(element).overflowX;
  return ["auto", "scroll", "overlay"].includes(overflowX) && element.scrollWidth > element.clientWidth + 1;
}

function activeTurnFromThread(thread: Thread): string | null {
  const active = [...(thread.turns ?? [])].reverse().find((turn) => turn.status === "inProgress");
  return active?.id ?? null;
}

function userInputText(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((item) => {
      const record = asRecord(item);
      if (record.type === "text") return String(record.text ?? "");
      if (record.type === "image") return `[image] ${String(record.url ?? "")}`;
      if (record.type === "localImage") return `[local image] ${String(record.path ?? "")}`;
      if (record.type === "skill" || record.type === "mention") return `[${String(record.type)}] ${String(record.name ?? "")}: ${String(record.path ?? "")}`;
      return JSON.stringify(record);
    })
    .join("\n");
}

function commandFromActions(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }
  return value.map((item) => asRecord(item).command).filter(Boolean).join(" | ");
}

function labelForKind(kind: string): string {
  const labels: Record<string, string> = {
    userMessage: "User",
    agentMessage: "Codex",
    commandExecution: "Command",
    fileChange: "Files",
    mcpToolCall: "MCP",
    dynamicToolCall: "Tool",
    collabAgentToolCall: "Agent",
    webSearch: "Search",
    imageView: "Image",
    imageGeneration: "Image",
    logEntry: "Log",
    reasoning: "Reasoning",
    plan: "Plan"
  };
  return labels[kind] || kind;
}

function kindClass(kind: string): string {
  if (kind === "userMessage") return "user";
  if (kind === "agentMessage" || kind === "reasoning" || kind === "plan") return "agent";
  if (kind === "commandExecution") return "command";
  return "tool";
}

function sandboxPolicyFor(value: string): JsonValue | null {
  if (value === "danger-full-access") return { type: "dangerFullAccess" };
  if (value === "read-only") return { type: "readOnly" };
  if (value === "workspace-write") return { type: "workspaceWrite" };
  return null;
}

function compact(value: Record<string, unknown>): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== "" && item !== null && item !== undefined)) as Record<string, JsonValue>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function threadIdFromThread(value: unknown): string {
  const record = asRecord(value);
  return typeof record.id === "string" ? record.id : "";
}

function formatDate(seconds: number | null | undefined): string {
  if (!seconds) return "";
  const ms = seconds > 10_000_000_000 ? seconds : seconds * 1000;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
}

function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 8)}...${id.slice(-4)}` : id;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n... truncated ${value.length - limit} chars ...`;
}

function exitText(value: unknown): string {
  return typeof value === "number" ? `exit ${value}` : "";
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
