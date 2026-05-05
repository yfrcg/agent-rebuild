import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  clampMaxResults,
  validateSearchInput,
} from "../packages/gateway/webSearchProvider";
import type { WebSearchInput } from "../packages/gateway/types";

describe("web.search validation", () => {
  it("rejects empty query", () => {
    const input: WebSearchInput = { query: "" };
    const error = validateSearchInput(input);
    assert.ok(error !== null);
    assert.ok(error!.includes("must not be empty"));
  });

  it("rejects whitespace-only query", () => {
    const input: WebSearchInput = { query: "   " };
    const error = validateSearchInput(input);
    assert.ok(error !== null);
    assert.ok(error!.includes("must not be empty"));
  });

  it("rejects query exceeding 300 characters", () => {
    const input: WebSearchInput = { query: "a".repeat(301) };
    const error = validateSearchInput(input);
    assert.ok(error !== null);
    assert.ok(error!.includes("300"));
  });

  it("accepts valid query at boundary (300 chars)", () => {
    const input: WebSearchInput = { query: "a".repeat(300) };
    const error = validateSearchInput(input);
    assert.equal(error, null);
  });

  it("accepts normal query", () => {
    const input: WebSearchInput = { query: "TypeScript best practices" };
    const error = validateSearchInput(input);
    assert.equal(error, null);
  });
});

describe("web.search maxResults clamping", () => {
  it("defaults to 5 when undefined", () => {
    assert.equal(clampMaxResults(undefined), 5);
  });

  it("clamps to 1 when below minimum", () => {
    assert.equal(clampMaxResults(0), 1);
    assert.equal(clampMaxResults(-5), 1);
  });

  it("clamps to 10 when above maximum", () => {
    assert.equal(clampMaxResults(15), 10);
    assert.equal(clampMaxResults(100), 10);
  });

  it("passes through valid values", () => {
    assert.equal(clampMaxResults(1), 1);
    assert.equal(clampMaxResults(5), 5);
    assert.equal(clampMaxResults(10), 10);
  });

  it("floors fractional values", () => {
    assert.equal(clampMaxResults(3.7), 3);
    assert.equal(clampMaxResults(7.2), 7);
  });

  it("handles NaN and Infinity as 1", () => {
    assert.equal(clampMaxResults(Number.NaN), 1);
    assert.equal(clampMaxResults(Number.POSITIVE_INFINITY), 1);
  });
});

describe("web.search tool registration", () => {
  it("tool is always registered", async () => {
    const { createBuiltinToolRegistry } = await import(
      "../packages/gateway/builtinTools"
    );
    const registry = createBuiltinToolRegistry();
    const toolNames = registry.list().map((t) => t.name);
    assert.ok(toolNames.includes("web.search"));
  });

  it("tool is registered with tavilyApiKey", async () => {
    const { createBuiltinToolRegistry } = await import(
      "../packages/gateway/builtinTools"
    );
    const registry = createBuiltinToolRegistry({ tavilyApiKey: "test-key" });
    const toolNames = registry.list().map((t) => t.name);
    assert.ok(toolNames.includes("web.search"));
  });

  it("web.search tool has correct schema", async () => {
    const { createBuiltinToolRegistry } = await import(
      "../packages/gateway/builtinTools"
    );
    const registry = createBuiltinToolRegistry({ tavilyApiKey: "test-key" });
    const tool = registry.get("web.search");
    assert.ok(tool);
    assert.ok(tool!.schema);
    const schema = tool!.schema as Record<string, unknown>;
    const properties = schema.properties as Record<string, unknown>;
    assert.ok(properties.query);
    assert.ok(properties.maxResults);
    assert.ok(properties.topic);
    assert.ok(properties.includeDomains);
    assert.ok(properties.excludeDomains);
    assert.ok(properties.freshness);
  });

  it("web.search tool has correct security profile", async () => {
    const { createBuiltinToolRegistry } = await import(
      "../packages/gateway/builtinTools"
    );
    const registry = createBuiltinToolRegistry({ tavilyApiKey: "test-key" });
    const tool = registry.get("web.search");
    assert.ok(tool);
    assert.ok(tool!.security);
    assert.equal(tool!.security!.riskLevel, "low");
    assert.equal(tool!.security!.allowNetwork, true);
    assert.equal(tool!.security!.allowWrite, false);
    assert.equal(tool!.security!.requireApproval, false);
    assert.equal(tool!.readOnly, true);
  });

  it("web.search execute rejects empty query", async () => {
    const { createBuiltinToolRegistry } = await import(
      "../packages/gateway/builtinTools"
    );
    const registry = createBuiltinToolRegistry({ tavilyApiKey: "test-key" });
    const tool = registry.get("web.search");
    assert.ok(tool);
    assert.ok(tool!.execute);
    const result = await tool!.execute!({ query: "" });
    assert.equal(result.ok, false);
    assert.ok(result.error!.includes("must not be empty"));
  });

  it("web.search execute rejects query exceeding 300 chars", async () => {
    const { createBuiltinToolRegistry } = await import(
      "../packages/gateway/builtinTools"
    );
    const registry = createBuiltinToolRegistry({ tavilyApiKey: "test-key" });
    const tool = registry.get("web.search");
    assert.ok(tool);
    const result = await tool!.execute!({ query: "a".repeat(301) });
    assert.equal(result.ok, false);
    assert.ok(result.error!.includes("300"));
  });

  it("web.search execute returns clear error when TAVILY_API_KEY is missing", async () => {
    const { createBuiltinToolRegistry } = await import(
      "../packages/gateway/builtinTools"
    );
    const registry = createBuiltinToolRegistry();
    const tool = registry.get("web.search");
    assert.ok(tool);
    assert.ok(tool!.execute);
    const result = await tool!.execute!({ query: "test query" });
    assert.equal(result.ok, false);
    assert.ok(result.error!.includes("TAVILY_API_KEY"));
  });
});

describe("web.search config integration", () => {
  it("loadGatewayConfig reads TAVILY_API_KEY from env", async () => {
    const { loadGatewayConfig } = await import(
      "../packages/gateway/config"
    );
    const config = loadGatewayConfig({
      TAVILY_API_KEY: "tvly-test-123",
    });
    assert.equal(config.tavilyApiKey, "tvly-test-123");
  });

  it("loadGatewayConfig defaults TAVILY_API_KEY to empty string", async () => {
    const { loadGatewayConfig } = await import(
      "../packages/gateway/config"
    );
    const config = loadGatewayConfig({});
    assert.equal(config.tavilyApiKey, "");
  });

  it("loadGatewayConfig trims TAVILY_API_KEY whitespace", async () => {
    const { loadGatewayConfig } = await import(
      "../packages/gateway/config"
    );
    const config = loadGatewayConfig({
      TAVILY_API_KEY: "  tvly-key  ",
    });
    assert.equal(config.tavilyApiKey, "tvly-key");
  });
});
