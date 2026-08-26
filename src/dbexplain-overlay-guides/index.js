"use strict";

const fs = require("fs");
const path = require("path");

const GUIDE_ROOT = __dirname;

function readGuide(relativePath) {
  return fs.readFileSync(path.join(GUIDE_ROOT, relativePath), "utf8");
}

const OVERLAY_CATALOGS = Object.freeze([
  {
    path: "business/index.md",
    directory: "business",
    title: "Business overlay / 业务覆盖层",
    purpose: "Read this index first, then open one matching child. / 先读本索引，再打开一条匹配的子项。",
    children: [
      { href: "terms/", label: "Terms / 术语", detail: "Business words bound to columns. / 业务词到列的绑定。" },
      { href: "datasets/", label: "Datasets / 数据集", detail: "Query fields on one physical table. / 一张物理表上的查询字段。" },
      { href: "relationships/", label: "Relationships / 关系", detail: "How datasets join. / 数据集如何连接。" },
    ],
  },
  {
    path: "business/terms/index.md",
    directory: "business/terms",
    title: "Business terms / 业务术语",
    purpose: "Scan titles here before opening a term file. / 先扫标题，再打开术语文件。",
    children: [],
  },
  {
    path: "business/datasets/index.md",
    directory: "business/datasets",
    title: "Semantic datasets / 语义数据集",
    purpose: "Scan titles here before opening a dataset file. / 先扫标题，再打开数据集文件。",
    children: [],
  },
  {
    path: "business/relationships/index.md",
    directory: "business/relationships",
    title: "Semantic relationships / 语义关系",
    purpose: "Scan titles here before opening a join file. / 先扫标题，再打开关系文件。",
    children: [],
  },
  {
    path: "metrics/index.md",
    directory: "metrics",
    title: "Metrics / 指标",
    purpose: "Scan titles here before opening a measure. / 先扫标题，再打开指标文件。",
    children: [],
  },
  {
    path: "queries/index.md",
    directory: "queries",
    title: "Saved queries / 已知查询",
    purpose: "Scan titles here to reuse known SQL. / 先扫标题，再复用已知 SQL。",
    children: [],
  },
  {
    path: "computations/index.md",
    directory: "computations",
    title: "Computations / 计算",
    purpose: "Scan titles here before opening a computation. / 先扫标题，再打开计算文件。",
    children: [],
  },
  {
    path: "policies/index.md",
    directory: "policies",
    title: "Policies / 策略",
    purpose: "Scan titles here before opening a query rule. / 先扫标题，再打开策略文件。",
    children: [],
  },
  {
    path: "skills/index.md",
    directory: "skills",
    title: "Skills / 技能",
    purpose: "Scan titles here before opening a consumer skill. / 先扫标题，再打开技能文件。",
    children: [],
  },
  {
    path: "attesters/index.md",
    directory: "attesters",
    title: "Attesters / 证明方",
    purpose: "Scan titles here before opening an attester. / 先扫标题，再打开证明方文件。",
    children: [],
  },
  {
    path: "references/index.md",
    directory: "references",
    title: "References / 参考",
    purpose: "Read this index first, then open one matching child. / 先读本索引，再打开一条匹配的子项。",
    children: [
      { href: "enums/", label: "Enumerations / 枚举", detail: "Shared code and label lists. / 共享代码与标签。" },
    ],
  },
  {
    path: "references/enums/index.md",
    directory: "references/enums",
    title: "Enumerations / 枚举",
    purpose: "Scan titles here before opening an enum file. / 先扫标题，再打开枚举文件。",
    children: [],
  },
]);

function overlayScaffoldFiles() {
  return new Map();
}

function legacyOverlayScaffoldFiles() {
  // Keep these bytes unchanged so sync can identify and remove untouched
  // pre-index-only scaffolds without deleting user-edited guides.
  const files = new Map();
  files.set("business/guide.md", readGuide("business/guide.md"));
  files.set("queries/guide.md", readGuide("queries/guide.md"));
  files.set("metrics/guide.md", readGuide("metrics/guide.md"));
  files.set("computations/guide.md", readGuide("computations/guide.md"));
  files.set("policies/guide.md", readGuide("policies/guide.md"));
  files.set("skills/guide.md", readGuide("skills/guide.md"));
  files.set("attesters/guide.md", readGuide("attesters/guide.md"));
  files.set("references/guide.md", readGuide("references/guide.md"));
  return files;
}

module.exports = {
  OVERLAY_CATALOGS,
  legacyOverlayScaffoldFiles,
  overlayScaffoldFiles,
};
