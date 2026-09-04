"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { Client } = require("@modelcontextprotocol/client");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/client");

const { buildIndex } = require("../src/indexer");
const { splitFrontmatter } = require("../src/parser");
const { validateIndex } = require("../src/validation");
const { searchConcepts } = require("../src/search");
const { runStreamableHttpServer } = require("../src/mcp-server");
const { callJson, connectMcp } = require("./mcp-client");
const { legacyOverlayScaffoldFiles } = require("../src/dbexplain-overlay-guides");
const {
  DbExplainError,
  applyTableFilter,
  assertSupportedDbExplainVersion,
  buildBundleCandidate,
  checkDbExplain,
  draftDbExplainOverlay,
  inspectDbExplain,
  normalizeSnapshot,
  objectPath,
  refreshDbExplainOverlayIndexes,
  syncDbExplain,
  validateDbExplainBundle,
} = require("../src/dbexplain");

function column(name, type, values) {
  return Object.assign({ name, type, nullable: false }, values || {});
}

function snapshot(options) {
  const config = options || {};
  const tables = [
    {
      name: "users",
      comment: "Application users",
      engine: "postgres",
      row_count: config.usersRows === undefined ? 10 : config.usersRows,
      columns: [
        column("id", "bigint", { is_primary: true }),
        column("name", "text"),
        ...(config.addEmail ? [column("email", "text", { is_unique: true })] : []),
      ],
      indexes: [{ name: "users_pk", columns: ["id"], unique: true, type: "BTREE" }],
    },
    {
      name: "orders",
      engine: "postgres",
      row_count: config.ordersRows === undefined ? 20 : config.ordersRows,
      columns: [
        column("id", "bigint", { is_primary: true }),
        column("user_id", "bigint", { is_index: true }),
        column("status", "smallint", { comment: "状态[1:运行中,2:成功,3:失败]" }),
        column("credential_token", "text", { default: "do-not-publish" }),
      ],
      indexes: [
        { name: "orders_pk", columns: ["id"], unique: true, type: "BTREE" },
        { name: "orders_user", columns: ["user_id"], type: "BTREE" },
      ],
      foreign_keys: [{
        name: config.constraintName || "orders_user_fk",
        columns: ["user_id"],
        ref_table: "users",
        ref_columns: ["id"],
        on_delete: "CASCADE",
      }],
      op_stats: { seq_scan: config.seqScan === undefined ? 2 : config.seqScan, idx_scan: 9 },
    },
  ];
  if (!config.removeAudit) {
    tables.push({
      name: "audit_events",
      engine: "postgres",
      row_count: 5,
      columns: [
        column("id", "bigint", { is_primary: true }),
        column("user_id", "bigint"),
      ],
      indexes: [{ name: "audit_pk", columns: ["id"], unique: true, type: "BTREE" }],
    });
  }
  const refs = [{
    from_instance: "prod-main",
    from_db: "app",
    from_table: "orders",
    from_col: "user_id",
    to_instance: "prod-main",
    to_db: "app",
    to_table: "users",
    to_col: "id",
    inferred: false,
    confidence: 100,
  }];
  if (!config.removeAudit) {
    refs.push({
      from_instance: "prod-main",
      from_db: "app",
      from_table: "audit_events",
      from_col: "user_id",
      to_instance: "prod-main",
      to_db: "app",
      to_table: "users",
      to_col: "id",
      inferred: true,
      confidence: 85,
    });
  }
  return {
    instances: [{
      label: "prod-main",
      kind: "postgres",
      databases: [{ name: "app", table_count: tables.length, tables }],
    }],
    refs,
    groups: [{
      name: "app",
      tables: tables.map((table) => ({ instance: "prod-main", db: "app", table: table.name })),
    }],
    issues: [{ severity: "info", table: "prod-main/app/orders", message: "test diagnostic" }],
    metrics: [{
      label: "prod-main",
      kind: "postgres",
      success: true,
      duration_ms: 5,
      num_databases: 1,
      num_tables: tables.length,
    }],
  };
}

function makeFakeDbExplain(t, initial, options) {
  const fakeOptions = options || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "okf-fake-dbexplain-"));
  const executable = path.join(root, "dbexplain");
  const snapshotPath = path.join(root, "snapshot.json");
  fs.writeFileSync(snapshotPath, JSON.stringify(initial), "utf8");
  fs.writeFileSync(executable, `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write(${JSON.stringify(`${fakeOptions.version || "v0.1.11-test"}\n`)});
  process.exit(0);
}
const operation = args[0];
if (${JSON.stringify(fakeOptions.rejectJson || false)} && args.includes("--json")) {
  process.stderr.write("flag provided but not defined: -json\\nUsage of " + operation + ":\\n");
  process.exit(2);
}
const allowed = {
  list: ["--json", "--log-dir", "--config"],
  check: ["--json", "--label", "--timeout", "--log-dir", "--config"],
  collect: ["--json", "-o", "--context", "--include", "--timeout", "--conn", "--log-dir", "--config"],
}[operation] || [];
for (const arg of args.slice(1)) {
  if (arg.startsWith("-") && !allowed.includes(arg)) {
    process.stderr.write("unsupported fake option: " + arg + "\\n");
    process.exit(2);
  }
}
const snapshot = JSON.parse(fs.readFileSync(process.env.FAKE_DBEXPLAIN_SNAPSHOT, "utf8"));
if (operation === "list") {
  const entries = snapshot.instances.map((instance, index) => ({
    index: index + 1,
    label: instance.label,
    kind: instance.kind,
    hostPort: "redacted.invalid",
    database: instance.databases[0] ? instance.databases[0].name : "(n/a)",
  }));
  process.stdout.write(JSON.stringify({ logDirectory: "redacted", entries }));
  process.exit(0);
}
if (operation === "check") {
  const labelAt = args.indexOf("--label");
  const label = labelAt >= 0 ? args[labelAt + 1] : snapshot.instances[0].label;
  const instance = snapshot.instances.find((entry) => entry.label === label);
  process.stdout.write(JSON.stringify({
    total: 1,
    connected: instance ? 1 : 0,
    failed: instance ? 0 : 1,
    invalid: 0,
    results: [{ label, kind: instance ? instance.kind : "unknown", syntaxOK: true, connOK: Boolean(instance), latency: "1ms" }],
  }));
  process.exit(0);
}
if (operation === "collect") {
  const outputAt = args.indexOf("-o");
  const contextAt = args.indexOf("--context");
  fs.writeFileSync(args[outputAt + 1], JSON.stringify(snapshot), "utf8");
  if (contextAt >= 0) {
    const context = args[contextAt + 1];
    fs.mkdirSync(context, { recursive: true });
    fs.writeFileSync(path.join(context, "summary.json"), JSON.stringify({
      total_tables: snapshot.instances[0].databases[0].tables.length,
      total_instances: snapshot.instances.length,
      core_tables: snapshot.instances.flatMap((instance) => instance.databases.flatMap((database) => database.tables.map((table) => [instance.label, database.name, table.name].join("/")))),
      largest_tables: [],
      highly_connected_tables: [],
    }));
    fs.writeFileSync(path.join(context, "topology.json"), JSON.stringify(snapshot.topology || {
      subgraphs: [{ name: "app", tables: snapshot.instances.flatMap((instance) => instance.databases.flatMap((database) => database.tables.map((table) => [instance.label, database.name, table.name].join("/")))) }],
      isolated_tables: snapshot.isolated_tables || [],
    }));
    fs.writeFileSync(path.join(context, "diagnostics.json"), JSON.stringify(snapshot.diagnostics || {
      missing_pk: [],
      unindexed_fk: [],
      wide_tables: [],
      no_timestamp: [],
    }));
  }
  process.stderr.write("Report written to a protected temporary file\\n");
  process.exit(0);
}
process.stderr.write("unsupported fake operation\\n");
process.exit(2);
`, { encoding: "utf8", mode: 0o755 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    executable,
    snapshotPath,
    update(value) {
      fs.writeFileSync(snapshotPath, JSON.stringify(value), "utf8");
    },
  };
}

function common(fake, bundleRoot, generatedAt) {
  return {
    dbexplainBin: fake.executable,
    bundleRoot,
    generatedAt,
    packageVersion: "0.9.0-test",
    env: Object.assign({}, process.env, { FAKE_DBEXPLAIN_SNAPSHOT: fake.snapshotPath }),
  };
}

function readConcept(root, relativePath) {
  return splitFrontmatter(fs.readFileSync(path.join(root, ...relativePath.split("/")), "utf8"));
}

function statementSha256(sql) {
  return `sha256:${crypto.createHash("sha256").update(String(sql).replace(/\r\n/g, "\n").trim()).digest("hex")}`;
}

test("dbexplain normalization preserves int64 values and stable endpoint relationship identities", () => {
  const raw = JSON.stringify(snapshot({ constraintName: "old_name" }))
    .replace('"row_count":10', '"row_count":9007199254740993');
  const oldModel = normalizeSnapshot(raw, { selectedLabels: ["prod-main"] });
  const renamedModel = normalizeSnapshot(JSON.stringify(snapshot({ constraintName: "new_name" })), { selectedLabels: ["prod-main"] });
  assert.equal(oldModel.tables.find((table) => table.name === "users").rowCount, "9007199254740993");
  assert.equal(oldModel.declaredRelationships[0].path, renamedModel.declaredRelationships[0].path);
  assert.notDeepEqual(oldModel.declaredRelationships[0].constraints, renamedModel.declaredRelationships[0].constraints);
  assert.equal(oldModel.inferredRelationships[0].confidences[0], 85);

  assert.throws(
    () => normalizeSnapshot('{"instances":[],"instances":[]}', {}),
    (error) => error instanceof DbExplainError && error.code === "invalid_dbexplain_json",
  );
});

test("dbexplain requires v0.1.11 while allowing compatible future versions", () => {
  assert.equal(assertSupportedDbExplainVersion("dbexplain v0.1.11").text, "v0.1.11");
  assert.equal(assertSupportedDbExplainVersion("v0.2.0").text, "v0.2.0");
  assert.equal(assertSupportedDbExplainVersion("v1.0.0-beta.1").text, "v1.0.0");
  assert.throws(
    () => assertSupportedDbExplainVersion("v0.1.10"),
    (error) => error instanceof DbExplainError
      && error.code === "unsupported_dbexplain_version"
      && error.details.minimumVersion === "v0.1.11",
  );
});

test("future dbexplain contract drift reports an actionable compatibility issue", (t) => {
  const fake = makeFakeDbExplain(t, snapshot(), { version: "v0.2.0", rejectJson: true });
  assert.throws(
    () => inspectDbExplain({
      dbexplainBin: fake.executable,
      env: Object.assign({}, process.env, { FAKE_DBEXPLAIN_SNAPSHOT: fake.snapshotPath }),
    }),
    (error) => error instanceof DbExplainError
      && error.code === "unsupported_dbexplain_contract"
      && error.details.detectedVersion === "v0.2.0"
      && /github\.com\/doctormacky\/okf-mcp\/issues/.test(error.details.issueUrl),
  );
});

test("dbexplain sync applies reviewed structure, refreshes observations, and deprecates removed objects", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "okf-dbexplain-sync-test-"));
  const bundleRoot = path.join(root, "database-bundle");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fake = makeFakeDbExplain(t, snapshot());
  const sourceConfig = {
    dbexplainBin: fake.executable,
    env: Object.assign({}, process.env, { FAKE_DBEXPLAIN_SNAPSHOT: fake.snapshotPath }),
  };
  const inspected = inspectDbExplain(sourceConfig);
  assert.deepEqual(inspected.selectedSources, [{ label: "prod-main", kind: "postgres", database: "app" }]);
  assert.deepEqual(inspected.supportedKinds, ["gaussdb", "mysql", "oracle", "postgres", "sqlite"]);
  assert.equal(checkDbExplain(sourceConfig).valid, true);

  const firstConfig = common(fake, bundleRoot, "2026-08-25T09:00:00Z");
  const preview = syncDbExplain(Object.assign({}, firstConfig, { dryRun: true }));
  assert.equal(preview.applied, false);
  assert.equal(fs.existsSync(bundleRoot), false);
  assert.equal(preview.counts.tables, 3);
  assert.equal(preview.counts.columns, 8);
  assert.equal(preview.counts.declaredRelationships, 1);
  assert.equal(preview.counts.queryableDeclaredRelationships, 1);
  assert.equal(preview.counts.inferredRelationships, 1);
  assert.equal(preview.counts.semanticOverlays, 0);
  assert.equal(preview.counts.overlaySeeded > 0, true);
  assert.equal(preview.counts.overlayPreserved, 0);

  const applied = syncDbExplain(Object.assign({}, firstConfig, { expectPlan: preview.planDigest }));
  assert.equal(applied.applied, true);
  const validation = validateIndex(buildIndex([{ id: "database", root: bundleRoot }], { strictLinks: true }));
  assert.equal(validation.validForProject, true);
  assert.equal(fs.existsSync(path.join(bundleRoot, "databases", "prod-main", "index.md")), true);
  assert.equal(fs.existsSync(path.join(bundleRoot, "tables", "prod-main", "index.md")), true);
  assert.equal(fs.existsSync(path.join(bundleRoot, "tables", "prod-main", "app", "index.md")), true);
  assert.equal(fs.existsSync(path.join(bundleRoot, "observations", "tables", "prod-main", "app", "index.md")), true);
  assert.doesNotMatch(fs.readFileSync(path.join(bundleRoot, "tables", "index.md"), "utf8"), /orders\.md/);

  const initialModel = normalizeSnapshot(JSON.stringify(snapshot()), { selectedLabels: ["prod-main"] });
  const users = initialModel.tables.find((table) => table.name === "users");
  const orders = initialModel.tables.find((table) => table.name === "orders");
  const audit = initialModel.tables.find((table) => table.name === "audit_events");
  const declared = initialModel.declaredRelationships[0];
  const inferred = initialModel.inferredRelationships[0];
  const usersConcept = readConcept(bundleRoot, users.path);
  const inferredConcept = readConcept(bundleRoot, inferred.path);
  assert.equal(usersConcept.frontmatter.generated.at, "2026-08-25T09:00:00Z");
  assert.equal(usersConcept.frontmatter.description, "Application users");
  assert.match(usersConcept.body, /Row identity: `id`/);
  assert.match(usersConcept.body, /`id`.*PK/);
  assert.equal(inferredConcept.frontmatter.status, "draft");
  assert.equal(inferredConcept.frontmatter.dbexplain.evidence, "inferred_ref");
  assert.equal(inferredConcept.frontmatter.dbexplain.confidence, 85);
  assert.equal(inferredConcept.frontmatter.dbexplain.join_binding.executable, false);
  assert.equal(users.path, "tables/prod-main/app/users.md");
  assert.equal(orders.path, "tables/prod-main/app/orders.md");
  assert.equal(declared.path, "relationships/declared/orders__users.md");
  assert.equal(inferred.path, "relationships/inferred/audit_events__users.md");
  const ordersText = fs.readFileSync(path.join(bundleRoot, orders.path), "utf8");
  assert.match(ordersText, /urn:database:prod-main:app:table:orders/);
  assert.match(ordersText, /Executable source: `"public"\."orders"`/);
  assert.match(ordersText, /Logical type/);
  assert.match(ordersText, /# Joins/);
  assert.doesNotMatch(ordersText, /do-not-publish/);
  const ordersConcept = readConcept(bundleRoot, orders.path);
  assert.equal(ordersConcept.frontmatter.dbexplain.sql_binding.version, 2);
  assert.equal(ordersConcept.frontmatter.dbexplain.sql_binding.dialect, "postgres");
  assert.equal(ordersConcept.frontmatter.dbexplain.sql_binding.source_sql, '"public"."orders"');
  assert.equal(ordersConcept.frontmatter.dbexplain.sql_binding.columns.find((entry) => entry.name === "user_id").sql_reference_template, '{{alias}}."user_id"');
  assert.equal(ordersConcept.frontmatter.dbexplain.sql_binding.columns.find((entry) => entry.name === "status").comment, "状态[1:运行中,2:成功,3:失败]");
  assert.match(ordersConcept.body, /状态\[1:运行中,2:成功,3:失败\]/);
  const declaredConcept = readConcept(bundleRoot, declared.path);
  assert.equal(declaredConcept.frontmatter.dbexplain.join_binding.cardinality, "many-to-one");
  assert.equal(declaredConcept.frontmatter.dbexplain.join_binding.executable, true);
  assert.equal(declaredConcept.frontmatter.dbexplain.join_binding.predicate_template, 'ON {{from}}."user_id" = {{to}}."id"');
  assert.match(declaredConcept.body, /# Join Template/);
  const generatedIndex = buildIndex([{ id: "database", root: bundleRoot }], { strictLinks: true });
  assert.equal(generatedIndex.edges.some((edge) => (
    edge.source === `okf://database/${orders.path.replace(/\.md$/, "")}`
      && edge.kind === "source"
      && edge.target === "okf://database/bundle"
      && !edge.broken
  )), true);
  assert.equal(generatedIndex.edges.some((edge) => (
    edge.source === "okf://database/databases/prod-main/app"
      && edge.kind === "markdown_link"
      && edge.target === "okf://database/tables/prod-main/app/index.md"
      && !edge.broken
  )), true);

  fake.update(snapshot({ usersRows: 100, seqScan: 10 }));
  const observationConfig = common(fake, bundleRoot, "2026-08-26T09:00:00Z");
  const observationPreview = syncDbExplain(Object.assign({}, observationConfig, { dryRun: true }));
  fake.update(snapshot({ usersRows: 101, seqScan: 11 }));
  const observationApply = syncDbExplain(Object.assign({}, observationConfig, { expectPlan: observationPreview.planDigest }));
  assert.equal(observationApply.applied, true);
  assert.equal(readConcept(bundleRoot, users.path).frontmatter.generated.at, "2026-08-25T09:00:00Z");
  assert.equal(readConcept(bundleRoot, "observations/current.md").frontmatter.generated.at, "2026-08-26T09:00:00Z");
  const currentObservation = readConcept(bundleRoot, "observations/current.md");
  assert.match(currentObservation.body, /# dbexplain Core Tables/);
  assert.match(currentObservation.body, /# Table Clusters/);
  assert.match(currentObservation.body, /# Topology Subgraphs/);
  assert.ok(Array.isArray(currentObservation.frontmatter.dbexplain.core_table_paths));
  assert.ok(currentObservation.frontmatter.dbexplain.core_table_paths.length > 0);

  fake.update(snapshot({ removeAudit: true, usersRows: 101 }));
  const removalConfig = common(fake, bundleRoot, "2026-08-27T09:00:00Z");
  const removalPreview = syncDbExplain(Object.assign({}, removalConfig, { dryRun: true }));
  assert.equal(removalPreview.changes.deprecated.includes(audit.path), true);
  assert.equal(removalPreview.changes.deprecated.includes(inferred.path), true);
  const removalApply = syncDbExplain(Object.assign({}, removalConfig, { expectPlan: removalPreview.planDigest }));
  assert.equal(removalApply.applied, true);
  assert.equal(readConcept(bundleRoot, audit.path).frontmatter.status, "deprecated");
  assert.equal(readConcept(bundleRoot, inferred.path).frontmatter.status, "deprecated");
  assert.equal(readConcept(bundleRoot, declared.path).frontmatter.status, "stable");

  const beforeStructureDrift = fs.readFileSync(path.join(bundleRoot, users.path), "utf8");
  const driftConfig = common(fake, bundleRoot, "2026-08-28T09:00:00Z");
  const driftPreview = syncDbExplain(Object.assign({}, driftConfig, { dryRun: true }));
  fake.update(snapshot({ removeAudit: true, usersRows: 101, addEmail: true }));
  const driftApply = syncDbExplain(Object.assign({}, driftConfig, { expectPlan: driftPreview.planDigest }));
  assert.equal(driftApply.applied, false);
  assert.equal(driftApply.planChanged, true);
  assert.equal(fs.readFileSync(path.join(bundleRoot, users.path), "utf8"), beforeStructureDrift);
});

test("dbexplain sync rejects failed collection metrics before touching the Bundle", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "okf-dbexplain-failed-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const failed = snapshot();
  failed.metrics.push({ label: "broken", kind: "postgres", success: false, num_databases: 0, num_tables: 0 });
  const fake = makeFakeDbExplain(t, failed);
  assert.throws(
    () => syncDbExplain(Object.assign({}, common(fake, path.join(root, "bundle"), "2026-08-25T09:00:00Z"), { dryRun: true })),
    (error) => error instanceof DbExplainError && error.code === "incomplete_dbexplain_collection",
  );
  assert.equal(fs.existsSync(path.join(root, "bundle")), false);
});

test("generated SQL and join bindings are returned intact through OKF MCP", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "okf-dbexplain-mcp-test-"));
  const bundleRoot = path.join(root, "database-bundle");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fake = makeFakeDbExplain(t, snapshot());
  const config = common(fake, bundleRoot, "2026-08-25T09:00:00Z");
  const preview = syncDbExplain(Object.assign({}, config, { dryRun: true }));
  assert.equal(syncDbExplain(Object.assign({}, config, { expectPlan: preview.planDigest })).applied, true);

  const { client } = await connectMcp(t, [`database=${bundleRoot}`]);
  const search = await callJson(client, "search_concepts", {
    query: "orders",
    types: ["Database Table"],
  });
  assert.equal(search.payload.results.some((entry) => entry.uri === "okf://database/tables/prod-main/app/orders"), true);
  const tableCommentSearch = await callJson(client, "search_concepts", {
    query: "Application users",
    types: ["Database Table"],
  });
  assert.equal(tableCommentSearch.payload.results.some((entry) => entry.uri === "okf://database/tables/prod-main/app/users"), true);
  const columnCommentSearch = await callJson(client, "search_concepts", {
    query: "状态",
    types: ["Database Table"],
  });
  assert.equal(columnCommentSearch.payload.results.some((entry) => entry.uri === "okf://database/tables/prod-main/app/orders"), true);

  const table = await callJson(client, "get_concept", {
    uri: "okf://database/tables/prod-main/app/orders",
  });
  assert.equal(table.payload.frontmatter.dbexplain.sql_binding.source_sql, '"public"."orders"');
  assert.equal(table.payload.frontmatter.dbexplain.sql_binding.columns.find((entry) => entry.name === "user_id").sql_identifier, '"user_id"');
  assert.equal(table.payload.frontmatter.dbexplain.sql_binding.columns.find((entry) => entry.name === "status").comment, "状态[1:运行中,2:成功,3:失败]");

  const relationship = await callJson(client, "get_concept", {
    uri: "okf://database/relationships/declared/orders__users",
  });
  assert.equal(relationship.payload.frontmatter.dbexplain.join_binding.executable, true);
  assert.equal(relationship.payload.frontmatter.dbexplain.join_binding.predicate_template, 'ON {{from}}."user_id" = {{to}}."id"');
});

test("stable table and relationship paths prefer readable names", () => {
  const first = { instance: "prod-main", database: "app", table: "Users" };
  const second = { instance: "prod-main", database: "app", table: "users" };
  assert.equal(objectPath("table", { instance: "prod-main", database: "app", table: "orders" }), "tables/prod-main/app/orders.md");
  assert.equal(objectPath("database", { instance: "prod-main", database: "app" }), "databases/prod-main/app.md");
  assert.notEqual(objectPath("table", first), objectPath("table", second));
});

// Returns an equivalent snapshot with every semantically unordered collection
// reordered: instances, databases, tables, indexes, foreign keys, refs,
// groups, and issues. Physical column order and composite index/FK column
// order are preserved.
function reorderCollections(value) {
  const cloned = JSON.parse(JSON.stringify(value));
  cloned.refs.reverse();
  cloned.groups.forEach((group) => group.tables.reverse());
  cloned.groups.reverse();
  cloned.issues.reverse();
  cloned.instances.reverse();
  cloned.instances.forEach((instance) => {
    instance.databases.reverse();
    instance.databases.forEach((database) => {
      database.tables.reverse();
      database.tables.forEach((table) => {
        if (table.indexes) table.indexes.reverse();
        if (table.foreign_keys) table.foreign_keys.reverse();
      });
    });
  });
  return cloned;
}

function snapshotWithCompositeIndex() {
  const value = snapshot();
  const orders = value.instances[0].databases[0].tables.find((table) => table.name === "orders");
  orders.indexes.push({ name: "orders_user_id_composite", columns: ["user_id", "id"], type: "BTREE" });
  return value;
}

test("structuralDigest is stable for an empty target when unordered collections are reordered", (t) => {
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), "okf-dbexplain-digest-a-"));
  const rootB = fs.mkdtempSync(path.join(os.tmpdir(), "okf-dbexplain-digest-b-"));
  t.after(() => {
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  });
  const base = snapshotWithCompositeIndex();
  const reordered = reorderCollections(base);
  const labels = ["prod-main"];
  const contextA = { summary: { core_tables: ["prod-main/app/users", "prod-main/app/orders"] }, topology: null };
  const contextB = { summary: { core_tables: ["prod-main/app/orders", "prod-main/app/users"] }, topology: null };
  const captureFor = (value, context) => ({
    dbexplainVersion: "v0.1.11-test",
    selectedSources: [{ label: "prod-main", kind: "postgres" }],
    rawInputSha256: "sha256:test-input",
    model: normalizeSnapshot(JSON.stringify(value), { selectedLabels: labels }),
    context,
  });

  const model = captureFor(base, contextA).model;
  const ordersModel = model.tables.find((table) => table.name === "orders");
  // Physical column order is preserved even though other collections sort.
  assert.deepEqual(model.tables.find((table) => table.name === "users").columns.map((entry) => entry.name), ["id", "name"]);
  // Indexes canonicalize by name; composite column order stays physical.
  assert.deepEqual(ordersModel.indexes.map((entry) => entry.name), [...ordersModel.indexes.map((entry) => entry.name)].sort());
  const composite = ordersModel.indexes.find((entry) => entry.name === "orders_user_id_composite");
  assert.deepEqual(composite.columns, ["user_id", "id"]);

  const generatedAt = "2026-08-25T09:00:00Z";
  const candidateA = buildBundleCandidate(captureFor(base, contextA), rootA, generatedAt, "0.9.0-test");
  const candidateB = buildBundleCandidate(captureFor(reordered, contextB), rootB, generatedAt, "0.9.0-test");
  assert.equal(candidateB.structuralDigest, candidateA.structuralDigest);
  assert.equal(candidateB.observationDigest, candidateA.observationDigest);
  const ordersText = candidateA.files.get(ordersModel.path);
  assert.match(ordersText, /`user_id`, `id`/);

  // A different generatedAt changes planDigest even when structure is
  // identical. For an empty target the structural manifest legitimately embeds
  // generated.at, so only planDigest binding is asserted here.
  const candidateC = buildBundleCandidate(captureFor(base, contextA), rootA, "2026-08-25T09:00:01Z", "0.9.0-test");
  assert.notEqual(candidateC.planDigest, candidateA.planDigest);
});

test("dbexplain sync keeps structuralDigest stable across reordered collections and still applies updates", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "okf-dbexplain-reorder-sync-"));
  const bundleRoot = path.join(root, "database-bundle");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = snapshotWithCompositeIndex();
  const fake = makeFakeDbExplain(t, reorderCollections(base));
  const config = (generatedAt) => common(fake, bundleRoot, generatedAt);

  // Initial create from a reordered snapshot.
  const firstPreview = syncDbExplain(Object.assign({}, config("2026-08-25T09:00:00Z"), { dryRun: true }));
  const firstApply = syncDbExplain(Object.assign({}, config("2026-08-25T09:00:00Z"), { expectPlan: firstPreview.planDigest }));
  assert.equal(firstApply.applied, true);
  const validation = validateIndex(buildIndex([{ id: "database-reorder", root: bundleRoot }], { strictLinks: true }));
  assert.equal(validation.validForProject, true);

  // Equivalent incremental run with reordered collections reorders core_tables
  // too (the fake derives them from table order): no structural drift.
  fake.update(base);
  const secondPreview = syncDbExplain(Object.assign({}, config("2026-08-26T09:00:00Z"), { dryRun: true }));
  assert.equal(secondPreview.structuralDigest, firstPreview.structuralDigest);
  assert.equal(secondPreview.changes.added.length, 0);
  assert.equal(secondPreview.changes.updated.length, 0);
  assert.equal(secondPreview.changes.deprecated.length, 0);
  const secondApply = syncDbExplain(Object.assign({}, config("2026-08-26T09:00:00Z"), { expectPlan: secondPreview.planDigest }));
  assert.equal(secondApply.applied, true);
});

test("dbexplain sync preserves overlay business concepts and rejects unmanaged files", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "okf-dbexplain-overlay-"));
  const bundleRoot = path.join(root, "database-bundle");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fake = makeFakeDbExplain(t, snapshot());
  const firstConfig = common(fake, bundleRoot, "2026-08-25T09:00:00Z");
  const preview = syncDbExplain(Object.assign({}, firstConfig, { dryRun: true }));
  assert.equal(syncDbExplain(Object.assign({}, firstConfig, { expectPlan: preview.planDigest })).applied, true);

  const overlayPath = path.join(bundleRoot, "business", "terms", "order.md");
  fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
  const overlayText = [
    "---",
    "type: Business Term",
    "title: Order",
    "description: A customer purchase.",
    "aliases: [purchase, sales order]",
    "---",
    "",
    "Bind this term to [orders](/tables/prod-main/app/orders.md).",
    "",
  ].join("\n");
  fs.writeFileSync(overlayPath, overlayText, "utf8");

  fake.update(snapshot({ usersRows: 100, seqScan: 10 }));
  const observationConfig = common(fake, bundleRoot, "2026-08-26T09:00:00Z");
  const observationPreview = syncDbExplain(Object.assign({}, observationConfig, { dryRun: true }));
  assert.equal(observationPreview.structuralDigest, preview.structuralDigest);
  const observationApply = syncDbExplain(Object.assign({}, observationConfig, { expectPlan: observationPreview.planDigest }));
  assert.equal(observationApply.applied, true);
  assert.equal(fs.readFileSync(overlayPath, "utf8"), overlayText);
  const overlayValidation = validateIndex(buildIndex([{ id: "database-overlay", root: bundleRoot }], { strictLinks: true }));
  assert.equal(overlayValidation.validForProject, true);

  fs.writeFileSync(path.join(bundleRoot, "stray.md"), "---\ntype: Note\ntitle: Stray\n---\n\nUnmanaged.\n", "utf8");
  assert.throws(
    () => syncDbExplain(Object.assign({}, common(fake, bundleRoot, "2026-08-27T09:00:00Z"), { dryRun: true })),
    (error) => error instanceof DbExplainError && error.code === "unmanaged_bundle_content",
  );
});

test("semantic overlays bind terms, datasets, relationships, and Metrics to active physical contracts", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "okf-dbexplain-semantic-test-"));
  const bundleRoot = path.join(root, "database-bundle");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fake = makeFakeDbExplain(t, snapshot());
  const firstConfig = common(fake, bundleRoot, "2026-08-25T09:00:00Z");
  const preview = syncDbExplain(Object.assign({}, firstConfig, { dryRun: true }));
  assert.equal(syncDbExplain(Object.assign({}, firstConfig, { expectPlan: preview.planDigest })).applied, true);

  const writeOverlay = (relativePath, frontmatter, body) => {
    const target = path.join(bundleRoot, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, ["---", ...frontmatter, "---", "", body || "", ""].join("\n"), "utf8");
  };
  writeOverlay("business/datasets/orders.md", [
    "type: Semantic Dataset",
    "title: Orders",
    "aliases: [purchases]",
    "relations:",
    "  - type: depends_on",
    "    target: /tables/prod-main/app/orders.md",
    "    label: physical_table",
    "semantic:",
    "  profile: dbexplain-okf-v1",
    "  kind: dataset",
    "  physical_table: /tables/prod-main/app/orders.md",
    "  fields:",
    "    - name: order_id",
    "      column: id",
    "    - name: customer_id",
    "      column: user_id",
  ], "# Orders\n\n[Physical table](/tables/prod-main/app/orders.md)\n\norder_id id customer_id user_id");
  writeOverlay("business/datasets/users.md", [
    "type: Semantic Dataset",
    "title: Users",
    "relations:",
    "  - type: depends_on",
    "    target: /tables/prod-main/app/users.md",
    "    label: physical_table",
    "semantic:",
    "  profile: dbexplain-okf-v1",
    "  kind: dataset",
    "  physical_table: /tables/prod-main/app/users.md",
    "  fields:",
    "    - name: user_id",
    "      column: id",
  ], "# Users\n\n[Physical table](/tables/prod-main/app/users.md)\n\nuser_id id");
  writeOverlay("business/terms/customer.md", [
    "type: Business Term",
    "title: Customer",
    "aliases: [buyer, purchaser]",
    "relations:",
    "  - type: related_to",
    "    target: /tables/prod-main/app/orders.md",
    "    label: 'binding:user_id'",
    "semantic:",
    "  profile: dbexplain-okf-v1",
    "  kind: term",
    "  bindings:",
    "    - table: /tables/prod-main/app/orders.md",
    "      column: user_id",
  ], "# Customer\n\n[Orders table](/tables/prod-main/app/orders.md)");
  writeOverlay("business/relationships/orders-to-users.md", [
    "type: Semantic Relationship",
    "title: Order customer",
    "relations:",
    "  - type: depends_on",
    "    target: /business/datasets/orders.md",
    "    label: from_dataset",
    "  - type: depends_on",
    "    target: /business/datasets/users.md",
    "    label: to_dataset",
    "  - type: depends_on",
    "    target: /relationships/declared/orders__users.md",
    "    label: physical_relationship",
    "semantic:",
    "  profile: dbexplain-okf-v1",
    "  kind: relationship",
    "  physical_relationship: /relationships/declared/orders__users.md",
    "  from_dataset: /business/datasets/orders.md",
    "  to_dataset: /business/datasets/users.md",
  ], "# Order customer\n\n[Orders](/business/datasets/orders.md) [Users](/business/datasets/users.md) [FK](/relationships/declared/orders__users.md)");
  writeOverlay("metrics/order-count.md", [
    "type: Metric",
    "title: Order Count",
    "aliases: [number of orders]",
    "relations:",
    "  - type: depends_on",
    "    target: /tables/prod-main/app/orders.md",
    "    label: base_table",
    "  - type: depends_on",
    "    target: /relationships/declared/orders__users.md",
    "    label: required_relationship",
    "semantic:",
    "  profile: dbexplain-okf-v1",
    "  kind: metric",
    "  base_table: /tables/prod-main/app/orders.md",
    "  expressions:",
    "    postgres: COUNT({{orders.id}})",
    "  required_relationships:",
    "    - /relationships/declared/orders__users.md",
  ], "# Order Count\n\n[Orders](/tables/prod-main/app/orders.md) [Order user FK](/relationships/declared/orders__users.md)\n\npostgres COUNT({{orders.id}})");

  const semanticConfig = common(fake, bundleRoot, "2026-08-26T09:00:00Z");
  const semanticPreview = syncDbExplain(Object.assign({}, semanticConfig, { dryRun: true }));
  assert.equal(semanticPreview.counts.semanticOverlays, 5);
  assert.equal(semanticPreview.validation.semanticOverlays, 5);

  writeOverlay("business/terms/customer.md", [
    "type: Business Term",
    "title: Customer",
    "relations:",
    "  - type: related_to",
    "    target: /tables/prod-main/app/orders.md",
    "    label: 'binding:missing_customer_id'",
    "semantic:",
    "  profile: dbexplain-okf-v1",
    "  kind: term",
    "  bindings:",
    "    - table: /tables/prod-main/app/orders.md",
    "      column: missing_customer_id",
  ], "# Customer\n\n[Orders table](/tables/prod-main/app/orders.md)");
  assert.throws(
    () => syncDbExplain(Object.assign({}, semanticConfig, { dryRun: true })),
    (error) => error instanceof DbExplainError
      && error.code === "invalid_semantic_overlay"
      && error.details.field === "semantic.bindings[0].column",
  );
});

test("dbexplain sync keeps templates out of search and removes only untouched legacy guides", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "okf-dbexplain-overlay-guides-"));
  const bundleRoot = path.join(root, "database-bundle");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fake = makeFakeDbExplain(t, snapshot());
  const firstConfig = common(fake, bundleRoot, "2026-08-25T09:00:00Z");
  const preview = syncDbExplain(Object.assign({}, firstConfig, { dryRun: true }));
  assert.equal(syncDbExplain(Object.assign({}, firstConfig, { expectPlan: preview.planDigest })).applied, true);

  const overlayRoots = [
    "business",
    "metrics",
    "queries",
    "computations",
    "policies",
    "skills",
    "attesters",
    "references",
  ];
  overlayRoots.forEach((folder) => {
    const guidePath = path.join(bundleRoot, folder, "guide.md");
    const indexPath = path.join(bundleRoot, folder, "index.md");
    assert.equal(fs.existsSync(guidePath), false, `${folder}/guide.md`);
    assert.equal(fs.existsSync(indexPath), true, `${folder}/index.md`);
    const index = fs.readFileSync(indexPath, "utf8");
    assert.equal(index.startsWith("# "), true);
    assert.doesNotMatch(index, /^---/m);
    assert.match(index, /\]\(\/index\.md\)/);
  });
  assert.equal(fs.existsSync(path.join(bundleRoot, "metrics", "order-count.md")), false);
  const rootIndex = fs.readFileSync(path.join(bundleRoot, "index.md"), "utf8");
  assert.match(rootIndex, /\]\(queries\/\)/);
  const validation = validateIndex(buildIndex([{ id: "database-guides", root: bundleRoot }], { strictLinks: true }));
  assert.equal(validation.validForProject, true);

  fs.mkdirSync(path.join(bundleRoot, "business", "terms"), { recursive: true });
  fs.writeFileSync(path.join(bundleRoot, "business", "terms", "customer.md"), [
    "---",
    "type: Business Term",
    "title: Customer",
    "description: A buyer.",
    "---",
    "",
    "# Customer",
    "",
  ].join("\n"), "utf8");
  const legacy = legacyOverlayScaffoldFiles();
  const queriesGuide = path.join(bundleRoot, "queries", "guide.md");
  const businessGuide = path.join(bundleRoot, "business", "guide.md");
  fs.writeFileSync(queriesGuide, legacy.get("queries/guide.md"), "utf8");
  const edited = `${legacy.get("business/guide.md")}\n<!-- user note -->\n`;
  fs.writeFileSync(businessGuide, edited, "utf8");
  const secondConfig = common(fake, bundleRoot, "2026-08-26T09:00:00Z");
  const secondPreview = syncDbExplain(Object.assign({}, secondConfig, { dryRun: true }));
  assert.deepEqual(secondPreview.catalogChanges.scaffoldsRemoved, ["queries/guide.md"]);
  assert.equal(syncDbExplain(Object.assign({}, secondConfig, { expectPlan: secondPreview.planDigest })).applied, true);
  assert.equal(fs.existsSync(queriesGuide), false);
  assert.equal(fs.readFileSync(businessGuide, "utf8"), edited);
  const termsIndex = fs.readFileSync(path.join(bundleRoot, "business", "terms", "index.md"), "utf8");
  assert.match(termsIndex, /\]\(customer\.md\)/);
  assert.match(termsIndex, /Customer/);
});

test("semantic overlay joins, enums, and saved queries bind without inventing SQL", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "okf-dbexplain-overlay-join-"));
  const bundleRoot = path.join(root, "database-bundle");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fake = makeFakeDbExplain(t, snapshot());
  const firstConfig = common(fake, bundleRoot, "2026-08-25T09:00:00Z");
  const preview = syncDbExplain(Object.assign({}, firstConfig, { dryRun: true }));
  assert.equal(syncDbExplain(Object.assign({}, firstConfig, { expectPlan: preview.planDigest })).applied, true);

  const writeOverlay = (relativePath, frontmatter, body) => {
    const target = path.join(bundleRoot, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, ["---", ...frontmatter, "---", "", body || "", ""].join("\n"), "utf8");
  };
  writeOverlay("business/datasets/orders.md", [
    "type: Semantic Dataset",
    "title: Orders",
    "relations:",
    "  - type: depends_on",
    "    target: /tables/prod-main/app/orders.md",
    "    label: physical_table",
    "semantic:",
    "  profile: dbexplain-okf-v1",
    "  kind: dataset",
    "  physical_table: /tables/prod-main/app/orders.md",
    "  fields:",
    "    - name: order_id",
    "      column: id",
    "    - name: status",
    "      column: credential_token",
    "      enum:",
    "        values:",
    "          - code: open",
    "            labels:",
    "              en: Open",
    "              zh: 未关闭",
  ], "# Orders\n\n[Physical table](/tables/prod-main/app/orders.md)\n\norder_id id status credential_token open Open 未关闭");
  writeOverlay("business/datasets/users.md", [
    "type: Semantic Dataset",
    "title: Users",
    "relations:",
    "  - type: depends_on",
    "    target: /tables/prod-main/app/users.md",
    "    label: physical_table",
    "semantic:",
    "  profile: dbexplain-okf-v1",
    "  kind: dataset",
    "  physical_table: /tables/prod-main/app/users.md",
    "  fields:",
    "    - name: user_id",
    "      column: id",
  ], "# Users\n\n[Physical table](/tables/prod-main/app/users.md)\n\nuser_id id");
  writeOverlay("business/relationships/audit-to-users.md", [
    "type: Semantic Relationship",
    "title: Audit user",
    "status: draft",
    "relations:",
    "  - type: depends_on",
    "    target: /business/datasets/orders.md",
    "    label: from_dataset",
    "  - type: depends_on",
    "    target: /business/datasets/users.md",
    "    label: to_dataset",
    "  - type: depends_on",
    "    target: /tables/prod-main/app/orders.md",
    "    label: join_from_table",
    "  - type: depends_on",
    "    target: /tables/prod-main/app/users.md",
    "    label: join_to_table",
    "semantic:",
    "  profile: dbexplain-okf-v1",
    "  kind: relationship",
    "  from_dataset: /business/datasets/orders.md",
    "  to_dataset: /business/datasets/users.md",
    "  join:",
    "    cardinality: many-to-one",
    "    predicate_template: 'ON {{from}}.user_id = {{to}}.id'",
    "    from:",
    "      table: /tables/prod-main/app/orders.md",
    "      columns:",
    "        - user_id",
    "    to:",
    "      table: /tables/prod-main/app/users.md",
    "      columns:",
    "        - id",
  ], "# Audit user\n\n[Orders dataset](/business/datasets/orders.md) [Users dataset](/business/datasets/users.md) [Orders table](/tables/prod-main/app/orders.md) [Users table](/tables/prod-main/app/users.md)");
  writeOverlay("queries/open-orders.md", [
    "type: Saved Query",
    "title: Open orders",
    "status: draft",
    "relations:",
    "  - type: depends_on",
    "    target: /tables/prod-main/app/orders.md",
    "    label: query_table",
    "verified:",
    "  by: process:dbexplain",
    "  at: '2026-08-26T09:00:00Z'",
    "  method: dbexplain_execute",
    `  statement_sha256: ${statementSha256("SELECT id FROM public.orders")}`,
    "  instance_label: prod-main",
    "semantic:",
    "  profile: dbexplain-okf-v1",
    "  kind: query",
    "  dialect: postgres",
    "  tables:",
    "    - /tables/prod-main/app/orders.md",
  ], "# Open orders\n\n[Orders table](/tables/prod-main/app/orders.md)\n\n```sql\nSELECT id FROM public.orders\n```\n");
  writeOverlay("references/enums/open-flag.md", [
    "type: Enumeration",
    "title: Open flag",
    "status: draft",
    "semantic:",
    "  profile: dbexplain-okf-v1",
    "  kind: enumeration",
    "  values:",
    "    - code: open",
    "      labels:",
    "        en: Open",
    "        zh: 未关闭",
  ], "# Open flag\n\nopen Open 未关闭");

  const semanticConfig = common(fake, bundleRoot, "2026-08-26T09:00:00Z");
  const semanticPreview = syncDbExplain(Object.assign({}, semanticConfig, { dryRun: true }));
  assert.equal(semanticPreview.counts.semanticOverlays, 5);

  writeOverlay("business/relationships/audit-to-users.md", [
    "type: Semantic Relationship",
    "title: Audit user",
    "relations:",
    "  - type: depends_on",
    "    target: /business/datasets/orders.md",
    "    label: from_dataset",
    "  - type: depends_on",
    "    target: /business/datasets/users.md",
    "    label: to_dataset",
    "  - type: depends_on",
    "    target: /relationships/declared/orders__users.md",
    "    label: physical_relationship",
    "semantic:",
    "  profile: dbexplain-okf-v1",
    "  kind: relationship",
    "  physical_relationship: /relationships/declared/orders__users.md",
    "  from_dataset: /business/datasets/orders.md",
    "  to_dataset: /business/datasets/users.md",
    "  join:",
    "    from:",
    "      table: /tables/prod-main/app/orders.md",
    "      columns:",
    "        - user_id",
    "    to:",
    "      table: /tables/prod-main/app/users.md",
    "      columns:",
    "        - id",
    "    predicate_template: 'ON {{from}}.user_id = {{to}}.id'",
  ], "# Mixed\n\n[Orders](/business/datasets/orders.md) [Users](/business/datasets/users.md) [FK](/relationships/declared/orders__users.md)");
  assert.throws(
    () => syncDbExplain(Object.assign({}, semanticConfig, { dryRun: true })),
    (error) => error instanceof DbExplainError
      && error.code === "invalid_semantic_overlay"
      && error.details.field === "semantic",
  );
});

test("case-colliding table names receive identity digests only after path collision", () => {
  const colliding = snapshot();
  colliding.instances[0].databases[0].tables.push({
    name: "Users",
    engine: "postgres",
    row_count: 1,
    columns: [column("id", "bigint", { is_primary: true })],
    indexes: [{ name: "Users_pk", columns: ["id"], unique: true, type: "BTREE" }],
  });
  colliding.instances[0].databases[0].table_count = colliding.instances[0].databases[0].tables.length;
  colliding.metrics[0].num_tables = colliding.instances[0].databases[0].tables.length;
  const model = normalizeSnapshot(JSON.stringify(colliding), { selectedLabels: ["prod-main"] });
  const lower = model.tables.find((table) => table.name === "users");
  const upper = model.tables.find((table) => table.name === "Users");
  assert.match(lower.path, /users-[0-9a-f]{16}\.md$/);
  assert.match(upper.path, /Users-[0-9a-f]{16}\.md$/);
  assert.notEqual(lower.path, upper.path);
});

function oneTableSnapshot(kind, database, table, engine, columns) {
  return {
    instances: [{
      label: `${kind}-main`,
      kind,
      databases: [{
        name: database,
        table_count: 1,
        tables: [{ name: table, engine: engine || "", row_count: 1, columns, indexes: [] }],
      }],
    }],
    refs: [],
    groups: [],
    issues: [],
    metrics: [{ label: `${kind}-main`, kind, success: true, num_databases: 1, num_tables: 1 }],
  };
}

test("query binding v2 renders executable MySQL, PostgreSQL, GaussDB, SQLite, and Oracle identifiers", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "okf-dbexplain-binding-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cases = [
    {
      kind: "mysql", database: "sales", table: "order", engine: "InnoDB",
      columns: [column("select", "varchar(20)")], source: "`sales`.`order`", identifier: "`select`", datatype: "String",
    },
    {
      kind: "postgres", database: "appdb", table: "analytics.orders",
      columns: [column("created_at", "timestamp(6) with time zone")], source: '\"analytics\".\"orders\"', identifier: '\"created_at\"', datatype: "DateTimeTz",
    },
    {
      kind: "gaussdb", database: "appdb", table: "finance.ledger",
      columns: [column("amount", "numeric(18,2)")], source: '\"finance\".\"ledger\"', identifier: '\"amount\"', datatype: "Decimal",
    },
    {
      kind: "sqlite", database: "/Users/private/app.sqlite", table: "user",
      columns: [column("id", "integer")], source: '\"main\".\"user\"', identifier: '\"id\"', datatype: "Integer",
    },
    {
      kind: "oracle", database: "APP", table: "ORDER",
      columns: [column("CREATED_AT", "DATE")], source: '\"APP\".\"ORDER\"', identifier: '\"CREATED_AT\"', datatype: "DateTime",
    },
  ];

  cases.forEach((entry) => {
    const raw = oneTableSnapshot(entry.kind, entry.database, entry.table, entry.engine, entry.columns);
    const model = normalizeSnapshot(JSON.stringify(raw), { selectedLabels: [`${entry.kind}-main`] });
    const capture = {
      dbexplainVersion: "v0.1.11-test",
      selectedSources: [{ label: `${entry.kind}-main`, kind: entry.kind }],
      rawInputSha256: "sha256:test-input",
      model,
      context: entry.kind === "sqlite"
        ? { summary: { core_tables: [`${entry.kind}-main/${entry.database}/${entry.table}`] } }
        : {},
    };
    const candidate = buildBundleCandidate(capture, path.join(root, entry.kind), "2026-08-25T09:00:00Z", "0.9.0-test");
    const tableModel = model.tables[0];
    const concept = splitFrontmatter(candidate.files.get(tableModel.path));
    const binding = concept.frontmatter.dbexplain.sql_binding;
    assert.equal(binding.dialect, entry.kind);
    assert.equal(binding.source_sql, entry.source);
    assert.equal(binding.columns[0].sql_identifier, entry.identifier);
    assert.equal(binding.columns[0].datatype, entry.datatype);
    if (entry.kind === "mysql") assert.equal(concept.frontmatter.dbexplain.engine, "InnoDB");
    if (entry.kind === "sqlite") {
      assert.equal(tableModel.database, "main");
      assert.doesNotMatch(Array.from(candidate.files.values()).join("\n"), /Users\/private/);
    }
  });
});

test("unsupported database kinds fail during inspection and before a Bundle can be written", (t) => {
  const raw = oneTableSnapshot("clickhouse", "analytics", "events", "MergeTree", [column("id", "UInt64")]);
  const fake = makeFakeDbExplain(t, raw);
  assert.throws(
    () => inspectDbExplain({
      dbexplainBin: fake.executable,
      env: Object.assign({}, process.env, { FAKE_DBEXPLAIN_SNAPSHOT: fake.snapshotPath }),
    }),
    (error) => error instanceof DbExplainError && error.code === "unsupported_sql_binding_dialect",
  );
  assert.throws(
    () => normalizeSnapshot(JSON.stringify(raw), { selectedLabels: ["clickhouse-main"] }),
    (error) => error instanceof DbExplainError && error.code === "unsupported_sql_binding_dialect",
  );
});

test("declared relationship cardinality requires a unique target and detects one-to-one sources", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "okf-dbexplain-cardinality-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const raw = snapshot();
  const orders = raw.instances[0].databases[0].tables.find((table) => table.name === "orders");
  orders.columns.find((entry) => entry.name === "user_id").is_unique = true;
  const model = normalizeSnapshot(JSON.stringify(raw), { selectedLabels: ["prod-main"] });
  const candidate = buildBundleCandidate({
    dbexplainVersion: "v0.1.11-test",
    selectedSources: [{ label: "prod-main", kind: "postgres" }],
    rawInputSha256: "sha256:test-input",
    model,
    context: {},
  }, root, "2026-08-25T09:00:00Z", "0.9.0-test");
  const relationship = model.declaredRelationships[0];
  const concept = splitFrontmatter(candidate.files.get(relationship.path));
  assert.equal(concept.frontmatter.dbexplain.join_binding.cardinality, "one-to-one");

  const noUniqueTarget = snapshot();
  const users = noUniqueTarget.instances[0].databases[0].tables.find((table) => table.name === "users");
  users.columns.find((entry) => entry.name === "id").is_primary = false;
  users.indexes[0].unique = false;
  const unsafeModel = normalizeSnapshot(JSON.stringify(noUniqueTarget), { selectedLabels: ["prod-main"] });
  const unsafeCandidate = buildBundleCandidate({
    dbexplainVersion: "v0.1.11-test",
    selectedSources: [{ label: "prod-main", kind: "postgres" }],
    rawInputSha256: "sha256:test-input",
    model: unsafeModel,
    context: {},
  }, path.join(root, "unsafe"), "2026-08-25T09:00:00Z", "0.9.0-test");
  const unsafeConcept = splitFrontmatter(unsafeCandidate.files.get(unsafeModel.declaredRelationships[0].path));
  assert.equal(unsafeConcept.frontmatter.dbexplain.join_binding.cardinality, "unknown");
  assert.equal(unsafeConcept.frontmatter.dbexplain.join_binding.executable, false);
});

test("PostgreSQL-style unqualified references resolve only when the schema target is unique", () => {
  const unique = snapshot();
  const uniqueUsers = unique.instances[0].databases[0].tables.find((table) => table.name === "users");
  uniqueUsers.name = "analytics.users";
  const uniqueModel = normalizeSnapshot(JSON.stringify(unique), { selectedLabels: ["prod-main"] });
  assert.equal(uniqueModel.declaredRelationships[0].to.name, "analytics.users");

  const ambiguous = snapshot();
  const publicUsers = ambiguous.instances[0].databases[0].tables.find((table) => table.name === "users");
  ambiguous.instances[0].databases[0].tables.push(Object.assign({}, JSON.parse(JSON.stringify(publicUsers)), {
    name: "analytics.users",
  }));
  ambiguous.instances[0].databases[0].table_count = ambiguous.instances[0].databases[0].tables.length;
  ambiguous.metrics[0].num_tables = ambiguous.instances[0].databases[0].tables.length;
  assert.throws(
    () => normalizeSnapshot(JSON.stringify(ambiguous), { selectedLabels: ["prod-main"] }),
    (error) => error instanceof DbExplainError && error.code === "ambiguous_table_reference",
  );
});

test("overlay-draft creates dataset and declared relationship drafts without overwriting existing overlay", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "okf-dbexplain-overlay-draft-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundleRoot = path.join(root, "bundle");
  const fake = makeFakeDbExplain(t, snapshot());
  const syncConfig = common(fake, bundleRoot, "2026-08-26T09:00:00Z");
  const preview = syncDbExplain(Object.assign({}, syncConfig, { dryRun: true }));
  syncDbExplain(Object.assign({}, syncConfig, { expectPlan: preview.planDigest }));

  const dry = draftDbExplainOverlay({ bundleRoot, dryRun: true, tables: "orders,users,audit_events" });
  assert.equal(dry.datasetsDrafted, 3);
  assert.equal(dry.relationshipsDrafted, 1);
  assert.ok(dry.files.includes("business/datasets/orders.md"));
  assert.ok(dry.files.includes("business/relationships/orders-to-users.md"));

  const applied = draftDbExplainOverlay({ bundleRoot, tables: "orders,users,audit_events" });
  assert.equal(applied.applied, true);
  const ordersDataset = readConcept(bundleRoot, "business/datasets/orders.md");
  assert.equal(ordersDataset.frontmatter.semantic.kind, "dataset");
  assert.equal(ordersDataset.frontmatter.status, "draft");
  assert.equal(
    ordersDataset.frontmatter.semantic.fields.find((field) => field.name === "status").enum.values[1].labels.zh,
    "成功",
  );
  const relationship = readConcept(bundleRoot, "business/relationships/orders-to-users.md");
  assert.equal(relationship.frontmatter.semantic.physical_relationship, "/relationships/declared/orders__users.md");
  assert.equal(ordersDataset.frontmatter.relations[0].label, "physical_table");
  assert.match(ordersDataset.body, /Semantic Fields/);
  const overlayIndex = buildIndex([{ id: "database", root: bundleRoot }], { strictLinks: true, allowCustomRelationTypes: true });
  assert.equal(overlayIndex.edges.some((edge) => (
    edge.source === "okf://database/business/datasets/orders"
      && edge.kind === "relation"
      && edge.relationType === "depends_on"
      && edge.target === "okf://database/tables/prod-main/app/orders"
  )), true);
  assert.equal(searchConcepts(overlayIndex, {
    query: "成功",
    pathPrefix: "business/datasets",
  }).results.some((entry) => entry.path === "business/datasets/orders.md"), true);
  assert.equal(validateDbExplainBundle({ bundleRoot }).valid, true);

  const second = draftDbExplainOverlay({ bundleRoot, tables: "orders,users,audit_events", dryRun: true });
  assert.equal(second.datasetsDrafted, 0);
  assert.equal(second.relationshipsDrafted, 0);
});

test("Streamable HTTP exposes a domain-neutral search and graph path to SQL bindings", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "okf-dbexplain-http-"));
  const bundleRoot = path.join(root, "bundle");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fake = makeFakeDbExplain(t, snapshot());
  const syncConfig = common(fake, bundleRoot, "2026-08-26T09:00:00Z");
  const preview = syncDbExplain(Object.assign({}, syncConfig, { dryRun: true }));
  syncDbExplain(Object.assign({}, syncConfig, { expectPlan: preview.planDigest }));
  draftDbExplainOverlay({ bundleRoot, tables: "orders,users" });

  const httpServer = await runStreamableHttpServer([`database=${bundleRoot}`], { port: 0 });
  t.after(async () => {
    await httpServer.handler.close();
    await new Promise((resolve) => httpServer.server.close(resolve));
  });
  const client = new Client(
    { name: "dbexplain-http-test", version: "1" },
    { versionNegotiation: { mode: "legacy" } },
  );
  const transport = new StreamableHTTPClientTransport(new URL(httpServer.url));
  await client.connect(transport);
  t.after(() => client.close());

  const search = await callJson(client, "search_concepts", {
    query: "成功",
    pathPrefix: "business/datasets",
  });
  const dataset = search.payload.results.find((entry) => entry.uri.endsWith("/business/datasets/orders"));
  assert.ok(dataset);

  const neighbors = await callJson(client, "get_neighbors", { uri: dataset.uri });
  const tableNeighbor = neighbors.payload.outbound.find((entry) => (
    entry.edge.kind === "relation" && entry.edge.relationType === "depends_on"
  ));
  assert.equal(tableNeighbor.node.path, "tables/prod-main/app/orders.md");

  const table = await callJson(client, "get_concept", { uri: tableNeighbor.node.uri });
  assert.equal(table.payload.frontmatter.dbexplain.sql_binding.source_sql, '"public"."orders"');

  const subgraph = await callJson(client, "get_subgraph", {
    uri: "okf://database/business/relationships/orders-to-users",
    depth: 2,
  });
  assert.equal(subgraph.payload.nodes.some((entry) => entry.path === "relationships/declared/orders__users.md"), true);
  assert.equal(subgraph.payload.nodes.some((entry) => entry.path === "tables/prod-main/app/users.md"), true);
});

test("overlay-index rebuilds catalogs after new overlay concepts without overwriting them", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "okf-dbexplain-overlay-index-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundleRoot = path.join(root, "bundle");
  const fake = makeFakeDbExplain(t, snapshot());
  const syncConfig = common(fake, bundleRoot, "2026-08-26T09:00:00Z");
  const preview = syncDbExplain(Object.assign({}, syncConfig, { dryRun: true }));
  syncDbExplain(Object.assign({}, syncConfig, { expectPlan: preview.planDigest }));
  draftDbExplainOverlay({ bundleRoot, tables: "orders,users" });

  const queryPath = path.join(bundleRoot, "queries", "open-orders.md");
  fs.writeFileSync(queryPath, [
    "---",
    "type: Saved Query",
    "title: Open orders",
    "description: Approved monthly order count.",
    "status: draft",
    "relations:",
    "  - type: depends_on",
    "    target: /tables/prod-main/app/orders.md",
    "    label: query_table",
    "verified:",
    "  by: process:dbexplain",
    "  at: '2026-08-26T09:00:00Z'",
    "  method: dbexplain_execute",
    `  statement_sha256: ${statementSha256("SELECT COUNT(*) FROM orders")}`,
    "  instance_label: prod-main",
    "semantic:",
    "  profile: dbexplain-okf-v1",
    "  kind: query",
    "  dialect: postgres",
    "  tables:",
    "    - /tables/prod-main/app/orders.md",
    "---",
    "",
    "[Orders table](/tables/prod-main/app/orders.md)",
    "",
    "```sql",
    "SELECT COUNT(*) FROM orders",
    "```",
    "",
  ].join("\n"), "utf8");
  assert.equal(fs.readFileSync(path.join(bundleRoot, "queries/index.md"), "utf8").includes("Open orders"), false);

  const datasetPath = path.join(bundleRoot, "business/datasets/orders.md");
  fs.writeFileSync(
    datasetPath,
    fs.readFileSync(datasetPath, "utf8").replace(/^title: .+$/m, "title: Customer orders"),
    "utf8",
  );

  const refreshed = refreshDbExplainOverlayIndexes({ bundleRoot });
  assert.equal(refreshed.applied, true);
  assert.equal(refreshed.conceptCounts["queries/index.md"], 1);
  assert.equal(refreshed.conceptCounts["business/datasets/index.md"] >= 2, true);
  assert.match(fs.readFileSync(path.join(bundleRoot, "queries/index.md"), "utf8"), /Open orders/);
  assert.match(fs.readFileSync(path.join(bundleRoot, "business/datasets/index.md"), "utf8"), /Customer orders/);
  assert.match(fs.readFileSync(queryPath, "utf8"), /Approved monthly order count/);
  fs.writeFileSync(
    queryPath,
    fs.readFileSync(queryPath, "utf8").replace("SELECT COUNT(*) FROM orders", "SELECT SUM(id) FROM orders"),
    "utf8",
  );
  assert.throws(
    () => validateDbExplainBundle({ bundleRoot }),
    (error) => error instanceof DbExplainError
      && error.code === "invalid_semantic_overlay"
      && error.details.field === "verified.statement_sha256",
  );
});

test("overlay-draft requires explicit scope", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "okf-dbexplain-overlay-scope-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundleRoot = path.join(root, "bundle");
  const fake = makeFakeDbExplain(t, snapshot());
  const syncConfig = common(fake, bundleRoot, "2026-08-26T09:00:00Z");
  const preview = syncDbExplain(Object.assign({}, syncConfig, { dryRun: true }));
  syncDbExplain(Object.assign({}, syncConfig, { expectPlan: preview.planDigest }));
  assert.throws(
    () => draftDbExplainOverlay({ bundleRoot, dryRun: true }),
    (error) => error instanceof DbExplainError && error.code === "missing_overlay_scope",
  );
});

test("applyTableFilter keeps only matched tables and drops dangling relationships", () => {
  const identity = (table) => ({ instance: "prod-main", database: "app", table });
  const table = (name) => ({ name, identity: identity(name) });
  const relationship = (from, to) => ({
    identity: { kind: "declared", from: identity(from), from_columns: [], to: identity(to), to_columns: [] },
    from: table(from),
    to: table(to),
  });
  const allTables = [table("users"), table("orders"), table("audit_events")];
  const model = () => ({
    instances: [{ label: "prod-main", databases: [{ name: "app", tables: allTables.slice() }] }],
    tables: allTables.slice(),
    declaredRelationships: [relationship("orders", "users")],
    inferredRelationships: [relationship("audit_events", "users")],
    groups: [{ name: "app", tables: ["users", "orders", "audit_events"].map(identity) }],
  });

  const included = applyTableFilter(model(), { includeTables: "users,orders" });
  assert.deepEqual(included.tables.map((table) => table.name).sort(), ["orders", "users"]);
  assert.deepEqual(included.instances[0].databases[0].tables.map((table) => table.name).sort(), ["orders", "users"]);
  assert.equal(included.declaredRelationships.length, 1);
  assert.equal(included.inferredRelationships.length, 0);
  assert.deepEqual(included.groups[0].tables.map((entry) => entry.table).sort(), ["orders", "users"]);

  const globbed = applyTableFilter(model(), { includeTables: "u*,o*" });
  assert.deepEqual(globbed.tables.map((table) => table.name).sort(), ["orders", "users"]);

  const excluded = applyTableFilter(model(), { excludeTables: "audit_*" });
  assert.deepEqual(excluded.tables.map((table) => table.name).sort(), ["orders", "users"]);
  assert.equal(excluded.inferredRelationships.length, 0);

  const unfiltered = applyTableFilter(model(), {});
  assert.equal(unfiltered.tables.length, 3);
});
