"use client";

import {
  Activity,
  Archive,
  AtSign,
  ChevronUp,
  ChevronsDown,
  ChevronsUp,
  DollarSign,
  FileDiff,
  Folder,
  FolderGit2,
  GitFork,
  Home,
  KeyRound,
  LogOut,
  MessageSquarePlus,
  Mic,
  Minimize2,
  MoreHorizontal,
  Paperclip,
  PauseCircle,
  Plug,
  Plus,
  Radiation,
  RefreshCw,
  Save,
  Search,
  Send,
  Settings,
  Trash2,
  X
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { Fragment, FormEvent, memo, MouseEvent, PointerEvent, TouchEvent, UIEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode, RefObject } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  CodeBlock
} from "@/components/ai-elements/code-block";
import {
  Context,
  ContextCacheUsage,
  ContextContent,
  ContextContentBody,
  ContextContentFooter,
  ContextContentHeader,
  ContextInputUsage,
  ContextOutputUsage,
  ContextReasoningUsage,
  ContextTrigger
} from "@/components/ai-elements/context";
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRequest,
  ConfirmationTitle
} from "@/components/ai-elements/confirmation";
import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputTools
} from "@/components/ai-elements/prompt-input";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Terminal } from "@/components/ai-elements/terminal";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import {
  AUTH_UNAUTHORIZED_EVENT,
  browseFiles,
  browseRepositories,
  createRepository,
  deleteThreadLog,
  downloadReferencedFile,
  getAuth,
  getClientRequests,
  getMcpServers,
  getStatus,
  loginMcpServer,
  listSkills,
  login,
  logout,
  openEventStream,
  readReferencedFile,
  recoverAppServer,
  reloadMcpServers,
  respondClientRequest,
  restartServer,
  transcribeAudio,
  rpc,
  saveMcpServer,
  uploadAttachment
} from "./api";
import type { AuthEventStream } from "./api";
import { ComposerLexicalInput } from "./ComposerLexicalInput";
import type { ComposerInputHandle, ComposerTrigger } from "./ComposerLexicalInput";
import { FileExplorerModal, FileViewerLoadingModal, FileViewerModal } from "./filePanels";
import type { AuthState, ClientRequest, FileExplorer, FileExplorerEntry, FilePreview, FileReference, JsonValue, McpServerList, McpServerStatus, PermissionPolicy, RateLimitSnapshot, RepositoryBrowser, ServerEvent, ServerStatus, SkillReference, Thread, ThreadItem, ThreadTokenUsage, TokenUsageBreakdown, Turn, UiSettings } from "./types";

const defaultSettings: UiSettings = {
  cwd: "",
  model: "gpt-5.5",
  effort: "high",
  approvalPolicy: "on-request",
  sandbox: "workspace-write"
};

const idleWaveformLevels = [0.16, 0.26, 0.42, 0.32, 0.22, 0.34, 0.18];
const transcribingWaveformLevels = [0.3, 0.58, 0.82, 0.48, 0.72, 0.4, 0.62];

type ComposerAction = "send" | "steer";
type ComposerTriggerMenu = ComposerTrigger;
type ApprovalDecision = "accept" | "acceptForSession" | "acceptWithExecpolicyAmendment" | "decline";
type MobilePane = "sessions" | "thread";
type ThreadPaneCount = 1 | 2;
type ThreadPermissionOverride = Pick<UiSettings, "approvalPolicy" | "sandbox">;
type ToastState = {
  message: string;
  tone: "info" | "error";
  actionLabel?: string;
  onAction?: () => void;
};
type SavedComposerDraft = {
  id: string;
  savedAt: number;
  text: string;
};
type StoredLayout = {
  activePaneIndex?: number;
  mobilePane?: MobilePane;
  openThreadIds?: (string | null)[];
  recentOnly?: boolean;
  showArchived?: boolean;
  sidebarWidth?: number;
  threadPaneCount?: ThreadPaneCount;
  threadSplitRatio?: number;
};
type DisplayThreadItem = ThreadItem & { items?: ThreadItem[] };

const THREAD_ITEM_BATCH_SIZE = 20;
const ACTIVE_THREAD_POLL_INTERVAL_MS = 5000;
const SESSION_PAGE_SIZE = 50;
const THREAD_SPLIT_RESIZER_WIDTH = 8;
const ACCOUNT_RATE_LIMIT_ID = "codex";
const COMPOSER_SAVED_DRAFTS_KEY = "codex-web-ui-saved-composer-drafts-v1";
const LAYOUT_STORAGE_KEY = "codex-web-ui-layout-v1";
const THREAD_PERMISSION_STORAGE_KEY = "codex-web-ui-thread-permissions-v1";
const mobilePanes: MobilePane[] = ["sessions", "thread"];
const initialStoredLayout = readStoredLayout();

type AppProps = {
  initialThreadId?: string | null;
};

function useStableCallback<T extends (...args: never[]) => unknown>(callback: T): T {
  const callbackRef = useRef(callback);
  useLayoutEffect(() => {
    callbackRef.current = callback;
  });
  return useCallback(((...args: Parameters<T>) => callbackRef.current(...args)) as T, []);
}

export default function App({ initialThreadId = null }: AppProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [authInfo, setAuthInfo] = useState<AuthState | null>(null);
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [serverStatus, setServerStatus] = useState<ServerStatus>({ state: "stopped" });
  const [sessions, setSessions] = useState<Thread[]>([]);
  const [loadedThreadIds, setLoadedThreadIds] = useState<Set<string>>(new Set());
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [openThreadIds, setOpenThreadIds] = useState<(string | null)[]>(() => initialOpenThreadIds(initialStoredLayout));
  const [openThreads, setOpenThreads] = useState<Record<string, Thread>>({});
  const [activePaneIndex, setActivePaneIndex] = useState(() => initialActivePaneIndex(initialStoredLayout));
  const [sessionPreviews, setSessionPreviews] = useState<Record<string, string>>({});
  const [sessionPage, setSessionPage] = useState(1);
  const [hasMoreSessions, setHasMoreSessions] = useState(false);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(new Set());
  const [sidebarWidth, setSidebarWidth] = useState(() => clampNumber(initialStoredLayout.sidebarWidth, 240, 520, 330));
  const [threadSplitRatio, setThreadSplitRatio] = useState(() => clampNumber(initialStoredLayout.threadSplitRatio, 0.25, 0.75, 0.5));
  const [showArchived, setShowArchived] = useState(() => initialStoredLayout.showArchived ?? false);
  const [recentOnly, setRecentOnly] = useState(() => initialStoredLayout.recentOnly ?? false);
  const [searchTerm, setSearchTerm] = useState("");
  const [mobilePane, setMobilePane] = useState<MobilePane>(() => initialStoredLayout.mobilePane ?? "sessions");
  const [threadPaneCount, setThreadPaneCount] = useState<ThreadPaneCount>(() => initialStoredLayout.threadPaneCount ?? 1);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [topMenuOpen, setTopMenuOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [threadActionsOpen, setThreadActionsOpen] = useState(false);
  const [statusRefreshing, setStatusRefreshing] = useState(false);
  const [settings, setSettings] = useState<UiSettings>({ ...defaultSettings });
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [activeTurns, setActiveTurns] = useState<Record<string, string>>({});
  const [threadTokenUsageById, setThreadTokenUsageById] = useState<Record<string, ThreadTokenUsage>>({});
  const [rateLimits, setRateLimits] = useState<RateLimitSnapshot | null>(null);
  const [filePreviewCache, setFilePreviewCache] = useState<Record<string, FilePreview>>({});
  const [fileViewer, setFileViewer] = useState<{ reference: FileReference; file: FilePreview } | null>(null);
  const [fileViewerLoading, setFileViewerLoading] = useState<FileReference | null>(null);
  const [fileExplorerOpen, setFileExplorerOpen] = useState(false);
  const [fileExplorerMode, setFileExplorerMode] = useState<"view" | "reference">("view");
  const [fileExplorer, setFileExplorer] = useState<FileExplorer | null>(null);
  const [fileExplorerCache, setFileExplorerCache] = useState<Record<string, FileExplorer>>({});
  const [fileExplorerLoading, setFileExplorerLoading] = useState(false);
  const [skillSelectorOpen, setSkillSelectorOpen] = useState(false);
  const [skills, setSkills] = useState<SkillReference[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [loadingThreadByPane, setLoadingThreadByPane] = useState<Record<number, string>>({});
  const [clientRequests, setClientRequests] = useState<Record<string, ClientRequest>>({});
  const [respondingClientRequestIds, setRespondingClientRequestIds] = useState<Set<string>>(new Set());
  const [threadPermissionOverrides, setThreadPermissionOverrides] = useState<Record<string, ThreadPermissionOverride>>(() => readStoredThreadPermissions());
  const [pullRefresh, setPullRefresh] = useState<{ active: boolean; distance: number; refreshing: boolean }>({ active: false, distance: 0, refreshing: false });
  const [mcpServers, setMcpServers] = useState<McpServerList | null>(null);
  const [mcpLoading, setMcpLoading] = useState(false);

  const eventSourceRef = useRef<AuthEventStream | null>(null);
  const recentOAuthFailureToastRef = useRef<Map<string, number>>(new Map());
  const refreshTimersRef = useRef<Map<string, number>>(new Map());
  const activeThreadPollInFlightRef = useRef<Set<string>>(new Set());
  const lastThreadEventAtRef = useRef<Map<string, number>>(new Map());
  const contextReloadAttemptedThreadIdsRef = useRef<Set<string>>(new Set());
  const contextReloadInFlightThreadIdsRef = useRef<Set<string>>(new Set());
  const listTimerRef = useRef<number | null>(null);
  const sessionsLoadSeqRef = useRef(0);
  const threadLoadSeqRef = useRef(0);
  const fileExplorerLoadSeqRef = useRef(0);
  const filePreviewLoadSeqRef = useRef(0);
  const fileReferenceSelectRef = useRef<((entry: FileExplorerEntry, explorer: FileExplorer) => void) | null>(null);
  const skillSelectRef = useRef<((skill: SkillReference) => void) | null>(null);
  const paneThreadLoadTokensRef = useRef<Record<number, number>>({});
  const appliedInitialThreadIdRef = useRef<string | null>(null);
  const activePaneIndexRef = useRef(activePaneIndex);
  const activeTurnsRef = useRef<Record<string, string>>({});
  const openThreadIdsRef = useRef<(string | null)[]>(openThreadIds);
  const openThreadsRef = useRef<Record<string, Thread>>({});
  const threadTokenUsageByIdRef = useRef<Record<string, ThreadTokenUsage>>({});
  const threadPermissionOverridesRef = useRef<Record<string, ThreadPermissionOverride>>(threadPermissionOverrides);
  const restoredLayoutThreadsRef = useRef(false);
  const touchStartRef = useRef<{ x: number; y: number; paneSwipeBlocked: boolean; refreshEligible: boolean } | null>(null);
  const headerPullStartRef = useRef<{ x: number; y: number } | null>(null);
  const resizingSidebarRef = useRef(false);
  const resizingThreadSplitRef = useRef(false);
  const layoutRef = useRef<HTMLElement | null>(null);
  const threadGridRef = useRef<HTMLDivElement | null>(null);
  const sidebarWidthRef = useRef(sidebarWidth);
  const sidebarResizeFrameRef = useRef<number | null>(null);
  const pendingSidebarWidthRef = useRef(sidebarWidth);
  const threadSplitRatioRef = useRef(threadSplitRatio);
  const threadSplitResizeFrameRef = useRef<number | null>(null);
  const pendingThreadSplitRatioRef = useRef(threadSplitRatio);
  const layoutWriteTimerRef = useRef<number | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressActivatedRef = useRef(false);
  const sessionClickTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!topMenuOpen && !mobileMenuOpen && !threadActionsOpen) {
      return;
    }
    function closeMenusOnOutsidePointer(event: globalThis.PointerEvent) {
      const target = event.target;
      if (target instanceof Element && target.closest("[data-menu-root]")) {
        return;
      }
      setTopMenuOpen(false);
      setMobileMenuOpen(false);
      setThreadActionsOpen(false);
    }
    window.addEventListener("pointerdown", closeMenusOnOutsidePointer);
    return () => window.removeEventListener("pointerdown", closeMenusOnOutsidePointer);
  }, [mobileMenuOpen, threadActionsOpen, topMenuOpen]);

  useEffect(() => {
    openThreadsRef.current = openThreads;
  }, [openThreads]);

  useEffect(() => {
    activeTurnsRef.current = activeTurns;
  }, [activeTurns]);

  useEffect(() => {
    threadPermissionOverridesRef.current = threadPermissionOverrides;
    writeStoredThreadPermissions(threadPermissionOverrides);
  }, [threadPermissionOverrides]);

  useEffect(() => {
    return () => {
      for (const timer of refreshTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      refreshTimersRef.current.clear();
      if (listTimerRef.current) {
        window.clearTimeout(listTimerRef.current);
      }
      if (layoutWriteTimerRef.current) {
        window.clearTimeout(layoutWriteTimerRef.current);
      }
      if (sidebarResizeFrameRef.current) {
        window.cancelAnimationFrame(sidebarResizeFrameRef.current);
      }
      if (threadSplitResizeFrameRef.current) {
        window.cancelAnimationFrame(threadSplitResizeFrameRef.current);
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
    function handleUnauthorized() {
      eventSourceRef.current?.close();
      setAuthInfo(null);
      setAuthenticated(false);
      setLoginError("Session expired. Sign in again.");
    }
    window.addEventListener(AUTH_UNAUTHORIZED_EVENT, handleUnauthorized);
    return () => window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, handleUnauthorized);
  }, []);

  useEffect(() => {
    if (!authenticated) {
      return;
    }
    getStatus().then(setServerStatus).catch(showToast);
    loadSessions();
    restoreOpenThreadsFromLayout();
    loadRateLimits();
    loadClientRequestQueue();
    eventSourceRef.current?.close();
    const source = openEventStream(
      (event) => {
        handleServerEvent(event);
      },
      (events) => {
        for (const event of events) {
          handleServerEvent(event);
        }
      }
    );
    source.onerror = () => setServerStatus((current) => ({ ...current, state: "disconnected", error: "Event stream disconnected" }));
    eventSourceRef.current = source;
    return () => {
      source.close();
    };
  }, [authenticated]);

  useEffect(() => {
    if (!authenticated || !initialThreadId) {
      appliedInitialThreadIdRef.current = null;
      return;
    }
    if (appliedInitialThreadIdRef.current === initialThreadId) {
      return;
    }
    appliedInitialThreadIdRef.current = initialThreadId;
    const targetPaneIndex = activePaneIndexRef.current;
    const existingPaneIndex = openThreadIdsRef.current.indexOf(initialThreadId);
    if (existingPaneIndex >= 0) {
      activatePane(existingPaneIndex);
      setSelectedThreadId(initialThreadId);
      return;
    }
    if (threadPaneCount > 1 && openThreadIdsRef.current.some(Boolean)) {
      return;
    }
    void selectThread(initialThreadId, targetPaneIndex, false);
  }, [authenticated, initialThreadId]);

  useEffect(() => {
    if (!authenticated || !statusOpen) {
      return;
    }
    void loadMcpServerStatus();
  }, [authenticated, statusOpen]);

  useEffect(() => {
    if (!authenticated) {
      return;
    }
    const timer = window.setInterval(() => {
      const now = Date.now();
      const openIds = uniqueStrings(openThreadIdsRef.current);
      for (const threadId of openIds) {
        const thread = openThreadsRef.current[threadId];
        if (!thread || !isThreadLikelyActive(thread, activeTurnsRef.current[threadId])) {
          continue;
        }
        const lastEventAt = lastThreadEventAtRef.current.get(threadId) ?? 0;
        if (now - lastEventAt < ACTIVE_THREAD_POLL_INTERVAL_MS || activeThreadPollInFlightRef.current.has(threadId)) {
          continue;
        }
        const paneIndex = openThreadIdsRef.current.indexOf(threadId);
        if (paneIndex < 0) {
          continue;
        }
        activeThreadPollInFlightRef.current.add(threadId);
        void readThread(threadId, paneIndex)
          .finally(() => activeThreadPollInFlightRef.current.delete(threadId));
      }
    }, ACTIVE_THREAD_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
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
  const activeThreadId = paneThreadIds[activePaneIndex] ?? null;
  const activeThread = activeThreadId ? openThreads[activeThreadId] ?? null : null;
  const appTitle = isMobileViewport() && mobilePane === "sessions"
    ? "Codex Web UI"
    : activeThread
      ? titleForThread(activeThread)
      : "Codex Web UI";
  const selectionActive = selectedSessionIds.size > 0;
  const handleActivatePane = useStableCallback((paneIndex: number) => activatePane(paneIndex));
  const handleArchivePaneThread = useStableCallback((thread: Thread, paneIndex: number) => archiveThread(thread, paneIndex));
  const handleForkPaneThread = useStableCallback((thread: Thread, paneIndex: number) => forkThread(thread, paneIndex));
  const handleInterruptPaneThread = useStableCallback((thread: Thread) => interruptThread(thread));
  const handleRenamePaneThread = useStableCallback((thread: Thread, name: string) => renameThread(thread, name));
  const handleSendPaneMessage = useStableCallback((thread: Thread, paneIndex: number, text: string, action?: ComposerAction) => sendMessageText(thread, paneIndex, text, action));
  const handleOpenFileReference = useStableCallback((reference: FileReference) => openFileReference(reference));
  const handleReferenceFile = useStableCallback((onSelect: (entry: FileExplorerEntry, explorer: FileExplorer) => void) => openFileExplorerForReference(onSelect));
  const handleReferenceSkill = useStableCallback((onSelect: (skill: SkillReference) => void) => openSkillSelector(onSelect));
  const handleLoginMcpServer = useStableCallback((name: string) => loginMcpServerFromUi(name));
  const handlePaneError = useStableCallback((error: unknown) => showToast(error));
  const handleRespondClientRequest = useStableCallback((request: ClientRequest, decision: ApprovalDecision) => respondToClientRequest(request, decision));
  const handleOpenSettings = useStableCallback(() => setSettingsOpen(true));
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

  useEffect(() => {
    writeStoredLayout({
      activePaneIndex,
      mobilePane,
      openThreadIds,
      recentOnly,
      showArchived,
      sidebarWidth,
      threadPaneCount,
      threadSplitRatio
    }, layoutWriteTimerRef);
  }, [activePaneIndex, mobilePane, openThreadIds, recentOnly, showArchived, sidebarWidth, threadPaneCount, threadSplitRatio]);

  useEffect(() => {
    sidebarWidthRef.current = sidebarWidth;
    pendingSidebarWidthRef.current = sidebarWidth;
    layoutRef.current?.style.setProperty("--sidebar-width", `${sidebarWidth}px`);
  }, [sidebarWidth]);

  useEffect(() => {
    threadSplitRatioRef.current = threadSplitRatio;
    pendingThreadSplitRatioRef.current = threadSplitRatio;
    updateThreadGridSplitVars(threadGridRef.current, threadSplitRatio);
  }, [threadSplitRatio]);

  if (authenticated === null) {
    return <div className="boot">Loading</div>;
  }

  if (!authenticated) {
    return (
      <main className="login-screen">
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
      </main>
    );
  }

  return (
    <main className={`app-shell ${authInfo?.warning ? "auth-warning-mode" : ""}`}>
      <header
        className="topbar"
        onTouchStart={handleHeaderTouchStart}
        onTouchMove={handleHeaderTouchMove}
        onTouchEnd={() => void finishHeaderPullRefresh()}
        onTouchCancel={cancelHeaderPullRefresh}
      >
        <div className="brand-block">
          <div className="mark" aria-hidden="true">
            <img src="/icon.svg" alt="" />
          </div>
          <div>
            <strong title={appTitle}>{appTitle}</strong>
            {authInfo?.warning && <span className="auth-warning-text">{authInfo.warning}</span>}
          </div>
        </div>
        <div className="top-actions">
          <button className={`status-button ${serverStatus.state === "disconnected" ? "disconnected" : ""}`} type="button" onClick={() => setStatusOpen(true)} title="Show app server status" aria-label="Show app server status">
            <Activity size={16} />
            <span className="top-action-label">Status</span>
            <StatusBadge value={serverStatus.state} />
          </button>
          <div className="action-overflow" data-menu-root>
            <button className="ghost-button" type="button" onClick={() => setTopMenuOpen((open) => !open)} title="More actions" aria-label="More actions" aria-expanded={topMenuOpen}>
              <MoreHorizontal size={18} />
            </button>
            {topMenuOpen && (
              <div className="action-overflow-menu top-overflow-menu" role="menu">
                <button type="button" role="menuitem" onClick={() => {
                  setTopMenuOpen(false);
                  void openFileExplorer();
                }}>
                  <Folder size={16} /> Files
                </button>
                <button type="button" role="menuitem" onClick={() => {
                  setTopMenuOpen(false);
                  void handleRestart();
                }}>
                  <RefreshCw size={16} /> Reconnect
                </button>
                <button type="button" role="menuitem" onClick={() => {
                  setTopMenuOpen(false);
                  void handleLogout();
                }}>
                  <LogOut size={16} /> Logout
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <nav className="mobile-pane-tabs" aria-label="Panes">
        <button className={mobilePane === "sessions" ? "selected" : ""} type="button" onClick={() => setMobilePane("sessions")}>
          Threads
        </button>
        <button className={mobilePane === "thread" ? "selected" : ""} type="button" onClick={() => setMobilePane("thread")}>
          Thread
        </button>
        <div className="mobile-nav-actions">
          <button className="ghost-button" type="button" onClick={() => setNewSessionOpen(true)} title="New thread" aria-label="New thread">
            <MessageSquarePlus size={17} />
          </button>
          <button className={`status-button ${serverStatus.state === "disconnected" ? "disconnected" : ""}`} type="button" onClick={() => setStatusOpen(true)} title="Show app server status" aria-label="Show app server status">
            <Activity size={17} />
          </button>
          <div className="action-overflow" data-menu-root>
            <button className="ghost-button" type="button" onClick={() => setMobileMenuOpen((open) => !open)} title="More actions" aria-label="More actions" aria-expanded={mobileMenuOpen}>
              <MoreHorizontal size={18} />
            </button>
            {mobileMenuOpen && (
              <div className="action-overflow-menu mobile-overflow-menu" role="menu">
                <label className="menu-check-item">
                  <input type="checkbox" checked={recentOnly} onChange={(event) => setRecentOnlyFilter(event.target.checked)} />
                  <span>Recent</span>
                </label>
                <label className="menu-check-item">
                  <input type="checkbox" checked={showArchived} onChange={(event) => switchArchiveFilter(event.target.checked)} />
                  <span>Archived</span>
                </label>
                <button type="button" role="menuitem" disabled={sessionsLoading} onClick={() => void refreshSessionsFromMobileMenu()}>
                  <RefreshCw size={16} className={sessionsLoading ? "spin-icon" : ""} /> Refresh
                </button>
                <button type="button" role="menuitem" onClick={() => {
                  setMobileMenuOpen(false);
                  void openFileExplorer();
                }}>
                  <Folder size={16} /> Files
                </button>
                <button type="button" role="menuitem" onClick={() => {
                  setMobileMenuOpen(false);
                  void handleRestart();
                }}>
                  <RefreshCw size={16} /> Reconnect
                </button>
                <button type="button" role="menuitem" onClick={() => {
                  setMobileMenuOpen(false);
                  void handleLogout();
                }}>
                  <LogOut size={16} /> Logout
                </button>
              </div>
            )}
          </div>
        </div>
      </nav>

      <div
        className={`pull-refresh-indicator ${pullRefresh.active || pullRefresh.refreshing ? "visible" : ""} ${pullRefresh.refreshing ? "refreshing" : ""}`}
        style={{ "--pull-distance": `${Math.min(72, pullRefresh.distance)}px` } as CSSProperties}
        aria-hidden="true"
      >
        <RefreshCw size={18} />
      </div>

      <section
        ref={layoutRef}
        style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
        className={`layout mobile-pane-${mobilePane}`}
        onTouchStart={(event) => {
          const touch = event.touches[0];
          touchStartRef.current = touch
            ? {
                x: touch.clientX,
                y: touch.clientY,
                paneSwipeBlocked: isWithinHorizontalScroller(event.target, event.currentTarget),
                refreshEligible: isWithinScrollableAtTop(event.target, event.currentTarget)
              }
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
          if (start.refreshEligible && deltaY > 110 && Math.abs(deltaY) > Math.abs(deltaX) * 1.25) {
            window.location.reload();
            return;
          }
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
            </div>
            <div className="panel-actions">
              <button className="icon-button" type="button" onClick={() => setNewSessionOpen(true)} title="New thread" aria-label="New thread">
                <MessageSquarePlus size={18} />
              </button>
              <div className="action-overflow thread-actions-overflow" data-menu-root>
                <button className="icon-button" type="button" onClick={() => setThreadActionsOpen((open) => !open)} title="Thread list actions" aria-label="Thread list actions" aria-expanded={threadActionsOpen}>
                  <MoreHorizontal size={18} />
                </button>
                {threadActionsOpen && (
                  <div className="action-overflow-menu thread-actions-menu" role="menu">
                    <label className="menu-check-item">
                      <input type="checkbox" checked={recentOnly} onChange={(event) => setRecentOnlyFilter(event.target.checked)} />
                      <span>Recent</span>
                    </label>
                    <label className="menu-check-item">
                      <input type="checkbox" checked={showArchived} onChange={(event) => switchArchiveFilter(event.target.checked)} />
                      <span>Archived</span>
                    </label>
                    <button type="button" role="menuitem" disabled={sessionsLoading} onClick={() => void refreshSessionsFromThreadMenu()}>
                      <RefreshCw size={16} className={sessionsLoading ? "spin-icon" : ""} /> Refresh
                    </button>
                  </div>
                )}
              </div>
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
                <ThreadProjectGroup
                  group={group}
                  key={group.key}
                  onClearLongPress={clearSessionLongPress}
                  onRowClick={handleSessionRowClick}
                  onStartLongPress={startSessionLongPress}
                  selectedSessionIds={selectedSessionIds}
                  selectedThreadId={selectedThreadId}
                  sessionPreviews={sessionPreviews}
                />
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
            pendingSidebarWidthRef.current = sidebarWidthRef.current;
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (!resizingSidebarRef.current) {
              return;
            }
            updateSidebarWidthDuringResize(Math.min(520, Math.max(240, event.clientX)));
          }}
          onPointerUp={(event) => {
            resizingSidebarRef.current = false;
            setSidebarWidth(pendingSidebarWidthRef.current);
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => {
            resizingSidebarRef.current = false;
            setSidebarWidth(pendingSidebarWidthRef.current);
          }}
        />

        <section className={`thread-workspace panes-${threadPaneCount}`}>
          <div className="thread-view-controls" aria-label="Thread layout">
            {[1, 2].map((count) => (
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
          <div
            className="thread-grid"
            ref={threadGridRef}
            style={threadGridSplitStyle(threadSplitRatio)}
          >
            {paneThreadIds.map((threadId, paneIndex) => {
              const thread = threadId ? openThreads[threadId] ?? null : null;
              const isLoadingThread = Boolean(threadId && loadingThreadByPane[paneIndex] === threadId && !thread);
              return (
                <Fragment key={paneIndex}>
                  {threadPaneCount === 2 && paneIndex === 1 && (
                    <div
                      className="thread-split-resizer"
                      role="separator"
                      aria-label="Resize thread panes"
                      aria-orientation="vertical"
                      onPointerDown={(event) => {
                        resizingThreadSplitRef.current = true;
                        pendingThreadSplitRatioRef.current = threadSplitRatioRef.current;
                        event.currentTarget.setPointerCapture(event.pointerId);
                      }}
                      onPointerMove={(event) => {
                        if (!resizingThreadSplitRef.current) {
                          return;
                        }
                        const nextRatio = threadSplitRatioFromPointer(event.clientX);
                        if (nextRatio !== null) {
                          updateThreadSplitDuringResize(nextRatio);
                        }
                      }}
                      onPointerUp={(event) => {
                        resizingThreadSplitRef.current = false;
                        setThreadSplitRatio(pendingThreadSplitRatioRef.current);
                        event.currentTarget.releasePointerCapture(event.pointerId);
                      }}
                      onPointerCancel={() => {
                        resizingThreadSplitRef.current = false;
                        setThreadSplitRatio(pendingThreadSplitRatioRef.current);
                      }}
                    />
                  )}
                  <ThreadPane
                    activeTurnId={thread ? activeTurnFromThread(thread) || activeTurns[thread.id] || null : null}
                    archiveLabel={showArchived ? "Unarchive" : "Archive"}
                    isActive={paneIndex === activePaneIndex}
                    isLoading={isLoadingThread}
                    onActivatePane={handleActivatePane}
                    onArchiveThread={handleArchivePaneThread}
                    onForkThread={handleForkPaneThread}
                    onInterruptThread={handleInterruptPaneThread}
                    onRenameThread={handleRenamePaneThread}
                    onError={handlePaneError}
                    onOpenFile={handleOpenFileReference}
                    onOpenSettings={handleOpenSettings}
                    onReferenceFile={handleReferenceFile}
                    onReferenceSkill={handleReferenceSkill}
                    onSendMessage={handleSendPaneMessage}
                    paneIndex={paneIndex}
                    thread={thread}
                    tokenUsage={threadId ? threadTokenUsageById[threadId] ?? null : null}
                  />
                </Fragment>
              );
            })}
          </div>
        </section>

      </section>

      {Object.keys(clientRequests).length > 0 && (
        <ApprovalTray
          permissionPolicy={authInfo?.permissionPolicy}
          requests={Object.values(clientRequests)}
          respondingIds={respondingClientRequestIds}
          onRespond={handleRespondClientRequest}
          onUpgradePermissions={upgradeThreadPermissionsFromApproval}
        />
      )}

      {newSessionOpen && (
        <SessionModal
          title="New Thread"
          settings={settings}
          permissionPolicy={authInfo?.permissionPolicy}
          onClose={() => setNewSessionOpen(false)}
          onSubmit={createSession}
          includePrompt
        />
      )}
      {settingsOpen && (
        <SessionModal
          title="Settings"
          settings={settings}
          permissionPolicy={authInfo?.permissionPolicy}
          onClose={() => setSettingsOpen(false)}
          onSubmit={({ settings: nextSettings }) => {
            setSettings(nextSettings);
            setSettingsOpen(false);
          }}
        />
      )}
      {statusOpen && (
        <StatusModal
          activeThread={activeThread}
          mcpLoading={mcpLoading}
          mcpServers={mcpServers}
          rateLimits={rateLimits}
          status={serverStatus}
          onClose={() => setStatusOpen(false)}
          onRecover={recoverAppServerFromUi}
          onRefreshMcp={reloadMcpServerStatus}
          onLoginMcpServer={handleLoginMcpServer}
          statusRefreshing={statusRefreshing}
          onRefresh={refreshStatus}
          onSaveMcpServer={saveMcpServerFromUi}
        />
      )}
      {fileExplorerOpen && (
        <FileExplorerModal
          explorer={fileExplorer}
          loading={fileExplorerLoading}
          onBrowse={(pathValue) => void loadFileExplorer(fileExplorer?.cwd || defaultFileExplorerCwd(), pathValue)}
          onClose={closeFileExplorer}
          onOpenFile={handleFileExplorerFile}
          onRefresh={() => fileExplorer ? void loadFileExplorer(fileExplorer.cwd, fileExplorer.path, true) : void loadFileExplorer(defaultFileExplorerCwd(), null, true)}
          title={fileExplorerMode === "reference" ? "Reference file" : "Files"}
        />
      )}
      {skillSelectorOpen && (
        <SkillSelectorModal
          loading={skillsLoading}
          onClose={closeSkillSelector}
          onRefresh={() => void loadSkills(true)}
          onSelect={handleSkillSelect}
          skills={skills}
        />
      )}
      {fileViewer && (
        <FileViewerModal
          file={fileViewer.file}
          reference={fileViewer.reference}
          onClose={() => setFileViewer(null)}
        />
      )}
      {fileViewerLoading && (
        <FileViewerLoadingModal
          reference={fileViewerLoading}
          onClose={() => {
            filePreviewLoadSeqRef.current += 1;
            setFileViewerLoading(null);
          }}
        />
      )}
      {toast && (
        <div className={`toast ${toast.tone}`}>
          <span>{toast.message}</span>
          {toast.actionLabel && toast.onAction && (
            <button type="button" onClick={toast.onAction}>
              {toast.actionLabel}
            </button>
          )}
        </div>
      )}
    </main>
  );

  async function handleLogin(event: FormEvent) {
    event.preventDefault();
    setLoginError("");
    try {
      const nextAuth = await login(password);
      setPassword("");
      applyAuth(nextAuth);
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
    const permissionPolicy = nextAuth.permissionPolicy;
    if (permissionPolicy) {
      setSettings((current) => ({
        ...current,
        approvalPolicy: permissionPolicy.locked
          ? permissionPolicy.defaultApprovalPolicy
          : (permissionPolicy.allowedApprovalPolicies.includes(current.approvalPolicy)
              ? current.approvalPolicy
              : permissionPolicy.defaultApprovalPolicy),
        sandbox: permissionPolicy.locked
          ? permissionPolicy.defaultSandbox
          : (permissionPolicy.allowedSandboxes.includes(current.sandbox)
              ? current.sandbox
              : permissionPolicy.defaultSandbox)
      }));
    }
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

  async function recoverAppServerFromUi() {
    try {
      const result = await recoverAppServer();
      setServerStatus(result.status);
      showToast(result.output || "App server recovered");
      await loadSessions();
    } catch (error) {
      showToast(error);
    }
  }

  async function refreshStatus() {
    setStatusRefreshing(true);
    try {
      setServerStatus(await getStatus());
      await loadRateLimits();
    } catch (error) {
      showToast(error);
    } finally {
      setStatusRefreshing(false);
    }
  }

  async function refreshSessionsFromMobileMenu() {
    await loadSessions();
    setMobileMenuOpen(false);
  }

  async function refreshSessionsFromThreadMenu() {
    await loadSessions();
    setThreadActionsOpen(false);
  }

  function handleHeaderTouchStart(event: TouchEvent<HTMLElement>) {
    if (!isMobileViewport()) {
      return;
    }
    const touch = event.touches[0];
    headerPullStartRef.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
  }

  function handleHeaderTouchMove(event: TouchEvent<HTMLElement>) {
    const start = headerPullStartRef.current;
    const touch = event.touches[0];
    if (!start || !touch || pullRefresh.refreshing) {
      return;
    }
    const deltaY = touch.clientY - start.y;
    const deltaX = touch.clientX - start.x;
    if (deltaY <= 4 || Math.abs(deltaX) > Math.max(32, deltaY * 0.8)) {
      return;
    }
    event.preventDefault();
    setPullRefresh({ active: true, distance: Math.min(96, deltaY * 0.72), refreshing: false });
  }

  async function finishHeaderPullRefresh() {
    const shouldRefresh = pullRefresh.active && pullRefresh.distance >= 54;
    headerPullStartRef.current = null;
    if (!shouldRefresh) {
      setPullRefresh({ active: false, distance: 0, refreshing: false });
      return;
    }
    setPullRefresh({ active: true, distance: 64, refreshing: true });
    try {
      await refreshVisibleData();
    } finally {
      window.setTimeout(() => setPullRefresh({ active: false, distance: 0, refreshing: false }), 220);
    }
  }

  function cancelHeaderPullRefresh() {
    headerPullStartRef.current = null;
    if (!pullRefresh.refreshing) {
      setPullRefresh({ active: false, distance: 0, refreshing: false });
    }
  }

  async function refreshVisibleData() {
    await Promise.all([
      refreshStatus(),
      loadSessions(),
      activeThreadId ? readThread(activeThreadId, activePaneIndexRef.current) : Promise.resolve(null)
    ]);
  }

  function defaultFileExplorerCwd(): string {
    return activeThread?.cwd || settings.cwd || serverStatus.cwd || "";
  }

  function fileExplorerCacheKey(cwd: string, pathValue?: string | null): string {
    return `${cwd}\n${pathValue || ""}`;
  }

  async function openFileExplorer() {
    setFileExplorerMode("view");
    fileReferenceSelectRef.current = null;
    setFileExplorerOpen(true);
    await loadFileExplorer(defaultFileExplorerCwd());
  }

  async function openFileExplorerForReference(onSelect: (entry: FileExplorerEntry, explorer: FileExplorer) => void) {
    fileReferenceSelectRef.current = onSelect;
    setFileExplorerMode("reference");
    setFileExplorerOpen(true);
    await loadFileExplorer(defaultFileExplorerCwd());
  }

  function closeFileExplorer() {
    fileReferenceSelectRef.current = null;
    setFileExplorerMode("view");
    setFileExplorerOpen(false);
  }

  async function handleFileExplorerFile(entry: FileExplorerEntry) {
    if (!fileExplorer) {
      return;
    }
    const onSelect = fileReferenceSelectRef.current;
    if (fileExplorerMode === "reference" && onSelect) {
      onSelect(entry, fileExplorer);
      closeFileExplorer();
      return;
    }
    await openFileReference({ path: entry.path, cwd: fileExplorer.cwd, label: entry.name });
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
    const cached = filePreviewCache[key];
    if (cached) {
      setFileViewerLoading(null);
      if (!cached.previewable) {
        await downloadReferencedFile(reference, cached.name);
        return;
      }
      setFileViewer({ reference, file: cached });
      return;
    }
    const loadId = ++filePreviewLoadSeqRef.current;
    setFileViewer(null);
    setFileViewerLoading(reference);
    try {
      const file = await readReferencedFile(reference);
      if (loadId !== filePreviewLoadSeqRef.current) {
        return;
      }
      setFilePreviewCache((current) => ({ ...current, [key]: file }));
      if (!file.previewable) {
        setFileViewerLoading(null);
        await downloadReferencedFile(reference, file.name);
        return;
      }
      setFileViewerLoading(null);
      setFileViewer({ reference, file });
    } catch (error) {
      if (loadId === filePreviewLoadSeqRef.current) {
        setFileViewerLoading(null);
        showToast(error);
      }
    }
  }

  async function openSkillSelector(onSelect: (skill: SkillReference) => void) {
    skillSelectRef.current = onSelect;
    setSkillSelectorOpen(true);
    if (!skills.length) {
      await loadSkills();
    }
  }

  function closeSkillSelector() {
    skillSelectRef.current = null;
    setSkillSelectorOpen(false);
  }

  async function loadSkills(force = false) {
    if (skills.length && !force) {
      return;
    }
    setSkillsLoading(true);
    try {
      setSkills(await listSkills());
    } catch (error) {
      showToast(error);
    } finally {
      setSkillsLoading(false);
    }
  }

  function handleSkillSelect(skill: SkillReference) {
    skillSelectRef.current?.(skill);
    closeSkillSelector();
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

  function restoreOpenThreadsFromLayout() {
    if (restoredLayoutThreadsRef.current) {
      return;
    }
    restoredLayoutThreadsRef.current = true;
    const entries = openThreadIdsRef.current
      .map((threadId, paneIndex) => ({ threadId, paneIndex }))
      .filter((entry): entry is { threadId: string; paneIndex: number } => Boolean(entry.threadId));
    if (entries.length === 0) {
      return;
    }
    const activeThreadId = openThreadIdsRef.current[activePaneIndexRef.current] ?? entries[0]?.threadId ?? null;
    if (activeThreadId) {
      setSelectedThreadId(activeThreadId);
    }
    setLoadingThreadByPane((current) => {
      const next = { ...current };
      for (const entry of entries) {
        next[entry.paneIndex] = entry.threadId;
      }
      return next;
    });
    for (const entry of entries) {
      const loadToken = ++threadLoadSeqRef.current;
      paneThreadLoadTokensRef.current[entry.paneIndex] = loadToken;
      void readThread(entry.threadId, entry.paneIndex, loadToken).finally(() => {
        setLoadingThreadByPane((current) => {
          if (current[entry.paneIndex] !== entry.threadId) {
            return current;
          }
          const next = { ...current };
          delete next[entry.paneIndex];
          return next;
        });
      });
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
      setRateLimits((current) => current);
    }
  }

  async function loadClientRequestQueue() {
    try {
      const requests = await getClientRequests();
      setClientRequests(Object.fromEntries(requests.map((request) => [clientRequestKey(request.id), request])));
    } catch (error) {
      showToast(error);
    }
  }

  async function loadMcpServerStatus() {
    setMcpLoading(true);
    try {
      setMcpServers(await getMcpServers());
    } catch (error) {
      showToast(error);
    } finally {
      setMcpLoading(false);
    }
  }

  async function reloadMcpServerStatus() {
    setMcpLoading(true);
    try {
      setMcpServers(await reloadMcpServers());
      showToast("MCP servers reloaded");
    } catch (error) {
      showToast(error);
    } finally {
      setMcpLoading(false);
    }
  }

  async function saveMcpServerFromUi(input: { name: string; url: string }) {
    setMcpLoading(true);
    try {
      setMcpServers(await saveMcpServer(input));
      showToast("MCP server saved and reloaded");
    } catch (error) {
      showToast(error);
      throw error;
    } finally {
      setMcpLoading(false);
    }
  }

  async function loginMcpServerFromUi(name: string): Promise<string> {
    try {
      const result = await loginMcpServer(name);
      showToast(`Opening OAuth login for ${name}`);
      return result.authorizationUrl;
    } catch (error) {
      showToast(error);
      throw error;
    }
  }

  async function respondToClientRequest(request: ClientRequest, decision: ApprovalDecision) {
    const key = clientRequestKey(request.id);
    setRespondingClientRequestIds((current) => new Set(current).add(key));
    setClientRequests((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    try {
      await respondClientRequest(request.id, { decision: approvalDecisionPayload(request, decision) });
    } catch (error) {
      showToast(error);
    } finally {
      setRespondingClientRequestIds((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }

  async function upgradeThreadPermissionsFromApproval(request: ClientRequest) {
    const policy = authInfo?.permissionPolicy;
    if (!canUseFullControl(policy)) {
      showToast("Full-control permissions are not allowed by this server.");
      return;
    }
    const threadId = threadIdFromClientRequest(request) || selectedThreadId;
    if (!threadId) {
      showToast("No thread id was available for this approval.");
      return;
    }
    const nextOverrides = {
      ...threadPermissionOverridesRef.current,
      [threadId]: { approvalPolicy: "never", sandbox: "danger-full-access" }
    };
    threadPermissionOverridesRef.current = nextOverrides;
    writeStoredThreadPermissions(nextOverrides);
    setThreadPermissionOverrides(nextOverrides);
    showToast("Full-control permissions enabled for this thread.");
    const pendingForThread = Object.values(clientRequests)
      .filter((item) => clientRequestKey(item.id) === clientRequestKey(request.id) || threadIdFromClientRequest(item) === threadId)
      .sort((a, b) => a.receivedAt - b.receivedAt);
    for (const item of pendingForThread) {
      await respondToClientRequest(item, fullControlDecision(item));
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

  function rememberThreadTokenUsage(threadId: string, usage: ThreadTokenUsage | null): ThreadTokenUsage | null {
    const merged = mergeThreadTokenUsage(usage, threadTokenUsageByIdRef.current[threadId] ?? null);
    if (!merged) {
      return null;
    }
    const previous = threadTokenUsageByIdRef.current[threadId] ?? null;
    if (sameThreadTokenUsage(previous, merged)) {
      return merged;
    }
    threadTokenUsageByIdRef.current = { ...threadTokenUsageByIdRef.current, [threadId]: merged };
    setThreadTokenUsageById(threadTokenUsageByIdRef.current);
    return merged;
  }

  function rememberOpenThread(thread: Thread, paneIndex = activePaneIndexRef.current, assignPane = true) {
    const targetPaneIndex = Math.min(threadPaneCount - 1, Math.max(0, paneIndex));
    const rememberedUsage = rememberThreadTokenUsage(thread.id, threadTokenUsage(thread));
    const incomingThread = rememberedUsage ? { ...thread, tokenUsage: rememberedUsage } : thread;
    setOpenThreads((current) => {
      const rememberedThread = reconcileThreadUpdate(incomingThread, current[thread.id]);
      const next = { ...current, [thread.id]: rememberedThread };
      openThreadsRef.current = next;
      return next;
    });
    if (assignPane) {
      setPaneThreadId(targetPaneIndex, thread.id);
    }
    if (targetPaneIndex === activePaneIndexRef.current && openThreadIdsRef.current[targetPaneIndex] === thread.id) {
      setSelectedThreadId(thread.id);
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
    setSelectedThreadId((current) => (current && closing.has(current) ? null : current));
  }

  async function selectThread(threadId: string, paneIndex = activePaneIndexRef.current, updateRoute = true) {
    const targetPaneIndex = Math.min(threadPaneCount - 1, Math.max(0, paneIndex));
    const loadToken = ++threadLoadSeqRef.current;
    paneThreadLoadTokensRef.current[targetPaneIndex] = loadToken;
    activatePane(targetPaneIndex);
    setLoadingThreadByPane((current) => ({ ...current, [targetPaneIndex]: threadId }));
    setPaneThreadId(targetPaneIndex, threadId);
    if (updateRoute && threadPaneCount === 1) {
      const nextPath = `/thread/${encodeURIComponent(threadId)}`;
      if (pathname !== nextPath) {
        router.push(nextPath);
      }
    }
    setSelectedThreadId(threadId);
    setMobilePane("thread");
    await resumeThread(threadId, targetPaneIndex, loadToken);
    setLoadingThreadByPane((current) => {
      if (current[targetPaneIndex] !== threadId || !isThreadLoadCurrent(targetPaneIndex, loadToken)) {
        return current;
      }
      const next = { ...current };
      delete next[targetPaneIndex];
      return next;
    });
  }

  async function readThread(threadId: string, paneIndex = openThreadIdsRef.current.indexOf(threadId), loadToken?: number, ensureContextUsage = true): Promise<Thread | null> {
    try {
      const result = await rpc<{ thread: Thread }>("thread/read", { threadId, includeTurns: true });
      const targetPaneIndex = paneIndex >= 0 ? paneIndex : openThreadIdsRef.current.indexOf(threadId);
      if (!canApplyThreadToPane(threadId, targetPaneIndex, loadToken)) {
        return null;
      }
      rememberOpenThread(result.thread, targetPaneIndex, false);
      rememberSessionPreview(result.thread);
      reconcileActiveTurn(result.thread);
      if (ensureContextUsage) {
        ensureThreadContextUsageLoaded(result.thread, targetPaneIndex, loadToken);
      }
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
      reconcileActiveTurn(result.thread);
      setLoadedThreadIds((current) => new Set([...current, result.thread.id]));
      scheduleThreadRefresh(result.thread.id, 700);
      scheduleListRefresh(1000);
      return result.thread;
    } catch (error) {
      return readThread(threadId, paneIndex, loadToken, false);
    }
  }

  function ensureThreadContextUsageLoaded(thread: Thread, paneIndex: number, loadToken?: number) {
    if (hasMeaningfulThreadTokenUsage(threadTokenUsage(thread)) || hasMeaningfulThreadTokenUsage(threadTokenUsageByIdRef.current[thread.id] ?? null)) {
      return;
    }
    if (!canApplyThreadToPane(thread.id, paneIndex, loadToken)) {
      return;
    }
    if (contextReloadAttemptedThreadIdsRef.current.has(thread.id) || contextReloadInFlightThreadIdsRef.current.has(thread.id)) {
      return;
    }
    contextReloadAttemptedThreadIdsRef.current.add(thread.id);
    contextReloadInFlightThreadIdsRef.current.add(thread.id);
    void resumeThread(thread.id, paneIndex, loadToken).finally(() => {
      contextReloadInFlightThreadIdsRef.current.delete(thread.id);
    });
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
    if (event.type === "client-request") {
      const request = parseClientRequest(event.payload);
      if (request) {
        setClientRequests((current) => ({ ...current, [clientRequestKey(request.id)]: request }));
      }
      return;
    }
    if (event.type === "client-request-resolved") {
      const record = asRecord(event.payload);
      const id = typeof record.id === "string" || typeof record.id === "number" ? record.id : null;
      if (id !== null) {
        setClientRequests((current) => {
          const next = { ...current };
          delete next[clientRequestKey(id)];
          return next;
        });
      }
      return;
    }
    if (event.type !== "notification") {
      return;
    }
    const payload = asRecord(event.payload);
    const method = typeof payload.method === "string" ? payload.method : "";
    const params = asRecord(payload.params);
    const threadId = typeof params.threadId === "string" ? params.threadId : threadIdFromThread(params.thread);
    if (threadId) {
      markThreadEventActivity(threadId);
    }

    if (method === "mcpServer/status/updated") {
      void loadMcpServerStatus();
      return;
    }
    if (method === "mcpServer/oauthLogin/completed") {
      const name = typeof params.name === "string" ? params.name : "MCP server";
      const success = params.success === true;
      const error = typeof params.error === "string" ? params.error : "";
      if (success) {
        showToast(`${name} OAuth login completed`);
      } else if (shouldShowOAuthFailureToast(name, error)) {
        showToast(
          `${name} needs MCP login${error ? `: ${friendlyOAuthError(error)}` : ""}`,
          {
            tone: "error",
            actionLabel: "Open status",
            onAction: () => setStatusOpen(true)
          }
        );
      }
      void loadMcpServerStatus();
      return;
    }

    if (method === "turn/started" && threadId) {
      const turn = asRecord(params.turn);
      if (typeof turn.id === "string") {
        setActiveTurns((current) => ({ ...current, [threadId]: turn.id as string }));
      }
      scheduleThreadRefresh(threadId, 800);
    }
    if (method === "turn/completed" && threadId) {
      clearActiveTurn(threadId);
      scheduleThreadRefresh(threadId, 600);
      scheduleListRefresh(1200);
    }
    if (method === "thread/status/changed" && threadId) {
      applyThreadStatus(threadId, params.status as Thread["status"]);
    }
    if (method === "account/rateLimits/updated") {
      const nextRateLimits = parseRateLimitsUpdate(params);
      if (nextRateLimits) {
        setRateLimits(nextRateLimits);
      }
    }
    if (threadId && method === "thread/tokenUsage/updated") {
      const tokenUsage = parseThreadTokenUsage(params.tokenUsage ?? params.token_usage ?? params);
      if (tokenUsage) {
        const mergedUsage = rememberThreadTokenUsage(threadId, tokenUsage) ?? tokenUsage;
        patchOpenThread(threadId, (thread) => ({ ...thread, tokenUsage: mergeThreadTokenUsage(mergedUsage, threadTokenUsage(thread)) ?? mergedUsage }));
      }
    }
    if (method === "serverRequest/resolved") {
      const id = typeof params.id === "string" || typeof params.id === "number"
        ? params.id
        : typeof params.requestId === "string" || typeof params.requestId === "number"
          ? params.requestId
          : null;
      if (id !== null) {
        setClientRequests((current) => {
          const next = { ...current };
          delete next[clientRequestKey(id)];
          return next;
        });
      }
    }
    if (threadId && method === "item/agentMessage/delta") {
      const turnId = typeof params.turnId === "string" ? params.turnId : null;
      const itemId = typeof params.itemId === "string" ? params.itemId : null;
      const delta = typeof params.delta === "string" ? params.delta : "";
      if (turnId && itemId && delta) {
        applyAgentMessageDelta(threadId, turnId, itemId, delta);
      }
    }
    if (threadId && method === "item/started") {
      const item = asRecord(params.item);
      const turnId = typeof params.turnId === "string" ? params.turnId : null;
      if (turnId && typeof item.id === "string" && typeof item.type === "string") {
        applyStartedItem(threadId, turnId, item as unknown as ThreadItem);
      }
    }
    if (threadId && method === "item/completed") {
      const item = asRecord(params.item);
      const turnId = typeof params.turnId === "string" ? params.turnId : null;
      if (turnId && typeof item.id === "string" && typeof item.type === "string") {
        const completedItem = item as unknown as ThreadItem;
        applyCompletedItem(threadId, turnId, completedItem);
        if (isFinalAnswerItem(completedItem)) {
          clearActiveTurn(threadId, turnId);
          applyThreadStatus(threadId, "idle");
          scheduleThreadRefresh(threadId, 350);
          scheduleListRefresh(700);
          return;
        }
      }
    }
    if (threadId && openThreadIdsRef.current.includes(threadId) && method.startsWith("item/")) {
      scheduleThreadRefresh(threadId, 800);
    }
  }

  function patchOpenThread(threadId: string, updater: (thread: Thread) => Thread) {
    setOpenThreads((current) => {
      const thread = current[threadId];
      if (!thread) {
        return current;
      }
      const nextThread = updater(thread);
      const next = { ...current, [threadId]: nextThread };
      openThreadsRef.current = next;
      return next;
    });
  }

  function applyAgentMessageDelta(threadId: string, turnId: string, itemId: string, delta: string) {
    patchOpenThread(threadId, (thread) => patchThreadItem(thread, turnId, itemId, (item) => ({
      ...item,
      id: itemId,
      type: "agentMessage",
      text: `${typeof item.text === "string" ? item.text : ""}${delta}`
    })));
  }

  function applyCompletedItem(threadId: string, turnId: string, item: ThreadItem) {
    patchOpenThread(threadId, (thread) => patchThreadItem(thread, turnId, item.id, () => item));
  }

  function clearActiveTurn(threadId: string, turnId?: string | null) {
    setActiveTurns((current) => {
      if (!(threadId in current)) {
        return current;
      }
      if (turnId && current[threadId] !== turnId) {
        return current;
      }
      const next = { ...current };
      delete next[threadId];
      return next;
    });
  }

  function applyThreadStatus(threadId: string, status: Thread["status"]) {
    setSessions((current) => current.map((thread) => (thread.id === threadId ? { ...thread, status } : thread)));
    setOpenThreads((current) => {
      if (!current[threadId]) {
        return current;
      }
      const next = { ...current, [threadId]: { ...current[threadId], status } };
      openThreadsRef.current = next;
      return next;
    });
  }

  function markThreadEventActivity(threadId: string) {
    lastThreadEventAtRef.current.set(threadId, Date.now());
  }

  function applyStartedItem(threadId: string, turnId: string, item: ThreadItem) {
    patchOpenThread(threadId, (thread) => patchThreadItem(thread, turnId, item.id, (current) => ({
      ...current,
      ...item
    })));
  }

  function reconcileActiveTurn(thread: Thread) {
    const turnId = activeTurnFromThread(thread);
    if (turnId) {
      setActiveTurns((current) => ({ ...current, [thread.id]: turnId }));
      return;
    }
    if (isIdleThreadStatus(statusType(thread)) || threadHasFinalAnswer(thread)) {
      clearActiveTurn(thread.id);
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
    const permissions = threadSettingsFor(threadId);
    return compact({
      threadId,
      cwd: settings.cwd || null,
      model: settings.model || null,
      sandbox: permissions.sandbox || null
    });
  }

  function buildTurnStartParams(threadId: string, text: string, overrides: UiSettings = threadSettingsFor(threadId)): Record<string, JsonValue> {
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

  function threadSettingsFor(threadId: string): UiSettings {
    const override = threadPermissionOverridesRef.current[threadId];
    return override ? { ...settings, ...override } : settings;
  }

  function showToast(error: unknown, options: Partial<ToastState> = {}) {
    const message = messageFromError(error);
    const tone = options.tone ?? (error instanceof Error || looksLikeErrorMessage(message) ? "error" : "info");
    const toastState: ToastState = {
      message,
      tone,
      actionLabel: options.actionLabel,
      onAction: options.onAction
    };
    setToast(toastState);
    window.setTimeout(() => {
      setToast((current) => current === toastState ? null : current);
    }, tone === "error" ? 7000 : 4200);
  }

  function shouldShowOAuthFailureToast(name: string, error: string): boolean {
    const normalizedError = friendlyOAuthError(error);
    const key = `${name}\n${normalizedError}`;
    const now = Date.now();
    const previous = recentOAuthFailureToastRef.current.get(key) ?? 0;
    recentOAuthFailureToastRef.current.set(key, now);
    return now - previous > 20_000;
  }

  function switchMobilePane(direction: 1 | -1) {
    setMobilePane((current) => {
      const index = mobilePanes.indexOf(current);
      const nextIndex = Math.min(mobilePanes.length - 1, Math.max(0, index + direction));
      return mobilePanes[nextIndex] ?? current;
    });
  }

  function updateSidebarWidthDuringResize(width: number) {
    pendingSidebarWidthRef.current = width;
    if (sidebarResizeFrameRef.current !== null) {
      return;
    }
    sidebarResizeFrameRef.current = window.requestAnimationFrame(() => {
      sidebarResizeFrameRef.current = null;
      layoutRef.current?.style.setProperty("--sidebar-width", `${pendingSidebarWidthRef.current}px`);
    });
  }

  function threadSplitRatioFromPointer(clientX: number): number | null {
    const rect = threadGridRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= THREAD_SPLIT_RESIZER_WIDTH) {
      return null;
    }
    const availableWidth = rect.width - THREAD_SPLIT_RESIZER_WIDTH;
    return clampNumber((clientX - rect.left) / availableWidth, 0.25, 0.75, 0.5);
  }

  function updateThreadSplitDuringResize(ratio: number) {
    pendingThreadSplitRatioRef.current = ratio;
    if (threadSplitResizeFrameRef.current !== null) {
      return;
    }
    threadSplitResizeFrameRef.current = window.requestAnimationFrame(() => {
      threadSplitResizeFrameRef.current = null;
      updateThreadGridSplitVars(threadGridRef.current, pendingThreadSplitRatioRef.current);
    });
  }
}

function uniqueStrings(values: (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function isThreadLikelyActive(thread: Thread, activeTurnId: string | undefined): boolean {
  if (activeTurnId || activeTurnFromThread(thread)) {
    return true;
  }
  if (threadHasFinalAnswer(thread)) {
    return false;
  }
  return isActiveTurnStatus(statusType(thread));
}

function threadGridSplitStyle(ratio: number): CSSProperties {
  return {
    "--thread-left-width": threadSplitWidthValue(ratio),
    "--thread-right-width": threadSplitWidthValue(1 - ratio)
  } as CSSProperties;
}

function updateThreadGridSplitVars(element: HTMLElement | null, ratio: number) {
  if (!element) {
    return;
  }
  element.style.setProperty("--thread-left-width", threadSplitWidthValue(ratio));
  element.style.setProperty("--thread-right-width", threadSplitWidthValue(1 - ratio));
}

function threadSplitWidthValue(ratio: number): string {
  return `calc(${(ratio * 100).toFixed(2)}% - ${(THREAD_SPLIT_RESIZER_WIDTH * ratio).toFixed(2)}px)`;
}

function ThreadProjectGroup({
  group,
  onClearLongPress,
  onRowClick,
  onStartLongPress,
  selectedSessionIds,
  selectedThreadId,
  sessionPreviews
}: {
  group: { key: string; label: string; threads: Thread[] };
  onClearLongPress: () => void;
  onRowClick: (event: MouseEvent<HTMLButtonElement>, threadId: string) => void;
  onStartLongPress: (event: PointerEvent<HTMLButtonElement>, threadId: string) => void;
  selectedSessionIds: Set<string>;
  selectedThreadId: string | null;
  sessionPreviews: Record<string, string>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className={`thread-group ${open ? "open" : ""}`}>
      <button
        className="thread-group-heading"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <strong>{group.label}</strong>
        <span>{group.threads.length}</span>
      </button>
      <div className="thread-group-content-shell">
        <div className="thread-group-content">
          {group.threads.map((thread) => (
            <button
              key={thread.id}
              type="button"
              className={`session-row ${thread.id === selectedThreadId ? "selected" : ""} ${selectedSessionIds.has(thread.id) ? "multi-selected" : ""}`}
              aria-pressed={selectedSessionIds.has(thread.id)}
              onClick={(event) => onRowClick(event, thread.id)}
              onContextMenu={(event) => event.preventDefault()}
              onPointerDown={(event) => onStartLongPress(event, thread.id)}
              onPointerUp={onClearLongPress}
              onPointerCancel={onClearLongPress}
              onPointerLeave={onClearLongPress}
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
        </div>
      </div>
    </section>
  );
}

const ThreadPane = memo(function ThreadPane({
  activeTurnId,
  archiveLabel,
  isActive,
  isLoading,
  onActivatePane,
  onArchiveThread,
  onForkThread,
  onInterruptThread,
  onRenameThread,
  onError,
  onOpenFile,
  onOpenSettings,
  onReferenceFile,
  onReferenceSkill,
  onSendMessage,
  paneIndex,
  thread,
  tokenUsage
}: {
  activeTurnId: string | null;
  archiveLabel: string;
  isActive: boolean;
  isLoading: boolean;
  onActivatePane: (paneIndex: number) => void;
  onArchiveThread: (thread: Thread, paneIndex: number) => void;
  onForkThread: (thread: Thread, paneIndex: number) => void;
  onInterruptThread: (thread: Thread) => void;
  onRenameThread: (thread: Thread, name: string) => Promise<void>;
  onError: (error: unknown) => void;
  onOpenFile: (reference: FileReference) => Promise<void>;
  onOpenSettings: () => void;
  onReferenceFile: (onSelect: (entry: FileExplorerEntry, explorer: FileExplorer) => void) => void;
  onReferenceSkill: (onSelect: (skill: SkillReference) => void) => void;
  onSendMessage: (thread: Thread, paneIndex: number, text: string, action?: ComposerAction) => Promise<boolean>;
  paneIndex: number;
  thread: Thread | null;
  tokenUsage: ThreadTokenUsage | null;
}) {
  const [topHidden, setTopHidden] = useState(() => isMobileViewport());
  const [composerCollapsed, setComposerCollapsed] = useState(false);
  const conversationRef = useRef<HTMLDivElement | null>(null);
  const conversationScrollTopRef = useRef(0);
  const composerManuallyCollapsedRef = useRef(false);
  const topHiddenRef = useRef(topHidden);
  const composerCollapsedRef = useRef(composerCollapsed);
  const chromeStateFrameRef = useRef<number | null>(null);
  const pendingChromeStateRef = useRef<{ topHidden?: boolean; composerCollapsed?: boolean }>({});
  const lastThreadViewRef = useRef("");
  const lastItemCountRef = useRef(0);
  const autoScrollRef = useRef(true);
  const scrollFrameRef = useRef<number | null>(null);
  const itemCount = useMemo(() => countDisplayThreadItems(thread?.turns ?? []), [thread?.turns]);
  const contextUsage = useMemo(
    () => (thread ? mergeThreadTokenUsage(threadTokenUsage(thread), tokenUsage) : null),
    [thread, tokenUsage]
  );
  const handleRenderedThreadItemsChange = useCallback(() => {
    if (autoScrollRef.current) {
      scrollToEnd("smooth", 2);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (chromeStateFrameRef.current !== null) {
        window.cancelAnimationFrame(chromeStateFrameRef.current);
      }
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!thread || typeof ResizeObserver === "undefined") {
      return;
    }
    let cancelled = false;
    let observer: ResizeObserver | null = null;
    const frame = window.requestAnimationFrame(() => {
      if (cancelled) {
        return;
      }
      const content = conversationRef.current?.querySelector(".turn-history-content");
      if (!(content instanceof HTMLElement)) {
        return;
      }
      observer = new ResizeObserver(() => {
        if (autoScrollRef.current) {
          scrollToEnd("instant", 1);
        }
      });
      observer.observe(content);
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [thread?.id]);

  useEffect(() => {
    if (!thread) {
      lastThreadViewRef.current = "";
      lastItemCountRef.current = 0;
      autoScrollRef.current = true;
      composerManuallyCollapsedRef.current = false;
      setTopHiddenState(false);
      setComposerCollapsedState(false);
      return;
    }
    if (lastThreadViewRef.current !== thread.id) {
      lastThreadViewRef.current = thread.id;
      lastItemCountRef.current = itemCount;
      autoScrollRef.current = true;
      composerManuallyCollapsedRef.current = false;
      setTopHiddenState(isMobileViewport());
      setComposerCollapsedState(false);
      scrollToEnd("instant");
      return;
    }
    if (itemCount > lastItemCountRef.current && autoScrollRef.current) {
      scrollToEnd("smooth");
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
    const nearBottom = bottomDistance < 48;
    const awayFromBottom = bottomDistance > 120;

    conversationScrollTopRef.current = nextTop;
    if (nearBottom) {
      autoScrollRef.current = true;
    } else if (scrollingTowardHistory && awayFromBottom) {
      autoScrollRef.current = false;
    }

    if (isMobileViewport()) {
      if (scrollingTowardHistory && awayFromBottom) {
        scheduleChromeState({ topHidden: false, composerCollapsed: composerManuallyCollapsedRef.current ? undefined : true });
        return;
      }
      if (nearBottom) {
        scheduleChromeState({ topHidden: true, composerCollapsed: composerManuallyCollapsedRef.current ? undefined : false });
        return;
      }
      if (scrollingTowardBottom) {
        scheduleChromeState({ topHidden: true });
      }
      return;
    }

    if (topHiddenRef.current) {
      scheduleChromeState({ topHidden: false });
    }
  }

  function scrollToEnd(behavior: ScrollBehavior = "smooth", passes = 1) {
    autoScrollRef.current = true;
    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current);
    }
    const applyScroll = (remaining: number) => {
      scrollFrameRef.current = window.requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        const element = conversationRef.current;
        if (!element) {
          return;
        }
        element.scrollTo({ top: element.scrollHeight, behavior });
        conversationScrollTopRef.current = Math.max(0, element.scrollHeight - element.clientHeight);
        if (remaining > 1 && autoScrollRef.current) {
          applyScroll(remaining - 1);
          return;
        }
        if (isMobileViewport()) {
          setTopHiddenState(true);
          if (!composerManuallyCollapsedRef.current) {
            setComposerCollapsedState(false);
          }
        }
      });
    };
    applyScroll(Math.max(1, passes));
  }

  function handleComposerCollapsedChange(collapsed: boolean) {
    composerManuallyCollapsedRef.current = collapsed;
    setComposerCollapsedState(collapsed);
  }

  function scheduleChromeState(nextState: { topHidden?: boolean; composerCollapsed?: boolean }) {
    pendingChromeStateRef.current = {
      ...pendingChromeStateRef.current,
      ...(nextState.topHidden === undefined ? {} : { topHidden: nextState.topHidden }),
      ...(nextState.composerCollapsed === undefined ? {} : { composerCollapsed: nextState.composerCollapsed })
    };
    if (chromeStateFrameRef.current !== null) {
      return;
    }
    chromeStateFrameRef.current = window.requestAnimationFrame(() => {
      chromeStateFrameRef.current = null;
      const pending = pendingChromeStateRef.current;
      pendingChromeStateRef.current = {};
      if (pending.topHidden !== undefined) {
        setTopHiddenState(pending.topHidden);
      }
      if (pending.composerCollapsed !== undefined) {
        setComposerCollapsedState(pending.composerCollapsed);
      }
    });
  }

  function setTopHiddenState(value: boolean) {
    if (topHiddenRef.current === value) {
      return;
    }
    topHiddenRef.current = value;
    setTopHidden(value);
  }

  function setComposerCollapsedState(value: boolean) {
    if (composerCollapsedRef.current === value) {
      return;
    }
    composerCollapsedRef.current = value;
    setComposerCollapsed(value);
  }

  return (
    <section className={`thread-panel ${topHidden ? "top-hidden" : ""} ${isActive ? "active" : ""}`} onPointerDown={() => onActivatePane(paneIndex)}>
      <header className="thread-header">
        {thread ? (
          <div className="thread-title-block">
            <StatusBadge value={statusType(thread)} />
            <EditableThreadTitle thread={thread} onRename={(name) => onRenameThread(thread, name)} />
            {thread.cwd && <p>{thread.cwd}</p>}
          </div>
        ) : isLoading ? (
          <div className="thread-title-block empty">
            <h2><Shimmer as="span" duration={1.4}>Loading thread</Shimmer></h2>
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
            <TurnHistory
              cwd={thread.cwd || null}
              key={thread.id}
              onRenderedItemsChange={handleRenderedThreadItemsChange}
              onOpenFile={onOpenFile}
              threadId={thread.id}
              turns={thread.turns ?? []}
              scrollContainerRef={conversationRef}
            />
          </div>
          <Composer
            activeTurnId={activeTurnId}
            deliveryKey={thread.id}
            deliveryVersion={itemCount}
            onInterrupt={() => onInterruptThread(thread)}
            onSend={(text, action) => onSendMessage(thread, paneIndex, text, action)}
            onFork={() => onForkThread(thread, paneIndex)}
            onArchive={() => onArchiveThread(thread, paneIndex)}
            archiveLabel={archiveLabel}
            collapsed={composerCollapsed}
            contextUsage={contextUsage}
            onError={onError}
            onCollapsedChange={handleComposerCollapsedChange}
            onOpenSettings={onOpenSettings}
            onReferenceFile={onReferenceFile}
            onReferenceSkill={onReferenceSkill}
          />
        </>
      ) : isLoading ? (
        <div className="empty-state thread-loading-placeholder" aria-hidden="true" />
      ) : (
        <div className="empty-state">
          <h2>Select a thread</h2>
          <p>Choose an existing thread or start a new one.</p>
        </div>
      )}
    </section>
  );
});

function ApprovalTray({
  onRespond,
  onUpgradePermissions,
  permissionPolicy,
  requests,
  respondingIds
}: {
  onRespond: (request: ClientRequest, decision: ApprovalDecision) => Promise<void>;
  onUpgradePermissions: (request: ClientRequest) => Promise<void>;
  permissionPolicy?: PermissionPolicy;
  requests: ClientRequest[];
  respondingIds: Set<string>;
}) {
  const sortedRequests = [...requests].sort((a, b) => a.receivedAt - b.receivedAt);
  return (
    <aside className="approval-tray" aria-label="Pending approvals">
      <header>
        <strong>Approval needed</strong>
        <span>{sortedRequests.length} pending</span>
      </header>
      <div className="approval-list">
        {sortedRequests.map((request) => (
          <ApprovalRequestCard
            key={clientRequestKey(request.id)}
            onRespond={onRespond}
            onUpgradePermissions={onUpgradePermissions}
            permissionPolicy={permissionPolicy}
            request={request}
            responding={respondingIds.has(clientRequestKey(request.id))}
          />
        ))}
      </div>
    </aside>
  );
}

function ApprovalRequestCard({
  onRespond,
  onUpgradePermissions,
  permissionPolicy,
  request,
  responding
}: {
  onRespond: (request: ClientRequest, decision: ApprovalDecision) => Promise<void>;
  onUpgradePermissions: (request: ClientRequest) => Promise<void>;
  permissionPolicy?: PermissionPolicy;
  request: ClientRequest;
  responding: boolean;
}) {
  const params = asRecord(request.params);
  const command = typeof params.command === "string" ? params.command : commandFromActions(params.commandActions);
  const cwd = typeof params.cwd === "string" ? params.cwd : "";
  const reason = typeof params.reason === "string" ? params.reason : "";
  const canTrust = Boolean(execpolicyDecision(request));
  const canAcceptForSession = hasAvailableDecision(request, "acceptForSession");
  const canUpgradePermissions = canUseFullControl(permissionPolicy) && Boolean(threadIdFromClientRequest(request));
  return (
    <Confirmation
      approval={{ id: clientRequestKey(request.id) }}
      className="approval-card"
      state="approval-requested"
    >
      <ConfirmationTitle className="approval-card-heading">
        <span>{approvalTitle(request.method)}</span>
        <code>{request.method}</code>
      </ConfirmationTitle>
      <ConfirmationRequest>
        <div className="approval-request">
          {command && <pre className="approval-command">{command}</pre>}
          {reason && <p className="approval-reason">{reason}</p>}
          {cwd && <p className="approval-cwd muted" title={cwd}>{cwd}</p>}
        </div>
      </ConfirmationRequest>
      <ConfirmationActions className="approval-actions">
        <ConfirmationAction className="primary-button" disabled={responding} onClick={() => void onRespond(request, "accept")}>
          Approve
        </ConfirmationAction>
        {canAcceptForSession && (
          <ConfirmationAction className="secondary-button" disabled={responding} onClick={() => void onRespond(request, "acceptForSession")}>
            Approve session
          </ConfirmationAction>
        )}
        {canTrust && (
          <ConfirmationAction className="secondary-button" disabled={responding} onClick={() => void onRespond(request, "acceptWithExecpolicyAmendment")}>
            Trust command
          </ConfirmationAction>
        )}
        {canUpgradePermissions && (
          <ConfirmationAction className="nuclear-button" disabled={responding} onClick={() => void onUpgradePermissions(request)} title="Allow full permissions for this thread">
            <Radiation size={16} /> Full control
          </ConfirmationAction>
        )}
        <ConfirmationAction className="danger-button" disabled={responding} onClick={() => void onRespond(request, "decline")}>
          Deny
        </ConfirmationAction>
      </ConfirmationActions>
    </Confirmation>
  );
}

function StatusModal({
  activeThread,
  mcpLoading,
  mcpServers,
  rateLimits,
  status,
  statusRefreshing,
  onClose,
  onLoginMcpServer,
  onRecover,
  onRefresh,
  onRefreshMcp,
  onSaveMcpServer
}: {
  activeThread: Thread | null;
  mcpLoading: boolean;
  mcpServers: McpServerList | null;
  rateLimits: RateLimitSnapshot | null;
  status: ServerStatus;
  statusRefreshing: boolean;
  onClose: () => void;
  onLoginMcpServer: (name: string) => Promise<string>;
  onRecover: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onRefreshMcp: () => Promise<void>;
  onSaveMcpServer: (input: { name: string; url: string }) => Promise<void>;
}) {
  const socket = typeof status.config?.appServerSocketPath === "string" ? status.config.appServerSocketPath : "stdio / owned";
  const [serverName, setServerName] = useState("agro-ontology");
  const [serverUrl, setServerUrl] = useState("http://127.0.0.1:3000/api/mcp");
  const [oauthLoginServer, setOauthLoginServer] = useState<string | null>(null);
  const [oauthFallback, setOauthFallback] = useState<{ name: string; url: string } | null>(null);
  const [oauthError, setOauthError] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSaveMcpServer(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await onSaveMcpServer({
        name: serverName,
        url: serverUrl
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleMcpOAuthLogin(name: string) {
    const popup = window.open("", `codex-mcp-oauth-${name}`, "popup,width=560,height=760");
    setOauthLoginServer(name);
    setOauthError("");
    try {
      const authorizationUrl = await onLoginMcpServer(name);
      if (popup) {
        popup.location.href = authorizationUrl;
      } else {
        setOauthFallback({ name, url: authorizationUrl });
      }
    } catch (error) {
      popup?.close();
      setOauthError(messageFromError(error));
      throw error;
    } finally {
      setOauthLoginServer(null);
    }
  }

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
          <StatusDetail label="App server" value={<StatusBadge value={status.state} />} />
          <StatusDetail label="Socket" value={socket} />
          <StatusDetail label="Codex cwd" value={status.cwd || "Unavailable"} />
          <StatusDetail label="Active thread" value={activeThread ? `${titleForThread(activeThread)} (${shortId(activeThread.id)})` : "None"} />
          <StatusDetail label="5hr remaining" value={<QuotaMetric value={rateLimitRemainingPercent(rateLimits, "5hr")} />} />
          <StatusDetail label="Weekly remaining" value={<QuotaMetric value={rateLimitRemainingPercent(rateLimits, "weekly")} />} />
        </div>
        {status.error && <p className="error-text">{status.error}</p>}
        <section className="status-section mcp-status-section">
          <header className="section-heading">
            <div>
              <h3>MCP Servers</h3>
              <p className="muted">Config is written to {mcpServers?.configPath || "~/.codex/config.toml"} and reloaded without stopping the app-server.</p>
            </div>
            <button className="secondary-button" type="button" onClick={() => void onRefreshMcp()} disabled={mcpLoading}>
              <RefreshCw size={16} className={mcpLoading ? "spin-icon" : ""} /> Reload
            </button>
          </header>
          <div className="mcp-server-list">
            {mcpServers?.servers.length ? (
              mcpServers.servers.map((server) => (
                <McpServerCard
                  key={server.name}
                  loginPending={oauthLoginServer === server.name}
                  onLogin={() => void handleMcpOAuthLogin(server.name)}
                  server={server}
                />
              ))
            ) : (
              <div className="empty-state inline">
                <h2>{mcpLoading ? "Loading MCP servers" : "No MCP servers"}</h2>
                <p>Add a streamable HTTP MCP server below.</p>
              </div>
            )}
          </div>
          <form className="mcp-server-form" onSubmit={handleSaveMcpServer}>
            <label className="field">
              <span>Name</span>
              <input value={serverName} onChange={(event) => setServerName(event.target.value)} placeholder="agro-ontology" />
            </label>
            <label className="field">
              <span>URL</span>
              <input value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} placeholder="http://127.0.0.1:3000/api/mcp" />
            </label>
            <button className="primary-button" type="submit" disabled={saving || mcpLoading}>
              <Plug size={16} /> Save MCP
            </button>
          </form>
        </section>
        {oauthFallback && (
          <section className="status-section oauth-fallback-panel">
            <div>
              <h3>OAuth login</h3>
              <p className="muted">Popup blocked for {oauthFallback.name}. Open the login page manually.</p>
            </div>
            <a className="primary-button" href={oauthFallback.url} target="_blank" rel="noreferrer" onClick={() => setOauthFallback(null)}>
              <KeyRound size={16} /> Open login
            </a>
          </section>
        )}
        {oauthError && (
          <section className="status-section oauth-error-panel">
            <div>
              <h3>OAuth login needs attention</h3>
              <p>{oauthError}</p>
            </div>
          </section>
        )}
        <p className="muted">Rate limits use the app-server account quota snapshot. Recover checks the sidecar PID and socket, then reconnects this UI.</p>
        <footer className="modal-actions">
          <button className="secondary-button" type="button" onClick={() => void onRecover()}>
            <RefreshCw size={16} /> Recover app-server
          </button>
          <button className="primary-button" type="button" onClick={() => void onRefresh()} disabled={statusRefreshing}>
            <RefreshCw size={16} className={statusRefreshing ? "spin-icon" : ""} /> Refresh
          </button>
        </footer>
      </section>
    </div>
  );
}

function McpServerCard({
  loginPending,
  onLogin,
  server
}: {
  loginPending: boolean;
  onLogin: () => void;
  server: McpServerStatus;
}) {
  const needsLogin = server.authStatus === "notLoggedIn";
  const authLabel = mcpAuthStatusLabel(server.authStatus);
  return (
    <article className="mcp-server-card">
      <div className="mcp-server-card-header">
        <strong><Plug size={15} /> {server.name}</strong>
        <span>{authLabel}</span>
      </div>
      <p>{server.tools.length} tools{server.resources || server.resourceTemplates ? `, ${server.resources + server.resourceTemplates} resources` : ""}</p>
      {needsLogin && (
        <button className="secondary-button" type="button" onClick={onLogin} disabled={loginPending}>
          <KeyRound size={16} className={loginPending ? "spin-icon" : ""} /> {loginPending ? "Opening" : "Log in"}
        </button>
      )}
      {server.tools.length > 0 && (
        <div className="mcp-tool-list">
          {server.tools.map((tool) => <code key={tool}>{tool}</code>)}
        </div>
      )}
    </article>
  );
}

function mcpAuthStatusLabel(status: string): string {
  if (status === "bearerToken") return "token";
  if (status === "notLoggedIn") return "login required";
  if (status === "oAuth") return "oauth";
  if (status === "unsupported") return "unsupported";
  return status || "unknown";
}

function StatusDetail({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="status-detail">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function QuotaMetric({ value }: { value: number | null }) {
  return <span className={`usage-metric ${quotaMetricClass(value)}`}>{formatPercentValue(value)}</span>;
}

const TurnHistory = memo(function TurnHistory({
  cwd,
  onRenderedItemsChange,
  onOpenFile,
  scrollContainerRef,
  threadId,
  turns
}: {
  cwd: string | null;
  onRenderedItemsChange: () => void;
  onOpenFile: (reference: FileReference) => Promise<void>;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  threadId: string;
  turns: Turn[];
}) {
  const [visibleCount, setVisibleCount] = useState(THREAD_ITEM_BATCH_SIZE);
  const [readyItemKeys, setReadyItemKeys] = useState<Set<string>>(() => new Set());
  const readyItemKeysRef = useRef<Set<string>>(new Set());
  const loadEarlierRef = useRef<HTMLDivElement | null>(null);
  const loadingEarlierRef = useRef(false);
  const pendingScrollHeightRef = useRef<number | null>(null);
  const displayTurns = useMemo(() => dedupeTurnsForDisplay(turns), [turns]);
  const totalItemCount = useMemo(() => countDisplayThreadItems(displayTurns), [displayTurns]);
  const visibleTurns = useMemo(() => visibleTurnsByItemCount(displayTurns, visibleCount), [displayTurns, visibleCount]);
  const visibleItemCount = useMemo(() => visibleTurns.reduce((count, turn) => count + turn.items.length, 0), [visibleTurns]);
  const hiddenCount = Math.max(0, totalItemCount - visibleItemCount);

  useEffect(() => {
    setVisibleCount(THREAD_ITEM_BATCH_SIZE);
    const emptyReadyKeys = new Set<string>();
    readyItemKeysRef.current = emptyReadyKeys;
    setReadyItemKeys(emptyReadyKeys);
    loadingEarlierRef.current = false;
    pendingScrollHeightRef.current = null;
  }, [threadId]);

  useEffect(() => {
    const sentinel = loadEarlierRef.current;
    const root = scrollContainerRef.current;
    if (!sentinel || !root || hiddenCount === 0) {
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting || loadingEarlierRef.current) {
          return;
        }
        loadingEarlierRef.current = true;
        pendingScrollHeightRef.current = root.scrollHeight;
        setVisibleCount((current) => Math.min(totalItemCount, current + THREAD_ITEM_BATCH_SIZE));
      },
      { root, rootMargin: "160px 0px 0px 0px", threshold: 0.01 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hiddenCount, scrollContainerRef, totalItemCount, visibleCount]);

  useEffect(() => {
    const pendingKeys = visibleThreadItemKeys(visibleTurns)
      .reverse()
      .filter((key) => !readyItemKeysRef.current.has(key));
    if (pendingKeys.length === 0) {
      return;
    }
    let cancelled = false;
    let cancelScheduledWork: (() => void) | null = null;
    const revealNextItems = () => {
      cancelScheduledWork = null;
      if (cancelled) {
        return;
      }
      const nextKeys = pendingKeys.splice(0, 4);
      if (nextKeys.length > 0) {
        setReadyItemKeys((current) => {
          const next = new Set(current);
          for (const key of nextKeys) {
            next.add(key);
          }
          readyItemKeysRef.current = next;
          return next;
        });
      }
      if (pendingKeys.length > 0) {
        cancelScheduledWork = scheduleThreadRenderWork(revealNextItems);
      }
    };
    cancelScheduledWork = scheduleThreadRenderWork(revealNextItems);
    return () => {
      cancelled = true;
      cancelScheduledWork?.();
    };
  }, [threadId, visibleTurns]);

  useLayoutEffect(() => {
    onRenderedItemsChange();
  }, [onRenderedItemsChange, readyItemKeys]);

  useLayoutEffect(() => {
    const previousHeight = pendingScrollHeightRef.current;
    const element = scrollContainerRef.current;
    if (previousHeight === null || !element) {
      return;
    }
    element.scrollTop += element.scrollHeight - previousHeight;
    pendingScrollHeightRef.current = null;
    loadingEarlierRef.current = false;
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
    <div className="turn-history-content">
      {hiddenCount > 0 && (
        <div className="history-limit" ref={loadEarlierRef} aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          <span>Loading earlier items</span>
          <span className="history-count">{visibleItemCount} of {totalItemCount}</span>
        </div>
      )}
      {visibleTurns.map(({ turn, items }) => (
        <section className="turn-block" key={turn.id}>
          <div className="turn-heading">
            <StatusBadge value={turn.status} />
            <span className="turn-id">{turn.id}</span>
            <span className="turn-date">{formatDate(turn.startedAt)}</span>
          </div>
          {items.map((item) => {
            const renderKey = threadItemRenderKey(turn.id, item);
            return readyItemKeys.has(renderKey)
              ? <ThreadItemView cwd={cwd} item={item} key={renderKey} onOpenFile={onOpenFile} />
              : <ThreadItemPlaceholder item={item} key={renderKey} />;
          })}
        </section>
      ))}
    </div>
  );
});

function visibleThreadItemKeys(visibleTurns: { turn: Turn; items: DisplayThreadItem[] }[]): string[] {
  return visibleTurns.flatMap(({ turn, items }) => items.map((item) => threadItemRenderKey(turn.id, item)));
}

function threadItemRenderKey(turnId: string, item: DisplayThreadItem): string {
  return `${turnId}:${item.id}`;
}

function scheduleThreadRenderWork(callback: () => void): () => void {
  if (typeof window.requestIdleCallback === "function" && typeof window.cancelIdleCallback === "function") {
    const id = window.requestIdleCallback(callback, { timeout: 80 });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(callback, 0);
  return () => window.clearTimeout(id);
}

function ThreadItemPlaceholder({ item }: { item: DisplayThreadItem }) {
  const label = itemLabel(typeForItemLabel(item.type));
  return (
    <article className={`item ${kindClass(item.type)} loading-item`}>
      {label && <div className="item-label">{label}</div>}
      <div className="item-body">
        <Shimmer as="span" duration={1.2}>Loading item</Shimmer>
      </div>
    </article>
  );
}

function countDisplayThreadItems(turns: Turn[]): number {
  return turns.reduce((count, turn) => count + collateThreadItemsForDisplay(dedupeThreadItems(turn.items ?? [])).length, 0);
}

function visibleTurnsByItemCount(turns: Turn[], visibleCount: number): { turn: Turn; items: DisplayThreadItem[] }[] {
  const selected: { turn: Turn; items: DisplayThreadItem[] }[] = [];
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

function dedupeTurnsForDisplay(turns: Turn[]): Turn[] {
  let changed = false;
  const nextTurns = turns.map((turn) => {
    const items = turn.items ?? [];
    const nextItems = collateThreadItemsForDisplay(dedupeThreadItems(items));
    if (nextItems === items) {
      return turn;
    }
    changed = true;
    return { ...turn, items: nextItems as ThreadItem[] };
  });
  return changed ? nextTurns : turns;
}

function collateThreadItemsForDisplay(items: ThreadItem[]): DisplayThreadItem[] {
  const nextItems: DisplayThreadItem[] = [];
  let activeGroup: { kind: "commandGroup" | "reasoningGroup"; items: ThreadItem[] } | null = null;
  const flushGroup = () => {
    if (!activeGroup) {
      return;
    }
    nextItems.push(createDisplayGroup(activeGroup.kind, activeGroup.items));
    activeGroup = null;
  };

  for (const item of items) {
    const groupKind = displayGroupKind(item);
    if (!groupKind) {
      flushGroup();
      nextItems.push(item);
      continue;
    }
    if (!activeGroup || activeGroup.kind !== groupKind) {
      flushGroup();
      activeGroup = { kind: groupKind, items: [] };
    }
    activeGroup.items.push(item);
  }
  flushGroup();
  return nextItems;
}

function displayGroupKind(item: ThreadItem): "commandGroup" | "reasoningGroup" | null {
  if (item.type === "commandGroup" || item.type === "reasoningGroup") {
    return null;
  }
  if (item.type === "commandExecution") {
    return "commandGroup";
  }
  if (item.type === "reasoning") {
    return "reasoningGroup";
  }
  return null;
}

function createDisplayGroup(kind: "commandGroup" | "reasoningGroup", items: ThreadItem[]): DisplayThreadItem {
  if (items.length === 1) {
    return items[0];
  }
  return {
    id: `${kind}:${items[0]?.id ?? "start"}`,
    type: kind,
    items
  };
}

function dedupeThreadItems(items: ThreadItem[]): ThreadItem[] {
  const seenIds = new Set<string>();
  const seenSignatures = new Set<string>();
  let deduped: ThreadItem[] | null = null;
  for (const item of items) {
    const isDuplicateId = seenIds.has(item.id);
    const signature = threadItemContentSignature(item);
    const isDuplicateSignature = Boolean(signature && seenSignatures.has(signature));
    if (isDuplicateId || isDuplicateSignature) {
      deduped ??= items.slice(0, seenIds.size);
      continue;
    }
    seenIds.add(item.id);
    if (signature) {
      seenSignatures.add(signature);
    }
    deduped?.push(item);
  }
  return deduped ?? items;
}

function threadItemContentSignature(item: ThreadItem): string | null {
  if (item.type === "userMessage") {
    const text = userInputText(item.content).trim();
    return text ? `userMessage:${text}` : null;
  }
  if (item.type === "agentMessage") {
    const text = typeof item.text === "string" ? item.text.trim() : "";
    return text ? `agentMessage:${text}` : null;
  }
  return null;
}

function patchThreadItem(
  thread: Thread,
  turnId: string,
  itemId: string,
  updateItem: (item: ThreadItem) => ThreadItem
): Thread {
  const turns = thread.turns ?? [];
  let foundTurn = false;
  const nextTurns = turns.map((turn) => {
    if (turn.id !== turnId) {
      return turn;
    }
    foundTurn = true;
    return patchTurnItem(turn, itemId, updateItem);
  });
  if (!foundTurn) {
    nextTurns.push({
      id: turnId,
      status: "inProgress",
      items: [updateItem({ id: itemId, type: "agentMessage" })]
    });
  }
  return { ...thread, turns: nextTurns };
}

function patchTurnItem(turn: Turn, itemId: string, updateItem: (item: ThreadItem) => ThreadItem): Turn {
  const items = turn.items ?? [];
  let foundItem = false;
  const nextItems = items.map((item) => {
    if (item.id !== itemId) {
      return item;
    }
    foundItem = true;
    return updateItem(item);
  });
  if (!foundItem) {
    nextItems.push(updateItem({ id: itemId, type: "agentMessage" }));
  }
  return { ...turn, items: nextItems };
}

function reconcileThreadUpdate(incoming: Thread, existing: Thread | undefined): Thread {
  if (!existing) {
    return incoming;
  }
  if (!incoming.turns?.length) {
    return existing.turns?.length ? { ...incoming, turns: existing.turns } : incoming;
  }
  if (!existing.turns?.length) {
    return incoming;
  }
  const existingTurns = new Map(existing.turns.map((turn) => [turn.id, turn]));
  const incomingIds = new Set(incoming.turns.map((turn) => turn.id));
  const transientTurns = shouldPreserveTransientTurns(incoming)
    ? existing.turns.filter((turn) => !incomingIds.has(turn.id) && isTransientTurn(turn))
    : [];
  return {
    ...incoming,
    turns: [
      ...incoming.turns.map((turn) => reconcileTurnUpdate(turn, existingTurns.get(turn.id))),
      ...transientTurns
    ]
  };
}

function reconcileTurnUpdate(incoming: Turn, existing: Turn | undefined): Turn {
  if (!existing?.items?.length || !shouldPreserveTransientItems(incoming, existing)) {
    return incoming;
  }
  const incomingItems = dedupeThreadItems(incoming.items ?? []);
  const incomingIds = new Set(incomingItems.map((item) => item.id));
  const incomingSignatures = new Set(incomingItems.map(threadItemContentSignature).filter((value): value is string => Boolean(value)));
  const transientItems = existing.items.filter((item) => {
    if (incomingIds.has(item.id)) {
      return false;
    }
    const signature = threadItemContentSignature(item);
    return !signature || !incomingSignatures.has(signature);
  });
  if (transientItems.length === 0) {
    return incomingItems === incoming.items ? incoming : { ...incoming, items: incomingItems };
  }
  return { ...incoming, items: dedupeThreadItems([...incomingItems, ...transientItems]) };
}

function shouldPreserveTransientItems(incoming: Turn, existing: Turn): boolean {
  if (turnHasFinalAnswer(incoming) || isCompletedTurnStatus(incoming.status)) {
    return false;
  }
  return isTransientTurn(incoming) || isTransientTurn(existing);
}

function shouldPreserveTransientTurns(incoming: Thread): boolean {
  if (threadHasFinalAnswer(incoming) || isIdleThreadStatus(statusType(incoming))) {
    return false;
  }
  return (incoming.turns ?? []).some((turn) => isTransientTurn(turn) || isActiveTurnStatus(turn.status));
}

function isTransientTurn(turn: Turn): boolean {
  const status = String(turn.status ?? "").toLowerCase();
  return status === "inprogress";
}

const ThreadItemView = memo(function ThreadItemView({
  cwd,
  item,
  compact = false,
  onOpenFile
}: {
  cwd: string | null;
  item: DisplayThreadItem;
  compact?: boolean;
  onOpenFile: (reference: FileReference) => Promise<void>;
}) {
  const label = itemLabel(typeForItemLabel(item.type));
  return (
    <article className={`item ${kindClass(item.type)} ${messageToneClass(item)} ${compact ? "compact" : ""}`}>
      {label && <div className="item-label">{label}</div>}
      <div className="item-body">{renderItemBody(item, cwd, onOpenFile)}</div>
    </article>
  );
});

function messageToneClass(item: DisplayThreadItem): string {
  if (item.type !== "agentMessage") {
    return "";
  }
  if (isFinalAnswerItem(item as ThreadItem)) {
    return "final-answer";
  }
  const phase = String(asRecord(item).phase ?? "").toLowerCase().replace(/[_\s-]+/g, "");
  return phase === "commentary" ? "commentary" : "";
}

function typeForItemLabel(type: string): string | null {
  if (type === "agentMessage" || type === "userMessage") {
    return null;
  }
  return type;
}

function itemLabel(type: string | null): string | null {
  return type ? labelForKind(type) : null;
}

function renderItemBody(item: DisplayThreadItem, cwd: string | null, onOpenFile: (reference: FileReference) => Promise<void>) {
  if (item.type === "commandGroup") {
    return <CommandGroupView cwd={cwd} items={item.items ?? []} onOpenFile={onOpenFile} />;
  }
  if (item.type === "reasoningGroup") {
    return <ReasoningGroupView items={item.items ?? []} />;
  }
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
    return (
      <Reasoning className="reasoning-element" defaultOpen={false} isStreaming={String(item.status ?? "").toLowerCase().includes("running")}>
        <ReasoningTrigger />
        <ReasoningContent>{[summary, content].filter(Boolean).join("\n\n") || "Reasoning"}</ReasoningContent>
      </Reasoning>
    );
  }
  if (item.type === "plan") {
    return <MarkdownText cwd={cwd} onOpenFile={onOpenFile} text={typeof item.text === "string" ? item.text : "Plan updated"} />;
  }
  if (item.type === "commandExecution") {
    const command = typeof item.command === "string" ? item.command : commandFromActions(item.commandActions);
    return (
      <CollapsiblePanel
        className="command-output"
        meta={[item.status, exitText(item.exitCode), item.cwd].filter(Boolean).join(" | ")}
        title={`$ ${command || "command"}`}
      >
          {typeof item.aggregatedOutput === "string" && item.aggregatedOutput ? (
            <Terminal
              className="command-terminal"
              isStreaming={String(item.status ?? "").toLowerCase().includes("running")}
              output={truncate(item.aggregatedOutput, 16000)}
            />
          ) : (
            <p className="muted">No command output.</p>
          )}
      </CollapsiblePanel>
    );
  }
  if (item.type === "fileChange") {
    return <FileChangeView cwd={cwd} item={item} onOpenFile={onOpenFile} />;
  }
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
    const toolTitle = [item.server, item.namespace, item.tool].filter(Boolean).join(".") || "Tool call";
    return (
      <Tool className="tool-call-element" defaultOpen={false}>
        <ToolHeader state={toolStateFromStatus(item.status)} title={toolTitle} toolName={toolTitle} type="dynamic-tool" />
        <ToolContent>
          <ToolInput input={pickToolInput(item)} />
          <ToolOutput errorText={toolErrorText(item)} output={pickToolOutput(item)} />
        </ToolContent>
      </Tool>
    );
  }
  if (item.type === "webSearch") {
    return <MarkdownText cwd={cwd} onOpenFile={onOpenFile} text={typeof item.query === "string" ? item.query : "Web search"} />;
  }
  if (item.type === "imageView") {
    return <p>{String(item.path ?? "Image viewed")}</p>;
  }
  return <CodeBlock className="json-block" code={JSON.stringify(item, null, 2)} language="json" />;
}

function CollapsiblePanel({
  children,
  className = "",
  defaultOpen = false,
  meta,
  title
}: {
  children: ReactNode;
  className?: string;
  defaultOpen?: boolean;
  meta?: ReactNode;
  title: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`collapsible-output ${open ? "open" : ""} ${className}`}>
      <button
        className="collapsible-summary"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="summary-title command-line">{title}</span>
        {meta && <span className="summary-meta">{meta}</span>}
      </button>
      <div className="collapsible-content-shell">
        <div className="collapsible-content">{children}</div>
      </div>
    </div>
  );
}

function CommandGroupView({ cwd, items, onOpenFile }: { cwd: string | null; items: ThreadItem[]; onOpenFile: (reference: FileReference) => Promise<void> }) {
  const statuses = compactText(items.map((item) => String(item.status ?? "")));
  return (
    <CollapsiblePanel
      className="command-group-output"
      meta={statuses.join(" | ") || `${items.length} commands`}
      title={`Commands (${items.length})`}
    >
      <div className="collated-item-list">
        {items.map((item) => (
          <ThreadItemView compact cwd={cwd} item={item} key={item.id} onOpenFile={onOpenFile} />
        ))}
      </div>
    </CollapsiblePanel>
  );
}

function ReasoningGroupView({ items }: { items: ThreadItem[] }) {
  const content = items.map(reasoningText).filter(Boolean).join("\n\n---\n\n") || "Reasoning";
  const running = items.some((item) => String(item.status ?? "").toLowerCase().includes("running"));
  return (
    <CollapsiblePanel
      className="reasoning-group-output"
      meta={running ? "running" : `${items.length} entries`}
      title={`Reasoning (${items.length})`}
    >
      <Reasoning className="reasoning-element" defaultOpen isStreaming={running}>
        <ReasoningContent>{content}</ReasoningContent>
      </Reasoning>
    </CollapsiblePanel>
  );
}

function reasoningText(item: ThreadItem): string {
  const summary = Array.isArray(item.summary) ? item.summary.join("\n\n") : "";
  const content = Array.isArray(item.content) ? item.content.join("\n\n") : "";
  return [summary, content].filter(Boolean).join("\n\n");
}

type ToolState = Parameters<typeof ToolHeader>[0]["state"];

function toolStateFromStatus(status: unknown): ToolState {
  const value = String(status ?? "").toLowerCase();
  if (["failed", "error", "systemerror"].includes(value)) {
    return "output-error";
  }
  if (["denied", "cancelled", "canceled"].includes(value)) {
    return "output-denied";
  }
  if (["running", "inprogress", "active", "pending"].includes(value)) {
    return "input-available";
  }
  if (["waitingonapproval", "approval-requested"].includes(value)) {
    return "approval-requested";
  }
  return "output-available";
}

function pickToolInput(item: ThreadItem): unknown {
  const record = asRecord(item);
  return record.input ?? record.arguments ?? record.params ?? record;
}

function pickToolOutput(item: ThreadItem): unknown {
  const record = asRecord(item);
  return record.output ?? record.result ?? record.content ?? null;
}

function toolErrorText(item: ThreadItem): string | undefined {
  const record = asRecord(item);
  return typeof record.error === "string" ? record.error : undefined;
}

function FileChangeView({ cwd, item, onOpenFile }: { cwd: string | null; item: ThreadItem; onOpenFile: (reference: FileReference) => Promise<void> }) {
  const changes = parseFileChanges(item.changes);
  if (changes.length === 0) {
    return (
      <>
        <p>{String(item.status ?? "changed")}</p>
        <CodeBlock className="json-block" code={JSON.stringify(item.changes ?? [], null, 2)} language="json" />
      </>
    );
  }

  return (
    <div className="file-change-view">
      <div className="file-change-summary">
        <span>{String(item.status ?? "changed")}</span>
        <strong>{changes.length} file{changes.length === 1 ? "" : "s"}</strong>
      </div>
      <div className="file-change-list">
        {changes.map((change, index) => (
          <CollapsiblePanel
            className="file-diff-card"
            key={`${change.path}-${index}`}
            meta={(
              <span className="file-diff-meta">
                <span>{change.kind}</span>
                {change.movePath && <span>from {displayDiffPath(change.movePath)}</span>}
              </span>
            )}
            title={(
              <span className="file-diff-path" title={change.path}>
                <FileDiff size={15} />
                <span>{displayDiffPath(change.path)}</span>
              </span>
            )}
          >
            <div className="file-diff-body">
              <button
                className="secondary-button file-diff-open"
                type="button"
                onClick={() => void onOpenFile({ path: change.path, cwd, label: labelForPath(change.path) })}
              >
                Open file
              </button>
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
            </div>
          </CollapsiblePanel>
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
  permissionPolicy,
  includePrompt = false,
  onClose,
  onSubmit
}: {
  title: string;
  settings: UiSettings;
  permissionPolicy?: PermissionPolicy;
  includePrompt?: boolean;
  onClose: () => void;
  onSubmit: (value: { settings: UiSettings; prompt: string }) => void;
}) {
  const [draft, setDraft] = useState(settings);
  const [prompt, setPrompt] = useState("");
  const approvalOptions = permissionPolicy?.allowedApprovalPolicies.length ? permissionPolicy.allowedApprovalPolicies : ["on-request", "untrusted"];
  const sandboxOptions = permissionPolicy?.allowedSandboxes.length ? permissionPolicy.allowedSandboxes : ["read-only", "workspace-write"];
  const permissionLocked = Boolean(permissionPolicy?.locked);
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
            <select value={draft.approvalPolicy} onChange={(event) => setDraft({ ...draft, approvalPolicy: event.target.value })} disabled={permissionLocked}>
              {approvalOptions.map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Sandbox</span>
            <select value={draft.sandbox} onChange={(event) => setDraft({ ...draft, sandbox: event.target.value })} disabled={permissionLocked}>
              {sandboxOptions.map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
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
  return <span className={`status-badge ${statusClass(text)}`}>{statusLabel(text)}</span>;
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
  contextUsage,
  deliveryKey,
  deliveryVersion,
  onArchive,
  onCollapsedChange,
  onError,
  onFork,
  onInterrupt,
  onOpenSettings,
  onReferenceFile,
  onReferenceSkill,
  onSend
}: {
  activeTurnId: string | null;
  archiveLabel: string;
  collapsed: boolean;
  contextUsage: ThreadTokenUsage | null;
  deliveryKey: string;
  deliveryVersion: number;
  onArchive: () => void;
  onCollapsedChange: (collapsed: boolean) => void;
  onError: (error: unknown) => void;
  onFork: () => void;
  onInterrupt: () => void;
  onOpenSettings: () => void;
  onReferenceFile: (onSelect: (entry: FileExplorerEntry, explorer: FileExplorer) => void) => void;
  onReferenceSkill: (onSelect: (skill: SkillReference) => void) => void;
  onSend: (text: string, action?: ComposerAction) => Promise<boolean>;
}) {
  const [uploading, setUploading] = useState(false);
  const [recordingState, setRecordingState] = useState<"idle" | "recording" | "transcribing">("idle");
  const [waveformLevels, setWaveformLevels] = useState<number[]>(idleWaveformLevels);
  const [submittingAction, setSubmittingAction] = useState<ComposerAction | null>(null);
  const [submissionNotice, setSubmissionNotice] = useState<{ action: ComposerAction; queued: boolean; deliveryKey: string; deliveryVersion: number } | null>(null);
  const [triggerMenuOpen, setTriggerMenuOpen] = useState<ComposerTriggerMenu | null>(null);
  const [composerMenuOpen, setComposerMenuOpen] = useState(false);
  const [savedDrafts, setSavedDrafts] = useState<SavedComposerDraft[]>(() => readSavedComposerDrafts());
  const [savedDraftsOpen, setSavedDraftsOpen] = useState(false);
  const [draftPasteChoice, setDraftPasteChoice] = useState<SavedComposerDraft | null>(null);
  const [sendChoiceText, setSendChoiceText] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composerMenuRef = useRef<HTMLDivElement | null>(null);
  const triggerMenuRef = useRef<HTMLDivElement | null>(null);
  const composerInputRef = useRef<ComposerInputHandle | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioAnalyserRef = useRef<AnalyserNode | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const audioWaveformFrameRef = useRef<number | null>(null);
  const audioWaveformLastUpdateRef = useRef(0);
  const audioWaveformSmoothRef = useRef<number[]>(idleWaveformLevels);
  const audioWaveformTimeDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const deliveryKeyRef = useRef(deliveryKey);
  const submittingRef = useRef(false);
  const lastSubmissionRef = useRef<{ signature: string; at: number } | null>(null);

  useEffect(() => {
    deliveryKeyRef.current = deliveryKey;
    submittingRef.current = false;
    lastSubmissionRef.current = null;
    setSubmissionNotice(null);
    setSubmittingAction(null);
    setTriggerMenuOpen(null);
    setComposerMenuOpen(false);
    setSendChoiceText(null);
  }, [deliveryKey]);

  useEffect(() => {
    if (!submissionNotice) {
      return;
    }
    if (submissionNotice.deliveryKey !== deliveryKey) {
      setSubmissionNotice(null);
      return;
    }
    if (deliveryVersion > submissionNotice.deliveryVersion) {
      setSubmissionNotice(null);
    }
  }, [deliveryKey, deliveryVersion, submissionNotice]);

  useEffect(() => {
    if (!triggerMenuOpen) {
      return;
    }
    function closeTriggerMenuOnOutsidePointer(event: globalThis.PointerEvent) {
      const target = event.target;
      if (target instanceof Node && triggerMenuRef.current?.contains(target)) {
        return;
      }
      setTriggerMenuOpen(null);
    }
    window.addEventListener("pointerdown", closeTriggerMenuOnOutsidePointer);
    return () => window.removeEventListener("pointerdown", closeTriggerMenuOnOutsidePointer);
  }, [triggerMenuOpen]);

  useEffect(() => {
    if (!composerMenuOpen) {
      return;
    }
    function closeComposerMenuOnOutsidePointer(event: globalThis.PointerEvent) {
      const target = event.target;
      if (target instanceof Node && composerMenuRef.current?.contains(target)) {
        return;
      }
      setComposerMenuOpen(false);
    }
    window.addEventListener("pointerdown", closeComposerMenuOnOutsidePointer);
    return () => window.removeEventListener("pointerdown", closeComposerMenuOnOutsidePointer);
  }, [composerMenuOpen]);

  useEffect(() => () => {
    stopRecordingStream();
  }, []);

  useEffect(() => {
    writeSavedComposerDrafts(savedDrafts);
  }, [savedDrafts]);

  async function submitDraft(action: ComposerAction, text?: string) {
    const draftText = text ?? readDraft();
    const trimmedText = draftText.trim();
    const signature = `${deliveryKey}\u0000${action}\u0000${trimmedText}`;
    const now = Date.now();
    if (!trimmedText || submittingRef.current || (lastSubmissionRef.current?.signature === signature && now - lastSubmissionRef.current.at < 2500)) {
      return;
    }
    const queued = action === "send" && Boolean(activeTurnId);
    const baselineDeliveryVersion = deliveryVersion;
    submittingRef.current = true;
    lastSubmissionRef.current = { signature, at: now };
    setSubmissionNotice(null);
    setSubmittingAction(action);
    try {
      const sent = await onSend(draftText, action);
      if (sent) {
        setDraftValue("");
        if (deliveryKeyRef.current !== deliveryKey) {
          return;
        }
        setSubmissionNotice({ action, queued, deliveryKey, deliveryVersion: baselineDeliveryVersion });
      } else if (lastSubmissionRef.current?.signature === signature) {
        lastSubmissionRef.current = null;
      }
    } finally {
      submittingRef.current = false;
      setSubmittingAction(null);
    }
  }

  async function submitOrChooseActiveAction(text?: string) {
    if (activeTurnId) {
      setSendChoiceText(text ?? readDraft());
      return;
    }
    await submitDraft("send", text);
  }

  async function submitSendChoice(action: ComposerAction) {
    const text = sendChoiceText;
    setSendChoiceText(null);
    await submitDraft(action, text ?? undefined);
  }

  async function handleAttachmentFile(file: File | undefined) {
    if (!file) {
      return;
    }
    setUploading(true);
    try {
      const attachment = await uploadAttachment(file);
      const reference = markdownFileReference(attachment.name, attachment.path);
      insertDraftText(reference, { block: true });
    } catch (error) {
      onError(error);
    } finally {
      setUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  async function toggleRecording() {
    if (recordingState === "recording") {
      mediaRecorderRef.current?.stop();
      return;
    }
    if (recordingState !== "idle") {
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      onError(new Error("Audio recording is not available in this browser."));
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType });
      recordingChunksRef.current = [];
      recordingStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      startRecordingMeter(stream);
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          recordingChunksRef.current.push(event.data);
        }
      };
      recorder.onerror = () => {
        stopRecordingStream();
        setRecordingState("idle");
        onError(new Error("Audio recording failed."));
      };
      recorder.onstop = () => {
        const chunks = recordingChunksRef.current;
        const type = recorder.mimeType || "audio/webm";
        stopRecordingStream();
        if (chunks.length === 0) {
          setRecordingState("idle");
          return;
        }
        const file = new File(chunks, `composer-recording-${Date.now()}.webm`, { type });
        setRecordingState("transcribing");
        void transcribeAudio(file)
          .then((text) => {
            if (text) {
              insertDraftText(text, { block: true });
            }
          })
          .catch(onError)
          .finally(() => setRecordingState("idle"));
      };
      recorder.start();
      setRecordingState("recording");
    } catch (error) {
      stopRecordingStream();
      setRecordingState("idle");
      onError(error);
    }
  }

  function stopRecordingStream() {
    stopRecordingMeter();
    mediaRecorderRef.current = null;
    for (const track of recordingStreamRef.current?.getTracks() ?? []) {
      track.stop();
    }
    recordingStreamRef.current = null;
  }

  function startRecordingMeter(stream: MediaStream) {
    stopRecordingMeter();
    const AudioContextConstructor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextConstructor) {
      setWaveformLevels(idleWaveformLevels);
      return;
    }
    try {
      const audioContext = new AudioContextConstructor();
      const analyser = audioContext.createAnalyser();
      const source = audioContext.createMediaStreamSource(stream);
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.72;
      source.connect(analyser);
      audioContextRef.current = audioContext;
      audioAnalyserRef.current = analyser;
      audioSourceRef.current = source;
      audioWaveformTimeDataRef.current = new Uint8Array(analyser.fftSize);
      audioWaveformSmoothRef.current = idleWaveformLevels;
      setWaveformLevels(idleWaveformLevels);
      void audioContext.resume().catch(() => undefined);
      updateRecordingMeter();
    } catch {
      stopRecordingMeter();
      setWaveformLevels(idleWaveformLevels);
    }
  }

  function stopRecordingMeter() {
    if (audioWaveformFrameRef.current !== null) {
      window.cancelAnimationFrame(audioWaveformFrameRef.current);
      audioWaveformFrameRef.current = null;
    }
    audioSourceRef.current?.disconnect();
    audioSourceRef.current = null;
    audioAnalyserRef.current?.disconnect();
    audioAnalyserRef.current = null;
    const audioContext = audioContextRef.current;
    audioContextRef.current = null;
    void audioContext?.close().catch(() => undefined);
    audioWaveformTimeDataRef.current = null;
    audioWaveformLastUpdateRef.current = 0;
    audioWaveformSmoothRef.current = idleWaveformLevels;
    setWaveformLevels(idleWaveformLevels);
  }

  function updateRecordingMeter() {
    const analyser = audioAnalyserRef.current;
    const timeData = audioWaveformTimeDataRef.current;
    if (!analyser || !timeData) {
      return;
    }
    analyser.getByteTimeDomainData(timeData);
    const nextLevels = calculateWaveformLevels(timeData, audioWaveformSmoothRef.current.length);
    const smoothed = audioWaveformSmoothRef.current.map((previous, index) => {
      const next = nextLevels[index] ?? 0;
      return previous * 0.58 + next * 0.42;
    });
    audioWaveformSmoothRef.current = smoothed;
    const now = performance.now();
    if (now - audioWaveformLastUpdateRef.current > 70) {
      audioWaveformLastUpdateRef.current = now;
      setWaveformLevels(smoothed);
    }
    audioWaveformFrameRef.current = window.requestAnimationFrame(updateRecordingMeter);
  }

  function openReferenceFile() {
    setComposerMenuOpen(false);
    setTriggerMenuOpen(null);
    onReferenceFile((entry) => {
      insertTriggerSelectionText(markdownFileReference(entry.name, entry.relativePath || entry.path), { block: true });
    });
  }

  function openReferenceSkill() {
    setComposerMenuOpen(false);
    setTriggerMenuOpen(null);
    onReferenceSkill((skill) => insertTriggerSelectionText(`$${skill.name}`));
  }

  function runComposerMenuAction(action: () => void) {
    setComposerMenuOpen(false);
    action();
  }

  function insertComposerMenuText(value: string) {
    runComposerMenuAction(() => insertDraftText(value));
  }

  function insertTriggerSelectionText(value: string, options: { block?: boolean } = {}) {
    removeCurrentTriggerToken(triggerMenuOpen);
    insertDraftText(value, options);
  }

  function removeCurrentTriggerToken(trigger: ComposerTriggerMenu | null) {
    composerInputRef.current?.removeCurrentTriggerToken(trigger);
  }

  function saveDraftForLater() {
    const text = readDraft();
    if (!text.trim()) {
      return;
    }
    const draft: SavedComposerDraft = {
      id: createLocalId(),
      savedAt: Date.now(),
      text
    };
    setSavedDrafts((current) => [draft, ...current].slice(0, 80));
    setDraftValue("");
  }

  function readDraft(): string {
    return composerInputRef.current?.getValue() ?? "";
  }

  function setDraftValue(value: string) {
    composerInputRef.current?.setValue(value);
  }

  function insertDraftText(value: string, options: { block?: boolean } = {}) {
    composerInputRef.current?.insertText(value, options);
  }

  function useSavedDraft(draft: SavedComposerDraft) {
    if (readDraft().trim()) {
      setSavedDraftsOpen(false);
      setDraftPasteChoice(draft);
      return;
    }
    pasteSavedDraft(draft, "overwrite");
  }

  function pasteSavedDraft(draft: SavedComposerDraft, mode: "insert" | "overwrite") {
    setDraftPasteChoice(null);
    setSavedDraftsOpen(false);
    if (mode === "insert") {
      insertDraftText(draft.text, { block: true });
      return;
    }
    setDraftValue(draft.text);
    composerInputRef.current?.focus();
  }

  function deleteSavedDraft(draftId: string) {
    setSavedDrafts((current) => current.filter((draft) => draft.id !== draftId));
  }

  return (
    <>
    <PromptInput
      className={`composer ${collapsed ? "collapsed" : ""}`}
      maxFiles={1}
      onError={(error) => onError(new Error(error.message))}
      onSubmit={async () => {
        if (collapsed) {
          return;
        }
        await submitOrChooseActiveAction(readDraft());
      }}
    >
      <div className="composer-top">
        <div className="composer-top-left">
          <PromptInputButton
            className="icon-button"
            type="button"
            onClick={() => onCollapsedChange(!collapsed)}
            tooltip={collapsed ? "Expand composer" : "Collapse composer"}
            aria-label={collapsed ? "Expand composer" : "Collapse composer"}
          >
            {collapsed ? <ChevronsUp size={17} /> : <ChevronsDown size={17} />}
          </PromptInputButton>
        </div>
        <div className="composer-top-meta">
          {activeTurnId ? <Shimmer as="span" className="composer-active-status" duration={1.1}>Active</Shimmer> : <span>Ready</span>}
          <ContextUsageBadge usage={contextUsage} />
        </div>
      </div>
      <PromptInputBody className="composer-body">
        <div className="composer-rich-text" onFocus={() => setTriggerMenuOpen(null)}>
          <ComposerLexicalInput
            className="composer-lexical-input"
            ref={composerInputRef}
            placeholder="Send a new message or steer the active turn"
            onSubmit={() => void submitOrChooseActiveAction(readDraft())}
            onTrigger={(trigger) => setTriggerMenuOpen(trigger)}
          />
        </div>
        <ComposerInputStatus action={submittingAction} notice={submissionNotice} pendingQueued={submittingAction === "send" && Boolean(activeTurnId)} />
        <PromptInputFooter className="composer-bottom">
          <PromptInputTools className="composer-actions">
            <input
              className="file-input"
              ref={fileInputRef}
              type="file"
              onChange={(event) => void handleAttachmentFile(event.currentTarget.files?.[0])}
            />
            <div className="composer-trigger-tools" ref={triggerMenuRef}>
              <PromptInputButton
                className="icon-button"
                type="button"
                disabled={uploading || Boolean(submittingAction)}
                onClick={() => fileInputRef.current?.click()}
                tooltip="Attach file"
                aria-label="Attach file"
              >
                <Paperclip size={17} />
              </PromptInputButton>
              <div className="composer-overflow" ref={composerMenuRef}>
                <PromptInputButton
                  className="icon-button"
                  type="button"
                  aria-expanded={composerMenuOpen}
                  aria-haspopup="menu"
                  disabled={Boolean(submittingAction)}
                  onClick={() => {
                    setTriggerMenuOpen(null);
                    setComposerMenuOpen((value) => !value);
                  }}
                  tooltip="Composer actions"
                  aria-label="Composer actions"
                >
                  <MoreHorizontal size={17} />
                </PromptInputButton>
                {composerMenuOpen && (
                  <div className="composer-overflow-menu" role="menu">
                    <button type="button" role="menuitem" onClick={() => runComposerMenuAction(onOpenSettings)}>
                      <Settings size={16} /> Settings
                    </button>
                    <button type="button" role="menuitem" onClick={() => insertComposerMenuText("/compact")}>
                      <Minimize2 size={16} /> Compact
                    </button>
                    <button type="button" role="menuitem" onClick={() => runComposerMenuAction(onArchive)}>
                      <Archive size={16} /> {archiveLabel}
                    </button>
                    <button type="button" role="menuitem" onClick={() => runComposerMenuAction(() => setSavedDraftsOpen(true))}>
                      <Save size={16} /> Drafts
                    </button>
                    <button type="button" role="menuitem" onClick={() => runComposerMenuAction(onFork)}>
                      <GitFork size={16} /> Fork
                    </button>
                  </div>
                )}
              </div>
              {triggerMenuOpen && (
                <div className="composer-trigger-menu" role="menu">
                  {triggerMenuOpen === "@" && (
                    <button type="button" role="menuitem" disabled={Boolean(submittingAction)} onClick={openReferenceFile}>
                      <AtSign size={16} /> Reference file
                    </button>
                  )}
                  {triggerMenuOpen === "$" && (
                    <button type="button" role="menuitem" disabled={Boolean(submittingAction)} onClick={openReferenceSkill}>
                      <DollarSign size={16} /> Reference skill
                    </button>
                  )}
                </div>
              )}
            </div>
            <div className="composer-primary-actions">
              <PromptInputButton
                className={`icon-button mic-button ${recordingState}`}
                type="button"
                disabled={uploading || Boolean(submittingAction) || recordingState === "transcribing"}
                onClick={() => void toggleRecording()}
                tooltip={recordingState === "recording" ? "Stop recording" : recordingState === "transcribing" ? "Transcribing" : "Start transcription"}
                aria-label={recordingState === "recording" ? "Stop recording" : recordingState === "transcribing" ? "Transcribing" : "Start transcription"}
              >
                {recordingState === "idle" ? (
                  <Mic size={17} />
                ) : (
                  <AudioLevelMeter levels={recordingState === "recording" ? waveformLevels : transcribingWaveformLevels} />
                )}
              </PromptInputButton>
              <PromptInputButton
                className="icon-button interrupt-button"
                type="button"
                disabled={!activeTurnId}
                onClick={onInterrupt}
                tooltip="Interrupt active turn"
                aria-label="Interrupt active turn"
              >
                <PauseCircle size={17} />
              </PromptInputButton>
              <PromptInputButton
                className="icon-button save-draft-button"
                type="button"
                onClick={saveDraftForLater}
                tooltip="Save draft for later"
                aria-label="Save draft for later"
              >
                <Save size={17} />
              </PromptInputButton>
              <button className={activeTurnId ? "queue-button" : "primary-button"} disabled={Boolean(submittingAction)} type="button" onClick={() => void submitOrChooseActiveAction(readDraft())}>
                <Send size={16} /> {sendButtonLabel(activeTurnId, submittingAction)}
              </button>
            </div>
          </PromptInputTools>
        </PromptInputFooter>
      </PromptInputBody>
    </PromptInput>
    {sendChoiceText !== null && (
      <SendChoiceModal
        disabled={Boolean(submittingAction)}
        onClose={() => setSendChoiceText(null)}
        onEnqueue={() => void submitSendChoice("send")}
        onSteer={() => void submitSendChoice("steer")}
      />
    )}
    {savedDraftsOpen && (
      <SavedDraftsModal
        drafts={savedDrafts}
        onClose={() => setSavedDraftsOpen(false)}
        onDelete={deleteSavedDraft}
        onUse={useSavedDraft}
      />
    )}
    {draftPasteChoice && (
      <SavedDraftPasteChoiceModal
        draft={draftPasteChoice}
        onClose={() => setDraftPasteChoice(null)}
        onInsert={() => pasteSavedDraft(draftPasteChoice, "insert")}
        onOverwrite={() => pasteSavedDraft(draftPasteChoice, "overwrite")}
      />
    )}
    </>
  );
});

function AudioLevelMeter({ levels }: { levels: number[] }) {
  return (
    <span className="audio-level-meter" aria-hidden="true">
      {levels.map((level, index) => (
        <span
          key={index}
          style={{ "--level": `${Math.max(0.08, Math.min(1, level))}` } as CSSProperties}
        />
      ))}
    </span>
  );
}

function calculateWaveformLevels(data: Uint8Array<ArrayBuffer>, barCount: number): number[] {
  const chunkSize = Math.max(1, Math.floor(data.length / barCount));
  return Array.from({ length: barCount }, (_, index) => {
    const start = index * chunkSize;
    const end = index === barCount - 1 ? data.length : Math.min(data.length, start + chunkSize);
    let sumSquares = 0;
    let peak = 0;
    for (let offset = start; offset < end; offset += 1) {
      const centered = Math.abs((data[offset] ?? 128) - 128) / 128;
      sumSquares += centered * centered;
      peak = Math.max(peak, centered);
    }
    const sampleCount = Math.max(1, end - start);
    const rms = Math.sqrt(sumSquares / sampleCount);
    return Math.min(1, Math.max(0.08, rms * 4.2 + peak * 1.25));
  });
}

function SendChoiceModal({
  disabled,
  onClose,
  onEnqueue,
  onSteer
}: {
  disabled: boolean;
  onClose: () => void;
  onEnqueue: () => void;
  onSteer: () => void;
}) {
  return (
    <div className="modal-backdrop">
      <section className="modal send-choice-modal" role="dialog" aria-modal="true" aria-labelledby="send-choice-title">
        <header className="modal-header">
          <div>
            <h2 id="send-choice-title">Active turn</h2>
            <p className="muted">Choose how to send this input.</p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} title="Close" aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="send-choice-actions">
          <button className="queue-button" type="button" onClick={onEnqueue} disabled={disabled}>
            <Send size={16} /> Enqueue
          </button>
          <button className="primary-button" type="button" onClick={onSteer} disabled={disabled}>
            <Send size={16} /> Steer active turn
          </button>
        </div>
      </section>
    </div>
  );
}

function SavedDraftsModal({
  drafts,
  onClose,
  onDelete,
  onUse
}: {
  drafts: SavedComposerDraft[];
  onClose: () => void;
  onDelete: (draftId: string) => void;
  onUse: (draft: SavedComposerDraft) => void;
}) {
  return (
    <div className="modal-backdrop">
      <section className="modal saved-drafts-modal" role="dialog" aria-modal="true" aria-labelledby="saved-drafts-title">
        <header className="modal-header">
          <div>
            <h2 id="saved-drafts-title">Saved drafts</h2>
            <p className="muted">{drafts.length ? `${drafts.length} saved` : "No saved drafts"}</p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} title="Close" aria-label="Close">
            <X size={16} />
          </button>
        </header>
        {drafts.length > 0 ? (
          <div className="saved-draft-list">
            {drafts.map((draft) => (
              <article className="saved-draft-row" key={draft.id}>
                <button type="button" onClick={() => onUse(draft)}>
                  <strong>{summarizeSavedDraft(draft.text)}</strong>
                  <span>{formatSavedDraftDate(draft.savedAt)}</span>
                </button>
                <button className="icon-button" type="button" onClick={() => onDelete(draft.id)} title="Delete saved draft" aria-label="Delete saved draft">
                  <Trash2 size={16} />
                </button>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-state inline">
            <h2>Nothing saved</h2>
            <p>Use the disk button next to send to save composer text for later.</p>
          </div>
        )}
      </section>
    </div>
  );
}

function SavedDraftPasteChoiceModal({
  draft,
  onClose,
  onInsert,
  onOverwrite
}: {
  draft: SavedComposerDraft;
  onClose: () => void;
  onInsert: () => void;
  onOverwrite: () => void;
}) {
  return (
    <div className="modal-backdrop">
      <section className="modal saved-draft-choice-modal" role="dialog" aria-modal="true" aria-labelledby="saved-draft-choice-title">
        <header className="modal-header">
          <div>
            <h2 id="saved-draft-choice-title">Composer has text</h2>
            <p className="muted">{summarizeSavedDraft(draft.text)}</p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} title="Close" aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="send-choice-actions">
          <button className="secondary-button" type="button" onClick={onInsert}>
            <Plus size={16} /> Insert
          </button>
          <button className="primary-button" type="button" onClick={onOverwrite}>
            <Save size={16} /> Overwrite
          </button>
        </div>
      </section>
    </div>
  );
}

function SkillSelectorModal({
  loading,
  onClose,
  onRefresh,
  onSelect,
  skills
}: {
  loading: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onSelect: (skill: SkillReference) => void;
  skills: SkillReference[];
}) {
  const [filter, setFilter] = useState("");
  const visibleSkills = useMemo(() => {
    const normalized = filter.trim().toLowerCase();
    if (!normalized) {
      return skills;
    }
    return skills.filter((skill) => `${skill.name}\n${skill.description || ""}\n${skill.source}`.toLowerCase().includes(normalized));
  }, [filter, skills]);

  return (
    <div className="modal-backdrop">
      <section className="modal skill-selector-modal" role="dialog" aria-modal="true" aria-labelledby="skill-selector-title">
        <header className="modal-header">
          <div className="file-viewer-title">
            <h2 id="skill-selector-title">Reference skill</h2>
            <p className="muted">{skills.length ? `${skills.length} skills available` : "Loading skills"}</p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} title="Close" aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="file-explorer-toolbar">
          <label className="file-search-field">
            <Search size={15} />
            <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter skills" autoFocus />
          </label>
          <button className="icon-button" type="button" onClick={onRefresh} disabled={loading} title="Refresh skills" aria-label="Refresh skills">
            <RefreshCw size={16} className={loading ? "spin-icon" : ""} />
          </button>
        </div>
        <div className={`skill-selector-list ${loading ? "loading" : ""}`}>
          {loading && !skills.length ? (
            <Shimmer as="span" className="muted empty-pad" duration={1.4}>Loading skills</Shimmer>
          ) : visibleSkills.length === 0 ? (
            <p className="muted empty-pad">No skills found.</p>
          ) : (
            visibleSkills.map((skill) => (
              <button className="skill-selector-row" key={`${skill.source}:${skill.name}:${skill.path}`} type="button" onClick={() => onSelect(skill)}>
                <strong>${skill.name}</strong>
                {skill.description && <span>{skill.description}</span>}
                <small>{skill.source}</small>
              </button>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function ComposerInputStatus({
  action,
  notice,
  pendingQueued
}: {
  action: ComposerAction | null;
  notice: { action: ComposerAction; queued: boolean } | null;
  pendingQueued: boolean;
}) {
  if (action) {
    return (
      <div className="composer-input-status busy">
        <span className="spinner" />
        <span>{action === "steer" ? "Sending steer input" : pendingQueued ? "Enqueuing input" : "Sending input"}</span>
      </div>
    );
  }
  if (!notice) {
    return null;
  }
  return (
    <div className={`composer-input-status ${notice.action === "steer" ? "steer" : "queued"}`}>
      <span className="status-dot" />
      <span>{notice.action === "steer" ? "Steer sent" : notice.queued ? "Input enqueued" : "Input sent"}</span>
    </div>
  );
}

function ContextUsageBadge({ usage }: { usage: ThreadTokenUsage | null }) {
  const current = usage?.last ?? usage?.total ?? null;
  return (
    <Context maxTokens={usage?.modelContextWindow ?? null} usedTokens={current?.totalTokens ?? null} usage={contextUsageForElement(current)}>
      <ContextTrigger className="context-trigger" />
      <ContextContent>
        <ContextContentHeader />
        <ContextContentBody>
          <ContextInputUsage />
          <ContextOutputUsage />
          <ContextReasoningUsage />
          <ContextCacheUsage />
        </ContextContentBody>
        <ContextContentFooter>
          Total used: {formatTokenCount(usage?.total.totalTokens ?? null)}
        </ContextContentFooter>
      </ContextContent>
    </Context>
  );
}

function contextUsageForElement(usage: TokenUsageBreakdown | null) {
  return usage
    ? {
        cachedTokens: usage.cachedInputTokens,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        reasoningTokens: usage.reasoningOutputTokens,
        totalTokens: usage.totalTokens
      }
    : null;
}

function sendButtonLabel(activeTurnId: string | null, submittingAction: ComposerAction | null): string {
  if (submittingAction === "send") {
    return "Sending";
  }
  return "Send";
}

function markdownFileReference(label: string, pathValue: string): string {
  return `[${escapeMarkdownLinkLabel(label || labelForPath(pathValue))}](${encodeURI(pathValue)})`;
}

function escapeMarkdownLinkLabel(value: string): string {
  return value.replace(/([\\[\]])/g, "\\$1");
}

function statusClass(status: string): string {
  if (["running", "idle", "completed"].includes(status)) return "good";
  if (["starting", "active", "inProgress", "waitingOnApproval", "waitingOnUserInput", "turn started"].includes(status)) return "busy";
  if (["failed", "error", "systemError", "exited", "disconnected", "stderr"].includes(status)) return "bad";
  if (["notLoaded", "interrupted", "stdout"].includes(status)) return "info";
  return "neutral";
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    inProgress: "in progress",
    waitingOnApproval: "waiting approval",
    waitingOnUserInput: "waiting input",
    notLoaded: "not loaded",
    systemError: "system error"
  };
  return labels[status] || status;
}

function parseClientRequest(value: unknown): ClientRequest | null {
  const record = asRecord(value);
  const id = typeof record.id === "string" || typeof record.id === "number" ? record.id : null;
  const method = typeof record.method === "string" ? record.method : "";
  if (id === null || !method) {
    return null;
  }
  return {
    id,
    method,
    params: isJsonValue(record.params) ? record.params : {},
    receivedAt: numberValue(record.receivedAt) ?? Date.now()
  };
}

function clientRequestKey(id: string | number): string {
  return String(id);
}

function approvalDecisionPayload(request: ClientRequest, decision: ApprovalDecision): JsonValue {
  if (decision === "acceptWithExecpolicyAmendment") {
    return execpolicyDecision(request) ?? "accept";
  }
  if (decision === "decline" && !hasAvailableDecision(request, "decline") && hasAvailableDecision(request, "cancel")) {
    return "cancel";
  }
  return decision;
}

function fullControlDecision(request: ClientRequest): ApprovalDecision {
  if (execpolicyDecision(request)) {
    return "acceptWithExecpolicyAmendment";
  }
  if (hasAvailableDecision(request, "acceptForSession")) {
    return "acceptForSession";
  }
  return "accept";
}

function threadIdFromClientRequest(request: ClientRequest): string | null {
  const params = asRecord(request.params);
  if (typeof params.threadId === "string") {
    return params.threadId;
  }
  return threadIdFromThread(params.thread);
}

function canUseFullControl(policy: PermissionPolicy | undefined): boolean {
  return Boolean(
    policy?.unsafePermissions
    && !policy.locked
    && policy.allowedApprovalPolicies.includes("never")
    && policy.allowedSandboxes.includes("danger-full-access")
  );
}

function hasAvailableDecision(request: ClientRequest, decision: string): boolean {
  const available = availableDecisions(request);
  return available.some((item) => item === decision);
}

function execpolicyDecision(request: ClientRequest): JsonValue | null {
  const available = availableDecisions(request);
  const explicit = available.find((item) => isRecordWithKey(item, "acceptWithExecpolicyAmendment"));
  if (explicit) {
    return explicit;
  }
  const params = asRecord(request.params);
  const amendment = Array.isArray(params.proposedExecpolicyAmendment) ? params.proposedExecpolicyAmendment : null;
  return amendment ? { acceptWithExecpolicyAmendment: { execpolicy_amendment: amendment.filter(isJsonValue) } } : null;
}

function availableDecisions(request: ClientRequest): JsonValue[] {
  const params = asRecord(request.params);
  return Array.isArray(params.availableDecisions) ? params.availableDecisions.filter(isJsonValue) : [];
}

function isRecordWithKey(value: JsonValue, key: string): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && key in value);
}

function approvalTitle(method: string): string {
  if (method === "item/commandExecution/requestApproval") return "Command execution";
  if (method === "item/fileChange/requestApproval") return "File change";
  if (method === "item/mcpToolCall/requestApproval") return "MCP tool call";
  if (method === "item/permissions/requestApproval") return "Permission request";
  return "App-server request";
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

function cleanFileReferencePath(value: string): string {
  return stripLineSuffix(value.trim().replace(/[.,;:!?]+$/g, ""));
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

function isWithinScrollableAtTop(target: EventTarget | null, stopAt: Element): boolean {
  if (!(target instanceof Element)) {
    return window.scrollY <= 1;
  }
  for (let element: Element | null = target; element && element !== stopAt; element = element.parentElement) {
    if (canScrollVertically(element)) {
      return element.scrollTop <= 1;
    }
  }
  return window.scrollY <= 1;
}

function canScrollVertically(element: Element): boolean {
  const overflowY = window.getComputedStyle(element).overflowY;
  return ["auto", "scroll", "overlay"].includes(overflowY) && element.scrollHeight > element.clientHeight + 1;
}

function isMobileViewport(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 780px)").matches;
}

function readStoredLayout(): StoredLayout {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    return parseStoredLayout(JSON.parse(window.localStorage.getItem(LAYOUT_STORAGE_KEY) || "{}"));
  } catch {
    return {};
  }
}

function readSavedComposerDrafts(): SavedComposerDraft[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const raw = JSON.parse(window.localStorage.getItem(COMPOSER_SAVED_DRAFTS_KEY) || "[]");
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw
      .map(parseSavedComposerDraft)
      .filter((draft): draft is SavedComposerDraft => Boolean(draft))
      .slice(0, 80);
  } catch {
    return [];
  }
}

function writeSavedComposerDrafts(drafts: SavedComposerDraft[]): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(COMPOSER_SAVED_DRAFTS_KEY, JSON.stringify(drafts.slice(0, 80)));
  } catch {
    // Saving drafts is optional; the composer still works without localStorage.
  }
}

function parseSavedComposerDraft(value: unknown): SavedComposerDraft | null {
  const record = asRecord(value);
  const id = typeof record.id === "string" && record.id ? record.id : createLocalId();
  const text = typeof record.text === "string" ? record.text : "";
  const savedAt = numberValue(record.savedAt) ?? Date.now();
  return text.trim() ? { id, savedAt, text } : null;
}

function summarizeSavedDraft(text: string): string {
  const summary = text.replace(/\s+/g, " ").trim();
  if (!summary) {
    return "Empty draft";
  }
  return summary.length > 96 ? `${summary.slice(0, 95)}...` : summary;
}

function formatSavedDraftDate(savedAt: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(savedAt));
}

function createLocalId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function writeStoredLayout(layout: StoredLayout, timerRef?: RefObject<number | null>): void {
  if (typeof window === "undefined") {
    return;
  }
  if (timerRef) {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      writeStoredLayout(layout);
    }, 350);
    return;
  }
  try {
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({
      activePaneIndex: clampNumber(layout.activePaneIndex, 0, (layout.threadPaneCount ?? 1) - 1, 0),
      mobilePane: layout.mobilePane,
      openThreadIds: initialOpenThreadIds(layout),
      recentOnly: layout.recentOnly ?? false,
      showArchived: layout.showArchived ?? false,
      sidebarWidth: clampNumber(layout.sidebarWidth, 240, 520, 330),
      threadPaneCount: layout.threadPaneCount,
      threadSplitRatio: clampNumber(layout.threadSplitRatio, 0.25, 0.75, 0.5)
    }));
  } catch {
    // Local storage is an optimization; the app still works without it.
  }
}

function readStoredThreadPermissions(): Record<string, ThreadPermissionOverride> {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const raw = asRecord(JSON.parse(window.localStorage.getItem(THREAD_PERMISSION_STORAGE_KEY) || "{}"));
    return Object.fromEntries(
      Object.entries(raw)
        .map(([threadId, value]) => [threadId, parseThreadPermissionOverride(value)] as const)
        .filter((entry): entry is readonly [string, ThreadPermissionOverride] => Boolean(entry[1]))
    );
  } catch {
    return {};
  }
}

function writeStoredThreadPermissions(value: Record<string, ThreadPermissionOverride>): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(THREAD_PERMISSION_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Local storage is an optimization; explicit thread settings still work for the current session.
  }
}

function parseThreadPermissionOverride(value: unknown): ThreadPermissionOverride | null {
  const record = asRecord(value);
  const approvalPolicy = typeof record.approvalPolicy === "string" ? record.approvalPolicy : "";
  const sandbox = typeof record.sandbox === "string" ? record.sandbox : "";
  return approvalPolicy && sandbox ? { approvalPolicy, sandbox } : null;
}

function parseStoredLayout(value: unknown): StoredLayout {
  const record = asRecord(value);
  const threadPaneCount = parseThreadPaneCount(record.threadPaneCount);
  const mobilePane = record.mobilePane === "thread" || record.mobilePane === "sessions" ? record.mobilePane : undefined;
  return {
    activePaneIndex: numberValue(record.activePaneIndex) ?? undefined,
    mobilePane,
    openThreadIds: Array.isArray(record.openThreadIds)
      ? record.openThreadIds.map((item) => typeof item === "string" && item ? item : null)
      : undefined,
    recentOnly: typeof record.recentOnly === "boolean" ? record.recentOnly : undefined,
    showArchived: typeof record.showArchived === "boolean" ? record.showArchived : undefined,
    sidebarWidth: numberValue(record.sidebarWidth) ?? undefined,
    threadPaneCount,
    threadSplitRatio: numberValue(record.threadSplitRatio) ?? undefined
  };
}

function initialOpenThreadIds(layout: StoredLayout): (string | null)[] {
  const count = layout.threadPaneCount ?? 1;
  const ids = layout.openThreadIds ?? [];
  return Array.from({ length: count }, (_, index) => ids[index] ?? null);
}

function initialActivePaneIndex(layout: StoredLayout): number {
  return clampNumber(layout.activePaneIndex, 0, (layout.threadPaneCount ?? 1) - 1, 0);
}

function parseThreadPaneCount(value: unknown): ThreadPaneCount | undefined {
  if (value === 1 || value === 2) {
    return value;
  }
  if (value === 4) {
    return 2;
  }
  return undefined;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function activeTurnFromThread(thread: Thread): string | null {
  const active = [...(thread.turns ?? [])].reverse().find((turn) => isActiveTurnStatus(turn.status));
  return active?.id ?? null;
}

function isActiveTurnStatus(status: unknown): boolean {
  const value = String(status ?? "").toLowerCase().replace(/[_\s-]+/g, "");
  return value === "inprogress" || value === "active" || value === "running";
}

function isCompletedTurnStatus(status: unknown): boolean {
  const value = String(status ?? "").toLowerCase().replace(/[_\s-]+/g, "");
  return value === "completed" || value === "complete" || value === "finished" || value === "failed" || value === "interrupted";
}

function isIdleThreadStatus(status: unknown): boolean {
  const value = String(status ?? "").toLowerCase().replace(/[_\s-]+/g, "");
  return value === "idle" || value === "completed" || value === "complete" || value === "finished";
}

function threadHasFinalAnswer(thread: Thread): boolean {
  for (let turnIndex = (thread.turns?.length ?? 0) - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = thread.turns?.[turnIndex];
    for (let itemIndex = (turn?.items?.length ?? 0) - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = turn?.items?.[itemIndex];
      if (item && isFinalAnswerItem(item)) {
        return true;
      }
    }
  }
  return false;
}

function turnHasFinalAnswer(turn: Turn): boolean {
  return (turn.items ?? []).some(isFinalAnswerItem);
}

function isFinalAnswerItem(item: ThreadItem): boolean {
  const record = asRecord(item);
  const type = String(record.type ?? "").toLowerCase();
  const phase = String(record.phase ?? record.kind ?? record.category ?? "").toLowerCase().replace(/[_\s-]+/g, "");
  const role = String(record.role ?? "").toLowerCase();
  return (type === "agentmessage" || role === "assistant") && (phase === "finalanswer" || phase === "final" || phase === "finalresponse");
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

function compactText(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
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
    reasoningGroup: "Reasoning",
    commandGroup: "Commands",
    plan: "Plan"
  };
  return labels[kind] || kind;
}

function kindClass(kind: string): string {
  if (kind === "userMessage") return "user";
  if (kind === "agentMessage" || kind === "reasoning" || kind === "reasoningGroup" || kind === "plan") return "agent";
  if (kind === "commandExecution" || kind === "commandGroup") return "command";
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
  const codex = parseRateLimitSnapshot(byLimitId[ACCOUNT_RATE_LIMIT_ID]);
  return codex ?? parseRateLimitSnapshot(record.rateLimits);
}

function parseRateLimitsUpdate(value: unknown): RateLimitSnapshot | null {
  const record = asRecord(value);
  const fromResponseShape = parseRateLimitsResponse(record);
  if (fromResponseShape?.limitId === ACCOUNT_RATE_LIMIT_ID) {
    return fromResponseShape;
  }
  const direct = parseRateLimitSnapshot(record.rateLimits);
  if (direct?.limitId === ACCOUNT_RATE_LIMIT_ID) {
    return direct;
  }
  const inline = parseRateLimitSnapshot(record);
  if (inline?.limitId === ACCOUNT_RATE_LIMIT_ID) {
    return inline;
  }
  return null;
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

function parseRateLimitWindow(value: unknown): RateLimitSnapshot["primary"] {
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

function threadTokenUsage(thread: Thread | null): ThreadTokenUsage | null {
  if (!thread) {
    return null;
  }
  const record = asRecord(thread);
  const direct = parseThreadTokenUsageFromRecord(record);
  if (direct) {
    return direct;
  }

  const breakdowns: TokenUsageBreakdown[] = [];
  const snapshots: ThreadTokenUsage[] = [];
  for (const turn of thread.turns ?? []) {
    const turnRecord = asRecord(turn);
    const turnSnapshot = parseThreadTokenUsageFromRecord(turnRecord);
    if (turnSnapshot) {
      snapshots.push(turnSnapshot);
    }
    const turnUsage = parseTokenUsageBreakdown(turnRecord.tokenUsage ?? turnRecord.token_usage ?? turnRecord.usage);
    if (turnUsage) {
      breakdowns.push(turnUsage);
    }
    for (const item of turn.items ?? []) {
      const itemRecord = asRecord(item);
      const itemSnapshot = parseThreadTokenUsageFromRecord(itemRecord);
      if (itemSnapshot) {
        snapshots.push(itemSnapshot);
      }
      const itemUsage = parseTokenUsageBreakdown(itemRecord.tokenUsage ?? itemRecord.token_usage ?? itemRecord.usage);
      if (itemUsage) {
        breakdowns.push(itemUsage);
      }
    }
  }
  const snapshot = snapshots.at(-1);
  if (snapshot) {
    return snapshot;
  }
  const total = sumTokenBreakdowns(breakdowns);
  const modelContextWindow = numberFromKeys(record, ["modelContextWindow", "model_context_window", "contextWindow", "context_window", "maxTokens", "max_tokens"]);
  if (!total && modelContextWindow === null) {
    return null;
  }
  return {
    total: total ?? emptyTokenBreakdown(),
    last: breakdowns.at(-1) ?? emptyTokenBreakdown(),
    modelContextWindow
  };
}

function parseThreadTokenUsageFromRecord(record: Record<string, unknown>): ThreadTokenUsage | null {
  return parseThreadTokenUsage(record.tokenUsage)
    ?? parseThreadTokenUsage(record.token_usage)
    ?? parseThreadTokenUsage(record.tokenCount)
    ?? parseThreadTokenUsage(record.token_count)
    ?? parseThreadTokenUsage(record.contextUsage)
    ?? parseThreadTokenUsage(record.context_usage)
    ?? parseThreadTokenUsage(record.usage)
    ?? parseThreadTokenUsage(record.context)
    ?? parseThreadTokenUsage(record.payload)
    ?? parseThreadTokenUsage(record.info)
    ?? parseThreadTokenUsage(record);
}

function parseThreadTokenUsage(value: unknown): ThreadTokenUsage | null {
  const record = asRecord(value);
  const info = asRecord(record.info);
  const tokenInfo = Object.keys(info).length ? info : record;
  const total = parseTokenUsageBreakdown(tokenInfo.total_token_usage ?? tokenInfo.totalTokenUsage ?? tokenInfo.total)
    ?? parseTokenUsageBreakdown(value);
  const last = parseTokenUsageBreakdown(tokenInfo.last_token_usage ?? tokenInfo.lastTokenUsage ?? tokenInfo.last) ?? total;
  const modelContextWindow = numberFromKeys(tokenInfo, ["modelContextWindow", "model_context_window", "contextWindow", "context_window", "maxTokens", "max_tokens"]);
  return total || modelContextWindow !== null
    ? {
        total: total ?? emptyTokenBreakdown(),
        last: last ?? emptyTokenBreakdown(),
        modelContextWindow
      }
    : null;
}

function mergeThreadTokenUsage(next: ThreadTokenUsage | null, previous: ThreadTokenUsage | null): ThreadTokenUsage | null {
  if (!next) {
    return previous;
  }
  if (!previous) {
    return next;
  }
  const nextTokens = Math.max(next.total.totalTokens, next.last.totalTokens);
  const previousTokens = Math.max(previous.total.totalTokens, previous.last.totalTokens);
  if (nextTokens === 0 && previousTokens > 0) {
    return {
      total: previous.total,
      last: previous.last,
      modelContextWindow: next.modelContextWindow ?? previous.modelContextWindow
    };
  }
  if (next.modelContextWindow === null && previous.modelContextWindow !== null) {
    return {
      ...next,
      modelContextWindow: previous.modelContextWindow
    };
  }
  return next;
}

function hasMeaningfulThreadTokenUsage(usage: ThreadTokenUsage | null): boolean {
  if (!usage) {
    return false;
  }
  return Math.max(usage.total.totalTokens, usage.last.totalTokens) > 0;
}

function sameThreadTokenUsage(a: ThreadTokenUsage | null, b: ThreadTokenUsage | null): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b || a.modelContextWindow !== b.modelContextWindow) {
    return false;
  }
  return sameTokenBreakdown(a.total, b.total) && sameTokenBreakdown(a.last, b.last);
}

function sameTokenBreakdown(a: TokenUsageBreakdown, b: TokenUsageBreakdown): boolean {
  return a.totalTokens === b.totalTokens
    && a.inputTokens === b.inputTokens
    && a.cachedInputTokens === b.cachedInputTokens
    && a.outputTokens === b.outputTokens
    && a.reasoningOutputTokens === b.reasoningOutputTokens;
}

function parseTokenUsageBreakdown(value: unknown): TokenUsageBreakdown | null {
  const record = asRecord(value);
  const promptDetails = asRecord(record.prompt_tokens_details ?? record.promptTokensDetails ?? record.inputTokensDetails ?? record.input_tokens_details);
  const completionDetails = asRecord(record.completion_tokens_details ?? record.completionTokensDetails ?? record.outputTokensDetails ?? record.output_tokens_details);
  const inputTokens = numberFromKeys(record, ["inputTokens", "input_tokens", "promptTokens", "prompt_tokens", "input"]);
  const cachedInputTokens = numberFromKeys(record, ["cachedInputTokens", "cached_input_tokens", "cachedTokens", "cached_tokens", "cached"]) ?? numberFromKeys(promptDetails, ["cachedTokens", "cached_tokens"]);
  const outputTokens = numberFromKeys(record, ["outputTokens", "output_tokens", "completionTokens", "completion_tokens", "output"]);
  const reasoningOutputTokens = numberFromKeys(record, ["reasoningOutputTokens", "reasoning_output_tokens", "reasoningTokens", "reasoning_tokens", "reasoning"]) ?? numberFromKeys(completionDetails, ["reasoningTokens", "reasoning_tokens"]);
  const totalTokens = numberFromKeys(record, ["totalTokens", "total_tokens", "total"]) ?? sumNumbers(inputTokens, outputTokens);
  if ([totalTokens, inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens].every((item) => item === null)) {
    return null;
  }
  return {
    totalTokens: totalTokens ?? 0,
    inputTokens: inputTokens ?? 0,
    cachedInputTokens: cachedInputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    reasoningOutputTokens: reasoningOutputTokens ?? 0
  };
}

function sumTokenBreakdowns(items: TokenUsageBreakdown[]): TokenUsageBreakdown | null {
  if (!items.length) {
    return null;
  }
  return items.reduce(
    (sum, item) => ({
      totalTokens: sum.totalTokens + item.totalTokens,
      inputTokens: sum.inputTokens + item.inputTokens,
      cachedInputTokens: sum.cachedInputTokens + item.cachedInputTokens,
      outputTokens: sum.outputTokens + item.outputTokens,
      reasoningOutputTokens: sum.reasoningOutputTokens + item.reasoningOutputTokens
    }),
    emptyTokenBreakdown()
  );
}

function emptyTokenBreakdown(): TokenUsageBreakdown {
  return {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0
  };
}

function numberFromKeys(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = numberValue(record[key]);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

function sumNumbers(...values: (number | null)[]): number | null {
  const usable = values.filter((value): value is number => value !== null);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) : null;
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

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || ["boolean", "number", "string"].includes(typeof value)) {
    return typeof value !== "number" || Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).every(isJsonValue);
  }
  return false;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatTokenCount(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "n/a";
  }
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: value >= 1000 ? 1 : 0, notation: "compact" }).format(value);
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

function looksLikeErrorMessage(message: string): boolean {
  return /\b(error|failed|invalid|unauthorized|forbidden|expired|timed out|requires)\b/i.test(message);
}

function friendlyOAuthError(error: string): string {
  if (/insecure protocol|https|http is only allowed/i.test(error)) {
    return "open the Web UI through HTTPS, then try login again";
  }
  if (/invalid_grant/i.test(error)) {
    return "the OAuth callback was already used or expired; try logging in again";
  }
  if (/timed out/i.test(error)) {
    return "the OAuth callback was not received in time; try logging in again";
  }
  return error;
}
