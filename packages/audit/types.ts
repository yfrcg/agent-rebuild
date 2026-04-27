export type AuditEventType =
  | "gateway.request.received"
  | "gateway.rate_limited"
  | "gateway.circuit.open"
  | "memory.search.completed"
  | "context.built"
  | "model.generate.completed"
  | "gateway.response.completed"
  | "gateway.error";

export interface AuditEvent {
  id: string;
  requestId: string;
  type: AuditEventType;
  message: string;
  createdAt: string;
  data?: Record<string, unknown>;
}
