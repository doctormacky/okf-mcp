"use strict";

const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const repositoryRoot = path.resolve(__dirname, "..");
const referenceRoot = path.join(repositoryRoot, "okf", "bundles", "okf-mcp");

function markdownFiles(root) {
  const results = [];
  const walk = (current) => {
    fs.readdirSync(current, { withFileTypes: true }).forEach((entry) => {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(absolutePath);
      }
    });
  };
  walk(root);
  return results.sort();
}

test("published reference repo links resolve to current repository files", () => {
  const missing = [];
  markdownFiles(referenceRoot).forEach((documentPath) => {
    const source = fs.readFileSync(documentPath, "utf8");
    const matches = source.matchAll(/repo:\/\/([A-Za-z0-9_.@/-]+)/g);
    for (const match of matches) {
      const relativePath = decodeURIComponent(match[1]);
      const target = path.resolve(repositoryRoot, ...relativePath.split("/"));
      const relative = path.relative(repositoryRoot, target);
      if (relative.startsWith("..") || path.isAbsolute(relative) || !fs.existsSync(target)) {
        missing.push({
          document: path.relative(repositoryRoot, documentPath),
          target: relativePath,
        });
      }
    }
  });
  assert.deepEqual(missing, []);
});
