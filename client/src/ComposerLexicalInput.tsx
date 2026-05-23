"use client";

import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $insertNodes,
  $isElementNode,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  DecoratorNode,
  type EditorConfig,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread
} from "lexical";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { MutableRefObject, ReactNode } from "react";

export type ComposerTrigger = "@" | "$" | "/";

export type ComposerInputHandle = {
  focus: () => void;
  getValue: () => string;
  insertText: (value: string, options?: { block?: boolean }) => void;
  removeCurrentTriggerToken: (trigger: ComposerTrigger | null) => void;
  setValue: (value: string) => void;
};

type ComposerLexicalInputProps = {
  className?: string;
  placeholder: string;
  onSubmit?: () => void;
  onTrigger?: (trigger: ComposerTrigger | null) => void;
};

type SerializedFileReferenceNode = Spread<{
  href: string;
  label: string;
}, SerializedLexicalNode>;

class FileReferenceNode extends DecoratorNode<ReactNode> {
  __href: string;
  __label: string;

  static getType(): string {
    return "file-reference";
  }

  static clone(node: FileReferenceNode): FileReferenceNode {
    return new FileReferenceNode(node.__label, node.__href, node.__key);
  }

  static importJSON(serializedNode: SerializedFileReferenceNode): FileReferenceNode {
    return $createFileReferenceNode(serializedNode.label, serializedNode.href);
  }

  constructor(label: string, href: string, key?: NodeKey) {
    super(key);
    this.__label = label;
    this.__href = href;
  }

  createDOM(): HTMLElement {
    const element = document.createElement("span");
    element.className = "composer-link-chip-shell";
    return element;
  }

  updateDOM(): false {
    return false;
  }

  decorate(): ReactNode {
    return <span className="composer-link-chip" title={this.__href}>{this.__label || labelForPath(this.__href)}</span>;
  }

  exportJSON(): SerializedFileReferenceNode {
    return {
      ...super.exportJSON(),
      href: this.__href,
      label: this.__label,
      type: FileReferenceNode.getType(),
      version: 1
    };
  }

  getTextContent(): string {
    return `[${escapeMarkdownLinkLabel(this.__label || labelForPath(this.__href))}](${encodeURI(this.__href)})`;
  }

  isInline(): true {
    return true;
  }

  isKeyboardSelectable(): true {
    return true;
  }
}

function $createFileReferenceNode(label: string, href: string): FileReferenceNode {
  return new FileReferenceNode(label, href);
}

function $isFileReferenceNode(node: LexicalNode | null | undefined): node is FileReferenceNode {
  return node instanceof FileReferenceNode;
}

export const ComposerLexicalInput = forwardRef<ComposerInputHandle, ComposerLexicalInputProps>(function ComposerLexicalInput({
  className,
  onSubmit,
  onTrigger,
  placeholder
}, ref) {
  const editorRef = useRef<LexicalEditor | null>(null);
  const valueRef = useRef("");

  useImperativeHandle(ref, () => ({
    focus() {
      editorRef.current?.focus();
    },
    getValue() {
      return valueRef.current;
    },
    insertText(value, options = {}) {
      const editor = editorRef.current;
      if (!editor) {
        return;
      }
      editor.update(() => {
        insertMarkdownText(value, options);
        valueRef.current = serializeRootToMarkdown();
      });
      editor.focus();
    },
    removeCurrentTriggerToken(trigger) {
      const editor = editorRef.current;
      if (!editor || !trigger) {
        return;
      }
      editor.update(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed() || selection.anchor.type !== "text") {
          return;
        }
        const node = selection.anchor.getNode();
        if (!$isTextNode(node)) {
          return;
        }
        const offset = selection.anchor.offset;
        if (offset <= 0 || node.getTextContent()[offset - 1] !== trigger) {
          return;
        }
        node.spliceText(offset - 1, 1, "");
        valueRef.current = serializeRootToMarkdown();
      });
    },
    setValue(value) {
      valueRef.current = value;
      const editor = editorRef.current;
      if (!editor) {
        return;
      }
      editor.update(() => {
        replaceRootWithMarkdown(value);
        valueRef.current = serializeRootToMarkdown();
      });
    }
  }), []);

  const initialConfig = {
    namespace: "codex-web-ui-composer",
    nodes: [FileReferenceNode],
    onError(error: Error) {
      throw error;
    },
    theme: {
      paragraph: "composer-lexical-paragraph"
    }
  };

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <ComposerEditorBridge editorRef={editorRef} valueRef={valueRef} />
      <RichTextPlugin
        contentEditable={<ContentEditable className={className} aria-placeholder={placeholder} placeholder={<span className="composer-lexical-placeholder">{placeholder}</span>} />}
        ErrorBoundary={LexicalErrorBoundary}
      />
      <HistoryPlugin />
      <OnChangePlugin
        ignoreHistoryMergeTagChange
        ignoreSelectionChange
        onChange={(editorState) => {
          editorState.read(() => {
            valueRef.current = serializeRootToMarkdown();
            onTrigger?.(currentTriggerFromSelection());
          });
        }}
      />
      <ComposerKeyPlugin onSubmit={onSubmit} />
      <ComposerPastePlugin />
    </LexicalComposer>
  );
});

function ComposerEditorBridge({
  editorRef,
  valueRef
}: {
  editorRef: MutableRefObject<LexicalEditor | null>;
  valueRef: MutableRefObject<string>;
}) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    editorRef.current = editor;
    editor.update(() => {
      if (!$getRoot().getFirstChild()) {
        replaceRootWithMarkdown(valueRef.current);
      }
    });
    return () => {
      if (editorRef.current === editor) {
        editorRef.current = null;
      }
    };
  }, [editor, editorRef, valueRef]);
  return null;
}

function ComposerKeyPlugin({ onSubmit }: { onSubmit?: () => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    const root = editor.getRootElement();
    if (!root) {
      return;
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
        event.preventDefault();
        onSubmit?.();
      }
    }
    root.addEventListener("keydown", handleKeyDown);
    return () => root.removeEventListener("keydown", handleKeyDown);
  }, [editor, onSubmit]);
  return null;
}

function ComposerPastePlugin() {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    const root = editor.getRootElement();
    if (!root) {
      return;
    }
    function handlePaste(event: ClipboardEvent) {
      const text = event.clipboardData?.getData("text/plain");
      if (!text || !markdownLinkPattern().test(text)) {
        return;
      }
      event.preventDefault();
      editor.update(() => insertMarkdownText(text, { block: false }));
    }
    root.addEventListener("paste", handlePaste);
    return () => root.removeEventListener("paste", handlePaste);
  }, [editor]);
  return null;
}

function replaceRootWithMarkdown(value: string) {
  const root = $getRoot();
  root.clear();
  const lines = value.split("\n");
  for (const line of lines.length ? lines : [""]) {
    const paragraph = $createParagraphNode();
    appendMarkdownSegments(paragraph, line);
    root.append(paragraph);
  }
  root.selectEnd();
}

function insertMarkdownText(value: string, options: { block?: boolean }) {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) {
    return;
  }
  const current = serializeRootToMarkdown();
  const shouldPrefixBlock = Boolean(options.block && current.trim() && !current.endsWith("\n"));
  const shouldSuffixBlock = Boolean(options.block);
  const nodes: LexicalNode[] = [];
  if (shouldPrefixBlock) {
    nodes.push($createTextNode("\n"));
  }
  nodes.push(...markdownSegmentsToNodes(value));
  if (shouldSuffixBlock) {
    nodes.push($createTextNode("\n"));
  }
  $insertNodes(nodes);
}

function appendMarkdownSegments(parent: ReturnType<typeof $createParagraphNode>, text: string) {
  for (const node of markdownSegmentsToNodes(text)) {
    parent.append(node);
  }
}

function markdownSegmentsToNodes(value: string): LexicalNode[] {
  const nodes: LexicalNode[] = [];
  const pattern = markdownLinkPattern();
  let index = 0;
  for (const match of value.matchAll(pattern)) {
    if (match.index === undefined) {
      continue;
    }
    if (match.index > index) {
      nodes.push($createTextNode(value.slice(index, match.index)));
    }
    nodes.push($createFileReferenceNode(unescapeMarkdownLinkLabel(match[1] || ""), safeDecodeURIComponent(match[2] || "")));
    index = match.index + match[0].length;
  }
  if (index < value.length) {
    nodes.push($createTextNode(value.slice(index)));
  }
  return nodes.length ? nodes : [$createTextNode("")];
}

function markdownLinkPattern(): RegExp {
  return /\[([^\]\n]{1,160})\]\(([^)\n]{1,700})\)/g;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function serializeRootToMarkdown(): string {
  return $getRoot().getChildren().map((child) => {
    if ($isParagraphNode(child) || $isElementNode(child)) {
      return child.getChildren().map(serializeNodeToMarkdown).join("");
    }
    return serializeNodeToMarkdown(child);
  }).join("\n");
}

function serializeNodeToMarkdown(node: LexicalNode): string {
  if ($isFileReferenceNode(node)) {
    return node.getTextContent();
  }
  if ($isTextNode(node)) {
    return node.getTextContent();
  }
  if ($isElementNode(node)) {
    return node.getChildren().map(serializeNodeToMarkdown).join("");
  }
  return node.getTextContent();
}

function currentTriggerFromSelection(): ComposerTrigger | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed() || selection.anchor.type !== "text") {
    return null;
  }
  const node = selection.anchor.getNode();
  if (!$isTextNode(node)) {
    return null;
  }
  const value = node.getTextContent().slice(0, selection.anchor.offset);
  const match = /(?:^|\s)([@$/])$/.exec(value);
  const trigger = match?.[1];
  return trigger === "@" || trigger === "$" || trigger === "/" ? trigger : null;
}

function escapeMarkdownLinkLabel(value: string): string {
  return value.replace(/([\\[\]])/g, "\\$1");
}

function unescapeMarkdownLinkLabel(value: string): string {
  return value.replace(/\\([\\[\]])/g, "$1");
}

function labelForPath(pathValue: string): string {
  const clean = pathValue.replace(/:\d+(?::\d+)?$/, "");
  return clean.split(/[\\/]/).filter(Boolean).at(-1) || clean;
}
