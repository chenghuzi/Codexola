import { useCallback, useEffect, useRef, useState } from "react";
import type { DebugEntry, PromptOption } from "../types";
import { getPromptsList } from "../services/tauri";

type UsePromptsOptions = {
  onDebug?: (entry: DebugEntry) => void;
  enabled?: boolean;
};

type PromptOptionWire = PromptOption & { argument_hint?: string | null };

export function usePrompts({ onDebug, enabled = true }: UsePromptsOptions) {
  const [prompts, setPrompts] = useState<PromptOption[]>([]);
  const inFlight = useRef(false);

  const refreshPrompts = useCallback(async () => {
    if (!enabled) {
      return;
    }
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    onDebug?.({
      id: `${Date.now()}-client-prompts-list`,
      timestamp: Date.now(),
      source: "client",
      label: "prompts/list",
    });
    try {
      const response = await getPromptsList();
      const data = Array.isArray(response) ? response : [];
      const normalized = data
        .map((item) => {
          const raw = item as PromptOptionWire;
          return {
            name: String(raw?.name ?? ""),
            path: String(raw?.path ?? ""),
            description: raw?.description ? String(raw.description) : undefined,
            argumentHint: raw?.argumentHint
              ? String(raw.argumentHint)
              : raw?.argument_hint
                ? String(raw.argument_hint)
                : undefined,
          };
        })
        .filter((item) => item.name);
      setPrompts(normalized);
      onDebug?.({
        id: `${Date.now()}-server-prompts-list`,
        timestamp: Date.now(),
        source: "server",
        label: "prompts/list response",
        payload: { count: normalized.length },
      });
    } catch (error) {
      onDebug?.({
        id: `${Date.now()}-client-prompts-list-error`,
        timestamp: Date.now(),
        source: "error",
        label: "prompts/list error",
        payload: error instanceof Error ? error.message : String(error),
      });
    } finally {
      inFlight.current = false;
    }
  }, [enabled, onDebug]);

  useEffect(() => {
    refreshPrompts();
  }, [refreshPrompts]);

  return {
    prompts,
    refreshPrompts,
  };
}
