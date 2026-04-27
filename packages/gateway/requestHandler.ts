import { randomUUID } from "node:crypto";
import type { GatewayRequest } from "./types";

export function createGatewayRequest(input: string): GatewayRequest {
  return {
    id: randomUUID(),
    input: input.trim(),
    createdAt: new Date().toISOString(),
  };
}