/*
Security boundary notes for sandbox v1:
- Gateway itself is not sandboxed.
- v1 sandboxes tool execution only, not model inference.
- Network is denied by default.
- Host env is not inherited by default.
- Only projectRoot is mounted to /workspace.
- elevated still requires human approval; it does not bypass deny rules.
- Deny rules always win.
- If Docker is unavailable, execution fails closed and never falls back to host execution.
*/
export * from "./audit";
export * from "./config";
export * from "./dockerBackend";
export * from "./pathGuard";
export * from "./policy";
export * from "./sandboxManager";
export * from "./types";
export * from "./wslBackend";
