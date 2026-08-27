"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const yaml = require("js-yaml");

const ROOT = path.resolve(__dirname, "..");
const REPOSITORY_SKILLS = [
  "okf-bundle-business",
  "okf-dbexplain",
  "okf-knowledge-publisher",
  "okf-nl2sql",
  "okf-v02-migration",
];
const PORTABLE_SKILLS = ["okf-bundle-business", "okf-dbexplain", "okf-nl2sql"];
const EVALUATED_SKILLS = ["okf-bundle-business", "okf-dbexplain", "okf-nl2sql"];

function readSkill(name) {
  const root = path.join(ROOT, ".agents", "skills", name);
  const text = fs.readFileSync(path.join(root, "SKILL.md"), "utf8");
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, `${name} must have YAML frontmatter`);
  return {
    root,
    text,
    body: text.slice(match[0].length),
    frontmatter: yaml.load(match[1]),
  };
}

test("repository Skills use concise single-line intent descriptions", () => {
  REPOSITORY_SKILLS.forEach((name) => {
    const skill = readSkill(name);
    assert.match(skill.text, /^description: \S[^\n]*$/m, `${name} must use a single-line description`);
    assert.match(skill.frontmatter.description, /^Use this skill when\b/);
    assert.ok(skill.frontmatter.description.length <= 1024, `${name} description exceeds 1024 characters`);
  });
});

test("portable database Skills have concise intent descriptions and no cross-Skill dependency", () => {
  PORTABLE_SKILLS.forEach((name) => {
    const skill = readSkill(name);
    const description = skill.frontmatter.description;
    assert.equal(skill.frontmatter.name, name);
    assert.match(description, /^Use this skill when\b/);
    assert.ok(description.length <= 1024, `${name} description exceeds 1024 characters`);
    assert.ok(skill.body.split("\n").length < 500, `${name} SKILL.md exceeds 500 lines`);

    PORTABLE_SKILLS.filter((candidate) => candidate !== name).forEach((other) => {
      assert.doesNotMatch(skill.text, new RegExp(`\\$?${other}`), `${name} must not depend on ${other}`);
    });
  });
});

test("portable database Skill references are one level deep and directly discoverable", () => {
  PORTABLE_SKILLS.forEach((name) => {
    const skill = readSkill(name);
    const links = Array.from(skill.body.matchAll(/\]\((references\/[^)]+\.md)\)/g), (match) => match[1]);
    assert.ok(links.length > 0, `${name} must directly link its conditional references`);
    assert.equal(new Set(links).size, links.length, `${name} contains duplicate reference links`);

    links.forEach((relative) => {
      const target = path.join(skill.root, relative);
      assert.equal(fs.existsSync(target), true, `${name} reference is missing: ${relative}`);
      const reference = fs.readFileSync(target, "utf8");
      assert.doesNotMatch(reference, /\]\(\.\.\/|\]\(references\//, `${relative} nests another reference`);
    });

    const referenceFiles = fs.readdirSync(path.join(skill.root, "references"))
      .filter((entry) => entry.endsWith(".md"))
      .map((entry) => `references/${entry}`)
      .sort();
    assert.deepEqual(Array.from(new Set(links)).sort(), referenceFiles, `${name} has an undiscoverable reference`);
  });
});

test("portable database Skills ship valid trigger and observable output evals", () => {
  EVALUATED_SKILLS.forEach((name) => {
    const skill = readSkill(name);
    const triggers = JSON.parse(fs.readFileSync(path.join(skill.root, "evals", "trigger-queries.json"), "utf8"));
    const outputs = JSON.parse(fs.readFileSync(path.join(skill.root, "evals", "output-scenarios.json"), "utf8"));

    assert.ok(triggers.length > 0, `${name} must ship at least one trigger eval`);
    assert.equal(new Set(triggers.map((entry) => entry.query)).size, triggers.length, `${name} trigger queries must be unique`);
    triggers.forEach((entry) => {
      assert.ok(["train", "validation"].includes(entry.split), `${name} trigger eval has an invalid split`);
      assert.equal(typeof entry.should_trigger, "boolean", `${name} trigger eval must declare should_trigger`);
      assert.ok(typeof entry.query === "string" && entry.query.trim(), `${name} trigger eval must have a query`);
    });

    if (name === "okf-nl2sql") {
      assert.equal(triggers.length, 1, `${name} must ship one customizable trigger template`);
      assert.equal(triggers[0].should_trigger, true);
      assert.equal(triggers[0].split, "train");
    } else {
      assert.equal(triggers.length, 20, `${name} must ship 20 trigger evals`);
      assert.equal(triggers.filter((entry) => entry.should_trigger === true).length, 10);
      assert.equal(triggers.filter((entry) => entry.should_trigger === false).length, 10);
      assert.equal(triggers.filter((entry) => entry.split === "train").length, 12);
      assert.equal(triggers.filter((entry) => entry.split === "validation").length, 8);
    }

    assert.ok(outputs.length >= 3, `${name} must ship at least three output scenarios`);
    outputs.forEach((entry) => {
      assert.ok(Array.isArray(entry.expected_behavior) && entry.expected_behavior.length > 1);
    });
  });
});
