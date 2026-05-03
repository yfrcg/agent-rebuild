import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { loadBootstrapContext } from "../packages/core/src/bootstrap";
import { discoverSkills, selectSkills } from "../packages/core/src/skills";

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
  const high = {
    name: "high-skill",
    title: "High Skill",
    description: "High priority",
    path: "high",
    relativePath: "high",
    platform: "workspace",
    content: "",
    aliases: ["high-skill", "high"],
    priority: 100,
    conflicts: ["low-skill"],
  };
  const low = {
    name: "low-skill",
    title: "Low Skill",
    description: "Low priority",
    path: "low",
    relativePath: "low",
    platform: "workspace",
    content: "",
    aliases: ["low-skill", "low"],
    priority: 10,
    conflicts: [],
  };

  const result = selectSkills({
    userInput: "$high-skill $low-skill",
    availableSkills: [low, high],
    maxMatches: 3,
  });

  assert.deepEqual(result.selectedSkills.map((skill) => skill.name), ["high-skill"]);
  assert.equal(result.strategy, "explicit");
});
