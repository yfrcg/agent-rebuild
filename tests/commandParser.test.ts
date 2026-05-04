import test from "node:test";
import assert from "node:assert/strict";

import { parseGatewayCommand } from "../packages/gateway/commandParser";

test("parseGatewayCommand parses compact command", () => {
  const parsed = parseGatewayCommand("compact");

  assert.equal(parsed.type, "compact");
  assert.equal(parsed.raw, "compact");
});

test("parseGatewayCommand keeps remember payload trimmed", () => {
  const parsed = parseGatewayCommand("记住：  需要索引到今天的日记忆  ");

  assert.equal(parsed.type, "remember");
  assert.equal(parsed.payload, "需要索引到今天的日记忆");
});

test("parseGatewayCommand parses skills command", () => {
  const parsed = parseGatewayCommand(":skills show gateway-maintainer");

  assert.equal(parsed.type, "skills");
  assert.equal(parsed.payload, "show gateway-maintainer");
});

test("parseGatewayCommand parses natural language use skill command", () => {
  const parsed = parseGatewayCommand("use skill gateway-maintainer");

  assert.equal(parsed.type, "skills");
  assert.equal(parsed.payload, "use gateway-maintainer");
});

test("parseGatewayCommand parses confirm command", () => {
  const parsed = parseGatewayCommand(":confirm approve_123");

  assert.equal(parsed.type, "confirm");
  assert.equal(parsed.payload, "approve_123");
});

test("parseGatewayCommand parses approvals command", () => {
  const parsed = parseGatewayCommand(":approvals clear");

  assert.equal(parsed.type, "approvals");
  assert.equal(parsed.payload, "clear");
});

test("parseGatewayCommand parses reject command", () => {
  const parsed = parseGatewayCommand(":reject approve_123");

  assert.equal(parsed.type, "reject");
  assert.equal(parsed.payload, "approve_123");
});

test("parseGatewayCommand keeps sandbox.exec tool payload intact", () => {
  const parsed = parseGatewayCommand(':tool sandbox.exec {"command":"node -v"}');

  assert.equal(parsed.type, "tool");
  assert.equal(parsed.payload, 'sandbox.exec {"command":"node -v"}');
});

test("parseGatewayCommand parses sandbox shortcut command as sh alias", () => {
  const parsed = parseGatewayCommand(":sandbox node -v");

  assert.equal(parsed.type, "sh");
  assert.equal(parsed.payload, "node -v");
});

test("parseGatewayCommand parses sh shortcut command", () => {
  const parsed = parseGatewayCommand(":sh npm test");

  assert.equal(parsed.type, "sh");
  assert.equal(parsed.payload, "npm test");
});

test("parseGatewayCommand parses /name as skills invoke", () => {
  const parsed = parseGatewayCommand("/commit");

  assert.equal(parsed.type, "skills");
  assert.equal(parsed.payload, "invoke commit");
});

test("parseGatewayCommand parses /name with args", () => {
  const parsed = parseGatewayCommand("/review fix auth.ts");

  assert.equal(parsed.type, "skills");
  assert.equal(parsed.payload, "invoke review fix auth.ts");
});

test("parseGatewayCommand parses /name with hyphens and slashes", () => {
  const parsed = parseGatewayCommand("/code-review");

  assert.equal(parsed.type, "skills");
  assert.equal(parsed.payload, "invoke code-review");
});

test("parseGatewayCommand does not parse // as skill", () => {
  const parsed = parseGatewayCommand("//not-a-skill");

  assert.notEqual(parsed.type, "skills");
});

test("parseGatewayCommand does not parse / with only special chars as skill", () => {
  const parsed = parseGatewayCommand("/!@#$");

  assert.notEqual(parsed.type, "skills");
});
