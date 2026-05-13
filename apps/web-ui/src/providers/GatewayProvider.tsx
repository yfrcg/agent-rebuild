/**
 * ?????CS336 ???
 * ???apps/web-ui/src/providers/GatewayProvider.tsx
 * ????? Gateway Provider?
 * ???????????????????????
 * ???????????????????????????????????? README ????????????????
 */
import React, { createContext, useContext, useEffect, useRef } from "react";
import { GatewayClient } from "@ws-client/index";
import type { WsEvent } from "@ws-client/types";
import { useConnectionStore } from "../stores/connectionStore";
import { useSessionStore } from "../stores/sessionStore";
import { useRunStore } from "../stores/runStore";
import { useEventStore } from "../stores/eventStore";
import { useApprovalStore } from "../stores/approvalStore";

const GatewayContext = createContext<GatewayClient | null>(null);
const gatewayWsUrl = import.meta.env.VITE_GATEWAY_WS_URL || "/v1/ws";
const gatewayWsToken = import.meta.env.VITE_GATEWAY_WS_TOKEN || undefined;

export function useGateway(): GatewayClient {
  const client = useContext(GatewayContext);
  if (!client) {
    throw new Error("useGateway must be used within GatewayProvider");
  }
  return client;
}

interface GatewayProviderProps {
  children: React.ReactNode;
}

export function GatewayProvider({ children }: GatewayProviderProps) {
  const clientRef = useRef<GatewayClient | null>(null);
  if (!clientRef.current) {
    clientRef.current = new GatewayClient({
      url: gatewayWsUrl,
      token: gatewayWsToken,
      reconnect: true,
      reconnectInitialMs: 1000,
      reconnectMaxMs: 30000,
      requestTimeoutMs: 30000,
      deltaBatchMs: 50,
    });
  }
  const client = clientRef.current;

  const setState = useConnectionStore((s) => s.setState);
  const setReconnectCount = useConnectionStore((s) => s.setReconnectCount);
  const setError = useConnectionStore((s) => s.setError);
  const setHeartbeat = useConnectionStore((s) => s.setHeartbeat);
  const setCapabilities = useConnectionStore((s) => s.setCapabilities);

  const setSessions = useSessionStore((s) => s.setSessions);
  const setCurrentSession = useSessionStore((s) => s.setCurrentSession);
  const updateSession = useSessionStore((s) => s.updateSession);

  const startRun = useRunStore((s) => s.startRun);
  const setPhase = useRunStore((s) => s.setPhase);
  const appendDelta = useRunStore((s) => s.appendDelta);
  const setCompleted = useRunStore((s) => s.setCompleted);
  const setFailed = useRunStore((s) => s.setFailed);
  const setCancelled = useRunStore((s) => s.setCancelled);

  const addEvent = useEventStore((s) => s.addEvent);

  const addApproval = useApprovalStore((s) => s.addApproval);
  const removeApproval = useApprovalStore((s) => s.removeApproval);

  useEffect(() => {
    const subscriptions: Array<() => void> = [];
    const subscribe = <E extends Parameters<GatewayClient["on"]>[0]>(
      event: E,
      handler: Parameters<GatewayClient["on"]>[1]
    ) => {
      subscriptions.push(client.on(event, handler));
    };

    subscriptions.push(client.onConnectionStateChange((state) => {
      setState(state);
      setReconnectCount(client.reconnectCount);
    }));

    subscribe("heartbeat", (payload) => {
      const heartbeatPayload = payload as { serverTime?: string };
      if (heartbeatPayload.serverTime) setHeartbeat(heartbeatPayload.serverTime);
    });

    subscribe("run.started", (payload, raw) => {
      const sessionId = raw.sessionId ?? (payload as Record<string, unknown>).sessionId as string ?? "";
      addEvent(toEventEntry(raw));
      setPhase("running");
    });

    subscribe("run.progress", (_, raw) => {
      addEvent(toEventEntry(raw));
    });

    subscribe("run.finished", (_, raw) => {
      addEvent(toEventEntry(raw));
    });

    subscribe("run.failed", (payload, raw) => {
      addEvent(toEventEntry(raw));
      const errPayload = payload as Record<string, unknown>;
      setFailed(String(errPayload.error ?? "Run failed"));
    });

    subscribe("run.cancelled", (_, raw) => {
      addEvent(toEventEntry(raw));
      setCancelled();
    });

    subscribe("chat.delta", (payload, raw) => {
      const deltaPayload = payload as Record<string, unknown>;
      const text =
        typeof deltaPayload.text === "string"
          ? deltaPayload.text
          : typeof deltaPayload.delta === "string"
            ? deltaPayload.delta
            : "";
      if (text) {
        appendDelta(text);
      }
      addEvent(toEventEntry(raw));
    });

    subscribe("chat.completed", (payload, raw) => {
      addEvent(toEventEntry(raw));
      const completedPayload = payload as Record<string, unknown>;
      if (typeof completedPayload.text === "string") {
        setCompleted(completedPayload.text);
      }
    });

    subscribe("tool.started", (_, raw) => addEvent(toEventEntry(raw)));
    subscribe("tool.finished", (_, raw) => addEvent(toEventEntry(raw)));
    subscribe("tool.failed", (_, raw) => addEvent(toEventEntry(raw)));
    subscribe("tool.denied", (_, raw) => addEvent(toEventEntry(raw)));

    subscribe("approval.required", (payload, raw) => {
      addEvent(toEventEntry(raw));
      const ap = payload as Record<string, unknown>;
      addApproval({
        token: String(ap.token ?? ""),
        toolName: String(ap.toolName ?? ""),
        input: ap.input,
        createdAt: raw.createdAt,
        expiresAt: String(ap.expiresAt ?? ""),
        message: ap.message as string | undefined,
        sessionId: raw.sessionId,
      });
    });

    subscribe("approval.confirmed", (payload, raw) => {
      addEvent(toEventEntry(raw));
      const ap = payload as Record<string, unknown>;
      if (ap.token) removeApproval(String(ap.token));
    });

    subscribe("approval.rejected", (payload, raw) => {
      addEvent(toEventEntry(raw));
      const ap = payload as Record<string, unknown>;
      if (ap.token) removeApproval(String(ap.token));
    });

    subscribe("session.updated", (payload, raw) => {
      addEvent(toEventEntry(raw));
      const session = payload as Record<string, unknown>;
      const id = typeof session.id === "string" ? session.id : raw.sessionId;
      if (id) {
        updateSession(id, {
          name: typeof session.name === "string" ? session.name : undefined,
          messageCount: typeof session.messageCount === "number" ? session.messageCount : undefined,
          updatedAt: typeof session.updatedAt === "string" ? session.updatedAt : undefined,
          permission: session.permission as string | undefined,
          projectBound: typeof session.projectBound === "boolean" ? session.projectBound : undefined,
          projectDir: session.projectDir as string | null | undefined,
          displayName: session.displayName as string | undefined,
          activeSkills: Array.isArray(session.activeSkills)
            ? session.activeSkills.filter((name): name is string => typeof name === "string")
            : undefined,
        });
      }
    });
    subscribe("audit.append", (_, raw) => addEvent(toEventEntry(raw)));

    subscribe("server.shutdown", (_, raw) => addEvent(toEventEntry(raw)));

    subscribe("state.resync_required", (_, raw) => {
      addEvent(toEventEntry(raw));
      handleResync(client);
    });

    client.connect().then(async (result) => {
      if (result.capabilities) {
        setCapabilities(result.capabilities);
      }
      try {
        const sessions = await client.sessionList();
        setSessions(
          (sessions as unknown[]).map((s) => {
            const session = s as Record<string, unknown>;
            return {
              id: String(session.id ?? ""),
              name: String(session.name ?? "unnamed"),
              messageCount: Number(session.messageCount ?? 0),
              updatedAt: String(session.updatedAt ?? ""),
              permission: session.permission as string | undefined,
              projectBound: Boolean(session.projectBound),
              projectDir: session.projectDir as string | null | undefined,
              displayName: session.displayName as string | undefined,
              activeSkills: Array.isArray(session.activeSkills)
                ? session.activeSkills.filter((name): name is string => typeof name === "string")
                : [],
            };
          })
        );
      } catch {
        // session list fetch is non-critical
      }
    }).catch(() => {
      setError("Failed to connect");
    });

    return () => {
      for (const unsubscribe of subscriptions) {
        unsubscribe();
      }
      client.disconnect();
    };
  }, []);

  return (
    <GatewayContext.Provider value={client}>
      {children}
    </GatewayContext.Provider>
  );
}

function toEventEntry(raw: WsEvent) {
  return {
    type: raw.type,
    seq: raw.seq,
    event: raw.event,
    runId: raw.runId,
    sessionId: raw.sessionId,
    payload: raw.payload,
    createdAt: raw.createdAt,
  };
}

function runStoreNeedsStart(_sessionId: string): boolean {
  const { phase } = useRunStore.getState();
  return phase === "idle" || phase === "completed" || phase === "failed" || phase === "cancelled";
}

async function handleResync(client: GatewayClient): Promise<void> {
  try {
    await client.runtimeStatus();
    const sessions = await client.sessionList();
    useSessionStore.getState().setSessions(
      (sessions as unknown[]).map((s) => {
        const session = s as Record<string, unknown>;
        return {
          id: String(session.id ?? ""),
          name: String(session.name ?? "unnamed"),
          messageCount: Number(session.messageCount ?? 0),
          updatedAt: String(session.updatedAt ?? ""),
          permission: session.permission as string | undefined,
          projectBound: Boolean(session.projectBound),
          projectDir: session.projectDir as string | null | undefined,
          displayName: session.displayName as string | undefined,
          activeSkills: Array.isArray(session.activeSkills)
            ? session.activeSkills.filter((name): name is string => typeof name === "string")
            : [],
        };
      })
    );
  } catch {
    // resync is best-effort
  }
}
