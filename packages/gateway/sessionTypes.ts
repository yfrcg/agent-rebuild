export type GatewaySessionId = string;

export interface GatewaySession {
  id: GatewaySessionId;
  name: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  transcriptPath: string;
}

export interface GatewaySessionCreateInput {
  name?: string;
}

export interface GatewaySessionRenameInput {
  id: GatewaySessionId;
  name: string;
}

export interface GatewaySessionStoreSnapshot {
  sessions: GatewaySession[];
}
