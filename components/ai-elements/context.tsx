"use client";

import { Button } from "@/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { cn } from "@/lib/utils";
import type { ComponentProps, HTMLAttributes, ReactNode } from "react";
import { createContext, useContext, useMemo } from "react";

type ContextUsage = {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  totalTokens?: number;
};

type ContextValue = {
  maxTokens: number | null;
  usedTokens: number;
  usage: ContextUsage;
  usedPercent: number | null;
};

const ContextState = createContext<ContextValue | null>(null);

export function Context({
  maxTokens,
  usedTokens,
  usage,
  ...props
}: ComponentProps<typeof HoverCard> & {
  maxTokens?: number | null;
  usedTokens?: number | null;
  usage?: ContextUsage | null;
}) {
  const value = useMemo(() => {
    const safeUsage = usage ?? {};
    const total = usedTokens ?? safeUsage.totalTokens ?? tokenTotal(safeUsage);
    const max = maxTokens && maxTokens > 0 ? maxTokens : null;
    return {
      maxTokens: max,
      usedTokens: total,
      usage: safeUsage,
      usedPercent: max ? Math.min(999, Math.max(0, (total / max) * 100)) : null
    };
  }, [maxTokens, usedTokens, usage]);

  return (
    <ContextState.Provider value={value}>
      <HoverCard {...props} />
    </ContextState.Provider>
  );
}

export function ContextTrigger({
  children,
  className,
  type = "button",
  ...props
}: ComponentProps<typeof Button> & { children?: ReactNode }) {
  const context = useContextData();
  return (
    <HoverCardTrigger asChild>
      <Button className={cn("gap-2", className)} size="sm" type={type} variant="outline" {...props}>
        <ContextRing percent={context.usedPercent} />
        {children ?? formatPercent(context.usedPercent)}
      </Button>
    </HoverCardTrigger>
  );
}

export function ContextContent({ className, ...props }: ComponentProps<typeof HoverCardContent>) {
  return <HoverCardContent align="end" className={cn("w-72 p-0", className)} {...props} />;
}

export function ContextContentHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-center gap-3 border-b p-3", className)} {...props} />;
}

export function ContextContentBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("grid gap-2 p-3", className)} {...props} />;
}

export function ContextContentFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("border-t bg-muted/45 p-3 text-xs text-muted-foreground", className)} {...props} />;
}

export function ContextInputUsage(props: HTMLAttributes<HTMLDivElement>) {
  return <UsageRow label="Input" value={useContextData().usage.inputTokens ?? 0} {...props} />;
}

export function ContextOutputUsage(props: HTMLAttributes<HTMLDivElement>) {
  return <UsageRow label="Output" value={useContextData().usage.outputTokens ?? 0} {...props} />;
}

export function ContextReasoningUsage(props: HTMLAttributes<HTMLDivElement>) {
  return <UsageRow label="Reasoning" value={useContextData().usage.reasoningTokens ?? 0} {...props} />;
}

export function ContextCacheUsage(props: HTMLAttributes<HTMLDivElement>) {
  return <UsageRow label="Cache" value={useContextData().usage.cachedTokens ?? 0} {...props} />;
}

function UsageRow({ className, label, value, ...props }: HTMLAttributes<HTMLDivElement> & { label: string; value: number }) {
  return (
    <div className={cn("flex items-center justify-between gap-3 text-xs", className)} {...props}>
      <span className="text-muted-foreground">{label}</span>
      <strong className="font-mono font-semibold">{formatTokens(value)}</strong>
    </div>
  );
}

function ContextRing({ percent }: { percent: number | null }) {
  const radius = 8;
  const circumference = 2 * Math.PI * radius;
  const normalized = percent === null ? 0 : Math.min(100, Math.max(0, percent));
  return (
    <svg aria-hidden="true" className="size-5" viewBox="0 0 20 20">
      <circle cx="10" cy="10" fill="none" r={radius} stroke="currentColor" strokeOpacity="0.18" strokeWidth="2.5" />
      <circle
        cx="10"
        cy="10"
        fill="none"
        r={radius}
        stroke="currentColor"
        strokeDasharray={circumference}
        strokeDashoffset={circumference - (normalized / 100) * circumference}
        strokeLinecap="round"
        strokeWidth="2.5"
        transform="rotate(-90 10 10)"
      />
    </svg>
  );
}

function useContextData(): ContextValue {
  const context = useContext(ContextState);
  if (!context) {
    throw new Error("Context components must be used inside <Context>.");
  }
  return context;
}

function tokenTotal(usage: ContextUsage): number {
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.reasoningTokens ?? 0);
}

function formatPercent(value: number | null): string {
  return value === null ? "Context" : `${Math.round(value)}%`;
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1, notation: "compact" }).format(value);
}
