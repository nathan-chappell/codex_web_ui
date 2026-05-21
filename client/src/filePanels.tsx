"use client";

import { ChevronUp, FileText, Folder, RefreshCw, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { BundledLanguage } from "shiki";
import { CodeBlock } from "@/components/ai-elements/code-block";
import { FileTree, FileTreeActions, FileTreeFile, FileTreeIcon, FileTreeName } from "@/components/ai-elements/file-tree";
import { downloadReferencedFile, fetchReferencedFileBlob } from "./api";
import type { FileExplorer, FileExplorerEntry, FilePreview, FileReference } from "./types";

export function FileExplorerModal({
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
  const entriesByPath = useMemo(() => new Map(visibleEntries.map((entry) => [entry.path, entry])), [visibleEntries]);

  function handleSelect(pathValue: string) {
    const entry = entriesByPath.get(pathValue);
    if (!entry || loading) {
      return;
    }
    if (entry.type === "directory") {
      onBrowse(entry.path);
      return;
    }
    void onOpenFile(entry);
  }

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
            <RefreshCw size={16} className={loading ? "spin-icon" : ""} />
          </button>
          <button
            className="icon-button"
            type="button"
            disabled={!explorer?.parentPath || loading}
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
        <div className={`file-explorer-list ${loading ? "loading" : ""}`}>
          {loading && explorer && <div className="file-list-progress"><span className="spinner" /> Loading</div>}
          {!explorer ? (
            <p className="muted empty-pad"><span className="spinner" /> Loading files</p>
          ) : visibleEntries.length === 0 ? (
            <p className="muted empty-pad">No files found.</p>
          ) : (
            <FileTree className="file-explorer-tree" onSelect={handleSelect}>
              {visibleEntries.map((entry) => (
                <FileTreeFile
                  className="file-explorer-tree-row"
                  key={`${entry.type}:${entry.path}`}
                  path={entry.path}
                  name={entry.name}
                  title={entry.displayPath}
                >
                  <FileTreeIcon className={`file-explorer-icon ${entry.type}`}>
                    {entry.type === "directory" ? <Folder size={18} /> : <FileText size={18} />}
                  </FileTreeIcon>
                  <span className="file-explorer-main">
                    <strong><FileTreeName>{entry.name}</FileTreeName></strong>
                    <span>{entry.relativePath || entry.displayPath}</span>
                  </span>
                  <FileTreeActions className="file-explorer-meta">
                    {entry.tracked && <span className="file-tracked-badge">git</span>}
                    {entry.type === "file" && <span>{formatFileSize(entry.size ?? 0)}</span>}
                    {entry.kind && <span>{entry.kind}</span>}
                  </FileTreeActions>
                </FileTreeFile>
              ))}
            </FileTree>
          )}
        </div>
      </section>
    </div>
  );
}

export function FileViewerLoadingModal({ reference, onClose }: { reference: FileReference; onClose: () => void }) {
  return (
    <div className="modal-backdrop">
      <section className="modal file-loading-modal" role="dialog" aria-modal="true" aria-labelledby="file-loading-title">
        <header className="modal-header">
          <div className="file-viewer-title">
            <h2 id="file-loading-title">Opening file</h2>
            <p className="muted">{reference.label || reference.path}</p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} title="Close">
            <X size={16} />
          </button>
        </header>
        <div className="file-loading-body">
          <span className="spinner large" />
          <span>Loading preview</span>
        </div>
      </section>
    </div>
  );
}

export function FileViewerModal({ file, reference, onClose }: { file: FilePreview; reference: FileReference; onClose: () => void }) {
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
          <button className="ghost-button" type="button" onClick={() => void downloadReferencedFile(reference, file.name)}>
            Download
          </button>
          <button className="primary-button" type="button" onClick={onClose}>Done</button>
        </footer>
      </section>
    </div>
  );
}

function renderFilePreview(file: FilePreview, reference: FileReference) {
  const content = file.content ?? "";
  if (file.kind === "image") {
    return <AuthenticatedMediaPreview className="file-image-preview" file={file} reference={reference} type="image" />;
  }
  if (file.kind === "pdf") {
    return <AuthenticatedMediaPreview className="file-pdf-preview" file={file} reference={reference} type="pdf" />;
  }
  if (file.kind === "video") {
    return <AuthenticatedMediaPreview className="file-video-preview" file={file} reference={reference} type="video" />;
  }
  if (file.kind === "json") {
    return <CodeBlock className="file-preview-code" code={prettyJson(content)} language="json" showLineNumbers />;
  }
  if (file.kind === "markdown") {
    return (
      <div className="markdown file-markdown-preview">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
    );
  }
  if (file.kind === "code") {
    return <CodeBlock className="file-preview-code" code={content} language={languageForFile(file)} showLineNumbers />;
  }
  return <CodeBlock className="file-preview-code" code={content} language="markdown" />;
}

function AuthenticatedMediaPreview({
  className,
  file,
  reference,
  type
}: {
  className: string;
  file: FilePreview;
  reference: FileReference;
  type: "image" | "pdf" | "video";
}) {
  const [objectUrl, setObjectUrl] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    let nextUrl = "";
    setObjectUrl("");
    setError("");
    fetchReferencedFileBlob(reference, true)
      .then((blob) => {
        if (!active) {
          return;
        }
        nextUrl = URL.createObjectURL(blob);
        setObjectUrl(nextUrl);
      })
      .catch((err) => {
        if (active) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      active = false;
      if (nextUrl) {
        URL.revokeObjectURL(nextUrl);
      }
    };
  }, [reference.cwd, reference.path]);

  if (error) {
    return <p className="error-text empty-pad">{error}</p>;
  }
  if (!objectUrl) {
    return <p className="muted empty-pad"><span className="spinner" /> Loading preview</p>;
  }
  if (type === "image") {
    return <img className={className} src={objectUrl} alt={file.name} />;
  }
  if (type === "pdf") {
    return <iframe className={className} src={objectUrl} title={file.name} />;
  }
  return <video className={className} src={objectUrl} controls playsInline preload="metadata" />;
}

function prettyJson(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

function languageForFile(file: FilePreview): BundledLanguage {
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
  return (map[file.extension] || file.extension || "markdown") as BundledLanguage;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
