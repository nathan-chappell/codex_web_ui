"use client";

import { Button } from "@/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { cn } from "@/lib/utils";
import type { ComponentProps, ReactNode } from "react";
import { createContext, useContext, useMemo } from "react";

type UsageLike = {
  totalTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
};

type ContextValue = {
  maxTokens: number | null;
  percent: number | null;
  usage: UsageLike;
  usedTokens: number | null;
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
  usage?: UsageLike | null;
}) {
  const value = useMemo<ContextValue>(() => {
    const normalizedUsage = usage ?? {};
    const normalizedUsed = usedTokens ?? normalizedUsage.totalTokens ?? sumUsage(normalizedUsage);
    const normalizedMax = typeof maxTokens === "number" && maxTokens > 0 ? maxTokens : null;
    return {
      maxTokens: normalizedMax,
      percent: normalizedMax && normalizedUsed !== null ? Math.min(100, Math.max(0, (normalizedUsed / normalizedMax) * 100)) : null,
      usage: normalizedUsage,
      usedTokens: normalizedUsed
    };
  }, [maxTokens, usage, usedTokens]);

  return (
    <ContextState.Provider value={value}>
      <HoverCard {...props} />
    </ContextState.Provider>
  );
}

export function ContextTrigger({ children, className, ...props }: ComponentProps<typeof Button>) {
  const context = useContextUsage();
  return (
    <HoverCardTrigger asChild>
      <Button className={cn("gap-2", className)} size="xs" type="button" variant="outline" {...props}>
        <ContextRing percent={context.percent} />
        {children ?? <span>{context.percent === null ? "ctx n/a" : `${Math.round(context.percent)}% ctx`}</span>}
      </Button>
    </HoverCardTrigger>
  );
}

export function ContextContent({ className, ...props }: ComponentProps<typeof HoverCardContent>) {
  return <HoverCardContent className={cn("w-72 p-0", className)} {...props} />;
}

export function ContextContentHeader({ children, className, ...props }: ComponentProps<"div">) {
  const context = useContextUsage();
  return (
    <div className={cn("flex items-center gap-3 border-b p-3", className)} {...props}>
      <ContextRing percent={context.percent} size={36} />
      <div className="min-w-0">
        <div className="text-sm font-semibold">Context used</div>
        <div className="text-xs text-muted-foreground">
          {children ?? `${formatTokenCount(context.usedTokens)}${context.maxTokens ? ` / ${formatTokenCount(context.maxTokens)}` : ""}`}
        </div>
      </div>
    </div>
  );
}

export function ContextContentBody({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("grid gap-2 p-3 text-xs", className)} {...props} />;
}

export function ContextContentFooter({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("border-t bg-muted/40 p-3 text-xs text-muted-foreground", className)} {...props} />;
}

export function ContextInputUsage(props: UsageRowProps) {
  return <UsageRow label="Input" selector={(usage) => usage.inputTokens} {...props} />;
}

export function ContextOutputUsage(props: UsageRowProps) {
  return <UsageRow label="Output" selector={(usage) => usage.outputTokens} {...props} />;
}

export function ContextReasoningUsage(props: UsageRowProps) {
  return <UsageRow label="Reasoning" selector={(usage) => usage.reasoningOutputTokens} {...props} />;
}

export function ContextCacheUsage(props: UsageRowProps) {
  return <UsageRow label="Cached" selector={(usage) => usage.cachedInputTokens} {...props} />;
}

type UsageRowProps = Omit<ComponentProps<"div">, "children"> & {
  children?: ReactNode;
};

function UsageRow({
  children,
  className,
  label,
  selector,
  ...props
}: UsageRowProps & {
  label: string;
  selector: (usage: UsageLike) => number | undefined;
}) {
  const context = useContextUsage();
  return (
    <div className={cn("flex items-center justify-between gap-3", className)} {...props}>
      <span className="text-muted-foreground">{children ?? label}</span>
      <span className="font-medium">{formatTokenCount(selector(context.usage) ?? null)}</span>
    </div>
  );
}

function ContextRing({ percent, size = 18 }: { percent: number | null; size?: number }) {
  const stroke = 3;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = percent === null ? circumference * 0.72 : circumference * (1 - percent / 100);
  return (
    <svg aria-hidden="true" className="shrink-0 text-current" height={size} viewBox={`0 0 ${size} ${size}`} width={size}>
      <circle cx={size / 2} cy={size / 2} fill="none" opacity="0.18" r={radius} stroke="currentColor" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        fill="none"
        r={radius}
        stroke="currentColor"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        strokeWidth={stroke}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

function useContextUsage(): ContextValue {
  const context = useContext(ContextState);
  if (!context) {
    throw new Error("Context components must be rendered inside <Context>.");
  }
  return context;
}

function sumUsage(usage: UsageLike): number | null {
  const values = [usage.inputTokens, usage.outputTokens, usage.reasoningOutputTokens].filter((value): value is number => typeof value === "number");
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}

function formatTokenCount(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "n/a";
  }
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: value >= 1000 ? 1 : 0, notation: "compact" }).format(value);
}
