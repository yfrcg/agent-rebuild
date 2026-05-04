import type { SandboxRunRequest, SandboxRunResult } from "./types";

const DEFAULT_SANDBOX_API_URL = "http://127.0.0.1:8765";
const DEFAULT_TIMEOUT_MS = 30_000;
const NETWORK_TIMEOUT_BUFFER_MS = 2_000;

export interface WslSandboxClientOptions {
  apiUrl?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export class WslSandboxClient {
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: WslSandboxClientOptions = {}) {
    this.apiUrl = normalizeApiUrl(
      options.apiUrl ?? process.env.SANDBOX_API_URL ?? DEFAULT_SANDBOX_API_URL
    );
    this.apiKey = options.apiKey ?? process.env.SANDBOX_API_KEY ?? "";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
    if (!this.apiKey.trim()) {
      return createErrorResult(
        "[sandbox-client] SANDBOX_API_KEY is not configured for WSL sandbox requests."
      );
    }

    const timeoutMs = normalizeTimeout(request.timeoutMs);
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      timeoutMs + NETWORK_TIMEOUT_BUFFER_MS
    );

    try {
      const response = await this.fetchImpl(`${this.apiUrl}/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          command: request.command,
          cwd: request.cwd ?? request.windowsCwd,
          windowsCwd: request.windowsCwd ?? request.cwd,
          timeoutMs,
          env: request.env,
          envAllowlist: request.envAllowlist,
          workspaceMount: request.workspaceMount,
          networkPolicy: request.networkPolicy,
          resourceLimits: request.resourceLimits,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await safeReadText(response);
        return createErrorResult(
          `[sandbox-client] worker returned HTTP ${response.status}${body ? `: ${body}` : ""}`,
          Date.now() - startedAt
        );
      }

      const payload = (await response.json()) as Partial<SandboxRunResult> | null;
      return {
        ok: payload?.ok === true,
        exitCode:
          typeof payload?.exitCode === "number" || payload?.exitCode === null
            ? payload.exitCode
            : null,
        stdout: typeof payload?.stdout === "string" ? payload.stdout : "",
        stderr: typeof payload?.stderr === "string" ? payload.stderr : "",
        durationMs:
          typeof payload?.durationMs === "number" && Number.isFinite(payload.durationMs)
            ? payload.durationMs
            : Date.now() - startedAt,
        timedOut: payload?.timedOut === true,
        artifacts: Array.isArray(payload?.artifacts)
          ? payload.artifacts.flatMap((artifact) => {
              if (!artifact || typeof artifact !== "object") {
                return [];
              }

              const candidate = artifact as Record<string, unknown>;
              return typeof candidate.path === "string"
                ? [
                    {
                      path: candidate.path,
                      sizeBytes:
                        typeof candidate.sizeBytes === "number"
                          ? candidate.sizeBytes
                          : undefined,
                      kind:
                        typeof candidate.kind === "string"
                          ? candidate.kind
                          : undefined,
                      description:
                        typeof candidate.description === "string"
                          ? candidate.description
                          : undefined,
                    },
                  ]
                : [];
            })
          : [],
      };
    } catch (error) {
      const message =
        error instanceof Error && error.name === "AbortError"
          ? `[sandbox-client] request timed out after ${timeoutMs}ms`
          : `[sandbox-client] request failed: ${error instanceof Error ? error.message : String(error)}`;
      return createErrorResult(message, Date.now() - startedAt);
    } finally {
      clearTimeout(timer);
    }
  }

  async health(): Promise<{ ok: boolean; status: number | null; body: string }> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);

    try {
      const response = await this.fetchImpl(`${this.apiUrl}/health`, {
        method: "GET",
        signal: controller.signal,
      });
      return {
        ok: response.ok,
        status: response.status,
        body: await safeReadText(response),
      };
    } catch (error) {
      return {
        ok: false,
        status: null,
        body:
          error instanceof Error && error.name === "AbortError"
            ? `[sandbox-client] health check timed out after ${Date.now() - startedAt}ms`
            : `[sandbox-client] health check failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

function normalizeApiUrl(input: string): string {
  return input.trim().replace(/\/+$/, "") || DEFAULT_SANDBOX_API_URL;
}

function normalizeTimeout(timeoutMs: number | undefined): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs === undefined || timeoutMs <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }

  return Math.floor(timeoutMs);
}

function createErrorResult(stderr: string, durationMs = 0): SandboxRunResult {
  return {
    ok: false,
    exitCode: null,
    stdout: "",
    stderr,
    durationMs,
    timedOut: false,
    artifacts: [],
  };
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return "";
  }
}
