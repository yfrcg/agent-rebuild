import { createToolSecurityProfile } from "../toolSecurityProfile";
import type { GatewayTool, GatewayToolInput, GatewayToolOutput } from "../toolTypes";

export function createWebFetchTool(): GatewayTool[] {
  return [createWebFetch()];
}

const BLOCKED_PROTOCOLS = new Set(["file:", "ftp:", "data:", "javascript:", "vbscript:"]);
const MAX_BODY_CHARS = 20000;

function createWebFetch(): GatewayTool {
  const schema = {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "HTTP/HTTPS URL to fetch.",
      },
      maxChars: {
        type: "number",
        description: "Maximum characters to return (default 15000, max 50000).",
      },
      extractLinks: {
        type: "boolean",
        description: "Extract links from HTML (default: true).",
      },
    },
    required: ["url"],
  } satisfies Record<string, unknown>;

  return {
    name: "web.fetch",
    description: "Fetch an HTTP/HTTPS web page. Returns title, text, links, status. Blocks file/ftp protocols.",
    schema,
    inputSchema: schema,
    riskLevel: "safe",
    permissionLevel: "read",
    readOnly: true,
    sideEffect: false,
    requiresSandbox: false,
    policy: {
      automationLevel: "auto",
      riskLevel: "external-read",
      tags: ["web", "fetch", "network", "read"],
    },
    security: createToolSecurityProfile({
      riskLevel: "low",
      sandboxRequired: false,
      allowNetwork: true,
      allowWrite: false,
      allowHostExecution: true,
      requireApproval: false,
    }),
    async invoke(input) {
      const urlStr = typeof input.url === "string" ? input.url.trim() : "";
      if (!urlStr) {
        return { ok: false, error: "URL must not be empty." };
      }

      let parsed: URL;
      try {
        parsed = new URL(urlStr);
      } catch {
        return { ok: false, error: `Invalid URL: ${urlStr}` };
      }

      if (BLOCKED_PROTOCOLS.has(parsed.protocol)) {
        return { ok: false, error: `Blocked protocol: ${parsed.protocol}. Only http/https allowed.` };
      }

      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { ok: false, error: `Unsupported protocol: ${parsed.protocol}` };
      }

      const maxChars = clampNumber(input.maxChars, 15000, 1000, 50000);
      const extractLinks = input.extractLinks !== false;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      try {
        const response = await fetch(urlStr, {
          signal: controller.signal,
          headers: {
            "User-Agent": "agent-rebuild/1.0",
            Accept: "text/html,application/xhtml+xml,text/plain,application/json,*/*",
          },
          redirect: "follow",
        });

        clearTimeout(timeoutId);

        const status = response.status;
        const contentType = response.headers.get("content-type") ?? "";
        const rawBody = await response.text();
        const body = rawBody.slice(0, MAX_BODY_CHARS);

        let title = "";
        let text = body;
        const links: Array<{ text: string; href: string }> = [];

        const isHtml = contentType.includes("text/html") || contentType.includes("application/xhtml");
        if (isHtml) {
          const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
          title = titleMatch ? titleMatch[1].trim().slice(0, 200) : "";

          text = body
            .replace(/<script[\s\S]*?<\/script>/gi, "")
            .replace(/<style[\s\S]*?<\/style>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, maxChars);

          if (extractLinks) {
            const linkRegex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
            let linkMatch: RegExpExecArray | null;
            while ((linkMatch = linkRegex.exec(body)) !== null && links.length < 50) {
              const href = linkMatch[1].trim();
              const linkText = linkMatch[2].replace(/<[^>]+>/g, "").trim().slice(0, 100);
              if (href && !href.startsWith("#") && !href.startsWith("javascript:")) {
                links.push({ text: linkText || href, href });
              }
            }
          }
        } else {
          text = body.slice(0, maxChars);
        }

        return {
          ok: true,
          content: {
            url: urlStr,
            status,
            title,
            text,
            links: extractLinks ? links : [],
            contentType,
            bodyLength: rawBody.length,
            truncated: rawBody.length > MAX_BODY_CHARS,
          },
          metadata: { status, bodyLength: rawBody.length },
        };
      } catch (err: unknown) {
        clearTimeout(timeoutId);
        if (err instanceof Error && err.name === "AbortError") {
          return { ok: false, error: `Fetch timeout after 15s: ${urlStr}` };
        }
        return { ok: false, error: `Fetch failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };
}

function clampNumber(value: unknown, defaultVal: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return defaultVal;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
