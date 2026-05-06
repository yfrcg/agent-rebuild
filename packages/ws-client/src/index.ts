export { GatewayClient } from "./gatewayClient";
export { GatewayError } from "./types";
export { ConnectionManager, GatewayClientAuthError } from "./connectionManager";
export { RequestManager, RequestTimeoutError, ConnectionClosedError } from "./requestManager";
export { EventDispatcher } from "./eventDispatcher";
export { ResumeManager } from "./resumeManager";

export type {
  ConnectionState,
  GatewayClientOptions,
  GatewayMethodParams,
  GatewayMethodResult,
  GatewayEventPayload,
  GatewayWsMethod,
  GatewayWsEvent,
  GatewayWsErrorCode,
  WsRequest,
  WsResponse,
  WsEvent,
} from "./types";
