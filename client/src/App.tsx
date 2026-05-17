import {
  Archive,
  GitFork,
  LogOut,
  MessageSquarePlus,
  PauseCircle,
  Play,
  RefreshCw,
  RotateCcw,
  Send,
  Settings,
  SquareTerminal
} from "lucide-react";
import { FormEvent, memo, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  getAuth,
  getStatus,
  listLoggedSessions,
  login,
  logout,
  openEventStream,
  readSessionLog,
  restartServer,
  rpc
} from "./api";
import type { JsonValue, LogEntry, ServerEvent, ServerStatus, SessionIndexRecord, Thread, ThreadItem, Turn, UiSettings } from "./types";

const rpcMethods = [
  "thread/start",
  "thread/resume",
  "thread/fork",
  "thread/archive",
  "thread/unarchive",
  "thread/name/set",
  "thread/compact/start",
  "thread/rollback",
  "thread/list",
  "thread/loaded/list",
  "thread/read",
  "thread/inject_items",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
  "review/start",
  "model/list",
  "mcpServerStatus/list",
  "mcpServer/resource/read",
  "mcpServer/tool/call",
  "app/list",
  "plugin/list",
  "skills/list",
  "hooks/list",
  "account/read",
  "config/read",
  "fs/readDirectory",
  "fs/readFile",
  "command/exec"
];

const defaultSettings: UiSettings = {
  cwd: "",
  model: "",
  effort: "",
  approvalPolicy: "",
  sandbox: ""
};

type SendMode = "auto" | "new" | "steer";
type MainView = "turns" | "logs" | "raw";
type SideView = "events" | "rpc";

const DEFAULT_RENDERED_TURNS = 40;
const DEFAULT_RENDERED_LOGS = 400;

export default function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [serverStatus, setServerStatus] = useState<ServerStatus>({ state: "stopped" });
  const [sessions, setSessions] = useState<Thread[]>([]);
  const [loggedSessions, setLoggedSessions] = useState<SessionIndexRecord[]>([]);
  const [loadedThreadIds, setLoadedThreadIds] = useState<Set<string>>(new Set());
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [selectedThread, setSelectedThread] = useState<Thread | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [events, setEvents] = useState<ServerEvent[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [sendMode, setSendMode] = useState<SendMode>("auto");
  const [mainView, setMainView] = useState<MainView>("turns");
  const [sideView, setSideView] = useState<SideView>("events");
  const [toast, setToast] = useState("");
  const [settings, setSettings] = useState<UiSettings>(loadSettings);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeTurns, setActiveTurns] = useState<Record<string, string>>({});

  const eventSourceRef = useRef<EventSource | null>(null);
  const eventsRef = useRef<ServerEvent[]>([]);
  const eventFlushTimerRef = useRef<number | null>(null);
  const refreshTimerRef = useRef<number | null>(null);
  const listTimerRef = useRef<number | null>(null);
  const selectedThreadIdRef = useRef<string | null>(null);

  useEffect(() => {
    getAuth()
      .then(setAuthenticated)
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
        rememberUiEvent(event);
        handleServerEvent(event);
      },
      (history) => {
        eventsRef.current = trimEvents(history.filter(isUsefulUiEvent));
        setEvents(eventsRef.current);
      }
    );
    source.onerror = () => setServerStatus((current) => ({ ...current, state: "disconnected", error: "Event stream disconnected" }));
    eventSourceRef.current = source;
    return () => {
      source.close();
      if (eventFlushTimerRef.current) {
        window.clearTimeout(eventFlushTimerRef.current);
        eventFlushTimerRef.current = null;
      }
    };
  }, [authenticated]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (authenticated) {
        loadSessions();
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [showArchived, searchTerm]);

  useEffect(() => {
    selectedThreadIdRef.current = selectedThreadId;
  }, [selectedThreadId]);

  const mergedSessions = useMemo(() => {
    const byId = new Map<string, Thread>();
    for (const logged of loggedSessions) {
      byId.set(logged.id, {
        id: logged.id,
        name: logged.name,
        preview: logged.preview,
        cwd: logged.cwd,
        sessionId: logged.sessionId,
        createdAt: logged.createdAt ?? undefined,
        updatedAt: logged.updatedAt ?? undefined,
        status: statusFromLogged(logged.status)
      });
    }
    for (const thread of sessions) {
      byId.set(thread.id, thread);
    }
    return [...byId.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }, [sessions, loggedSessions]);

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

  const selectedStatus = statusType(selectedThread);
  const activeTurnId = selectedThread ? activeTurnFromThread(selectedThread) || activeTurns[selectedThread.id] : null;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="mark">CX</div>
          <div>
            <strong>Codex Web UI</strong>
            <span>{serverStatus.error || `${serverStatus.command ?? "codex"} in ${serverStatus.cwd ?? ""}`}</span>
          </div>
        </div>
        <div className="top-actions">
          <StatusBadge value={serverStatus.state} />
          <button className="ghost-button" type="button" onClick={handleRestart}>
            <RefreshCw size={16} /> Restart
          </button>
          <button className="ghost-button" type="button" onClick={() => setSettingsOpen(true)}>
            <Settings size={16} /> Settings
          </button>
          <button className="ghost-button" type="button" onClick={handleLogout}>
            <LogOut size={16} /> Logout
          </button>
        </div>
      </header>

      <section className="layout">
        <aside className="sessions-panel">
          <div className="panel-heading">
            <div>
              <h2>Sessions</h2>
              <span>{mergedSessions.length} available</span>
            </div>
            <button className="icon-button" type="button" onClick={() => setNewSessionOpen(true)} title="New session">
              <MessageSquarePlus size={18} />
            </button>
          </div>
          <div className="session-tools">
            <label className="field">
              <span>Search</span>
              <input value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} placeholder="Title, preview, cwd" />
            </label>
            <div className="segmented">
              <button className={!showArchived ? "selected" : ""} type="button" onClick={() => setShowArchived(false)}>
                Active
              </button>
              <button className={showArchived ? "selected" : ""} type="button" onClick={() => setShowArchived(true)}>
                Archived
              </button>
            </div>
            <button className="secondary-button" type="button" onClick={loadSessions}>
              <RefreshCw size={16} /> Refresh
            </button>
          </div>
          <div className="sessions-list">
            {mergedSessions.length === 0 ? (
              <p className="muted empty-pad">No sessions found.</p>
            ) : (
              mergedSessions.map((thread) => (
                <button
                  key={thread.id}
                  type="button"
                  className={`session-row ${thread.id === selectedThreadId ? "selected" : ""}`}
                  onClick={() => selectThread(thread.id)}
                >
                  <strong>{titleForThread(thread)}</strong>
                  <p>{thread.preview || thread.cwd || thread.id}</p>
                  <div className="session-meta-row">
                    <StatusBadge value={statusType(thread)} />
                    <span className="muted">{formatDate(thread.updatedAt)}</span>
                  </div>
                </button>
              ))
            )}
          </div>
        </aside>

        <section className="thread-panel">
          {!selectedThread ? (
            <div className="empty-state">
              <h2>Select a session</h2>
              <p>Choose an existing session or start a new one.</p>
            </div>
          ) : (
            <>
              <header className="thread-header">
                <div className="thread-title-block">
                  <StatusBadge value={selectedStatus} />
                  <h2>{titleForThread(selectedThread)}</h2>
                  <p>{selectedThread.cwd || "cwd unavailable"} | {selectedThread.id}</p>
                </div>
                <div className="thread-actions">
                  <button className="ghost-button" type="button" onClick={resumeSelectedThread}>
                    <Play size={16} /> Load
                  </button>
                  <button className="ghost-button" type="button" onClick={renameSelectedThread}>Rename</button>
                  <button className="ghost-button" type="button" onClick={forkSelectedThread}>
                    <GitFork size={16} /> Fork
                  </button>
                  <button className="ghost-button" type="button" onClick={compactSelectedThread}>Compact</button>
                  <button className="ghost-button" type="button" onClick={rollbackSelectedThread}>
                    <RotateCcw size={16} /> Rollback
                  </button>
                  <button className="ghost-button" type="button" onClick={archiveSelectedThread}>
                    <Archive size={16} /> {showArchived ? "Unarchive" : "Archive"}
                  </button>
                </div>
              </header>

              <div className="view-tabs">
                <button className={mainView === "turns" ? "selected" : ""} onClick={() => setMainView("turns")} type="button">Turns</button>
                <button className={mainView === "logs" ? "selected" : ""} onClick={() => setMainView("logs")} type="button">File Log</button>
                <button className={mainView === "raw" ? "selected" : ""} onClick={() => setMainView("raw")} type="button">Raw</button>
              </div>

              <div className="conversation">
                {mainView === "turns" && <TurnHistory turns={selectedThread.turns ?? []} />}
                {mainView === "logs" && <FileLog entries={logs} />}
                {mainView === "raw" && <pre className="json-block">{JSON.stringify(selectedThread, null, 2)}</pre>}
              </div>

              <Composer
                activeTurnId={activeTurnId}
                mode={sendMode}
                onInterrupt={interruptTurn}
                onModeChange={setSendMode}
                onSend={sendMessageText}
              />
            </>
          )}
        </section>

        <aside className="activity-panel">
          <div className="tabs">
            <button className={sideView === "events" ? "selected" : ""} onClick={() => setSideView("events")} type="button">Events</button>
            <button className={sideView === "rpc" ? "selected" : ""} onClick={() => setSideView("rpc")} type="button">Raw RPC</button>
          </div>
          {sideView === "events" ? (
            <EventsList events={events} />
          ) : (
            <RawRpcPanel />
          )}
        </aside>
      </section>

      {newSessionOpen && (
        <SessionModal
          title="New Session"
          settings={settings}
          onClose={() => setNewSessionOpen(false)}
          onSubmit={createSession}
          includePrompt
        />
      )}
      {settingsOpen && (
        <SessionModal
          title="Defaults"
          settings={settings}
          onClose={() => setSettingsOpen(false)}
          onSubmit={(next) => {
            setSettings(next.settings);
            localStorage.setItem("codex-web-ui-settings", JSON.stringify(next.settings));
            setSettingsOpen(false);
          }}
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
      setAuthenticated(true);
    } catch (error) {
      setLoginError(messageFromError(error));
    }
  }

  async function handleLogout() {
    await logout().catch(() => undefined);
    eventSourceRef.current?.close();
    setAuthenticated(false);
  }

  async function handleRestart() {
    try {
      setServerStatus(await restartServer());
      showToast("App server restarted");
      await loadSessions();
    } catch (error) {
      showToast(error);
    }
  }

  async function loadSessions() {
    try {
      const params: Record<string, JsonValue> = {
        archived: showArchived,
        limit: 100,
        sortKey: "updated_at",
        sortDirection: "desc"
      };
      if (searchTerm.trim()) {
        params.searchTerm = searchTerm.trim();
      }
      const [threadResult, loadedResult, logResult] = await Promise.allSettled([
        rpc<{ data: Thread[] }>("thread/list", params),
        rpc<{ data: string[] }>("thread/loaded/list", { limit: 500 }),
        listLoggedSessions()
      ]);
      if (threadResult.status === "fulfilled") {
        setSessions(threadResult.value.data ?? []);
      }
      if (loadedResult.status === "fulfilled") {
        setLoadedThreadIds(new Set(loadedResult.value.data ?? []));
      }
      if (logResult.status === "fulfilled") {
        setLoggedSessions(logResult.value);
      }
      if (threadResult.status === "rejected") {
        throw threadResult.reason;
      }
    } catch (error) {
      showToast(error);
    }
  }

  async function selectThread(threadId: string) {
    setSelectedThreadId(threadId);
    await readThread(threadId);
  }

  async function readThread(threadId: string) {
    const logPromise = readSessionLog(threadId).then(setLogs).catch(() => setLogs([]));
    try {
      const result = await rpc<{ thread: Thread }>("thread/read", { threadId, includeTurns: true });
      setSelectedThread(result.thread);
      rememberActiveTurn(result.thread);
    } catch (error) {
      const logged = loggedSessions.find((item) => item.id === threadId);
      if (logged) {
        setSelectedThread({
          id: logged.id,
          name: logged.name,
          preview: logged.preview,
          cwd: logged.cwd,
          sessionId: logged.sessionId,
          createdAt: logged.createdAt ?? undefined,
          updatedAt: logged.updatedAt ?? undefined,
          status: statusFromLogged(logged.status)
        });
      } else {
        showToast(error);
      }
    }
    await logPromise;
  }

  async function resumeSelectedThread() {
    if (!selectedThread) {
      return;
    }
    try {
      const result = await rpc<{ thread: Thread }>("thread/resume", buildThreadLoadParams(selectedThread.id));
      setSelectedThread(result.thread);
      rememberActiveTurn(result.thread);
      setLoadedThreadIds((current) => new Set([...current, result.thread.id]));
      await loadSessions();
    } catch (error) {
      showToast(error);
    }
  }

  async function sendMessageText(text: string): Promise<boolean> {
    const trimmedText = text.trim();
    if (!selectedThread || !trimmedText) {
      return false;
    }
    try {
      let thread = selectedThread;
      if (!loadedThreadIds.has(thread.id) || statusType(thread) === "notLoaded") {
        const resumed = await rpc<{ thread: Thread }>("thread/resume", buildThreadLoadParams(thread.id));
        thread = resumed.thread;
        setSelectedThread(thread);
        setLoadedThreadIds((current) => new Set([...current, thread.id]));
      }

      const currentActiveTurn = activeTurnFromThread(thread) || activeTurns[thread.id];
      const shouldSteer = sendMode === "steer" || (sendMode === "auto" && currentActiveTurn);
      if (shouldSteer) {
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

  async function interruptTurn() {
    if (!selectedThread) {
      return;
    }
    const turnId = activeTurnFromThread(selectedThread) || activeTurns[selectedThread.id];
    if (!turnId) {
      return;
    }
    try {
      await rpc("turn/interrupt", { threadId: selectedThread.id, turnId });
      scheduleThreadRefresh(selectedThread.id, 600);
    } catch (error) {
      showToast(error);
    }
  }

  async function renameSelectedThread() {
    if (!selectedThread) {
      return;
    }
    const name = window.prompt("Session name", titleForThread(selectedThread));
    if (name === null) {
      return;
    }
    try {
      await rpc("thread/name/set", { threadId: selectedThread.id, name });
      await readThread(selectedThread.id);
      await loadSessions();
    } catch (error) {
      showToast(error);
    }
  }

  async function forkSelectedThread() {
    if (!selectedThread) {
      return;
    }
    try {
      const result = await rpc<{ thread: Thread }>("thread/fork", { ...buildThreadLoadParams(selectedThread.id), ephemeral: false, threadSource: "user" });
      setSelectedThreadId(result.thread.id);
      setSelectedThread(result.thread);
      setShowArchived(false);
      await readSessionLog(result.thread.id).then(setLogs).catch(() => setLogs([]));
      await loadSessions();
    } catch (error) {
      showToast(error);
    }
  }

  async function compactSelectedThread() {
    if (!selectedThread || !window.confirm("Start context compaction for this session?")) {
      return;
    }
    try {
      await rpc("thread/compact/start", { threadId: selectedThread.id });
      showToast("Compaction started");
    } catch (error) {
      showToast(error);
    }
  }

  async function rollbackSelectedThread() {
    if (!selectedThread) {
      return;
    }
    const raw = window.prompt("Number of turns to drop", "1");
    if (raw === null) {
      return;
    }
    const numTurns = Number(raw);
    if (!Number.isInteger(numTurns) || numTurns < 1) {
      showToast("Enter a positive whole number");
      return;
    }
    try {
      const result = await rpc<{ thread: Thread }>("thread/rollback", { threadId: selectedThread.id, numTurns });
      setSelectedThread(result.thread);
      await readSessionLog(selectedThread.id).then(setLogs).catch(() => setLogs([]));
      scheduleListRefresh(800);
    } catch (error) {
      showToast(error);
    }
  }

  async function archiveSelectedThread() {
    if (!selectedThread) {
      return;
    }
    try {
      if (showArchived) {
        const result = await rpc<{ thread: Thread }>("thread/unarchive", { threadId: selectedThread.id });
        setSelectedThread(result.thread);
        setShowArchived(false);
      } else {
        await rpc("thread/archive", { threadId: selectedThread.id });
        setSelectedThread(null);
        setSelectedThreadId(null);
      }
      await loadSessions();
    } catch (error) {
      showToast(error);
    }
  }

  async function createSession(input: { settings: UiSettings; prompt: string }) {
    try {
      const params = compact({
        cwd: input.settings.cwd || null,
        model: input.settings.model || null,
        approvalPolicy: input.settings.approvalPolicy || null,
        sandbox: input.settings.sandbox || null,
        threadSource: "user"
      });
      const result = await rpc<{ thread: Thread }>("thread/start", params);
      setSelectedThreadId(result.thread.id);
      setSelectedThread(result.thread);
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
      setSelectedThread((current) => (current?.id === threadId ? { ...current, status: status as Thread["status"] } : current));
    }
    if (threadId === selectedThreadIdRef.current && method.startsWith("item/")) {
      scheduleThreadRefresh(threadId, 800);
    }
  }

  function rememberUiEvent(event: ServerEvent) {
    if (!isUsefulUiEvent(event)) {
      return;
    }
    eventsRef.current = trimEvents([...eventsRef.current, event]);
    if (eventFlushTimerRef.current) {
      return;
    }
    eventFlushTimerRef.current = window.setTimeout(() => {
      eventFlushTimerRef.current = null;
      setEvents(eventsRef.current);
    }, 250);
  }

  function rememberActiveTurn(thread: Thread) {
    const turnId = activeTurnFromThread(thread);
    if (turnId) {
      setActiveTurns((current) => ({ ...current, [thread.id]: turnId }));
    }
  }

  function scheduleThreadRefresh(threadId: string, delay: number) {
    if (threadId !== selectedThreadIdRef.current) {
      return;
    }
    if (refreshTimerRef.current) {
      window.clearTimeout(refreshTimerRef.current);
    }
    refreshTimerRef.current = window.setTimeout(() => readThread(threadId), delay);
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
}

const TurnHistory = memo(function TurnHistory({ turns }: { turns: Turn[] }) {
  const [showAll, setShowAll] = useState(false);
  const visibleTurns = useMemo(() => (showAll ? turns : turns.slice(-DEFAULT_RENDERED_TURNS)), [showAll, turns]);
  if (turns.length === 0) {
    return (
      <div className="empty-state inline">
        <h2>No turns loaded</h2>
        <p>Load the session or send a message.</p>
      </div>
    );
  }
  return (
    <>
      {!showAll && turns.length > DEFAULT_RENDERED_TURNS && (
        <div className="history-limit">
          Showing latest {DEFAULT_RENDERED_TURNS} of {turns.length} turns.
          <button type="button" onClick={() => setShowAll(true)}>Show full history</button>
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

const FileLog = memo(function FileLog({ entries }: { entries: LogEntry[] }) {
  const [showAll, setShowAll] = useState(false);
  const visibleEntries = useMemo(() => (showAll ? entries : entries.slice(-DEFAULT_RENDERED_LOGS)), [showAll, entries]);
  if (entries.length === 0) {
    return (
      <div className="empty-state inline">
        <h2>No file log yet</h2>
        <p>The backend creates per-session JSONL logs as events arrive.</p>
      </div>
    );
  }
  return (
    <>
      {!showAll && entries.length > DEFAULT_RENDERED_LOGS && (
        <div className="history-limit">
          Showing latest {DEFAULT_RENDERED_LOGS} of {entries.length} log entries.
          <button type="button" onClick={() => setShowAll(true)}>Show full history</button>
        </div>
      )}
      {visibleEntries.map((entry, index) => (
        <LogEntryView entry={entry} key={`${entry.at}-${entry.method ?? entry.type}-${index}`} />
      ))}
    </>
  );
});

const LogEntryView = memo(function LogEntryView({ entry }: { entry: LogEntry }) {
  const payload = asRecord(entry.payload);
  const params = asRecord(payload.params);
  const result = asRecord(payload.result);
  const method = entry.method ?? "";

  if (entry.type === "stderr" || entry.type === "stdout") {
    return (
      <section className="log-entry">
        <div className="log-heading"><StatusBadge value={entry.type} /><span>{formatIso(entry.at)}</span></div>
        <pre className="code-block">{String(entry.payload ?? "")}</pre>
      </section>
    );
  }

  if (method === "turn/started" || method === "turn/completed") {
    const turn = asRecord(params.turn);
    return (
      <section className="log-entry">
        <div className="log-heading">
          <StatusBadge value={method === "turn/started" ? "turn started" : String(turn.status ?? "turn completed")} />
          <span>{String(turn.id ?? "")}</span>
          <span>{formatIso(entry.at)}</span>
        </div>
      </section>
    );
  }

  if ((method === "item/started" || method === "item/completed") && params.item) {
    return (
      <section className="log-entry">
        <div className="log-heading">
          <StatusBadge value={method === "item/started" ? "item started" : "item completed"} />
          <span>{formatIso(entry.at)}</span>
        </div>
        <ThreadItemView item={params.item as ThreadItem} compact />
      </section>
    );
  }

  if ((method === "turn/start" || method === "turn/steer") && entry.type === "rpc-request") {
    const requestParams = asRecord(payload.params);
    return (
      <section className="log-entry">
        <div className="log-heading"><StatusBadge value={method} /><span>{formatIso(entry.at)}</span></div>
        <MarkdownText text={userInputText(requestParams.input)} />
      </section>
    );
  }

  if (method === "thread/read" && result.thread) {
    const thread = result.thread as Thread;
    return (
      <section className="log-entry">
        <div className="log-heading"><StatusBadge value="thread snapshot" /><span>{titleForThread(thread)}</span><span>{formatIso(entry.at)}</span></div>
      </section>
    );
  }

  return (
    <section className="log-entry">
      <div className="log-heading">
        <StatusBadge value={entry.type} />
        {method && <span>{method}</span>}
        <span>{formatIso(entry.at)}</span>
      </div>
      <details>
        <summary>JSON</summary>
        <pre className="json-block">{JSON.stringify(entry.payload ?? entry, null, 2)}</pre>
      </details>
    </section>
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
          <button className="icon-button" type="button" onClick={onClose}>x</button>
        </header>
        <div className="form-grid">
          <label className="field">
            <span>Working directory</span>
            <input value={draft.cwd} onChange={(event) => setDraft({ ...draft, cwd: event.target.value })} placeholder="/path/to/project" />
          </label>
          <label className="field">
            <span>Model</span>
            <input value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} placeholder="configured default" />
          </label>
          <label className="field">
            <span>Reasoning effort</span>
            <select value={draft.effort} onChange={(event) => setDraft({ ...draft, effort: event.target.value })}>
              <option value="">default</option>
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
              <option value="">default</option>
              <option value="on-request">on-request</option>
              <option value="on-failure">on-failure</option>
              <option value="untrusted">untrusted</option>
              <option value="never">never</option>
            </select>
          </label>
          <label className="field">
            <span>Sandbox</span>
            <select value={draft.sandbox} onChange={(event) => setDraft({ ...draft, sandbox: event.target.value })}>
              <option value="">default</option>
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
          <button className="primary-button" type="submit">Save</button>
        </footer>
      </form>
    </div>
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

function statusFromLogged(value: JsonValue | null): Thread["status"] {
  if (value && typeof value === "object" && !Array.isArray(value) && typeof value.type === "string") {
    return { type: value.type };
  }
  return "notLoaded";
}

const Composer = memo(function Composer({
  activeTurnId,
  mode,
  onInterrupt,
  onModeChange,
  onSend
}: {
  activeTurnId: string | null;
  mode: SendMode;
  onInterrupt: () => void;
  onModeChange: (mode: SendMode) => void;
  onSend: (text: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState("");
  return (
    <form
      className="composer"
      onSubmit={async (event) => {
        event.preventDefault();
        const sent = await onSend(draft);
        if (sent) {
          setDraft("");
        }
      }}
    >
      <div className="composer-top">
        <div className="segmented">
          <button className={mode === "auto" ? "selected" : ""} type="button" onClick={() => onModeChange("auto")}>Auto</button>
          <button className={mode === "new" ? "selected" : ""} type="button" onClick={() => onModeChange("new")}>New turn</button>
          <button className={mode === "steer" ? "selected" : ""} type="button" onClick={() => onModeChange("steer")}>Steer</button>
        </div>
        <button className="danger-button" type="button" onClick={onInterrupt} disabled={!activeTurnId}>
          <PauseCircle size={16} /> Interrupt
        </button>
      </div>
      <textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={5} placeholder="Send a new message or steer the active turn" />
      <div className="composer-bottom">
        <span>{composerHint(mode, activeTurnId)}</span>
        <button className="primary-button" type="submit">
          <Send size={16} /> Send
        </button>
      </div>
    </form>
  );
});

const EventsList = memo(function EventsList({ events }: { events: ServerEvent[] }) {
  const visibleEvents = useMemo(() => events.slice(-140).reverse(), [events]);
  return (
    <div className="events-list">
      {visibleEvents.map((event, index) => (
        <div className="event-row" key={`${event.at}-${index}`}>
          <strong>{eventTitle(event)}</strong>
          <span>{eventMeta(event)}</span>
        </div>
      ))}
    </div>
  );
});

const RawRpcPanel = memo(function RawRpcPanel() {
  const [rawMethod, setRawMethod] = useState("thread/list");
  const [rawParams, setRawParams] = useState("{}");
  const [rawResult, setRawResult] = useState("");
  return (
    <form
      className="raw-rpc-form"
      onSubmit={async (event) => {
        event.preventDefault();
        try {
          const params = JSON.parse(rawParams || "{}") as JsonValue;
          const result = await rpc(rawMethod, params);
          setRawResult(JSON.stringify(result, null, 2));
        } catch (error) {
          setRawResult(messageFromError(error));
        }
      }}
    >
      <label className="field">
        <span>Method</span>
        <select value={rawMethod} onChange={(event) => setRawMethod(event.target.value)}>
          {rpcMethods.map((method) => <option key={method} value={method}>{method}</option>)}
        </select>
      </label>
      <label className="field">
        <span>Params JSON</span>
        <textarea value={rawParams} onChange={(event) => setRawParams(event.target.value)} rows={10} />
      </label>
      <button className="primary-button" type="submit">
        <SquareTerminal size={16} /> Call
      </button>
      {rawResult && <pre className="json-block">{rawResult}</pre>}
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

function activeTurnFromThread(thread: Thread): string | null {
  const active = [...(thread.turns ?? [])].reverse().find((turn) => turn.status === "inProgress");
  return active?.id ?? null;
}

function composerHint(mode: SendMode, activeTurnId: string | null): string {
  if (mode === "steer") {
    return activeTurnId ? `Steering active turn ${shortId(activeTurnId)}` : "Steer requires an active turn.";
  }
  if (mode === "new") {
    return "Starts a new user turn on the selected session.";
  }
  return activeTurnId ? `Auto will steer ${shortId(activeTurnId)}.` : "Auto starts a new turn when the session is idle.";
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

function eventTitle(event: ServerEvent): string {
  const payload = asRecord(event.payload);
  if (event.type === "notification") return String(payload.method ?? "notification");
  if (event.type === "rpc-response") return `${String(payload.method ?? "rpc")} ${payload.ok ? "ok" : "failed"}`;
  return event.type;
}

function eventMeta(event: ServerEvent): string {
  const payload = asRecord(event.payload);
  const params = asRecord(payload.params);
  const line = typeof payload.line === "string" ? payload.line : "";
  const threadId = typeof params.threadId === "string" ? shortId(params.threadId) : "";
  return [formatClock(event.at), threadId, line].filter(Boolean).join(" | ");
}

function isUsefulUiEvent(event: ServerEvent): boolean {
  if (event.type !== "notification") {
    return true;
  }
  const method = String(asRecord(event.payload).method ?? "");
  return ![
    "item/agentMessage/delta",
    "item/commandExecution/outputDelta",
    "item/fileChange/outputDelta",
    "item/reasoning/textDelta",
    "item/reasoning/summaryTextDelta",
    "thread/tokenUsage/updated",
    "turn/diff/updated"
  ].includes(method);
}

function trimEvents(events: ServerEvent[]): ServerEvent[] {
  return events.slice(-500);
}

function formatDate(seconds: number | null | undefined): string {
  if (!seconds) return "";
  const ms = seconds > 10_000_000_000 ? seconds : seconds * 1000;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
}

function formatIso(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

function formatClock(ms: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(ms));
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

function loadSettings(): UiSettings {
  try {
    return { ...defaultSettings, ...JSON.parse(localStorage.getItem("codex-web-ui-settings") || "{}") };
  } catch {
    return { ...defaultSettings };
  }
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
