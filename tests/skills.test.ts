import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { loadBootstrapContext } from "../packages/core/src/bootstrap";
import {
  discoverSkills,
  selectSkills,
  getSkillByName,
  resolveSkillPrompt,
  buildSkillDescriptions,
} from "../packages/core/src/skills";
import type { SkillDefinition } from "../packages/core/src/skills";

function makeSkill(overrides: Partial<SkillDefinition> & { name: string }): SkillDefinition {
  return {
    title: overrides.name,
    description: "",
    path: "",
    relativePath: "",
    platform: "workspace",
    content: "",
    aliases: [overrides.name],
    priority: 0,
    conflicts: [],
    userInvocable: true,
    context: "inline",
    source: "project",
    skillDir: "",
    ...overrides,
  };
}

test("discoverSkills supports cross-platform SKILL.md roots and activates matching skills", () => {
  const root = process.cwd();
  const skillDir = path.join(root, ".claude", "skills", "temp-cross-platform-skill");
  const skillFile = path.join(skillDir, "SKILL.md");

  fs.mkdirSync(skillDir, {
    recursive: true,
  });
  fs.writeFileSync(
    skillFile,
    [
      "# Temp Cross Platform Skill",
      "",
      "Use this skill when testing cross-platform SKILL.md discovery.",
    ].join("\n"),
    "utf8"
  );

  try {
    const discovery = discoverSkills();
    const tempSkill = discovery.skills.find(
      (skill) => skill.name === "temp-cross-platform-skill"
    );

    assert.ok(tempSkill);
    assert.equal(tempSkill?.platform, "claude");
    assert.equal(tempSkill?.source, "project");
    assert.equal(tempSkill?.context, "inline");
    assert.equal(tempSkill?.userInvocable, true);

    const bootstrap = loadBootstrapContext({
      userInput: "请使用 $temp-cross-platform-skill 技能处理这次任务",
    });

    assert.ok(bootstrap.discoveredSkillCount >= 1);
    assert.ok(
      bootstrap.activatedSkills.includes("temp-cross-platform-skill"),
      "expected the explicit skill mention to activate the matching SKILL.md"
    );
    assert.equal(bootstrap.skillSelectionStrategy, "explicit");
    assert.match(bootstrap.bootstrapText, /Temp Cross Platform Skill/);

    const sessionBootstrap = loadBootstrapContext({
      userInput: "继续处理当前任务",
      activeSkillNames: ["temp-cross-platform-skill"],
    });

    assert.ok(sessionBootstrap.activatedSkills.includes("temp-cross-platform-skill"));
    assert.equal(sessionBootstrap.skillSelectionStrategy, "session");
  } finally {
    fs.rmSync(skillDir, {
      recursive: true,
      force: true,
    });
  }
});

test("selectSkills respects priority and conflicts from SKILL frontmatter", () => {
  const high = makeSkill({
    name: "high-skill",
    title: "High Skill",
    description: "High priority",
    priority: 100,
    conflicts: ["low-skill"],
  });
  const low = makeSkill({
    name: "low-skill",
    title: "Low Skill",
    description: "Low priority",
    priority: 10,
  });

  const result = selectSkills({
    userInput: "$high-skill $low-skill",
    availableSkills: [low, high],
    maxMatches: 3,
  });

  assert.deepEqual(result.selectedSkills.map((skill) => skill.name), ["high-skill"]);
  assert.equal(result.strategy, "explicit");
});

test("discoverSkills parses when-to-use, allowed-tools, context, user-invocable from frontmatter", () => {
  const root = process.cwd();
  const skillDir = path.join(root, ".claude", "skills", "temp-frontmatter-skill");
  const skillFile = path.join(skillDir, "SKILL.md");

  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    skillFile,
    [
      "---",
      "when-to-use: Use this for code reviews",
      "allowed-tools: shell.run, fs.write",
      "context: fork",
      "user-invocable: false",
      "priority: 50",
      "aliases: review, cr",
      "---",
      "# Code Review Skill",
      "",
      "Perform a thorough code review.",
    ].join("\n"),
    "utf8"
  );

  try {
    const discovery = discoverSkills();
    const skill = discovery.skills.find((s) => s.name === "temp-frontmatter-skill");

    assert.ok(skill, "skill should be discovered");
    assert.equal(skill?.whenToUse, "Use this for code reviews");
    assert.deepEqual(skill?.allowedTools, ["shell.run", "fs.write"]);
    assert.equal(skill?.context, "fork");
    assert.equal(skill?.userInvocable, false);
    assert.equal(skill?.priority, 50);
    assert.ok(skill?.aliases.includes("review"));
    assert.ok(skill?.aliases.includes("cr"));
    assert.ok(skill?.skillDir.endsWith("temp-frontmatter-skill"));
  } finally {
    fs.rmSync(skillDir, { recursive: true, force: true });
  }
});

test("resolveSkillPrompt replaces $ARGUMENTS and ${SKILL_DIR} template variables", () => {
  const skill = makeSkill({
    name: "test-skill",
    content: "Process the following: $ARGUMENTS\nSkill dir: ${SKILL_DIR}\nArgs again: ${ARGUMENTS}",
    skillDir: "/path/to/skill",
  });

  const result = resolveSkillPrompt(skill, "fix the bug in auth.ts");
  assert.equal(
    result,
    "Process the following: fix the bug in auth.ts\nSkill dir: /path/to/skill\nArgs again: fix the bug in auth.ts"
  );
});

test("resolveSkillPrompt handles empty args", () => {
  const skill = makeSkill({
    name: "test-skill",
    content: "Args: $ARGUMENTS end",
    skillDir: "/tmp",
  });

  assert.equal(resolveSkillPrompt(skill, ""), "Args:  end");
});

test("getSkillByName finds skill by name and alias", () => {
  const skills = [
    makeSkill({ name: "code-review", aliases: ["code-review", "cr", "review"] }),
    makeSkill({ name: "commit-helper", aliases: ["commit-helper", "commit"] }),
  ];

  assert.ok(getSkillByName("code-review", skills));
  assert.ok(getSkillByName("cr", skills));
  assert.ok(getSkillByName("review", skills));
  assert.ok(getSkillByName("commit", skills));
  assert.equal(getSkillByName("nonexistent", skills), undefined);
});

test("buildSkillDescriptions groups invocable and auto-only skills", () => {
  const skills = [
    makeSkill({
      name: "commit",
      description: "Create git commits",
      whenToUse: "When the user wants to commit",
    }),
    makeSkill({
      name: "internal-review",
      description: "Internal review process",
      userInvocable: false,
      whenToUse: "Automatically triggered on PR",
    }),
  ];

  const desc = buildSkillDescriptions(skills);
  assert.ok(desc.includes("User-invocable skills"));
  assert.ok(desc.includes("/commit"));
  assert.ok(desc.includes("Create git commits"));
  assert.ok(desc.includes("When the user wants to commit"));
  assert.ok(desc.includes("Auto-invocable skills"));
  assert.ok(desc.includes("internal-review"));
  assert.ok(desc.includes("Automatically triggered on PR"));
  assert.ok(desc.includes("skill"));
  assert.ok(desc.includes("programmatically"));
});

test("buildSkillDescriptions returns empty for empty list", () => {
  assert.equal(buildSkillDescriptions([]), "");
});
