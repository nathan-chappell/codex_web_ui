import {
  Archive,
  ChevronUp,
  ChevronsDown,
  FileDiff,
  FileText,
  Folder,
  FolderGit2,
  GitFork,
  Home,
  LogOut,
  MessageSquarePlus,
  Minimize2,
  Paperclip,
  PauseCircle,
  Plus,
  RefreshCw,
  Search,
  Send,
  Trash2,
  X
} from "lucide-react";
import { SignInButton, SignUpButton, UserButton, useAuth, useClerk } from "@clerk/react";
import { FormEvent, memo, MouseEvent, PointerEvent, UIEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode, RefObject } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import {
  browseFiles,
  browseRepositories,
  createClerkSession,
  createRepository,
  deleteThreadLog,
  getAuth,
  getStatus,
  login,
  logout,
  openEventStream,
  readReferencedFile,
  referencedFileDownloadUrl,
  referencedFileRawUrl,
  restartServer,
  rpc,
  uploadAttachment
} from "./api";
import type { AuthState, FileExplorer, FileExplorerEntry, FilePreview, FileReference, JsonValue, RateLimitSnapshot, RepositoryBrowser, ServerEvent, ServerStatus, Thread, ThreadItem, Turn, UiSettings } from "./types";
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

const THREAD_ITEM_BATCH_SIZE = 20;
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
  const [statusOpen, setStatusOpen] = useState(false);
  const [activeTurns, setActiveTurns] = useState<Record<string, string>>({});
  const [rateLimits, setRateLimits] = useState<RateLimitSnapshot | null>(null);
  const [filePreviewCache, setFilePreviewCache] = useState<Record<string, FilePreview>>({});
  const [fileViewer, setFileViewer] = useState<{ reference: FileReference; file: FilePreview } | null>(null);
  const [fileExplorerOpen, setFileExplorerOpen] = useState(false);
  const [fileExplorer, setFileExplorer] = useState<FileExplorer | null>(null);
  const [fileExplorerCache, setFileExplorerCache] = useState<Record<string, FileExplorer>>({});
  const [fileExplorerLoading, setFileExplorerLoading] = useState(false);
  const [loadingThreadByPane, setLoadingThreadByPane] = useState<Record<number, string>>({});

  const eventSourceRef = useRef<EventSource | null>(null);
  const refreshTimersRef = useRef<Map<string, number>>(new Map());
  const listTimerRef = useRef<number | null>(null);
  const sessionsLoadSeqRef = useRef(0);
  const threadLoadSeqRef = useRef(0);
  const fileExplorerLoadSeqRef = useRef(0);
  const paneThreadLoadTokensRef = useRef<Record<number, number>>({});
  const activePaneIndexRef = useRef(0);
  const openThreadIdsRef = useRef<(string | null)[]>([null]);
  const touchStartRef = useRef<{ x: number; y: number; paneSwipeBlocked: boolean } | null>(null);
  const resizingSidebarRef = useRef(false);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressActivatedRef = useRef(false);
  const sessionClickTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      for (const timer of refreshTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      refreshTimersRef.current.clear();
      if (listTimerRef.current) {
        window.clearTimeout(listTimerRef.current);
      }
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
    loadRateLimits();
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
    const nextOpenThreadIds = Array.from({ length: threadPaneCount }, (_, index) => openThreadIdsRef.current[index] ?? null);
    openThreadIdsRef.current = nextOpenThreadIds;
    setOpenThreadIds(nextOpenThreadIds);
    const nextActivePaneIndex = Math.min(activePaneIndexRef.current, threadPaneCount - 1);
    activePaneIndexRef.current = nextActivePaneIndex;
    setActivePaneIndex(nextActivePaneIndex);
  }, [threadPaneCount]);

  useEffect(() => {
    openThreadIdsRef.current = openThreadIds;
  }, [openThreadIds]);

  useEffect(() => {
    activePaneIndexRef.current = activePaneIndex;
  }, [activePaneIndex]);

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
          <button className="status-button" type="button" onClick={() => setStatusOpen(true)} title="Show app server status">
            <UsageStatusSummary rateLimits={rateLimits} compact />
          </button>
          <button className="ghost-button" type="button" onClick={() => void openFileExplorer()} title="Browse files">
            <Folder size={16} /> Files
          </button>
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
              const isLoadingThread = Boolean(threadId && loadingThreadByPane[paneIndex] === threadId && !thread);
              return (
                <ThreadPane
                  activeTurnId={thread ? activeTurnFromThread(thread) || activeTurns[thread.id] || null : null}
                  allThreads={mergedSessions}
                  archiveLabel={showArchived ? "Unarchive" : "Archive"}
                  isActive={paneIndex === activePaneIndex}
                  isLoading={isLoadingThread}
                  key={paneIndex}
                  onActivate={() => activatePane(paneIndex)}
                  onArchive={() => thread && archiveThread(thread, paneIndex)}
                  onCompact={() => thread && compactThread(thread)}
                  onFork={() => thread && forkThread(thread, paneIndex)}
                  onInterrupt={() => thread && interruptThread(thread)}
                  onRename={(name) => (thread ? renameThread(thread, name) : Promise.resolve())}
                  onError={showToast}
                  onOpenFile={openFileReference}
                  onSelectThread={(nextThreadId) => selectThread(nextThreadId, paneIndex)}
                  onSend={(text, action) => (thread ? sendMessageText(thread, paneIndex, text, action) : Promise.resolve(false))}
                  paneCount={threadPaneCount}
                  rateLimits={rateLimits}
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
      {statusOpen && (
        <StatusModal
          rateLimits={rateLimits}
          status={serverStatus}
          onClose={() => setStatusOpen(false)}
          onRefresh={refreshStatus}
        />
      )}
      {fileExplorerOpen && (
        <FileExplorerModal
          explorer={fileExplorer}
          loading={fileExplorerLoading}
          onBrowse={(pathValue) => void loadFileExplorer(fileExplorer?.cwd || defaultFileExplorerCwd(), pathValue)}
          onClose={() => setFileExplorerOpen(false)}
          onOpenFile={(entry) => fileExplorer ? openFileReference({ path: entry.path, cwd: fileExplorer.cwd, label: entry.name }) : Promise.resolve()}
          onRefresh={() => fileExplorer ? void loadFileExplorer(fileExplorer.cwd, fileExplorer.path, true) : void openFileExplorer()}
        />
      )}
      {fileViewer && (
        <FileViewerModal
          file={fileViewer.file}
          reference={fileViewer.reference}
          onClose={() => setFileViewer(null)}
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

  async function refreshStatus() {
    try {
      setServerStatus(await getStatus());
      await loadRateLimits();
    } catch (error) {
      showToast(error);
    }
  }

  function defaultFileExplorerCwd(): string {
    return selectedThread?.cwd || settings.cwd || serverStatus.cwd || "";
  }

  function fileExplorerCacheKey(cwd: string, pathValue?: string | null): string {
    return `${cwd}\n${pathValue || ""}`;
  }

  async function openFileExplorer() {
    setFileExplorerOpen(true);
    await loadFileExplorer(defaultFileExplorerCwd());
  }

  async function loadFileExplorer(cwd: string, pathValue?: string | null, force = false) {
    const key = fileExplorerCacheKey(cwd, pathValue);
    const cached = fileExplorerCache[key];
    if (cached && !force) {
      fileExplorerLoadSeqRef.current += 1;
      setFileExplorer(cached);
      setFileExplorerLoading(false);
      return;
    }
    const loadId = ++fileExplorerLoadSeqRef.current;
    setFileExplorerLoading(true);
    try {
      const explorer = await browseFiles({ cwd, path: pathValue });
      if (loadId !== fileExplorerLoadSeqRef.current) {
        return;
      }
      setFileExplorer(explorer);
      setFileExplorerCache((current) => ({ ...current, [key]: explorer }));
    } catch (error) {
      showToast(error);
    } finally {
      if (loadId === fileExplorerLoadSeqRef.current) {
        setFileExplorerLoading(false);
      }
    }
  }

  async function openFileReference(reference: FileReference) {
    const key = fileReferenceKey(reference);
    try {
      const cached = filePreviewCache[key];
      const file = cached ?? await readReferencedFile(reference);
      if (!cached) {
        setFilePreviewCache((current) => ({ ...current, [key]: file }));
      }
      if (!file.previewable) {
        window.location.assign(referencedFileDownloadUrl(reference));
        return;
      }
      setFileViewer({ reference, file });
    } catch (error) {
      showToast(error);
    }
  }

  async function loadSessions(page = sessionPage) {
    const loadId = ++sessionsLoadSeqRef.current;
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
      if (loadId !== sessionsLoadSeqRef.current) {
        return;
      }
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
      if (loadId === sessionsLoadSeqRef.current) {
        showToast(error);
      }
    } finally {
      if (loadId === sessionsLoadSeqRef.current) {
        setSessionsLoading(false);
      }
    }
  }

  async function loadRateLimits() {
    try {
      const result = await rpc("account/rateLimits/read");
      const parsed = parseRateLimitsResponse(result);
      if (parsed) {
        setRateLimits(parsed);
      }
    } catch {
      setRateLimits(null);
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
      selectThread(threadId, activePaneIndexRef.current);
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

  function activatePane(paneIndex: number) {
    activePaneIndexRef.current = paneIndex;
    setActivePaneIndex(paneIndex);
  }

  function setPaneThreadId(paneIndex: number, threadId: string | null) {
    const targetPaneIndex = Math.min(threadPaneCount - 1, Math.max(0, paneIndex));
    const next = Array.from({ length: threadPaneCount }, (_, index) => openThreadIdsRef.current[index] ?? null);
    next[targetPaneIndex] = threadId;
    openThreadIdsRef.current = next;
    setOpenThreadIds(next);
  }

  function rememberOpenThread(thread: Thread, paneIndex = activePaneIndexRef.current, assignPane = true) {
    const targetPaneIndex = Math.min(threadPaneCount - 1, Math.max(0, paneIndex));
    setOpenThreads((current) => ({ ...current, [thread.id]: thread }));
    if (assignPane) {
      setPaneThreadId(targetPaneIndex, thread.id);
    }
    if (targetPaneIndex === activePaneIndexRef.current && openThreadIdsRef.current[targetPaneIndex] === thread.id) {
      setSelectedThreadId(thread.id);
      setSelectedThread(thread);
    }
  }

  function closeOpenThreads(threadIds: string[]) {
    const closing = new Set(threadIds);
    const nextOpenThreadIds = openThreadIdsRef.current.map((id) => (id && closing.has(id) ? null : id));
    openThreadIdsRef.current = nextOpenThreadIds;
    setOpenThreadIds(nextOpenThreadIds);
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

  async function selectThread(threadId: string, paneIndex = activePaneIndexRef.current) {
    const targetPaneIndex = Math.min(threadPaneCount - 1, Math.max(0, paneIndex));
    const loadToken = ++threadLoadSeqRef.current;
    paneThreadLoadTokensRef.current[targetPaneIndex] = loadToken;
    setLoadingThreadByPane((current) => ({ ...current, [targetPaneIndex]: threadId }));
    setPaneThreadId(targetPaneIndex, threadId);
    activatePane(targetPaneIndex);
    setSelectedThreadId(threadId);
    setSelectedThread(null);
    setMobilePane("thread");
    const thread = await resumeThread(threadId, targetPaneIndex, loadToken);
    if (thread && isThreadLoadCurrent(targetPaneIndex, loadToken)) {
      setSelectedThread(thread);
    }
    setLoadingThreadByPane((current) => {
      if (current[targetPaneIndex] !== threadId || !isThreadLoadCurrent(targetPaneIndex, loadToken)) {
        return current;
      }
      const next = { ...current };
      delete next[targetPaneIndex];
      return next;
    });
  }

  async function readThread(threadId: string, paneIndex = openThreadIdsRef.current.indexOf(threadId), loadToken?: number): Promise<Thread | null> {
    try {
      const result = await rpc<{ thread: Thread }>("thread/read", { threadId, includeTurns: true });
      const targetPaneIndex = paneIndex >= 0 ? paneIndex : openThreadIdsRef.current.indexOf(threadId);
      if (!canApplyThreadToPane(threadId, targetPaneIndex, loadToken)) {
        return null;
      }
      rememberOpenThread(result.thread, targetPaneIndex, false);
      rememberSessionPreview(result.thread);
      rememberActiveTurn(result.thread);
      return result.thread;
    } catch (error) {
      showToast(error);
      return null;
    }
  }

  async function resumeThread(threadId: string, paneIndex = activePaneIndexRef.current, loadToken?: number): Promise<Thread | null> {
    try {
      const result = await rpc<{ thread: Thread }>("thread/resume", buildThreadLoadParams(threadId));
      if (!canApplyThreadToPane(threadId, paneIndex, loadToken)) {
        return null;
      }
      rememberOpenThread(result.thread, paneIndex, false);
      rememberSessionPreview(result.thread);
      rememberActiveTurn(result.thread);
      setLoadedThreadIds((current) => new Set([...current, result.thread.id]));
      scheduleThreadRefresh(result.thread.id, 700);
      scheduleListRefresh(1000);
      return result.thread;
    } catch (error) {
      return readThread(threadId, paneIndex, loadToken);
    }
  }

  async function sendMessageText(selected: Thread, paneIndex: number, text: string, action: ComposerAction = "send"): Promise<boolean> {
    const trimmedText = text.trim();
    if (!trimmedText) {
      return false;
    }
    try {
      let thread = selected;
      if (!canSendFromPane(thread.id, paneIndex)) {
        throw new Error("Thread changed before send completed. Message was not sent.");
      }
      if (!loadedThreadIds.has(thread.id) || statusType(thread) === "notLoaded") {
        const resumed = await rpc<{ thread: Thread }>("thread/resume", buildThreadLoadParams(thread.id));
        thread = resumed.thread;
        if (!canSendFromPane(thread.id, paneIndex)) {
          throw new Error("Thread changed before send completed. Message was not sent.");
        }
        rememberOpenThread(thread, paneIndex, false);
        setLoadedThreadIds((current) => new Set([...current, thread.id]));
      }

      const currentActiveTurn = activeTurnFromThread(thread) || activeTurns[thread.id];
      if (action === "steer") {
        if (!currentActiveTurn) {
          throw new Error("No active turn is available to steer");
        }
        if (!canSendFromPane(thread.id, paneIndex)) {
          throw new Error("Thread changed before send completed. Message was not sent.");
        }
        await rpc("turn/steer", {
          threadId: thread.id,
          expectedTurnId: currentActiveTurn,
          input: [{ type: "text", text: trimmedText }]
        });
      } else {
        if (!canSendFromPane(thread.id, paneIndex)) {
          throw new Error("Thread changed before send completed. Message was not sent.");
        }
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
        const nextOpenThreadIds = openThreadIdsRef.current.map((id) => (id === thread.id ? null : id));
        openThreadIdsRef.current = nextOpenThreadIds;
        setOpenThreadIds(nextOpenThreadIds);
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
      rememberOpenThread(result.thread, activePaneIndexRef.current);
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
    if (method === "account/rateLimits/updated") {
      const nextRateLimits = parseRateLimitSnapshot(params.rateLimits);
      if (nextRateLimits) {
        setRateLimits(nextRateLimits);
      }
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
    const existingTimer = refreshTimersRef.current.get(threadId);
    if (existingTimer) {
      window.clearTimeout(existingTimer);
    }
    const timer = window.setTimeout(() => {
      refreshTimersRef.current.delete(threadId);
      const currentPaneIndex = openThreadIdsRef.current.indexOf(threadId);
      if (currentPaneIndex >= 0) {
        void readThread(threadId, currentPaneIndex);
      }
    }, delay);
    refreshTimersRef.current.set(threadId, timer);
  }

  function isThreadLoadCurrent(paneIndex: number, loadToken?: number): boolean {
    return loadToken === undefined || paneThreadLoadTokensRef.current[paneIndex] === loadToken;
  }

  function canApplyThreadToPane(threadId: string, paneIndex: number, loadToken?: number): boolean {
    return paneIndex >= 0 && openThreadIdsRef.current[paneIndex] === threadId && isThreadLoadCurrent(paneIndex, loadToken);
  }

  function canSendFromPane(threadId: string, paneIndex: number): boolean {
    return paneIndex >= 0 && openThreadIdsRef.current[paneIndex] === threadId;
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
  isLoading,
  onActivate,
  onArchive,
  onCompact,
  onFork,
  onInterrupt,
  onRename,
  onError,
  onOpenFile,
  onSelectThread,
  onSend,
  paneCount,
  rateLimits,
  thread
}: {
  activeTurnId: string | null;
  allThreads: Thread[];
  archiveLabel: string;
  isActive: boolean;
  isLoading: boolean;
  onActivate: () => void;
  onArchive: () => void;
  onCompact: () => void;
  onFork: () => void;
  onInterrupt: () => void;
  onRename: (name: string) => Promise<void>;
  onError: (error: unknown) => void;
  onOpenFile: (reference: FileReference) => Promise<void>;
  onSelectThread: (threadId: string) => void;
  onSend: (text: string, action?: ComposerAction) => Promise<boolean>;
  paneCount: ThreadPaneCount;
  rateLimits: RateLimitSnapshot | null;
  thread: Thread | null;
}) {
  const [topHidden, setTopHidden] = useState(() => isMobileViewport());
  const [composerCollapsed, setComposerCollapsed] = useState(false);
  const conversationRef = useRef<HTMLDivElement | null>(null);
  const conversationScrollTopRef = useRef(0);
  const composerManuallyCollapsedRef = useRef(false);
  const lastThreadViewRef = useRef("");
  const lastItemCountRef = useRef(0);
  const itemCount = useMemo(() => (thread?.turns ?? []).reduce((count, turn) => count + (turn.items?.length ?? 0), 0), [thread?.turns]);
  const fileReferences = useMemo(() => thread ? extractFileReferences(thread) : [], [thread]);

  useEffect(() => {
    if (!thread) {
      lastThreadViewRef.current = "";
      lastItemCountRef.current = 0;
      composerManuallyCollapsedRef.current = false;
      setTopHidden(false);
      setComposerCollapsed(false);
      return;
    }
    if (lastThreadViewRef.current !== thread.id) {
      lastThreadViewRef.current = thread.id;
      lastItemCountRef.current = itemCount;
      composerManuallyCollapsedRef.current = false;
      setTopHidden(isMobileViewport());
      setComposerCollapsed(false);
      scrollToEnd();
      return;
    }
    if (itemCount > lastItemCountRef.current) {
      scrollToEnd();
    }
    lastItemCountRef.current = itemCount;
  }, [itemCount, thread]);

  function handleConversationScroll(event: UIEvent<HTMLDivElement>) {
    const element = event.currentTarget;
    const nextTop = element.scrollTop;
    const previousTop = conversationScrollTopRef.current;
    const scrollDelta = nextTop - previousTop;
    const bottomDistance = element.scrollHeight - nextTop - element.clientHeight;
    const scrollingTowardHistory = scrollDelta < -18;
    const scrollingTowardBottom = scrollDelta > 18;
    const nearBottom = bottomDistance < 24;
    const awayFromBottom = bottomDistance > 120;

    conversationScrollTopRef.current = nextTop;

    if (isMobileViewport()) {
      if (scrollingTowardHistory && awayFromBottom) {
        setTopHidden(false);
        if (!composerManuallyCollapsedRef.current) {
          setComposerCollapsed(true);
        }
        return;
      }
      if (nearBottom) {
        setTopHidden(true);
        if (!composerManuallyCollapsedRef.current) {
          setComposerCollapsed(false);
        }
        return;
      }
      if (scrollingTowardBottom) {
        setTopHidden(true);
      }
      return;
    }

    if (topHidden) {
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
      if (isMobileViewport()) {
        setTopHidden(true);
        if (!composerManuallyCollapsedRef.current) {
          setComposerCollapsed(false);
        }
      }
    });
  }

  function handleComposerCollapsedChange(collapsed: boolean) {
    composerManuallyCollapsedRef.current = collapsed;
    setComposerCollapsed(collapsed);
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
            <ThreadUsageStats rateLimits={rateLimits} />
          </div>
        ) : isLoading ? (
          <div className="thread-title-block empty">
            <h2>Loading thread</h2>
            <p>Fetching the selected thread.</p>
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
          <FileReferenceBar references={fileReferences} onOpenFile={onOpenFile} />
          <div className="conversation" ref={conversationRef} onScroll={handleConversationScroll}>
            <TurnHistory
              cwd={thread.cwd || null}
              onOpenFile={onOpenFile}
              threadId={thread.id}
              turns={thread.turns ?? []}
              scrollContainerRef={conversationRef}
            />
          </div>
          <Composer
            activeTurnId={activeTurnId}
            onInterrupt={onInterrupt}
            onSend={onSend}
            onFork={onFork}
            onCompact={onCompact}
            onArchive={onArchive}
            archiveLabel={archiveLabel}
            collapsed={composerCollapsed}
            onError={onError}
            onCollapsedChange={handleComposerCollapsedChange}
          />
        </>
      ) : (
        <div className="empty-state">
          <h2>{isLoading ? "Loading thread" : "Select a thread"}</h2>
          <p>{isLoading ? "Fetching the selected thread." : "Choose an existing thread or start a new one."}</p>
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

function StatusModal({
  rateLimits,
  status,
  onClose,
  onRefresh
}: {
  rateLimits: RateLimitSnapshot | null;
  status: ServerStatus;
  onClose: () => void;
  onRefresh: () => Promise<void>;
}) {
  return (
    <div className="modal-backdrop">
      <section className="modal status-modal" role="dialog" aria-modal="true" aria-labelledby="status-title">
        <header className="modal-header">
          <div>
            <h2 id="status-title">Status</h2>
            <p className="muted">{status.command ?? "codex"} {status.state ? `is ${status.state}` : ""}</p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} title="Close">
            <X size={16} />
          </button>
        </header>
        <div className="status-grid">
          <StatusDetail label="5hr remaining" value={<QuotaMetric value={rateLimitRemainingPercent(rateLimits, "5hr")} />} />
          <StatusDetail label="Weekly remaining" value={<QuotaMetric value={rateLimitRemainingPercent(rateLimits, "weekly")} />} />
        </div>
        <p className="muted">Rate limits use the app-server account quota snapshot.</p>
        <footer className="modal-actions">
          <button className="ghost-button" type="button" onClick={onClose}>Close</button>
          <button className="primary-button" type="button" onClick={() => void onRefresh()}>
            <RefreshCw size={16} /> Refresh
          </button>
        </footer>
      </section>
    </div>
  );
}

function StatusDetail({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="status-detail">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function UsageStatusSummary({ compact = false, rateLimits }: { compact?: boolean; rateLimits: RateLimitSnapshot | null }) {
  return (
    <div className={`usage-status-summary ${compact ? "compact" : ""}`}>
      <span>5hr left {formatPercentValue(rateLimitRemainingPercent(rateLimits, "5hr"))}</span>
      <span>wk left {formatPercentValue(rateLimitRemainingPercent(rateLimits, "weekly"))}</span>
    </div>
  );
}

function QuotaMetric({ value }: { value: number | null }) {
  return <span className={`usage-metric ${quotaMetricClass(value)}`}>{formatPercentValue(value)}</span>;
}

function FileReferenceBar({ references, onOpenFile }: { references: FileReference[]; onOpenFile: (reference: FileReference) => Promise<void> }) {
  if (references.length === 0) {
    return null;
  }
  return (
    <div className="file-reference-bar" aria-label="Referenced files">
      {references.slice(0, 16).map((reference) => (
        <button
          key={fileReferenceKey(reference)}
          type="button"
          onClick={() => void onOpenFile(reference)}
          title={reference.path}
        >
          <Paperclip size={14} />
          <span>{reference.label || reference.path}</span>
        </button>
      ))}
      {references.length > 16 && <span className="muted">+{references.length - 16} more</span>}
    </div>
  );
}

function FileExplorerModal({
  explorer,
  loading,
  onBrowse,
  onClose,
  onOpenFile,
  onRefresh
}: {
  explorer: FileExplorer | null;
  loading: boolean;
  onBrowse: (pathValue: string) => void;
  onClose: () => void;
  onOpenFile: (entry: FileExplorerEntry) => Promise<void>;
  onRefresh: () => void;
}) {
  const [filter, setFilter] = useState("");
  const visibleEntries = useMemo(() => {
    const normalized = filter.trim().toLowerCase();
    const entries = explorer?.entries ?? [];
    if (!normalized) {
      return entries;
    }
    return entries.filter((entry) => `${entry.name}\n${entry.relativePath}\n${entry.kind || ""}`.toLowerCase().includes(normalized));
  }, [explorer, filter]);

  return (
    <div className="modal-backdrop">
      <section className="modal file-explorer-modal" role="dialog" aria-modal="true" aria-labelledby="file-explorer-title">
        <header className="modal-header">
          <div className="file-viewer-title">
            <h2 id="file-explorer-title">Files</h2>
            <p className="muted">{explorer?.displayPath || "Loading project files"}</p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} title="Close">
            <X size={16} />
          </button>
        </header>
        <div className="file-explorer-toolbar">
          <label className="file-search-field">
            <Search size={15} />
            <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter files" />
          </label>
          <button className="icon-button" type="button" onClick={onRefresh} disabled={loading} title="Refresh files" aria-label="Refresh files">
            <RefreshCw size={16} />
          </button>
          <button
            className="icon-button"
            type="button"
            disabled={!explorer?.parentPath}
            onClick={() => explorer?.parentPath && onBrowse(explorer.parentPath)}
            title="Parent directory"
            aria-label="Parent directory"
          >
            <ChevronUp size={17} />
          </button>
        </div>
        {explorer && (
          <div className="file-explorer-summary">
            <span>{explorer.entries.length} entries</span>
            <span>{explorer.trackedCount} tracked</span>
            {explorer.relativePath && <span>{explorer.relativePath}</span>}
          </div>
        )}
        <div className="file-explorer-list">
          {!explorer ? (
            <p className="muted empty-pad">Loading files</p>
          ) : visibleEntries.length === 0 ? (
            <p className="muted empty-pad">No files found.</p>
          ) : (
            visibleEntries.map((entry) => (
              <button
                className="file-explorer-row"
                key={`${entry.type}:${entry.path}`}
                type="button"
                onClick={() => entry.type === "directory" ? onBrowse(entry.path) : void onOpenFile(entry)}
                title={entry.displayPath}
              >
                <span className={`file-explorer-icon ${entry.type}`}>
                  {entry.type === "directory" ? <Folder size={18} /> : <FileText size={18} />}
                </span>
                <span className="file-explorer-main">
                  <strong>{entry.name}</strong>
                  <span>{entry.relativePath || entry.displayPath}</span>
                </span>
                <span className="file-explorer-meta">
                  {entry.tracked && <span className="file-tracked-badge">git</span>}
                  {entry.type === "file" && <span>{formatFileSize(entry.size ?? 0)}</span>}
                  {entry.kind && <span>{entry.kind}</span>}
                </span>
              </button>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function FileViewerModal({ file, reference, onClose }: { file: FilePreview; reference: FileReference; onClose: () => void }) {
  return (
    <div className="modal-backdrop">
      <section className="modal file-viewer-modal" role="dialog" aria-modal="true" aria-labelledby="file-viewer-title">
        <header className="modal-header">
          <div className="file-viewer-title">
            <h2 id="file-viewer-title">{file.name}</h2>
            <p className="muted">{file.displayPath} | {formatFileSize(file.size)}</p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} title="Close">
            <X size={16} />
          </button>
        </header>
        <div className="file-viewer-body">
          {renderFilePreview(file, reference)}
        </div>
        <footer className="modal-actions">
          <a className="ghost-button" href={referencedFileDownloadUrl(reference)}>
            Download
          </a>
          <button className="primary-button" type="button" onClick={onClose}>Done</button>
        </footer>
      </section>
    </div>
  );
}

function renderFilePreview(file: FilePreview, reference: FileReference) {
  const content = file.content ?? "";
  if (file.kind === "image") {
    return <img className="file-image-preview" src={referencedFileRawUrl(reference)} alt={file.name} />;
  }
  if (file.kind === "pdf") {
    return <iframe className="file-pdf-preview" src={referencedFileRawUrl(reference)} title={file.name} />;
  }
  if (file.kind === "video") {
    return <video className="file-video-preview" src={referencedFileRawUrl(reference)} controls playsInline preload="metadata" />;
  }
  if (file.kind === "json") {
    return <pre className="json-block file-preview-block">{prettyJson(content)}</pre>;
  }
  if (file.kind === "markdown") {
    return (
      <div className="markdown file-markdown-preview">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
    );
  }
  if (file.kind === "code") {
    return (
      <SyntaxHighlighter language={languageForFile(file)} style={oneLight} customStyle={{ margin: 0, borderRadius: 6 }}>
        {content}
      </SyntaxHighlighter>
    );
  }
  return <pre className="code-block file-preview-block">{content}</pre>;
}

const TurnHistory = memo(function TurnHistory({
  cwd,
  onOpenFile,
  scrollContainerRef,
  threadId,
  turns
}: {
  cwd: string | null;
  onOpenFile: (reference: FileReference) => Promise<void>;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  threadId: string;
  turns: Turn[];
}) {
  const [visibleCount, setVisibleCount] = useState(THREAD_ITEM_BATCH_SIZE);
  const pendingScrollHeightRef = useRef<number | null>(null);
  const totalItemCount = useMemo(() => turns.reduce((count, turn) => count + (turn.items?.length ?? 0), 0), [turns]);
  const visibleTurns = useMemo(() => visibleTurnsByItemCount(turns, visibleCount), [turns, visibleCount]);
  const visibleItemCount = useMemo(() => visibleTurns.reduce((count, turn) => count + turn.items.length, 0), [visibleTurns]);
  const hiddenCount = Math.max(0, totalItemCount - visibleItemCount);

  useEffect(() => {
    setVisibleCount(THREAD_ITEM_BATCH_SIZE);
    pendingScrollHeightRef.current = null;
  }, [threadId]);

  useLayoutEffect(() => {
    const previousHeight = pendingScrollHeightRef.current;
    const element = scrollContainerRef.current;
    if (previousHeight === null || !element) {
      return;
    }
    element.scrollTop += element.scrollHeight - previousHeight;
    pendingScrollHeightRef.current = null;
  }, [scrollContainerRef, visibleCount]);

  if (turns.length === 0 || totalItemCount === 0) {
    return (
      <div className="empty-state inline">
        <h2>No items loaded</h2>
        <p>Select a thread or send a message.</p>
      </div>
    );
  }
  return (
    <>
      {hiddenCount > 0 && (
        <div className="history-limit">
          Showing latest {visibleItemCount} of {totalItemCount} items.
          <button
            type="button"
            onClick={() => {
              const element = scrollContainerRef.current;
              pendingScrollHeightRef.current = element?.scrollHeight ?? null;
              setVisibleCount((current) => Math.min(totalItemCount, current + THREAD_ITEM_BATCH_SIZE));
            }}
          >
            Load earlier
          </button>
        </div>
      )}
      {visibleTurns.map(({ turn, items }) => (
        <section className="turn-block" key={turn.id}>
          <div className="turn-heading">
            <StatusBadge value={turn.status} />
            <span>{turn.id}</span>
            <span>{formatDate(turn.startedAt)}</span>
          </div>
          {items.map((item) => <ThreadItemView cwd={cwd} item={item} key={item.id} onOpenFile={onOpenFile} />)}
        </section>
      ))}
    </>
  );
});

function visibleTurnsByItemCount(turns: Turn[], visibleCount: number): { turn: Turn; items: ThreadItem[] }[] {
  const selected: { turn: Turn; items: ThreadItem[] }[] = [];
  let remaining = visibleCount;
  for (let index = turns.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const turn = turns[index];
    const items = turn?.items ?? [];
    if (items.length === 0) {
      continue;
    }
    const visibleItems = items.slice(Math.max(0, items.length - remaining));
    selected.unshift({ turn, items: visibleItems });
    remaining -= visibleItems.length;
  }
  return selected;
}

const ThreadItemView = memo(function ThreadItemView({
  cwd,
  item,
  compact = false,
  onOpenFile
}: {
  cwd: string | null;
  item: ThreadItem;
  compact?: boolean;
  onOpenFile: (reference: FileReference) => Promise<void>;
}) {
  return (
    <article className={`item ${kindClass(item.type)} ${compact ? "compact" : ""}`}>
      <div className="item-kind">{labelForKind(item.type)}</div>
      <div className="item-body">{renderItemBody(item, cwd, onOpenFile)}</div>
    </article>
  );
});

function renderItemBody(item: ThreadItem, cwd: string | null, onOpenFile: (reference: FileReference) => Promise<void>) {
  if (item.type === "userMessage") {
    return <MarkdownText cwd={cwd} onOpenFile={onOpenFile} text={userInputText(item.content)} />;
  }
  if (item.type === "agentMessage") {
    return (
      <>
        {typeof item.phase === "string" && <p className="muted">{item.phase}</p>}
        <MarkdownText cwd={cwd} onOpenFile={onOpenFile} text={typeof item.text === "string" ? item.text : ""} />
      </>
    );
  }
  if (item.type === "reasoning") {
    const summary = Array.isArray(item.summary) ? item.summary.join("\n\n") : "";
    const content = Array.isArray(item.content) ? item.content.join("\n\n") : "";
    return <MarkdownText cwd={cwd} onOpenFile={onOpenFile} text={[summary, content].filter(Boolean).join("\n\n") || "Reasoning"} />;
  }
  if (item.type === "plan") {
    return <MarkdownText cwd={cwd} onOpenFile={onOpenFile} text={typeof item.text === "string" ? item.text : "Plan updated"} />;
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
    return <FileChangeView cwd={cwd} item={item} onOpenFile={onOpenFile} />;
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
    return <MarkdownText cwd={cwd} onOpenFile={onOpenFile} text={typeof item.query === "string" ? item.query : "Web search"} />;
  }
  if (item.type === "imageView") {
    return <p>{String(item.path ?? "Image viewed")}</p>;
  }
  return <pre className="json-block">{JSON.stringify(item, null, 2)}</pre>;
}

function FileChangeView({ cwd, item, onOpenFile }: { cwd: string | null; item: ThreadItem; onOpenFile: (reference: FileReference) => Promise<void> }) {
  const changes = parseFileChanges(item.changes);
  if (changes.length === 0) {
    return (
      <>
        <p>{String(item.status ?? "changed")}</p>
        <pre className="json-block">{JSON.stringify(item.changes ?? [], null, 2)}</pre>
      </>
    );
  }

  const totals = changes.reduce(
    (current, change) => ({
      added: current.added + change.stats.added,
      removed: current.removed + change.stats.removed
    }),
    { added: 0, removed: 0 }
  );

  return (
    <div className="file-change-view">
      <div className="file-change-summary">
        <span>{String(item.status ?? "changed")}</span>
        <strong>{changes.length} file{changes.length === 1 ? "" : "s"}</strong>
        <span className="diff-stat add">+{totals.added}</span>
        <span className="diff-stat remove">-{totals.removed}</span>
      </div>
      <div className="file-change-list">
        {changes.map((change, index) => (
          <section className="file-diff-card" key={`${change.path}-${index}`}>
            <header className="file-diff-header">
              <button
                className="file-diff-path"
                type="button"
                onClick={() => void onOpenFile({ path: change.path, cwd, label: labelForPath(change.path) })}
                title={change.path}
              >
                <FileDiff size={15} />
                <span>{displayDiffPath(change.path)}</span>
              </button>
              <div className="file-diff-meta">
                <span>{change.kind}</span>
                {change.movePath && <span>from {displayDiffPath(change.movePath)}</span>}
                <span className="diff-stat add">+{change.stats.added}</span>
                <span className="diff-stat remove">-{change.stats.removed}</span>
              </div>
            </header>
            {change.lines.length > 0 ? (
              <div className="diff-block" role="table" aria-label={`Diff for ${change.path}`}>
                {change.lines.map((line, lineIndex) => (
                  <div className={`diff-line ${line.kind}`} role="row" key={`${lineIndex}-${line.text}`}>
                    <span className="diff-line-marker" aria-hidden="true">{diffMarker(line)}</span>
                    <code>{line.text || " "}</code>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted">No textual diff available.</p>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}

type ParsedFileChange = {
  path: string;
  movePath: string | null;
  kind: string;
  lines: DiffLine[];
  stats: { added: number; removed: number };
};

type DiffLine = { kind: "hunk" | "add" | "remove" | "context" | "meta"; text: string };

function parseFileChanges(value: unknown): ParsedFileChange[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(parseFileChange).filter((change): change is ParsedFileChange => Boolean(change));
}

function parseFileChange(value: unknown): ParsedFileChange | null {
  const record = asRecord(value);
  const pathValue = typeof record.path === "string" ? record.path : "";
  if (!pathValue) {
    return null;
  }
  const kindRecord = asRecord(record.kind);
  const diffText = typeof record.diff === "string" ? record.diff : "";
  const lines = parseDiffLines(diffText);
  return {
    path: pathValue,
    movePath: typeof kindRecord.move_path === "string" ? kindRecord.move_path : null,
    kind: typeof kindRecord.type === "string" ? kindRecord.type : String(record.status ?? "changed"),
    lines,
    stats: diffStats(lines)
  };
}

function parseDiffLines(diffText: string): DiffLine[] {
  return diffText.split("\n").filter((line, index, lines) => line || index < lines.length - 1).map((line) => {
    if (line.startsWith("@@")) return { kind: "hunk", text: line };
    if (line.startsWith("+++") || line.startsWith("---")) return { kind: "meta", text: line };
    if (line.startsWith("+")) return { kind: "add", text: line.slice(1) };
    if (line.startsWith("-")) return { kind: "remove", text: line.slice(1) };
    return { kind: "context", text: line.startsWith(" ") ? line.slice(1) : line };
  });
}

function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  return lines.reduce(
    (current, line) => ({
      added: current.added + (line.kind === "add" ? 1 : 0),
      removed: current.removed + (line.kind === "remove" ? 1 : 0)
    }),
    { added: 0, removed: 0 }
  );
}

function diffMarker(line: DiffLine): string {
  if (line.kind === "add") return "+";
  if (line.kind === "remove") return "-";
  if (line.kind === "hunk") return "@";
  return " ";
}

function displayDiffPath(pathValue: string): string {
  const clean = stripLineSuffix(pathValue);
  const homePrefix = "/home/uphill/";
  return clean.startsWith(homePrefix) ? `~/${clean.slice(homePrefix.length)}` : clean;
}

const MarkdownText = memo(function MarkdownText({
  cwd,
  onOpenFile,
  text
}: {
  cwd: string | null;
  onOpenFile: (reference: FileReference) => Promise<void>;
  text: string;
}) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href, children }) {
            const pathValue = href ? filePathFromHref(href) : "";
            if (pathValue && looksLikeFileReference(pathValue)) {
              return (
                <button
                  className="file-link-button"
                  type="button"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void onOpenFile({ path: pathValue, cwd, label: markdownChildrenText(children) || pathValue });
                  }}
                >
                  {children}
                </button>
              );
            }
            return <a href={href}>{children}</a>;
          }
        }}
      >
        {linkifyFileReferences(text)}
      </ReactMarkdown>
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

const ThreadUsageStats = memo(function ThreadUsageStats({ rateLimits }: { rateLimits: RateLimitSnapshot | null }) {
  if (!rateLimits) {
    return null;
  }
  return (
    <div
      className="thread-usage-stats"
      title={[
        `5hr remaining ${formatPercentValue(rateLimitRemainingPercent(rateLimits, "5hr"))}`,
        `Weekly remaining ${formatPercentValue(rateLimitRemainingPercent(rateLimits, "weekly"))}`
      ].join(" | ")}
    >
      <UsageStatusSummary rateLimits={rateLimits} compact />
    </div>
  );
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
  collapsed,
  onArchive,
  onCompact,
  onCollapsedChange,
  onError,
  onFork,
  onInterrupt,
  onSend
}: {
  activeTurnId: string | null;
  archiveLabel: string;
  collapsed: boolean;
  onArchive: () => void;
  onCompact: () => void;
  onCollapsedChange: (collapsed: boolean) => void;
  onError: (error: unknown) => void;
  onFork: () => void;
  onInterrupt: () => void;
  onSend: (text: string, action?: ComposerAction) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  async function submitDraft(action: ComposerAction) {
    const sent = await onSend(draft, action);
    if (sent) {
      setDraft("");
    }
  }

  async function handleAttachmentFile(file: File | undefined) {
    if (!file) {
      return;
    }
    setUploading(true);
    try {
      const attachment = await uploadAttachment(file);
      setDraft((current) => (current.trim() ? `${current}\n${attachment.path}` : attachment.path));
    } catch (error) {
      onError(error);
    } finally {
      setUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  if (collapsed) {
    return (
      <div className="composer collapsed">
        <button className="primary-button" type="button" onClick={() => onCollapsedChange(false)}>
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
        <button className="icon-button" type="button" onClick={() => onCollapsedChange(true)} title="Collapse composer" aria-label="Collapse composer">
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
          <input
            className="file-input"
            ref={fileInputRef}
            type="file"
            onChange={(event) => void handleAttachmentFile(event.currentTarget.files?.[0])}
          />
          <button
            className="icon-button"
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            title="Attach file"
            aria-label="Attach file"
          >
            <Paperclip size={17} />
          </button>
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

function extractFileReferences(thread: Thread): FileReference[] {
  const references = new Map<string, FileReference>();
  const cwd = thread.cwd || null;
  for (const turn of thread.turns ?? []) {
    for (const item of turn.items ?? []) {
      for (const pathValue of pathsFromItem(item)) {
        addFileReference(references, { path: pathValue, cwd, label: labelForPath(pathValue) });
      }
    }
  }
  return [...references.values()];
}

function pathsFromItem(item: ThreadItem): string[] {
  const paths: string[] = [];
  if (item.type === "userMessage") {
    paths.push(...extractPathCandidates(userInputText(item.content)));
  }
  if (typeof item.text === "string") {
    paths.push(...extractPathCandidates(item.text));
  }
  if (typeof item.path === "string") {
    paths.push(item.path);
  }
  if (typeof item.aggregatedOutput === "string") {
    paths.push(...extractPathCandidates(item.aggregatedOutput));
  }
  const changes = item.changes;
  if (Array.isArray(changes)) {
    for (const change of changes) {
      const record = asRecord(change);
      if (typeof record.path === "string") {
        paths.push(record.path);
      }
    }
  }
  return uniqueFilePaths(paths);
}

function extractPathCandidates(text: string): string[] {
  const matches: string[] = [];
  const pattern = /(?:^|[\s`"'(\[])([~./A-Za-z0-9_-][^\s`"'<>)]{0,240}\.(?:json|md|markdown|mdx|py|tsx?|jsx?|css|scss|html|yaml|yml|toml|txt|log|csv|rs|go|java|kt|swift|c|h|cpp|hpp|cs|rb|php|sh|bash|zsh|fish|sql|xml|vue|svelte|png|jpe?g|gif|webp|bmp|avif|svg|pdf|mp4|m4v|webm|mov|ogv|ogg|avi|mkv|3gp|docx?|xlsx?|pptx?)(?::\d+(?::\d+)?)?)/gi;
  for (const match of text.matchAll(pattern)) {
    const pathValue = cleanFileReferencePath(match[1] || "");
    if (pathValue && looksLikeFileReference(pathValue)) {
      matches.push(pathValue);
    }
  }
  return uniqueFilePaths(matches);
}

function linkifyFileReferences(text: string): string {
  const pattern = /(^|[\s"'])([~./A-Za-z0-9_-][^\s`"'<>)]{0,240}\.(?:json|md|markdown|mdx|py|tsx?|jsx?|css|scss|html|yaml|yml|toml|txt|log|csv|rs|go|java|kt|swift|c|h|cpp|hpp|cs|rb|php|sh|bash|zsh|fish|sql|xml|vue|svelte|png|jpe?g|gif|webp|bmp|avif|svg|pdf|mp4|m4v|webm|mov|ogv|ogg|avi|mkv|3gp|docx?|xlsx?|pptx?)(?::\d+(?::\d+)?)?)/gi;
  let inFence = false;
  return text.split("\n").map((line) => {
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      return line;
    }
    if (inFence || line.includes("](")) {
      return line;
    }
    return line.replace(pattern, (match, prefix: string, pathValue: string, offset: number, source: string) => {
      const pathOffset = offset + prefix.length;
      const previous = source[pathOffset - 1] || "";
      if (previous === "`" || previous === "[" || previous === "(") {
        return match;
      }
      const cleanPath = cleanFileReferencePath(pathValue);
      if (!looksLikeFileReference(cleanPath)) {
        return match;
      }
      return `${prefix}[${pathValue}](${encodeURI(cleanPath)})`;
    });
  }).join("\n");
}

function uniqueFilePaths(paths: string[]): string[] {
  return [...new Set(paths.map(cleanFileReferencePath).filter((pathValue) => pathValue && looksLikeFileReference(pathValue)))];
}

function cleanFileReferencePath(value: string): string {
  return stripLineSuffix(value.trim().replace(/[.,;:!?]+$/g, ""));
}

function addFileReference(references: Map<string, FileReference>, reference: FileReference): void {
  const key = fileReferenceKey(reference);
  if (!references.has(key)) {
    references.set(key, reference);
  }
}

function fileReferenceKey(reference: FileReference): string {
  return `${reference.cwd || ""}\n${reference.path}`;
}

function filePathFromHref(href: string): string {
  if (!href || href.startsWith("#") || /^(?:mailto:|data:|blob:)/i.test(href)) {
    return "";
  }
  if (/^https?:/i.test(href)) {
    try {
      const url = new URL(href);
      const pathValue = cleanFileReferencePath(decodeURIComponent(url.pathname));
      const currentOrigin = typeof window !== "undefined" ? window.location.origin : "";
      if (url.origin === currentOrigin || looksLikeAbsoluteLocalPath(pathValue)) {
        return pathValue;
      }
    } catch {
      return "";
    }
    return "";
  }
  if (href.startsWith("file://")) {
    try {
      return cleanFileReferencePath(decodeURIComponent(new URL(href).pathname));
    } catch {
      return cleanFileReferencePath(href.replace(/^file:\/\//, ""));
    }
  }
  return cleanFileReferencePath(decodeURIComponent(href.split("#")[0]?.split("?")[0] || href));
}

function looksLikeAbsoluteLocalPath(pathValue: string): boolean {
  return /^\/(?:home|Users|tmp|var|mnt|opt|workspace|app)\//.test(pathValue);
}

function looksLikeFileReference(pathValue: string): boolean {
  if (!pathValue || pathValue.includes("://") || pathValue.startsWith("@")) {
    return false;
  }
  return /\.(?:json|md|markdown|mdx|py|tsx?|jsx?|css|scss|html|yaml|yml|toml|txt|log|csv|rs|go|java|kt|swift|c|h|cpp|hpp|cs|rb|php|sh|bash|zsh|fish|sql|xml|vue|svelte|png|jpe?g|gif|webp|bmp|avif|svg|pdf|mp4|m4v|webm|mov|ogv|ogg|avi|mkv|3gp|docx?|xlsx?|pptx?)$/i.test(stripLineSuffix(pathValue));
}

function stripLineSuffix(value: string): string {
  return value.replace(/:\d+(?::\d+)?$/, "");
}

function labelForPath(pathValue: string): string {
  const clean = stripLineSuffix(pathValue);
  return clean.split(/[\\/]/).filter(Boolean).at(-1) || clean;
}

function markdownChildrenText(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(markdownChildrenText).join("");
  }
  return "";
}

function prettyJson(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

function languageForFile(file: FilePreview): string {
  const map: Record<string, string> = {
    js: "javascript",
    jsx: "jsx",
    ts: "typescript",
    tsx: "tsx",
    py: "python",
    rs: "rust",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    yml: "yaml",
    yaml: "yaml",
    md: "markdown",
    markdown: "markdown"
  };
  return map[file.extension] || file.extension || "text";
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

function isMobileViewport(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 780px)").matches;
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

function parseRateLimitsResponse(value: unknown): RateLimitSnapshot | null {
  const record = asRecord(value);
  const byLimitId = asRecord(record.rateLimitsByLimitId);
  const codex = parseRateLimitSnapshot(byLimitId.codex);
  return codex ?? parseRateLimitSnapshot(record.rateLimits);
}

function parseRateLimitSnapshot(value: unknown): RateLimitSnapshot | null {
  const record = asRecord(value);
  const primary = parseRateLimitWindow(record.primary);
  const secondary = parseRateLimitWindow(record.secondary);
  if (!primary && !secondary) {
    return null;
  }
  return {
    limitId: typeof record.limitId === "string" ? record.limitId : null,
    limitName: typeof record.limitName === "string" ? record.limitName : null,
    primary,
    secondary
  };
}

function parseRateLimitWindow(value: unknown) {
  const record = asRecord(value);
  const usedPercent = numberValue(record.usedPercent);
  if (usedPercent === null) {
    return null;
  }
  return {
    usedPercent,
    windowDurationMins: typeof record.windowDurationMins === "number" ? record.windowDurationMins : null,
    resetsAt: typeof record.resetsAt === "number" ? record.resetsAt : null
  };
}

function rateLimitRemainingPercent(rateLimits: RateLimitSnapshot | null, target: "5hr" | "weekly"): number | null {
  if (!rateLimits) {
    return null;
  }
  const windows = [rateLimits.primary, rateLimits.secondary].filter((item): item is NonNullable<typeof item> => Boolean(item));
  const targetMinutes = target === "5hr" ? 300 : 10_080;
  const byDuration = windows.find((item) => item.windowDurationMins !== null && Math.abs(item.windowDurationMins - targetMinutes) <= 30);
  const usedPercent = byDuration?.usedPercent ?? (target === "5hr" ? rateLimits.primary?.usedPercent ?? null : rateLimits.secondary?.usedPercent ?? null);
  return usedPercent === null ? null : Math.max(0, Math.min(100, 100 - usedPercent));
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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

function formatPercentValue(value: number | null): string {
  return value === null ? "--" : `${Math.round(value)}%`;
}

function quotaMetricClass(value: number | null): string {
  if (value === null) return "neutral";
  if (value <= 10) return "bad";
  if (value <= 30) return "busy";
  return "good";
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
