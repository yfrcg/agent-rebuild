export type AuditEventType =
  | "gateway.request.received"
  | "gateway.rate_limited"
  | "gateway.circuit.open"
  | "gateway.confirmation.queued"
  | "gateway.confirmation.confirmed"
  | "gateway.confirmation.rejected"
  | "gateway.confirmation.cleared"
  | "gateway.confirmation.expired"
  | "gateway.confirmation.missing"
  | "memory.search.completed"
  | "context.built"
  | "gateway.auto_tool.decision"
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
