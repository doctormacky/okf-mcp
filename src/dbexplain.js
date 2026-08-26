"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const yaml = require("js-yaml");
const { isLosslessNumber, parse: parseLosslessJson } = require("lossless-json");

const { renderConceptMarkdown } = require("./authoring");
const {
  OVERLAY_CATALOGS,
  legacyOverlayScaffoldFiles,
  overlayScaffoldFiles,
} = require("./dbexplain-overlay-guides");
const { buildIndex } = require("./indexer");
const { markdownStructure } = require("./markdown");
const { extractMarkdownLinks, splitFrontmatter } = require("./parser");
const { validateIndex } = require("./validation");

const GENERATOR = "okf-dbexplain";
const GENERATOR_ACTOR = "process:okf-dbexplain";
const IDENTITY_VERSION = 1;
const BUNDLE_FORMAT_VERSION = 1;
const SQL_BINDING_VERSION = 2;
const SEMANTIC_PROFILE = "dbexplain-okf-v1";
const MIN_DBEXPLAIN_VERSION = Object.freeze({ major: 0, minor: 1, patch: 11, text: "v0.1.11" });
const DBEXPLAIN_COMPATIBILITY_ISSUES = "https://github.com/doctormacky/okf-mcp/issues";
const OSSIE_PROFILE = Object.freeze({
  name: "ossie-inspired",
  version: "0.2.0.dev0",
  revision: "1d9ebcea2932d3381c0840cc8304f0850d366509",
});
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
const MAX_BUNDLE_FILES = 5000;
const SQL_KINDS = new Set([
  "mysql",
  "postgres",
  "gaussdb",
  "sqlite",
  "clickhouse",
  "duckdb",
  "oracle",
  "hive",
  "starrocks",
]);
const QUERY_BINDING_KINDS = new Set(["mysql", "postgres", "gaussdb", "sqlite", "oracle"]);
const MANAGED_OBJECT_KINDS = new Set([
  "bundle",
  "instance",
  "database",
  "table",
  "declared_relationship",
  "inferred_relationship",
  "current_observation",
  "table_observation",
]);
const DEPRECATABLE_OBJECT_KINDS = new Set([
  "instance",
  "database",
  "table",
  "declared_relationship",
  "inferred_relationship",
  "table_observation",
]);
const OVERLAY_ROOTS = new Set([
  "business",
  "metrics",
  "queries",
  "computations",
  "policies",
  "skills",
  "attesters",
  "references",
]);
const TEMPORAL_LOGICAL_TYPES = new Set(["Date", "Time", "DateTime", "DateTimeTz"]);
const OSSIE_DATATYPES = new Set(["String", "Integer", "Decimal", "Float", "Boolean", "Date", "Time", "DateTime", "DateTimeTz", "Opaque"]);

class DbExplainError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = "DbExplainError";
    this.code = code || "dbexplain_error";
    if (details !== undefined) this.details = details;
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeForCanonical(value) {
  if (Array.isArray(value)) return value.map(normalizeForCanonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, normalizeForCanonical(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(normalizeForCanonical(value));
}

function identityDigest(kind, identity) {
  return sha256(canonicalJson({ version: IDENTITY_VERSION, kind, identity }));
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || isLosslessNumber(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function asArray(value, field, options) {
  if (value === null || value === undefined) {
    if (options && options.required) {
      throw new DbExplainError(`${field} must be an array.`, "invalid_dbexplain_json", { field });
    }
    return [];
  }
  if (!Array.isArray(value)) {
    throw new DbExplainError(`${field} must be an array.`, "invalid_dbexplain_json", { field });
  }
  return value;
}

function asObject(value, field) {
  if (!isPlainObject(value)) {
    throw new DbExplainError(`${field} must be an object.`, "invalid_dbexplain_json", { field });
  }
  return value;
}

function asString(value, field, options) {
  if ((value === undefined || value === null) && options && options.optional) return "";
  if (typeof value !== "string" || (!(options && options.allowEmpty) && value.trim() === "")) {
    throw new DbExplainError(`${field} must be ${options && options.allowEmpty ? "a string" : "a non-empty string"}.`, "invalid_dbexplain_json", { field });
  }
  return value;
}

function asBoolean(value, field, fallback) {
  if (value === undefined || value === null) return Boolean(fallback);
  if (typeof value !== "boolean") {
    throw new DbExplainError(`${field} must be a boolean.`, "invalid_dbexplain_json", { field });
  }
  return value;
}

function numericText(value, field, options) {
  if (value === undefined || value === null) return null;
  const text = isLosslessNumber(value)
    ? value.toString()
    : typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : null;
  if (text === null || !(options && options.decimal ? /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/ : /^-?\d+$/).test(text)) {
    throw new DbExplainError(`${field} must be a finite ${options && options.decimal ? "number" : "integer"}.`, "invalid_dbexplain_json", { field });
  }
  if (options && options.nonNegative && text.startsWith("-")) {
    if (!(options.allowUnknownMinusOne && text === "-1")) {
      throw new DbExplainError(`${field} must not be negative.`, "invalid_dbexplain_json", { field });
    }
  }
  return text;
}

function safeCount(value, field) {
  const text = numericText(value, field, { nonNegative: true });
  if (text === null) return null;
  const number = Number(text);
  if (!Number.isSafeInteger(number)) {
    throw new DbExplainError(`${field} exceeds the supported collection count range.`, "invalid_dbexplain_json", { field });
  }
  return number;
}

function compareText(left, right) {
  return Buffer.from(String(left), "utf8").compare(Buffer.from(String(right), "utf8"));
}

function compareIdentity(left, right) {
  return compareText(canonicalJson(left), canonicalJson(right));
}

function safeSlug(value, fallback) {
  const ascii = String(value || "")
    .normalize("NFKD")
    .replace(/[^\x00-\x7f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return ascii || fallback || "object";
}

function pathSegment(value, fallback) {
  const text = String(value || "");
  if (!text || text === "." || text === ".." || text.includes("\0")) {
    return fallback || "object";
  }
  const encoded = encodeURIComponent(text).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  if (!encoded || encoded === "." || encoded === ".." || encoded.startsWith(".")) {
    return fallback || "object";
  }
  return encoded;
}

function preferredObjectPath(kind, identity) {
  switch (kind) {
    case "instance":
      return `instances/${pathSegment(identity.instance, "instance")}.md`;
    case "database":
      return `databases/${pathSegment(identity.instance, "instance")}/${pathSegment(identity.database, "database")}.md`;
    case "table":
      return `tables/${pathSegment(identity.instance, "instance")}/${pathSegment(identity.database, "database")}/${pathSegment(identity.table, "table")}.md`;
    case "declared_relationship":
      return `relationships/declared/${pathSegment(identity.from.table, "from")}__${pathSegment(identity.to.table, "to")}.md`;
    case "inferred_relationship":
      return `relationships/inferred/${pathSegment(identity.from.table, "from")}__${pathSegment(identity.to.table, "to")}.md`;
    case "table_observation":
      return `observations/tables/${pathSegment(identity.table.instance, "instance")}/${pathSegment(identity.table.database, "database")}/${pathSegment(identity.table.table, "table")}.md`;
    default:
      throw new DbExplainError(`Unsupported managed object kind: ${kind}`, "invalid_managed_kind");
  }
}

function collidedObjectPath(kind, identity, preferred) {
  const digest = identityDigest(kind, identity).slice(0, 16);
  const directory = path.posix.dirname(preferred);
  const base = path.posix.basename(preferred, ".md");
  return `${directory}/${base}-${digest}.md`;
}

function objectPath(kind, identity) {
  return preferredObjectPath(kind, identity);
}

function resolvePathCollisions(entries) {
  const groups = new Map();
  entries.forEach((entry) => {
    const preferred = preferredObjectPath(entry.kind, entry.identity);
    const key = preferred.toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ object: entry.object, kind: entry.kind, identity: entry.identity, preferred });
  });
  const assigned = new Map();
  groups.forEach((group) => {
    const collide = group.length > 1;
    group.forEach((entry) => {
      const resolved = collide ? collidedObjectPath(entry.kind, entry.identity, entry.preferred) : entry.preferred;
      const collisionKey = resolved.toLowerCase();
      if (assigned.has(collisionKey)) {
        throw new DbExplainError(`Managed path collision: ${resolved}`, "managed_path_collision", { path: resolved });
      }
      assigned.set(collisionKey, entry);
      entry.object.path = resolved;
    });
  });
}

function assignModelPaths(model) {
  const entries = [];
  model.instances.forEach((instance) => {
    entries.push({ object: instance, kind: "instance", identity: instance.identity });
    instance.databases.forEach((database) => {
      entries.push({ object: database, kind: "database", identity: database.identity });
      database.tables.forEach((table) => {
        entries.push({ object: table, kind: "table", identity: table.identity });
      });
    });
  });
  model.declaredRelationships.forEach((relationship) => {
    entries.push({ object: relationship, kind: "declared_relationship", identity: relationship.identity });
  });
  model.inferredRelationships.forEach((relationship) => {
    entries.push({ object: relationship, kind: "inferred_relationship", identity: relationship.identity });
  });
  resolvePathCollisions(entries);
}

function tableObservationPath(table) {
  if (!table.path || !table.path.startsWith("tables/") || !table.path.toLowerCase().endsWith(".md")) {
    throw new DbExplainError("Table path is not a managed table document.", "invalid_managed_kind");
  }
  return `observations/tables/${table.path.slice("tables/".length)}`;
}

function overlayRoot(relativePath) {
  const first = String(relativePath || "").split("/")[0];
  return OVERLAY_ROOTS.has(first) ? first : "";
}

function semanticOverlayError(filePath, field, message) {
  throw new DbExplainError(`Semantic overlay is invalid: ${filePath}: ${message}`, "invalid_semantic_overlay", {
    path: filePath,
    field,
  });
}

function semanticString(value, filePath, field) {
  if (typeof value !== "string" || !value.trim()) {
    semanticOverlayError(filePath, field, `${field} must be a non-empty string.`);
  }
  return value.trim();
}

function semanticReference(value, filePath, field) {
  const reference = semanticString(value, filePath, field);
  if (!reference.startsWith("/") || !reference.toLowerCase().endsWith(".md") || reference.includes("..")) {
    semanticOverlayError(filePath, field, `${field} must be a bundle-root Markdown path such as /tables/prod/public/orders.md.`);
  }
  return reference.slice(1);
}

function semanticStringArray(value, filePath, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    semanticOverlayError(filePath, field, `${field} must be a list of non-empty strings.`);
  }
  return value.map((entry) => entry.trim());
}

function validateEnumValues(value, filePath, field) {
  if (!Array.isArray(value) || !value.length) {
    semanticOverlayError(filePath, field, `${field} must be a non-empty list of code/label mappings.`);
  }
  return value.map((entry, index) => {
    if (!isPlainObject(entry)) {
      semanticOverlayError(filePath, `${field}[${index}]`, "Each enum value must be a mapping.");
    }
    const code = semanticString(entry.code, filePath, `${field}[${index}].code`);
    if (!isPlainObject(entry.labels)) {
      semanticOverlayError(filePath, `${field}[${index}].labels`, "Each enum value requires labels.en and labels.zh.");
    }
    return {
      code,
      labels: {
        en: semanticString(entry.labels.en, filePath, `${field}[${index}].labels.en`),
        zh: semanticString(entry.labels.zh, filePath, `${field}[${index}].labels.zh`),
      },
    };
  });
}

function parseOverlayJoin(join, filePath, field) {
  if (!isPlainObject(join)) {
    semanticOverlayError(filePath, field, `${field} must be a mapping.`);
  }
  const parseEndpoint = (endpoint, endpointField) => {
    if (!isPlainObject(endpoint)) {
      semanticOverlayError(filePath, endpointField, `${endpointField} must be a mapping.`);
    }
    const columns = semanticStringArray(endpoint.columns, filePath, `${endpointField}.columns`);
    if (!columns.length) {
      semanticOverlayError(filePath, `${endpointField}.columns`, `${endpointField}.columns must list at least one column.`);
    }
    return {
      table: semanticReference(endpoint.table, filePath, `${endpointField}.table`),
      columns,
    };
  };
  return {
    predicateTemplate: semanticString(join.predicate_template, filePath, `${field}.predicate_template`),
    cardinality: join.cardinality === undefined
      ? ""
      : semanticString(join.cardinality, filePath, `${field}.cardinality`),
    from: parseEndpoint(join.from, `${field}.from`),
    to: parseEndpoint(join.to, `${field}.to`),
  };
}

function validateSemanticOverlayShape(frontmatter, filePath) {
  if (!Object.prototype.hasOwnProperty.call(frontmatter || {}, "semantic")) return null;
  const semantic = frontmatter.semantic;
  if (!isPlainObject(semantic)) {
    semanticOverlayError(filePath, "semantic", "semantic must be a mapping.");
  }
  if (semantic.profile !== SEMANTIC_PROFILE) {
    semanticOverlayError(filePath, "semantic.profile", `semantic.profile must be ${SEMANTIC_PROFILE}.`);
  }
  const kind = semanticString(semantic.kind, filePath, "semantic.kind");
  const expectedTypes = {
    dataset: "Semantic Dataset",
    relationship: "Semantic Relationship",
    term: "Business Term",
    metric: "Metric",
    enumeration: "Enumeration",
    query: "Saved Query",
  };
  if (!expectedTypes[kind] || frontmatter.type !== expectedTypes[kind]) {
    semanticOverlayError(filePath, "type", `semantic.kind ${kind} requires type: ${expectedTypes[kind] || "a supported semantic concept"}.`);
  }

  if (kind === "term") {
    if (!Array.isArray(semantic.bindings) || semantic.bindings.length === 0) {
      semanticOverlayError(filePath, "semantic.bindings", "A Business Term requires at least one table/column binding.");
    }
    const bindings = semantic.bindings.map((entry, index) => {
      if (!isPlainObject(entry)) semanticOverlayError(filePath, `semantic.bindings[${index}]`, "Each binding must be a mapping.");
      return {
        table: semanticReference(entry.table, filePath, `semantic.bindings[${index}].table`),
        column: semanticString(entry.column, filePath, `semantic.bindings[${index}].column`),
      };
    });
    return { kind, semantic, bindings };
  }

  if (kind === "dataset") {
    const physicalTable = semanticReference(semantic.physical_table, filePath, "semantic.physical_table");
    if (!Array.isArray(semantic.fields) || semantic.fields.length === 0) {
      semanticOverlayError(filePath, "semantic.fields", "A Semantic Dataset requires at least one field binding.");
    }
    const names = new Set();
    const fields = semantic.fields.map((entry, index) => {
      if (!isPlainObject(entry)) semanticOverlayError(filePath, `semantic.fields[${index}]`, "Each field must be a mapping.");
      const name = semanticString(entry.name, filePath, `semantic.fields[${index}].name`);
      if (names.has(name)) semanticOverlayError(filePath, `semantic.fields[${index}].name`, `Duplicate semantic field: ${name}.`);
      names.add(name);
      if (entry.datatype !== undefined && !OSSIE_DATATYPES.has(entry.datatype)) {
        semanticOverlayError(filePath, `semantic.fields[${index}].datatype`, `Unsupported OSSIE datatype: ${entry.datatype}.`);
      }
      if (entry.dimension !== undefined
        && (!isPlainObject(entry.dimension) || (entry.dimension.is_time !== undefined && typeof entry.dimension.is_time !== "boolean"))) {
        semanticOverlayError(filePath, `semantic.fields[${index}].dimension`, "dimension must be a mapping whose optional is_time value is boolean.");
      }
      semanticStringArray(entry.synonyms, filePath, `semantic.fields[${index}].synonyms`);
      if (entry.enum !== undefined) {
        if (!isPlainObject(entry.enum)) {
          semanticOverlayError(filePath, `semantic.fields[${index}].enum`, "enum must be a mapping with a values list.");
        }
        validateEnumValues(entry.enum.values, filePath, `semantic.fields[${index}].enum.values`);
      }
      return {
        name,
        column: semanticString(entry.column, filePath, `semantic.fields[${index}].column`),
      };
    });
    return { kind, semantic, physicalTable, fields };
  }

  if (kind === "relationship") {
    const hasPhysical = Object.prototype.hasOwnProperty.call(semantic, "physical_relationship");
    const hasJoin = Object.prototype.hasOwnProperty.call(semantic, "join");
    if (hasPhysical === hasJoin) {
      semanticOverlayError(
        filePath,
        "semantic",
        "A Semantic Relationship requires exactly one of semantic.physical_relationship or semantic.join.",
      );
    }
    const contract = {
      kind,
      semantic,
      fromDataset: semanticReference(semantic.from_dataset, filePath, "semantic.from_dataset"),
      toDataset: semanticReference(semantic.to_dataset, filePath, "semantic.to_dataset"),
    };
    if (hasPhysical) {
      contract.physicalRelationship = semanticReference(
        semantic.physical_relationship,
        filePath,
        "semantic.physical_relationship",
      );
    } else {
      contract.overlayJoin = parseOverlayJoin(semantic.join, filePath, "semantic.join");
    }
    return contract;
  }

  if (kind === "enumeration") {
    return {
      kind,
      semantic,
      values: validateEnumValues(semantic.values, filePath, "semantic.values"),
    };
  }

  if (kind === "query") {
    if (semantic.dialect !== undefined
      && !QUERY_BINDING_KINDS.has(semantic.dialect)
      && semantic.dialect !== "ansi_sql") {
      semanticOverlayError(filePath, "semantic.dialect", `Unsupported Saved Query dialect: ${semantic.dialect}.`);
    }
    const tables = semantic.tables === undefined
      ? []
      : semanticStringArray(semantic.tables, filePath, "semantic.tables")
        .map((entry, index) => semanticReference(entry, filePath, `semantic.tables[${index}]`));
    if (!tables.length) {
      semanticOverlayError(filePath, "semantic.tables", "A Saved Query requires at least one physical table binding.");
    }
    return { kind, semantic, tables };
  }

  const baseTable = semanticReference(semantic.base_table, filePath, "semantic.base_table");
  if (semantic.datatype !== undefined && !OSSIE_DATATYPES.has(semantic.datatype)) {
    semanticOverlayError(filePath, "semantic.datatype", `Unsupported OSSIE datatype: ${semantic.datatype}.`);
  }
  if (!isPlainObject(semantic.expressions) || !Object.keys(semantic.expressions).length) {
    semanticOverlayError(filePath, "semantic.expressions", "A Metric requires a dialect-to-SQL expression mapping.");
  }
  Object.entries(semantic.expressions).forEach(([dialect, expression]) => {
    if (!QUERY_BINDING_KINDS.has(dialect) && dialect !== "ansi_sql") {
      semanticOverlayError(filePath, `semantic.expressions.${dialect}`, `Unsupported Metric expression dialect: ${dialect}.`);
    }
    semanticString(expression, filePath, `semantic.expressions.${dialect}`);
  });
  return {
    kind,
    semantic,
    baseTable,
    requiredRelationships: semanticStringArray(semantic.required_relationships, filePath, "semantic.required_relationships")
      .map((entry, index) => semanticReference(entry, filePath, `semantic.required_relationships[${index}]`)),
  };
}

function reservedMarkdownName(relativePath) {
  const base = path.posix.basename(relativePath).toLowerCase();
  return base === "index.md" || base === "log.md";
}

function splitColumns(value, field) {
  const text = asString(value, field);
  const values = text.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (!values.length) {
    throw new DbExplainError(`${field} must identify at least one column.`, "invalid_dbexplain_json", { field });
  }
  return values;
}

function tableIdentity(instance, database, table) {
  return { instance, database, table };
}

function relationshipIdentity(kind, from, fromColumns, to, toColumns) {
  return {
    kind,
    from,
    from_columns: fromColumns,
    to,
    to_columns: toColumns,
  };
}

function tableKey(identity) {
  return canonicalJson(identity);
}

function resolveCollectedTable(tableLookup, identity) {
  const exact = tableLookup.get(tableKey(identity));
  const scoped = Array.from(new Set(tableLookup.values())).filter((table) => (
    table.label === identity.instance
    && table.sourceDatabase === identity.database
  ));
  const postgresStyle = scoped.some((table) => ["postgres", "gaussdb"].includes(table.kind));
  if (!postgresStyle || identity.table.includes(".")) return exact || null;
  const candidates = scoped.filter((table) => (
    table.sourceName === identity.table || table.sourceName.endsWith(`.${identity.table}`)
  ));
  if (candidates.length > 1) {
    throw new DbExplainError(`PostgreSQL-style table reference is ambiguous without a schema: ${identity.instance}/${identity.database}/${identity.table}`, "ambiguous_table_reference", {
      identity,
      candidates: candidates.map((table) => table.sourceName).sort(compareText),
    });
  }
  return candidates[0] || null;
}

function quoteSqlIdentifier(dialect, value) {
  const text = String(value || "");
  if (dialect === "mysql") {
    return `\`${text.replace(/`/g, "``")}\``;
  }
  if (["postgres", "gaussdb", "sqlite", "oracle"].includes(dialect)) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  throw new DbExplainError(`SQL binding is not implemented for database kind: ${dialect}`, "unsupported_sql_binding_dialect", { kind: dialect });
}

function databaseConceptName(kind, database) {
  return kind === "sqlite" ? "main" : database;
}

function sqlBinding(kind, label, database, table) {
  let namespace = database;
  let relation = table;
  if (kind === "postgres" || kind === "gaussdb") {
    const separator = table.indexOf(".");
    namespace = separator > 0 ? table.slice(0, separator) : "public";
    relation = separator > 0 ? table.slice(separator + 1) : table;
  } else if (kind === "sqlite") {
    namespace = "main";
  }
  if (!namespace || !relation) {
    throw new DbExplainError(`Cannot derive an executable SQL binding for ${label}/${database}/${table}.`, "invalid_sql_binding", {
      label,
      database,
      table,
    });
  }
  return {
    version: SQL_BINDING_VERSION,
    dialect: kind,
    instance_label: label,
    namespace,
    relation,
    source_sql: `${quoteSqlIdentifier(kind, namespace)}.${quoteSqlIdentifier(kind, relation)}`,
    alias_placeholder: "{{alias}}",
  };
}

function normalizeColumn(value, field) {
  const input = asObject(value, field);
  return {
    name: asString(input.name, `${field}.name`),
    type: asString(input.type, `${field}.type`),
    nullable: asBoolean(input.nullable, `${field}.nullable`, false),
    default: asString(input.default, `${field}.default`, { optional: true, allowEmpty: true }),
    comment: asString(input.comment, `${field}.comment`, { optional: true, allowEmpty: true }),
    isPrimary: asBoolean(input.is_primary, `${field}.is_primary`, false),
    isUnique: asBoolean(input.is_unique, `${field}.is_unique`, false),
    isIndex: asBoolean(input.is_index, `${field}.is_index`, false),
    isSortKey: asBoolean(input.is_sort_key, `${field}.is_sort_key`, false),
    isPartitionKey: asBoolean(input.is_partition_key, `${field}.is_partition_key`, false),
  };
}

function normalizeIndex(value, field, columns) {
  const input = asObject(value, field);
  const indexColumns = asArray(input.columns, `${field}.columns`, { required: true })
    .map((entry, index) => asString(entry, `${field}.columns[${index}]`));
  if (!indexColumns.length) {
    throw new DbExplainError(`${field}.columns must not be empty.`, "invalid_dbexplain_json", { field: `${field}.columns` });
  }
  indexColumns.forEach((column) => {
    if (!columns.has(column)) {
      throw new DbExplainError(`${field} references unknown column ${column}.`, "invalid_index_column", { field, column });
    }
  });
  return {
    name: asString(input.name, `${field}.name`),
    columns: indexColumns,
    unique: asBoolean(input.unique, `${field}.unique`, false),
    type: asString(input.type, `${field}.type`, { optional: true, allowEmpty: true }),
  };
}

function normalizeOpStats(value, field) {
  if (value === undefined || value === null) return null;
  const input = asObject(value, field);
  const out = {};
  [
    "seq_scan", "idx_scan", "n_tup_ins", "n_tup_upd", "n_tup_del",
    "query_count", "keyspace_hits", "keyspace_misses", "ops_per_sec",
  ].forEach((key) => {
    const normalized = numericText(input[key], `${field}.${key}`, { nonNegative: true });
    if (normalized !== null) out[key] = normalized;
  });
  const average = numericText(input.avg_duration_ms, `${field}.avg_duration_ms`, { nonNegative: true, decimal: true });
  if (average !== null) out.avg_duration_ms = average;
  return Object.keys(out).length ? out : null;
}

function normalizeSnapshot(text, options) {
  let parsed;
  try {
    // lossless-json 4.3.1 misses duplicate keys when both values are arrays or
    // objects. js-yaml's safe JSON schema provides the complete mapping-key
    // check; its parsed values are discarded so large integers stay lossless.
    yaml.load(String(text), { schema: yaml.JSON_SCHEMA, json: false });
    parsed = parseLosslessJson(String(text), null, {
      onDuplicateKey: ({ key, position }) => {
        throw new SyntaxError(`Duplicate JSON key ${JSON.stringify(key)} at position ${position}.`);
      },
    });
  } catch (error) {
    throw new DbExplainError(`dbexplain returned invalid JSON: ${error.message}`, "invalid_dbexplain_json");
  }
  const input = asObject(parsed, "root");
  const selectedLabels = new Set((options && options.selectedLabels) || []);
  const diagnostics = [];
  const tableLookup = new Map();
  const instances = [];
  const labels = new Set();

  asArray(input.instances, "instances", { required: true }).forEach((instanceValue, instanceIndex) => {
    const field = `instances[${instanceIndex}]`;
    const instanceInput = asObject(instanceValue, field);
    const label = asString(instanceInput.label, `${field}.label`);
    const kind = asString(instanceInput.kind, `${field}.kind`).toLowerCase();
    if (!SQL_KINDS.has(kind)) {
      throw new DbExplainError(`Unsupported dbexplain source kind in SQL Bundle: ${kind}`, "unsupported_dbexplain_kind", { label, kind });
    }
    if (!QUERY_BINDING_KINDS.has(kind)) {
      throw new DbExplainError(`Query-ready SQL binding is not implemented for database kind: ${kind}`, "unsupported_sql_binding_dialect", { label, kind });
    }
    if (labels.has(label)) {
      throw new DbExplainError(`Duplicate dbexplain instance label: ${label}`, "duplicate_instance_label", { label });
    }
    labels.add(label);
    const databaseNames = new Set();
    const databases = [];
    asArray(instanceInput.databases, `${field}.databases`).forEach((databaseValue, databaseIndex) => {
      const databaseField = `${field}.databases[${databaseIndex}]`;
      const databaseInput = asObject(databaseValue, databaseField);
      const sourceDatabaseName = asString(databaseInput.name, `${databaseField}.name`);
      if (databaseNames.has(sourceDatabaseName)) {
        throw new DbExplainError(`Duplicate database identity: ${label}/${sourceDatabaseName}`, "duplicate_database_identity", { label, database: sourceDatabaseName });
      }
      databaseNames.add(sourceDatabaseName);
      const databaseName = databaseConceptName(kind, sourceDatabaseName);
      const tableNames = new Set();
      const tables = [];
      const rawTables = asArray(databaseInput.tables, `${databaseField}.tables`);
      const declaredTableCount = safeCount(databaseInput.table_count, `${databaseField}.table_count`);
      if (declaredTableCount !== null && declaredTableCount !== rawTables.length) {
        throw new DbExplainError(`table_count does not match tables for ${label}/${databaseName}.`, "table_count_mismatch", {
          label,
          database: databaseName,
          declared: declaredTableCount,
          actual: rawTables.length,
        });
      }
      rawTables.forEach((tableValue, tableIndex) => {
        const tableField = `${databaseField}.tables[${tableIndex}]`;
        const tableInput = asObject(tableValue, tableField);
        const tableName = asString(tableInput.name, `${tableField}.name`);
        if (tableNames.has(tableName)) {
          throw new DbExplainError(`Duplicate table identity: ${label}/${databaseName}/${tableName}`, "duplicate_table_identity", {
            label,
            database: databaseName,
            table: tableName,
          });
        }
        tableNames.add(tableName);
        const columnNames = new Set();
        const columns = asArray(tableInput.columns, `${tableField}.columns`).map((columnValue, columnIndex) => {
          const column = normalizeColumn(columnValue, `${tableField}.columns[${columnIndex}]`);
          if (columnNames.has(column.name)) {
            throw new DbExplainError(`Duplicate column identity: ${label}/${databaseName}/${tableName}/${column.name}`, "duplicate_column_identity", {
              label,
              database: databaseName,
              table: tableName,
              column: column.name,
            });
          }
          columnNames.add(column.name);
          return column;
        });
        const indexNames = new Set();
        const indexes = asArray(tableInput.indexes, `${tableField}.indexes`).map((indexValue, indexIndex) => {
          const index = normalizeIndex(indexValue, `${tableField}.indexes[${indexIndex}]`, columnNames);
          if (indexNames.has(index.name)) {
            throw new DbExplainError(`Duplicate index identity: ${label}/${databaseName}/${tableName}/${index.name}`, "duplicate_index_identity", {
              label,
              database: databaseName,
              table: tableName,
              index: index.name,
            });
          }
          indexNames.add(index.name);
          return index;
        });
        // Index collection order carries no schema meaning (names are unique per
        // table), so sort by name for deterministic digests. Column order inside
        // each index is physical and must stay untouched.
        indexes.sort((left, right) => compareText(left.name, right.name));
        const binding = sqlBinding(kind, label, sourceDatabaseName, tableName);
        columns.forEach((column) => {
          column.sqlIdentifier = quoteSqlIdentifier(kind, column.name);
          column.sqlReferenceTemplate = `{{alias}}.${column.sqlIdentifier}`;
        });
        const identity = tableIdentity(label, databaseName, tableName);
        const sourceIdentity = tableIdentity(label, sourceDatabaseName, tableName);
        const table = {
          identity,
          path: objectPath("table", identity, tableName),
          label,
          kind,
          database: databaseName,
          sourceDatabase: sourceDatabaseName,
          sourceName: tableName,
          name: tableName,
          sqlBinding: binding,
          comment: asString(tableInput.comment, `${tableField}.comment`, { optional: true, allowEmpty: true }),
          engine: asString(tableInput.engine, `${tableField}.engine`, { optional: true, allowEmpty: true }),
          rowCount: numericText(tableInput.row_count, `${tableField}.row_count`, { nonNegative: true, allowUnknownMinusOne: true }),
          sizeBytes: numericText(tableInput.size_bytes, `${tableField}.size_bytes`, { nonNegative: true }),
          partitionKey: asString(tableInput.partition_key, `${tableField}.partition_key`, { optional: true, allowEmpty: true }),
          orderByKey: asString(tableInput.order_by_key, `${tableField}.order_by_key`, { optional: true, allowEmpty: true }),
          columns,
          indexes,
          foreignKeys: [],
          opStats: normalizeOpStats(tableInput.op_stats, `${tableField}.op_stats`),
        };
        table._rawForeignKeys = asArray(tableInput.foreign_keys, `${tableField}.foreign_keys`);
        tableLookup.set(tableKey(sourceIdentity), table);
        tables.push(table);
      });
      databases.push({
        identity: { instance: label, database: databaseName },
        path: objectPath("database", { instance: label, database: databaseName }, databaseName),
        label,
        kind,
        name: databaseName,
        sourceName: sourceDatabaseName,
        tables,
      });
    });
    instances.push({
      identity: { instance: label },
      path: objectPath("instance", { instance: label }, label),
      label,
      kind,
      databases,
    });
  });

  if (!instances.length) {
    throw new DbExplainError("dbexplain collection returned no SQL instances.", "empty_dbexplain_snapshot");
  }
  if (selectedLabels.size) {
    const missing = Array.from(selectedLabels).filter((label) => !labels.has(label)).sort(compareText);
    if (missing.length) {
      throw new DbExplainError("dbexplain collection omitted selected instances.", "missing_selected_instances", { missing });
    }
  }

  const declaredRelationships = new Map();
  instances.forEach((instance) => instance.databases.forEach((database) => database.tables.forEach((table) => {
    table._rawForeignKeys.forEach((foreignKeyValue, foreignKeyIndex) => {
      const field = `foreign_keys(${table.label}/${table.sourceDatabase}/${table.sourceName})[${foreignKeyIndex}]`;
      const inputForeignKey = asObject(foreignKeyValue, field);
      const fromColumns = asArray(inputForeignKey.columns, `${field}.columns`, { required: true })
        .map((value, index) => asString(value, `${field}.columns[${index}]`));
      const toColumns = asArray(inputForeignKey.ref_columns, `${field}.ref_columns`, { required: true })
        .map((value, index) => asString(value, `${field}.ref_columns[${index}]`));
      if (!fromColumns.length || fromColumns.length !== toColumns.length) {
        throw new DbExplainError(`${field} must have matching non-empty source and target columns.`, "invalid_foreign_key", { field });
      }
      const ownColumns = new Set(table.columns.map((column) => column.name));
      fromColumns.forEach((column) => {
        if (!ownColumns.has(column)) {
          throw new DbExplainError(`${field} references unknown source column ${column}.`, "invalid_foreign_key", { field, column });
        }
      });
      const targetIdentity = tableIdentity(
        asString(inputForeignKey.ref_instance, `${field}.ref_instance`, { optional: true, allowEmpty: true }) || table.label,
        asString(inputForeignKey.ref_db, `${field}.ref_db`, { optional: true, allowEmpty: true }) || table.sourceDatabase,
        asString(inputForeignKey.ref_table, `${field}.ref_table`),
      );
      const target = resolveCollectedTable(tableLookup, targetIdentity);
      if (!target) {
        throw new DbExplainError(`${field} points to an unknown target table.`, "unresolved_foreign_key", { field, target: targetIdentity });
      }
      const targetColumns = new Set(target.columns.map((column) => column.name));
      toColumns.forEach((column) => {
        if (!targetColumns.has(column)) {
          throw new DbExplainError(`${field} references unknown target column ${column}.`, "invalid_foreign_key", { field, column });
        }
      });
      const identity = relationshipIdentity("declared", table.identity, fromColumns, target.identity, toColumns);
      const key = canonicalJson(identity);
      const relationship = declaredRelationships.get(key) || {
        identity,
        path: objectPath("declared_relationship", identity, `${table.name}-to-${target.name}`),
        from: table,
        fromColumns,
        to: target,
        toColumns,
        constraints: [],
      };
      relationship.constraints.push({
        name: asString(inputForeignKey.name, `${field}.name`, { optional: true, allowEmpty: true }),
        onDelete: asString(inputForeignKey.on_delete, `${field}.on_delete`, { optional: true, allowEmpty: true }),
        onUpdate: asString(inputForeignKey.on_update, `${field}.on_update`, { optional: true, allowEmpty: true }),
      });
      declaredRelationships.set(key, relationship);
      table.foreignKeys.push({ identity, target: target.identity });
    });
    // Foreign key collection order carries no schema meaning; canonicalize by
    // relationship identity so equivalent snapshots produce identical models.
    table.foreignKeys.sort((left, right) => compareIdentity(left.identity, right.identity));
    delete table._rawForeignKeys;
  })));

  declaredRelationships.forEach((relationship) => {
    relationship.constraints.sort(compareIdentity);
  });

  const inferredRelationships = new Map();
  asArray(input.refs, "refs").forEach((referenceValue, referenceIndex) => {
    const field = `refs[${referenceIndex}]`;
    const reference = asObject(referenceValue, field);
    const from = tableIdentity(
      asString(reference.from_instance, `${field}.from_instance`),
      asString(reference.from_db, `${field}.from_db`),
      asString(reference.from_table, `${field}.from_table`),
    );
    const to = tableIdentity(
      asString(reference.to_instance, `${field}.to_instance`),
      asString(reference.to_db, `${field}.to_db`),
      asString(reference.to_table, `${field}.to_table`),
    );
    const fromTable = resolveCollectedTable(tableLookup, from);
    const toTable = resolveCollectedTable(tableLookup, to);
    if (!fromTable || !toTable) {
      throw new DbExplainError(`${field} points to an unknown table.`, "unresolved_reference", { field, from, to });
    }
    const fromColumns = splitColumns(reference.from_col, `${field}.from_col`);
    const toColumns = splitColumns(reference.to_col, `${field}.to_col`);
    if (fromColumns.length !== toColumns.length) {
      throw new DbExplainError(`${field} has mismatched source and target columns.`, "invalid_reference", { field });
    }
    const fromColumnNames = new Set(fromTable.columns.map((column) => column.name));
    const toColumnNames = new Set(toTable.columns.map((column) => column.name));
    fromColumns.forEach((column) => {
      if (!fromColumnNames.has(column)) throw new DbExplainError(`${field} references unknown source column ${column}.`, "invalid_reference", { field, column });
    });
    toColumns.forEach((column) => {
      if (!toColumnNames.has(column)) throw new DbExplainError(`${field} references unknown target column ${column}.`, "invalid_reference", { field, column });
    });
    const inferred = asBoolean(reference.inferred, `${field}.inferred`, false);
    const identity = relationshipIdentity(
      inferred ? "inferred" : "declared",
      fromTable.identity,
      fromColumns,
      toTable.identity,
      toColumns,
    );
    const key = canonicalJson(identity);
    if (!inferred) {
      if (!declaredRelationships.has(key)) {
        throw new DbExplainError(`${field} declared reference does not match a table foreign key.`, "declared_reference_mismatch", { field, identity });
      }
      return;
    }
    const confidenceText = numericText(reference.confidence, `${field}.confidence`, { nonNegative: true });
    const confidence = confidenceText === null ? 0 : Number(confidenceText);
    if (!Number.isSafeInteger(confidence) || confidence > 100) {
      throw new DbExplainError(`${field}.confidence must be an integer from 0 through 100.`, "invalid_reference_confidence", { field });
    }
    const existing = inferredRelationships.get(key) || {
      identity,
      path: objectPath("inferred_relationship", identity, `${fromTable.name}-to-${toTable.name}`),
      from: fromTable,
      fromColumns,
      to: toTable,
      toColumns,
      confidences: [],
    };
    existing.confidences.push(confidence);
    existing.confidences = Array.from(new Set(existing.confidences)).sort((left, right) => left - right);
    inferredRelationships.set(key, existing);
  });

  const issueLookup = new Map();
  tableLookup.forEach((table) => {
    const qualified = `${table.label}/${table.sourceDatabase}/${table.sourceName}`;
    if (!issueLookup.has(qualified)) issueLookup.set(qualified, []);
    issueLookup.get(qualified).push(table);
  });
  const orphanIssues = [];
  asArray(input.issues, "issues").forEach((issueValue, issueIndex) => {
    const field = `issues[${issueIndex}]`;
    const issue = asObject(issueValue, field);
    const normalized = {
      severity: asString(issue.severity, `${field}.severity`),
      table: asString(issue.table, `${field}.table`),
      message: asString(issue.message, `${field}.message`),
    };
    const matches = issueLookup.get(normalized.table) || [];
    if (matches.length === 1) {
      matches[0].issues = (matches[0].issues || []).concat(normalized);
    } else {
      orphanIssues.push(normalized);
    }
  });

  const metrics = asArray(input.metrics, "metrics").map((metricValue, metricIndex) => {
    const field = `metrics[${metricIndex}]`;
    const metric = asObject(metricValue, field);
    return {
      label: asString(metric.label, `${field}.label`),
      kind: asString(metric.kind, `${field}.kind`),
      success: asBoolean(metric.success, `${field}.success`, false),
      databases: safeCount(metric.num_databases, `${field}.num_databases`) || 0,
      tables: safeCount(metric.num_tables, `${field}.num_tables`) || 0,
    };
  }).sort((left, right) => compareText(left.label, right.label));
  const failed = metrics.filter((metric) => !metric.success).map((metric) => ({ label: metric.label, kind: metric.kind }));
  if (failed.length) {
    throw new DbExplainError("dbexplain reported failed collection attempts; refusing to deprecate existing knowledge.", "incomplete_dbexplain_collection", { failed });
  }

  const groups = asArray(input.groups, "groups").map((groupValue, groupIndex) => {
    const field = `groups[${groupIndex}]`;
    const group = asObject(groupValue, field);
    const tables = asArray(group.tables, `${field}.tables`).map((entryValue, entryIndex) => {
      const entry = asObject(entryValue, `${field}.tables[${entryIndex}]`);
      const sourceIdentity = tableIdentity(
        asString(entry.instance, `${field}.tables[${entryIndex}].instance`),
        asString(entry.db, `${field}.tables[${entryIndex}].db`),
        asString(entry.table, `${field}.tables[${entryIndex}].table`),
      );
      const table = resolveCollectedTable(tableLookup, sourceIdentity);
      if (!table) {
        throw new DbExplainError(`${field} references an unknown table.`, "invalid_topology_group", { field, identity: sourceIdentity });
      }
      return table.identity;
    }).sort(compareIdentity);
    return { name: asString(group.name, `${field}.name`), tables };
  }).sort(compareIdentity);

  instances.sort((left, right) => compareText(left.label, right.label));
  instances.forEach((instance) => {
    instance.databases.sort((left, right) => compareText(left.name, right.name));
    instance.databases.forEach((database) => database.tables.sort((left, right) => compareText(left.name, right.name)));
  });
  const tables = instances.flatMap((instance) => instance.databases.flatMap((database) => database.tables));
  const model = {
    instances,
    tables,
    declaredRelationships: Array.from(declaredRelationships.values()).sort((left, right) => compareIdentity(left.identity, right.identity)),
    inferredRelationships: Array.from(inferredRelationships.values()).sort((left, right) => compareIdentity(left.identity, right.identity)),
    groups,
    metrics,
    orphanIssues,
    diagnostics,
  };
  assignModelPaths(model);
  return model;
}

function sanitizeProcessText(value, secrets) {
  let text = String(value || "");
  (secrets || []).filter(Boolean).forEach((secret) => {
    text = text.split(String(secret)).join("<redacted>");
  });
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]*)@/gi, "$1<redacted>:<redacted>@")
    .replace(/([?&](?:password|passwd|pwd|token|secret)=)[^&\s]+/gi, "$1<redacted>");
}

function runProcess(binary, args, options) {
  const runner = options && options.spawnSync ? options.spawnSync : spawnSync;
  const result = runner(binary, args, {
    encoding: "utf8",
    env: options && options.env ? options.env : process.env,
    cwd: options && options.cwd ? options.cwd : process.cwd(),
    maxBuffer: MAX_CAPTURE_BYTES,
    timeout: options && options.timeoutMs ? options.timeoutMs : 15 * 60 * 1000,
    windowsHide: true,
  });
  if (result.error) {
    const message = result.error.code === "ENOENT"
      ? `dbexplain executable was not found: ${binary}`
      : `Could not run dbexplain: ${result.error.message}`;
    throw new DbExplainError(sanitizeProcessText(message, options && options.secrets), "dbexplain_process_error");
  }
  if (result.status !== 0 && !(options && options.allowNonZero)) {
    const detail = sanitizeProcessText(result.stderr || result.stdout, options && options.secrets).trim();
    throw new DbExplainError(`dbexplain exited with status ${result.status}${detail ? `: ${detail}` : ""}`, "dbexplain_process_failed", {
      status: result.status,
    });
  }
  return {
    status: result.status,
    stdout: String(result.stdout || ""),
    stderr: sanitizeProcessText(result.stderr || "", options && options.secrets),
  };
}

function parseOrdinaryJson(text, label) {
  try {
    return JSON.parse(String(text));
  } catch (error) {
    throw new DbExplainError(`${label} returned invalid JSON: ${error.message}`, "invalid_dbexplain_output");
  }
}

function parseDbExplainVersion(value) {
  const text = String(value || "").trim().replace(/^dbexplain\s+/i, "");
  const match = text.match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) {
    throw new DbExplainError(
      `Could not parse dbexplain version ${JSON.stringify(text || "<empty>")}; minimum supported version is ${MIN_DBEXPLAIN_VERSION.text}.`,
      "unsupported_dbexplain_version",
      { detectedVersion: text || "unknown", minimumVersion: MIN_DBEXPLAIN_VERSION.text },
    );
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    text: `v${match[1]}.${match[2]}.${match[3]}`,
  };
}

function assertSupportedDbExplainVersion(value) {
  const version = parseDbExplainVersion(value);
  const detected = [version.major, version.minor, version.patch];
  const minimum = [MIN_DBEXPLAIN_VERSION.major, MIN_DBEXPLAIN_VERSION.minor, MIN_DBEXPLAIN_VERSION.patch];
  const supported = detected.some((part, index) => part > minimum[index]
    && detected.slice(0, index).every((prior, priorIndex) => prior === minimum[priorIndex]))
    || detected.every((part, index) => part === minimum[index]);
  if (!supported) {
    throw new DbExplainError(
      `dbexplain ${version.text} is too old; install ${MIN_DBEXPLAIN_VERSION.text} or newer.`,
      "unsupported_dbexplain_version",
      { detectedVersion: version.text, minimumVersion: MIN_DBEXPLAIN_VERSION.text },
    );
  }
  return version;
}

function dbexplainCompatibilityError(error, version, capability) {
  if (error instanceof DbExplainError && error.code === "unsupported_dbexplain_version") return error;
  const message = error && error.message ? error.message : String(error);
  const contractFailure = error instanceof DbExplainError && ["invalid_dbexplain_output", "invalid_dbexplain_json"].includes(error.code)
    || /flag provided but not defined|unknown (?:flag|option)|unrecognized (?:flag|option)|usage of /i.test(message);
  if (!contractFailure) return error;
  const detectedVersion = version && version.text ? version.text : "unknown";
  return new DbExplainError(
    `dbexplain ${detectedVersion} does not satisfy the required ${capability} contract. Report this compatibility issue at ${DBEXPLAIN_COMPATIBILITY_ISSUES}.`,
    "unsupported_dbexplain_contract",
    {
      detectedVersion,
      minimumVersion: MIN_DBEXPLAIN_VERSION.text,
      capability,
      issueUrl: DBEXPLAIN_COMPATIBILITY_ISSUES,
      cause: message,
    },
  );
}

function sourceProcessOptions(config, temporaryRoot) {
  const env = Object.assign({}, config.env || process.env);
  const args = [];
  const secrets = [];
  if (config.dbexplainEnv) {
    const envPath = path.resolve(config.dbexplainEnv);
    if (!fs.existsSync(envPath) || !fs.statSync(envPath).isFile()) {
      throw new DbExplainError(`dbexplain env config does not exist: ${envPath}`, "missing_dbexplain_config");
    }
    env.DBPROBE_ENV_FILE = envPath;
  }
  if (config.dbexplainConfig) {
    const configPath = path.resolve(config.dbexplainConfig);
    if (!fs.existsSync(configPath) || !fs.statSync(configPath).isFile()) {
      throw new DbExplainError(`dbexplain JSON config does not exist: ${configPath}`, "missing_dbexplain_config");
    }
    args.push("--config", configPath);
  }
  if (config.dsnEnv) {
    const dsn = String(env[config.dsnEnv] || "");
    if (!dsn) {
      throw new DbExplainError(`Environment variable ${config.dsnEnv} is empty or missing.`, "missing_dsn_environment");
    }
    secrets.push(dsn);
    const dsnConfig = path.join(temporaryRoot, "dsn-config.json");
    fs.writeFileSync(dsnConfig, JSON.stringify([dsn]) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    args.push("--config", dsnConfig);
  }
  const sources = [config.dbexplainEnv, config.dbexplainConfig, config.dsnEnv].filter(Boolean);
  if (sources.length > 1) {
    throw new DbExplainError("Use only one of --dbexplain-env, --dbexplain-config, or --dsn-env.", "conflicting_dbexplain_sources");
  }
  return { env, args, secrets };
}

function selectConfiguredInstances(entries, config) {
  const include = new Set(String(config.include || "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean));
  const exclude = new Set(String(config.exclude || "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean));
  const seen = new Set();
  const selected = [];
  (entries || []).forEach((entry) => {
    const label = String(entry && entry.label || "");
    const kind = String(entry && entry.kind || "").toLowerCase();
    if (!SQL_KINDS.has(kind)) return;
    const database = String(entry && entry.database || "");
    const hostPort = String(entry && entry.hostPort || "");
    const automaticLabel = database && database !== "(n/a)" ? `${hostPort}/${database}` : hostPort;
    if (!/^[A-Za-z0-9_.:-]+$/.test(label)
      || SQL_KINDS.has(label.toLowerCase())
      || (automaticLabel && label === automaticLabel)) {
      throw new DbExplainError(`SQL source requires an explicit stable label using letters, numbers, dot, underscore, colon, or hyphen: ${label || "<missing>"}`, "unstable_instance_label", { label, kind });
    }
    const normalizedLabel = label.toLowerCase();
    if (seen.has(normalizedLabel)) {
      throw new DbExplainError(`Configured dbexplain label is not unique: ${label}`, "duplicate_instance_label", { label });
    }
    seen.add(normalizedLabel);
    const included = !include.size || include.has(normalizedLabel) || include.has(kind);
    const excluded = exclude.has(normalizedLabel) || exclude.has(kind);
    if (included && !excluded) selected.push({ label, kind, database: String(entry.database || "") });
  });
  selected.sort((left, right) => compareText(left.label, right.label));
  if (!selected.length) {
    throw new DbExplainError("No supported SQL database sources matched the selection.", "no_selected_dbexplain_sources");
  }
  const unsupported = selected.filter((entry) => !QUERY_BINDING_KINDS.has(entry.kind));
  if (unsupported.length) {
    throw new DbExplainError(
      "Selected database sources include kinds without a query-ready OKF binding; narrow --include to MySQL, PostgreSQL, GaussDB, SQLite, or Oracle.",
      "unsupported_sql_binding_dialect",
      { sources: unsupported.map((entry) => ({ label: entry.label, kind: entry.kind })) },
    );
  }
  return selected;
}

function dbexplainRuntimeInfo(config) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "okf-dbexplain-runtime-"));
  try {
    fs.chmodSync(temporaryRoot, 0o700);
    const source = sourceProcessOptions(config, temporaryRoot);
    const binary = config.dbexplainBin || "dbexplain";
    const common = {
      env: source.env,
      cwd: config.cwd,
      spawnSync: config.spawnSync,
      secrets: source.secrets,
    };
    const versionResult = runProcess(binary, ["--version"], common);
    const version = assertSupportedDbExplainVersion(versionResult.stdout);
    let inventory;
    try {
      const listResult = runProcess(binary, ["list", "--json", "--log-dir", path.join(temporaryRoot, "logs"), ...source.args], common);
      inventory = parseOrdinaryJson(listResult.stdout, "dbexplain list");
      if (!inventory || !Array.isArray(inventory.entries)) {
        throw new DbExplainError("dbexplain list JSON must contain entries[].", "invalid_dbexplain_output");
      }
    } catch (error) {
      throw dbexplainCompatibilityError(error, version, "list --json");
    }
    const selected = selectConfiguredInstances(inventory.entries, config);
    return {
      binary,
      version: version.text,
      selected,
      inventoryCount: Array.isArray(inventory.entries) ? inventory.entries.length : 0,
      source,
    };
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function inspectDbExplain(config) {
  const runtime = dbexplainRuntimeInfo(config || {});
  return {
    dbexplainVersion: runtime.version,
    supportedKinds: Array.from(QUERY_BINDING_KINDS).sort(compareText),
    configuredSources: runtime.inventoryCount,
    selectedSources: runtime.selected,
  };
}

function checkDbExplain(config) {
  const runtime = dbexplainRuntimeInfo(config || {});
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "okf-dbexplain-check-"));
  try {
    fs.chmodSync(temporaryRoot, 0o700);
    const source = sourceProcessOptions(config || {}, temporaryRoot);
    const results = [];
    runtime.selected.forEach((entry) => {
      let payload;
      try {
        const checked = runProcess(runtime.binary, [
          "check", "--json", "--label", entry.label,
          "--timeout", config.timeout || "20s",
          "--log-dir", path.join(temporaryRoot, "logs"),
          ...source.args,
        ], {
          env: source.env,
          cwd: config.cwd,
          spawnSync: config.spawnSync,
          secrets: source.secrets,
          allowNonZero: true,
        });
        payload = parseOrdinaryJson(checked.stdout, "dbexplain check");
        if (!payload || !Array.isArray(payload.results)) {
          throw new DbExplainError("dbexplain check JSON must contain results[].", "invalid_dbexplain_output");
        }
      } catch (error) {
        throw dbexplainCompatibilityError(error, assertSupportedDbExplainVersion(runtime.version), "check --json");
      }
      (payload.results || []).forEach((result) => results.push({
        label: result.label || entry.label,
        kind: result.kind || entry.kind,
        syntaxOK: Boolean(result.syntaxOK),
        connectionOK: Boolean(result.connOK),
        latency: result.latency || "",
        ...(result.syntaxErr ? { error: sanitizeProcessText(result.syntaxErr, source.secrets) } : {}),
        ...(result.connMsg && !result.connOK ? { error: sanitizeProcessText(result.connMsg, source.secrets) } : {}),
      }));
    });
    const failed = results.filter((result) => !result.syntaxOK || !result.connectionOK);
    return {
      dbexplainVersion: runtime.version,
      valid: failed.length === 0,
      selectedSources: runtime.selected,
      results,
      failed: failed.map((entry) => ({ label: entry.label, kind: entry.kind, error: entry.error || "connection failed" })),
    };
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function collectDbExplain(config) {
  const runtime = dbexplainRuntimeInfo(config || {});
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "okf-dbexplain-collect-"));
  try {
    fs.chmodSync(temporaryRoot, 0o700);
    const source = sourceProcessOptions(config || {}, temporaryRoot);
    const outputPath = path.join(temporaryRoot, "schema.json");
    const contextPath = path.join(temporaryRoot, "context");
    const labels = runtime.selected.map((entry) => entry.label);
    try {
      runProcess(runtime.binary, [
        "collect", "--json", "-o", outputPath,
        "--context", contextPath,
        "--include", labels.join(","),
        "--timeout", config.timeout || "20s",
        "--conn", String(config.conn || 10),
        "--log-dir", path.join(temporaryRoot, "logs"),
        ...source.args,
      ], {
        env: source.env,
        cwd: config.cwd,
        spawnSync: config.spawnSync,
        secrets: source.secrets,
      });
    } catch (error) {
      throw dbexplainCompatibilityError(error, assertSupportedDbExplainVersion(runtime.version), "collect --json --context");
    }
    const text = fs.readFileSync(outputPath, "utf8");
    let model;
    try {
      model = normalizeSnapshot(text, { selectedLabels: labels });
    } catch (error) {
      throw dbexplainCompatibilityError(error, assertSupportedDbExplainVersion(runtime.version), "collect JSON output");
    }
    let summary = null;
    let topology = null;
    let diagnostics = null;
    try {
      summary = parseLosslessJson(fs.readFileSync(path.join(contextPath, "summary.json"), "utf8"));
    } catch (_error) {
      summary = null;
    }
    try {
      topology = parseLosslessJson(fs.readFileSync(path.join(contextPath, "topology.json"), "utf8"));
    } catch (_error) {
      topology = null;
    }
    try {
      diagnostics = parseLosslessJson(fs.readFileSync(path.join(contextPath, "diagnostics.json"), "utf8"));
    } catch (_error) {
      diagnostics = null;
    }
    return {
      dbexplainVersion: runtime.version,
      selectedSources: runtime.selected,
      rawInputSha256: `sha256:${sha256(text)}`,
      model,
      context: { summary, topology, diagnostics },
    };
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function yamlExtension(kind, identity, dbexplainVersion, extra) {
  return Object.assign({
    generator: GENERATOR,
    bundle_format: BUNDLE_FORMAT_VERSION,
    identity_version: IDENTITY_VERSION,
    object_kind: kind,
    identity,
    dbexplain_version: dbexplainVersion,
  }, extra || {});
}

function generatedFrontmatter(kind, identity, dbexplainVersion, generatedAt, values, extra) {
  return Object.assign({}, values, {
    generated: { by: GENERATOR_ACTOR, at: generatedAt },
    generated_file: true,
    dbexplain: yamlExtension(kind, identity, dbexplainVersion, extra),
  });
}

function collectionSources() {
  return [{
    id: "database-bundle-capture",
    resource: "/bundle.md",
    title: "Database Bundle capture",
    author: GENERATOR_ACTOR,
  }];
}

function captureSources() {
  return [{
    id: "dbexplain-collect",
    resource: "urn:dbexplain:collection:selected-sql-databases",
    title: "dbexplain schema collection",
    author: GENERATOR_ACTOR,
  }];
}

function tableResource(table) {
  return `urn:database:${table.label}:${table.database}:table:${table.name}`;
}

function physicalTypeBase(physical) {
  let text = String(physical || "").trim().toLowerCase();
  let wrapper = text.match(/^(?:nullable|lowcardinality)\((.*)\)$/i);
  while (wrapper) {
    text = wrapper[1].trim();
    wrapper = text.match(/^(?:nullable|lowcardinality)\((.*)\)$/i);
  }
  return text
    .replace(/\s+unsigned\b/g, "")
    .replace(/\(\s*\d+(?:\s*,\s*\d+)?(?:\s*,\s*'[^']*')?\s*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function logicalTypeFromPhysical(physical, dialect) {
  const base = physicalTypeBase(physical);
  if ([
    "uuid", "uniqueidentifier", "char", "nchar", "varchar", "nvarchar", "character",
    "character varying", "bpchar", "text", "ntext", "clob", "longtext", "mediumtext",
    "tinytext", "citext", "name", "string", "enum", "set", "json", "jsonb", "xml",
    "varchar2", "nvarchar2", "fixedstring", "ipv4", "ipv6",
  ].includes(base) || base.startsWith("enum") || base.startsWith("set")) {
    return "String";
  }
  if ([
    "tinyint", "smallint", "mediumint", "int", "integer", "bigint", "int2", "int4", "int8",
    "serial", "smallserial", "bigserial", "int16", "int32", "int64", "int128", "int256",
    "uint8", "uint16", "uint32", "uint64", "uint128", "uint256",
  ].includes(base)) {
    return "Integer";
  }
  if (["decimal", "numeric", "number", "money", "smallmoney", "fixed", "decimal32", "decimal64", "decimal128", "decimal256"].includes(base)) return "Decimal";
  if (["float", "double", "real", "float4", "float8", "float32", "float64", "double precision", "binary_float", "binary_double"].includes(base)) return "Float";
  if (["bool", "boolean"].includes(base) || /^bit\(\s*1\s*\)$/i.test(String(physical || "").trim())) return "Boolean";
  if (base === "date" || base === "date32") return dialect === "oracle" ? "DateTime" : "Date";
  if (["time", "timetz", "time without time zone", "time with time zone"].includes(base)) return "Time";
  if ([
    "datetime", "datetime2", "datetime64", "smalldatetime", "timestamp", "timestamp without time zone",
  ].includes(base)) {
    return "DateTime";
  }
  if (["timestamptz", "timestamp with time zone", "timestamp with local time zone", "datetimeoffset"].includes(base)) return "DateTimeTz";
  return "Opaque";
}

function timeRoleFromLogical(logical) {
  return TEMPORAL_LOGICAL_TYPES.has(logical);
}

function sameColumnSet(left, right) {
  return left.length === right.length
    && left.slice().sort(compareText).every((column, index) => column === right.slice().sort(compareText)[index]);
}

function tableHasUniqueKey(table, columns) {
  const keys = [primaryKeyColumns(table), ...uniqueKeyGroups(table)].filter((entry) => entry.length);
  return keys.some((key) => sameColumnSet(key, columns));
}

function joinPredicateTemplate(relationship) {
  const clauses = relationship.fromColumns.map((column, index) => (
    `{{from}}.${quoteSqlIdentifier(relationship.from.kind, column)} = {{to}}.${quoteSqlIdentifier(relationship.to.kind, relationship.toColumns[index])}`
  ));
  return `ON ${clauses.join(" AND ")}`;
}

function joinBinding(relationship, inferred) {
  const sameLabel = relationship.from.label === relationship.to.label;
  const targetUnique = !inferred && tableHasUniqueKey(relationship.to, relationship.toColumns);
  const cardinality = !targetUnique
    ? "unknown"
    : tableHasUniqueKey(relationship.from, relationship.fromColumns) ? "one-to-one" : "many-to-one";
  return {
    version: SQL_BINDING_VERSION,
    executable: !inferred && sameLabel && targetUnique,
    execution_scope: sameLabel ? "same-label" : "cross-label",
    cardinality,
    predicate_template: joinPredicateTemplate(relationship),
    from: {
      table: `/${relationship.from.path}`,
      instance_label: relationship.from.label,
      columns: relationship.fromColumns.map((name) => ({
        name,
        sql_identifier: quoteSqlIdentifier(relationship.from.kind, name),
      })),
    },
    to: {
      table: `/${relationship.to.path}`,
      instance_label: relationship.to.label,
      columns: relationship.toColumns.map((name) => ({
        name,
        sql_identifier: quoteSqlIdentifier(relationship.to.kind, name),
      })),
    },
  };
}

function primaryKeyColumns(table) {
  return table.columns.filter((column) => column.isPrimary).map((column) => column.name);
}

function uniqueKeyGroups(table) {
  const primary = primaryKeyColumns(table);
  const groups = [];
  const seen = new Set();
  const remember = (columns) => {
    if (!columns.length) return;
    const key = canonicalJson(columns);
    if (seen.has(key) || canonicalJson(primary) === key) return;
    seen.add(key);
    groups.push(columns);
  };
  table.indexes.forEach((index) => {
    if (index.unique) remember(index.columns.slice());
  });
  table.columns.forEach((column) => {
    if (column.isUnique) remember([column.name]);
  });
  return groups;
}

function tableAliases(table) {
  return Array.from(new Set([table.name, table.sqlBinding.relation]));
}

function columnKeyLabel(column) {
  const flags = [];
  if (column.isPrimary) flags.push("PK");
  if (column.isUnique) flags.push("UNIQUE");
  if (column.isIndex) flags.push("INDEX");
  if (column.isPartitionKey) flags.push("PARTITION");
  if (column.isSortKey) flags.push("SORT");
  return flags.join(", ");
}

function escapeCell(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, "<br>");
}

function inlineCode(value) {
  const text = String(value === undefined || value === null ? "" : value);
  const runs = text.match(/`+/g) || [];
  const fence = "`".repeat(Math.max(1, ...runs.map((run) => run.length + 1)));
  return `${fence}${text}${fence}`;
}

function markdownLink(title, target) {
  const label = String(title || target).replace(/([\\\[\]])/g, "\\$1");
  return `[${label}](${target})`;
}

function renderInstance(instance, dbexplainVersion, generatedAt) {
  const lines = ["# Databases", ""];
  instance.databases.forEach((database) => {
    lines.push(`* ${markdownLink(database.name, `/${database.path}`)} - ${database.tables.length} table(s).`);
  });
  lines.push("");
  return renderConceptMarkdown({
    path: instance.path,
    frontmatter: generatedFrontmatter("instance", instance.identity, dbexplainVersion, generatedAt, {
      type: "Database Instance",
      title: instance.label,
      description: `${instance.kind} database instance containing ${instance.databases.length} namespace(s).`,
      resource: `urn:database:${instance.label}`,
      tags: ["database", "schema", instance.kind],
      aliases: [instance.label],
      status: "stable",
      sources: collectionSources(),
    }, { engine: instance.kind }),
    body: lines.join("\n"),
  });
}

function databaseTableDirectory(database) {
  if (database.tables.length) return path.posix.dirname(database.tables[0].path);
  const relative = database.path.replace(/^databases\//, "").replace(/\.md$/i, "");
  return `tables/${relative}`;
}

function renderDatabase(database, dbexplainVersion, generatedAt) {
  const tableDirectory = databaseTableDirectory(database);
  const lines = [
    `Part of ${markdownLink(database.label, `/${objectPath("instance", { instance: database.label })}`)}.`,
    "",
    "# Tables",
    "",
    `${database.tables.length} table(s). ${markdownLink("Browse the table catalog", `/${tableDirectory}/`)}.`,
    "",
  ];
  return renderConceptMarkdown({
    path: database.path,
    frontmatter: generatedFrontmatter("database", database.identity, dbexplainVersion, generatedAt, {
      type: "Database Namespace",
      title: `${database.label}/${database.name}`,
      description: `${database.name} namespace containing ${database.tables.length} table(s).`,
      resource: `urn:database:${database.label}:${database.name}`,
      tags: ["database", "schema", database.kind],
      aliases: [database.name],
      status: "stable",
      sources: collectionSources(),
    }, { engine: database.kind }),
    body: lines.join("\n"),
  });
}

function relationshipMap(model) {
  const map = new Map();
  model.declaredRelationships.concat(model.inferredRelationships).forEach((relationship) => {
    [relationship.from, relationship.to].forEach((table) => {
      const key = tableKey(table.identity);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(relationship);
    });
  });
  map.forEach((entries) => entries.sort((left, right) => compareIdentity(left.identity, right.identity)));
  return map;
}

function renderTable(table, relationships, dbexplainVersion, generatedAt) {
  const primary = primaryKeyColumns(table);
  const uniqueKeys = uniqueKeyGroups(table);
  const columns = table.columns.map((column) => {
    const datatype = logicalTypeFromPhysical(column.type, table.kind);
    return {
      name: column.name,
      sql_identifier: column.sqlIdentifier,
      sql_reference_template: column.sqlReferenceTemplate,
      physical_type: column.type,
      datatype,
      default_is_time: timeRoleFromLogical(datatype),
      comment: column.comment || "",
    };
  });
  const binding = Object.assign({}, table.sqlBinding, {
    columns,
    semantic_mapping: OSSIE_PROFILE,
  });
  const lines = [
    "# SQL Binding",
    "",
    `* Binding version: ${inlineCode(binding.version)}`,
    `* Dialect: ${inlineCode(binding.dialect)}`,
    `* Instance label: ${inlineCode(table.label)}`,
    `* Executable source: ${inlineCode(binding.source_sql)}`,
    `* Alias placeholder: ${inlineCode(binding.alias_placeholder)}`,
    `* Row identity: ${primary.length ? primary.map(inlineCode).join(", ") : "row identity unknown"}`,
  ];
  if (uniqueKeys.length) {
    lines.push(`* Unique keys: ${uniqueKeys.map((group) => group.map(inlineCode).join(", ")).join("; ")}`);
  }
  if (primary.length) {
    lines.push(`* Grain: one row per ${primary.map(inlineCode).join(", ")}`);
  }
  lines.push(
    `* Column SQL: replace ${inlineCode(binding.alias_placeholder)} in each schema row with a query-local alias such as ${inlineCode("t0")}.`,
    "",
    "# Schema",
    "",
    "| Column | SQL identifier | SQL reference template | Type | Nullable | Key | Description | Logical type | Time |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  table.columns.forEach((column, index) => {
    const semantic = columns[index];
    lines.push(`| ${escapeCell(inlineCode(column.name))} | ${escapeCell(inlineCode(semantic.sql_identifier))} | ${escapeCell(inlineCode(semantic.sql_reference_template))} | ${escapeCell(inlineCode(column.type))} | ${column.nullable ? "yes" : "no"} | ${escapeCell(columnKeyLabel(column))} | ${escapeCell(column.comment)} | ${semantic.datatype} | ${semantic.default_is_time ? "yes" : "no"} |`);
  });
  lines.push("");
  if (table.indexes.length) {
    lines.push("# Indexes", "", "| Index | Columns | Unique | Type |", "| --- | --- | --- | --- |");
    table.indexes.forEach((index) => {
      lines.push(`| ${escapeCell(inlineCode(index.name))} | ${escapeCell(index.columns.map(inlineCode).join(", "))} | ${index.unique ? "yes" : "no"} | ${escapeCell(index.type)} |`);
    });
    lines.push("");
  }
  if (table.partitionKey || table.orderByKey || table.engine) {
    lines.push("# Physical Layout", "");
    if (table.engine) lines.push(`* Engine: ${inlineCode(table.engine)}`);
    if (table.partitionKey) lines.push(`* Partition key: ${inlineCode(table.partitionKey)}`);
    if (table.orderByKey) lines.push(`* Order key: ${inlineCode(table.orderByKey)}`);
    lines.push("");
  }
  lines.push("# Joins", "");
  if (relationships.length) {
    relationships.forEach((relationship) => {
      const inferred = relationship.identity.kind === "inferred";
      const outgoing = tableKey(relationship.from.identity) === tableKey(table.identity);
      const related = outgoing ? relationship.to : relationship.from;
      const join = joinBinding(relationship, inferred);
      const direction = join.cardinality === "unknown"
        ? "cardinality unknown; do not use automatically"
        : outgoing ? `${join.cardinality} from this table` : `${join.cardinality} into this table`;
      const label = inferred
        ? `${relationship.from.name} -> ${relationship.to.name} (inferred candidate)`
        : `${relationship.from.name} -> ${relationship.to.name}`;
      lines.push(`* ${markdownLink(label, `/${relationship.path}`)} - ${related.name}; ${inferred ? "unverified candidate, do not use automatically" : direction}.`);
    });
  } else {
    lines.push("No documented physical relationships.");
  }
  lines.push("");
  return renderConceptMarkdown({
    path: table.path,
    frontmatter: generatedFrontmatter("table", table.identity, dbexplainVersion, generatedAt, {
      type: "Database Table",
      title: `${table.database}.${table.name}`,
      description: table.comment || `${table.name} table in ${table.database}.`,
      resource: tableResource(table),
      tags: ["database", "schema", "table", table.kind, table.database],
      aliases: tableAliases(table),
      status: "stable",
      sources: collectionSources(),
    }, {
      engine: table.engine || "",
      sql_binding: binding,
    }),
    body: lines.join("\n"),
  });
}

function renderDeclaredRelationship(relationship, dbexplainVersion, generatedAt) {
  const binding = joinBinding(relationship, false);
  const lines = [
    "# Endpoints",
    "",
    `* Cardinality: ${binding.cardinality}.`,
    `* Execution scope: ${binding.execution_scope}.`,
    `* Executable automatically: ${binding.executable ? "yes" : "no"}.`,
    `* From: ${markdownLink(relationship.from.name, `/${relationship.from.path}`)} columns ${relationship.fromColumns.map(inlineCode).join(", ")}.`,
    `* To: ${markdownLink(relationship.to.name, `/${relationship.to.path}`)} columns ${relationship.toColumns.map(inlineCode).join(", ")}.`,
    "",
    "# Join Template",
    "",
    "```sql",
    binding.predicate_template,
    "```",
    "",
    "Replace `{{from}}` and `{{to}}` with the query-local aliases assigned to the endpoint tables.",
    "",
    "# Declared Constraints",
    "",
  ];
  relationship.constraints.forEach((constraint) => {
    const properties = [constraint.onDelete && `ON DELETE ${constraint.onDelete}`, constraint.onUpdate && `ON UPDATE ${constraint.onUpdate}`].filter(Boolean);
    lines.push(`* ${constraint.name ? inlineCode(constraint.name) : "Unnamed constraint"}${properties.length ? ` - ${properties.join(", ")}` : ""}`);
  });
  lines.push("");
  return renderConceptMarkdown({
    path: relationship.path,
    frontmatter: generatedFrontmatter("declared_relationship", relationship.identity, dbexplainVersion, generatedAt, {
      type: "Physical Database Relationship",
      title: `${relationship.from.name} to ${relationship.to.name}`,
      description: "A foreign key relationship declared by the database schema.",
      tags: ["database", "relationship", "foreign-key", "declared"],
      status: "stable",
      sources: collectionSources(),
    }, {
      evidence: "declared_fk",
      cardinality: binding.cardinality,
      from_columns: relationship.fromColumns,
      to_columns: relationship.toColumns,
      constraints: relationship.constraints,
      join_binding: binding,
    }),
    body: lines.join("\n"),
  });
}

function renderInferredRelationship(relationship, dbexplainVersion, generatedAt) {
  const confidence = Math.max(...relationship.confidences);
  const binding = joinBinding(relationship, true);
  const lines = [
    "# Candidate Relationship",
    "",
    "* Cardinality: unknown. This candidate is not an approved business join.",
    `* Execution scope: ${binding.execution_scope}.`,
    `* From: ${markdownLink(relationship.from.name, `/${relationship.from.path}`)} columns ${relationship.fromColumns.map(inlineCode).join(", ")}.`,
    `* To: ${markdownLink(relationship.to.name, `/${relationship.to.path}`)} columns ${relationship.toColumns.map(inlineCode).join(", ")}.`,
    `* dbexplain confidence: ${confidence}/100.`,
    "",
    "# Candidate Join Template",
    "",
    "```sql",
    binding.predicate_template,
    "```",
    "",
    "This is a deterministic naming-based candidate. Do not use it automatically when assembling SQL.",
    "",
  ];
  return renderConceptMarkdown({
    path: relationship.path,
    frontmatter: generatedFrontmatter("inferred_relationship", relationship.identity, dbexplainVersion, generatedAt, {
      type: "Physical Database Relationship",
      title: `${relationship.from.name} to ${relationship.to.name} (inferred)`,
      description: "An unverified physical-reference candidate inferred by dbexplain.",
      tags: ["database", "relationship", "inferred", "unverified"],
      status: "draft",
      sources: collectionSources(),
    }, {
      evidence: "inferred_ref",
      cardinality: "unknown",
      from_columns: relationship.fromColumns,
      to_columns: relationship.toColumns,
      confidence,
      observed_confidences: relationship.confidences,
      join_binding: binding,
    }),
    body: lines.join("\n"),
  });
}

function renderTableObservation(table, dbexplainVersion, generatedAt) {
  const identity = { table: table.identity };
  const observationPath = tableObservationPath(table);
  const lines = [
    `Current observations for ${markdownLink(table.name, `/${table.path}`)}.`,
    "",
    "# Operational Facts",
    "",
  ];
  if (table.rowCount !== null) lines.push(`* Row count: ${inlineCode(table.rowCount)}.`);
  if (table.sizeBytes !== null) lines.push(`* Size in bytes: ${inlineCode(table.sizeBytes)}.`);
  if (table.opStats) {
    Object.entries(table.opStats).sort((left, right) => compareText(left[0], right[0])).forEach(([key, value]) => {
      lines.push(`* ${key}: ${inlineCode(value)}.`);
    });
  }
  if (table.issues && table.issues.length) {
    lines.push("", "# Diagnostics", "");
    table.issues.slice().sort(compareIdentity).forEach((issue) => {
      lines.push(`* **${escapeCell(issue.severity)}**: ${escapeCell(issue.message)}`);
    });
  }
  if (lines[lines.length - 1] !== "") lines.push("");
  return {
    path: observationPath,
    text: renderConceptMarkdown({
      path: observationPath,
      frontmatter: generatedFrontmatter("table_observation", identity, dbexplainVersion, generatedAt, {
        type: "Table Observation",
        title: `${table.label}/${table.database}/${table.name} observation`,
        description: "Latest dbexplain operational observations and diagnostics for this table.",
        tags: ["database", "observation", table.kind],
        status: "stable",
        sources: collectionSources(),
      }),
      body: lines.join("\n"),
    }),
  };
}

function losslessText(value) {
  if (isLosslessNumber(value)) return value.toString();
  return String(value === undefined || value === null ? "" : value);
}

function resolveTableLocator(sourceTables, locator) {
  const text = losslessText(locator);
  return sourceTables.get(text) || null;
}

function renderDiagnosticCategory(lines, title, issues, sourceTables) {
  if (!Array.isArray(issues) || !issues.length) return;
  lines.push(`## ${title}`, "");
  issues.slice().sort((left, right) => compareText(left.table, right.table) || compareText(left.message, right.message)).forEach((issue) => {
    const table = resolveTableLocator(sourceTables, issue.table);
    const target = table
      ? markdownLink(table.name, `/${table.path}`)
      : escapeCell(issue.table);
    lines.push(`* **${escapeCell(issue.severity)}** ${target}: ${escapeCell(issue.message)}`);
  });
  lines.push("");
}

function renderCurrentObservation(model, context, dbexplainVersion, generatedAt, rawInputSha256) {
  const degrees = new Map(model.tables.map((table) => [tableKey(table.identity), 0]));
  model.declaredRelationships.concat(model.inferredRelationships).forEach((relationship) => {
    degrees.set(tableKey(relationship.from.identity), (degrees.get(tableKey(relationship.from.identity)) || 0) + 1);
    degrees.set(tableKey(relationship.to.identity), (degrees.get(tableKey(relationship.to.identity)) || 0) + 1);
  });
  const largest = model.tables.filter((table) => table.rowCount !== null && table.rowCount !== "-1")
    .sort((left, right) => {
      const a = BigInt(left.rowCount);
      const b = BigInt(right.rowCount);
      return a === b ? compareIdentity(left.identity, right.identity) : a > b ? -1 : 1;
    }).slice(0, 10);
  const connected = model.tables.slice().sort((left, right) => (
    (degrees.get(tableKey(right.identity)) || 0) - (degrees.get(tableKey(left.identity)) || 0)
    || compareIdentity(left.identity, right.identity)
  )).filter((table) => (degrees.get(tableKey(table.identity)) || 0) > 0).slice(0, 10);
  const sourceTables = new Map(model.tables.map((table) => [
    `${table.label}/${table.sourceDatabase}/${table.sourceName}`,
    table,
  ]));
  const tableByKey = new Map(model.tables.map((table) => [tableKey(table.identity), table]));
  // dbexplain core-table locators can contain connection-local database paths
  // (notably SQLite). Resolve them to managed Concepts and never render the raw
  // locator into the Bundle.
  const coreTables = context && context.summary && Array.isArray(context.summary.core_tables)
    ? Array.from(new Set(context.summary.core_tables.map(losslessText)))
      .map((entry) => sourceTables.get(entry))
      .filter(Boolean)
      .sort((left, right) => compareIdentity(left.identity, right.identity))
    : [];
  const topology = context && context.topology ? context.topology : null;
  const diagnostics = context && context.diagnostics ? context.diagnostics : null;
  const isolatedTables = topology && Array.isArray(topology.isolated_tables)
    ? topology.isolated_tables.map((entry) => resolveTableLocator(sourceTables, entry)).filter(Boolean)
      .sort((left, right) => compareIdentity(left.identity, right.identity))
    : [];
  const subgraphs = topology && Array.isArray(topology.subgraphs) ? topology.subgraphs : [];
  const clusters = model.groups
    .map((group) => ({
      name: group.name,
      tables: group.tables.map((identity) => tableByKey.get(tableKey(identity))).filter(Boolean),
    }))
    .filter((group) => group.tables.length >= 2)
    .sort((left, right) => compareText(left.name, right.name));
  const lines = [
    "# Scope",
    "",
    `* Instances: ${model.instances.length}`,
    `* Databases: ${model.instances.reduce((count, instance) => count + instance.databases.length, 0)}`,
    `* Tables: ${model.tables.length}`,
    `* Declared relationships: ${model.declaredRelationships.length}`,
    `* Inferred relationship candidates: ${model.inferredRelationships.length}`,
    `* Input digest: ${inlineCode(rawInputSha256)}`,
    "",
    "* Value dictionaries, joins, and saved SQL belong in overlay folders such as [business](/business/), [queries](/queries/), and [references](/references/). Observations are counts and diagnostics only; they are not sample rows.",
    "",
  ];
  if (coreTables.length) {
    lines.push("# dbexplain Core Tables", "");
    coreTables.forEach((table) => lines.push(`* ${markdownLink(table.name, `/${table.path}`)}`));
    lines.push("");
  }
  if (clusters.length) {
    lines.push("# Table Clusters", "");
    clusters.forEach((group) => {
      lines.push(`## ${escapeCell(group.name)}`, "");
      group.tables.forEach((table) => lines.push(`* ${markdownLink(table.name, `/${table.path}`)}`));
      lines.push("");
    });
  }
  if (subgraphs.length) {
    lines.push("# Topology Subgraphs", "");
    subgraphs.slice().sort((left, right) => compareText(left.name, right.name)).forEach((subgraph) => {
      lines.push(`## ${escapeCell(subgraph.name)}`, "");
      (Array.isArray(subgraph.tables) ? subgraph.tables : []).forEach((entry) => {
        const table = resolveTableLocator(sourceTables, entry);
        lines.push(`* ${table ? markdownLink(table.name, `/${table.path}`) : escapeCell(losslessText(entry))}`);
      });
      lines.push("");
    });
  }
  if (isolatedTables.length) {
    lines.push("# Isolated Tables", "");
    isolatedTables.forEach((table) => lines.push(`* ${markdownLink(table.name, `/${table.path}`)}`));
    lines.push("");
  }
  if (largest.length) {
    lines.push("# Largest Tables", "");
    largest.forEach((table) => lines.push(`* ${markdownLink(table.name, `/${table.path}`)} - ${table.rowCount} row(s).`));
    lines.push("");
  }
  if (connected.length) {
    lines.push("# Highly Connected Tables", "");
    connected.forEach((table) => lines.push(`* ${markdownLink(table.name, `/${table.path}`)} - degree ${degrees.get(tableKey(table.identity))}.`));
    lines.push("");
  }
  if (diagnostics) {
    lines.push("# Categorized Diagnostics", "");
    renderDiagnosticCategory(lines, "Missing primary key", diagnostics.missing_pk, sourceTables);
    renderDiagnosticCategory(lines, "Unindexed foreign keys", diagnostics.unindexed_fk, sourceTables);
    renderDiagnosticCategory(lines, "Wide tables", diagnostics.wide_tables, sourceTables);
    renderDiagnosticCategory(lines, "No timestamp column", diagnostics.no_timestamp, sourceTables);
  }
  if (model.orphanIssues.length) {
    lines.push("# Unscoped Diagnostics", "");
    model.orphanIssues.slice().sort(compareIdentity).forEach((issue) => lines.push(`* **${escapeCell(issue.severity)}**: ${escapeCell(issue.message)}`));
    lines.push("");
  }
  const identity = { observation: "current" };
  return renderConceptMarkdown({
    path: "observations/current.md",
    frontmatter: generatedFrontmatter("current_observation", identity, dbexplainVersion, generatedAt, {
      type: "Database Observation",
      title: "Current Database Observation",
      description: "Latest dbexplain topology, diagnostics, and operational summary.",
      tags: ["database", "observation", "topology"],
      status: "stable",
      sources: collectionSources(),
    }, {
      input_sha256: rawInputSha256,
      core_table_paths: coreTables.map((table) => `/${table.path}`),
      isolated_table_paths: isolatedTables.map((table) => `/${table.path}`),
      table_clusters: clusters.map((group) => ({
        name: group.name,
        tables: group.tables.map((table) => `/${table.path}`),
      })),
    }),
    body: lines.join("\n"),
  });
}

function walkFiles(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const visit = (current, relative) => {
    fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name)).forEach((entry) => {
      const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(current, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        throw new DbExplainError(`Bundle contains a symbolic link: ${entryRelative}`, "unsafe_bundle_target", { path: entryRelative });
      }
      if (stat.isDirectory()) {
        if (entry.name === ".git") {
          throw new DbExplainError("The database Bundle root cannot be a Git repository root; use a dedicated subdirectory.", "unsafe_bundle_target");
        }
        if (entry.name.startsWith(".")) {
          throw new DbExplainError(`Bundle contains an unsupported hidden directory: ${entryRelative}`, "unsafe_bundle_target", { path: entryRelative });
        }
        visit(absolute, entryRelative);
      } else if (stat.isFile()) {
        out.push({ path: entryRelative, absolute, mode: stat.mode });
      } else {
        throw new DbExplainError(`Bundle contains an unsupported filesystem entry: ${entryRelative}`, "unsafe_bundle_target", { path: entryRelative });
      }
    });
  };
  visit(root, "");
  return out;
}

function readExistingBundle(root) {
  const files = new Map();
  const concepts = new Map();
  const preserved = new Map();
  const overlay = new Map();
  if (!fs.existsSync(root)) {
    return { files, concepts, preserved, overlay, rootMode: 0o755, targetDigest: `sha256:${sha256("[]")}` };
  }
  const rootStat = fs.statSync(root);
  if (!rootStat.isDirectory()) {
    throw new DbExplainError(`Bundle root is not a directory: ${root}`, "unsafe_bundle_target");
  }
  walkFiles(root).forEach((entry) => {
    if (entry.path === ".okf-knowledge.json") {
      preserved.set(entry.path, fs.readFileSync(entry.absolute));
      return;
    }
    if (entry.path.startsWith(".")) {
      throw new DbExplainError(`Bundle contains an unsupported control file: ${entry.path}`, "unsafe_bundle_target", { path: entry.path });
    }
    if (overlayRoot(entry.path)) {
      const bytes = fs.readFileSync(entry.absolute);
      overlay.set(entry.path, { bytes, mode: entry.mode & 0o777 });
      if (entry.path.toLowerCase().endsWith(".md")) {
        const text = bytes.toString("utf8");
        files.set(entry.path, text);
        if (!reservedMarkdownName(entry.path)) {
          let split;
          try {
            split = splitFrontmatter(text);
          } catch (error) {
            throw new DbExplainError(`Overlay concept is invalid: ${entry.path}: ${error.message}`, "invalid_overlay_concept", { path: entry.path });
          }
          if (!split.frontmatter || !String(split.frontmatter.type || "").trim()) {
            throw new DbExplainError(`Overlay concept is missing type: ${entry.path}`, "invalid_overlay_concept", { path: entry.path });
          }
          validateSemanticOverlayShape(split.frontmatter, entry.path);
        }
      }
      return;
    }
    if (!entry.path.toLowerCase().endsWith(".md")) {
      throw new DbExplainError(`Dedicated database Bundle contains an unmanaged file: ${entry.path}`, "unmanaged_bundle_content", { path: entry.path });
    }
    const text = fs.readFileSync(entry.absolute, "utf8");
    files.set(entry.path, text);
    if (reservedMarkdownName(entry.path)) return;
    let split;
    try {
      split = splitFrontmatter(text);
    } catch (error) {
      throw new DbExplainError(`Existing managed file is invalid: ${entry.path}: ${error.message}`, "invalid_existing_bundle", { path: entry.path });
    }
    const extension = split.frontmatter && split.frontmatter.dbexplain;
    if (!extension || extension.generator !== GENERATOR || extension.bundle_format !== BUNDLE_FORMAT_VERSION) {
      throw new DbExplainError(`Dedicated database Bundle contains an unmanaged concept: ${entry.path}`, "unmanaged_bundle_content", { path: entry.path });
    }
    if (!MANAGED_OBJECT_KINDS.has(extension.object_kind)) {
      throw new DbExplainError(`Managed concept has an unsupported object kind: ${entry.path}`, "invalid_existing_bundle", { path: entry.path });
    }
    concepts.set(entry.path, { path: entry.path, text, frontmatter: split.frontmatter, body: split.body });
  });
  const managedMarkdown = Array.from(files.keys()).filter((filePath) => !overlayRoot(filePath));
  if (managedMarkdown.length && !concepts.has("bundle.md")) {
    throw new DbExplainError("Non-empty target is not an okf-dbexplain managed Bundle.", "unmanaged_bundle_content");
  }
  return {
    files,
    concepts,
    preserved,
    overlay,
    rootMode: rootStat.mode & 0o777,
    targetDigest: targetDigestFor(files, overlay),
  };
}

function targetDigestFor(files, overlay) {
  const manifest = [];
  files.forEach((text, filePath) => manifest.push({ path: filePath, sha256: sha256(text) }));
  (overlay || new Map()).forEach((entry, filePath) => {
    if (files.has(filePath)) return;
    const bytes = Buffer.isBuffer(entry) ? entry : entry.bytes;
    manifest.push({ path: filePath, sha256: sha256(bytes) });
  });
  manifest.sort((left, right) => compareText(left.path, right.path));
  return `sha256:${sha256(canonicalJson(manifest))}`;
}

function deprecateConcept(existing, generatedAt) {
  const frontmatter = Object.assign({}, existing.frontmatter, {
    status: "deprecated",
    generated: { by: GENERATOR_ACTOR, at: generatedAt },
    dbexplain: Object.assign({}, existing.frontmatter.dbexplain, {
      removed_at: existing.frontmatter.dbexplain.removed_at || generatedAt,
    }),
  });
  if (existing.frontmatter.status === "deprecated" && existing.frontmatter.dbexplain.removed_at) {
    return existing.text;
  }
  return renderConceptMarkdown({ path: existing.path, frontmatter, body: existing.body });
}

function sameConceptIgnoringGeneratedAt(leftText, rightText) {
  try {
    const left = splitFrontmatter(leftText);
    const right = splitFrontmatter(rightText);
    const leftFrontmatter = JSON.parse(JSON.stringify(left.frontmatter));
    const rightFrontmatter = JSON.parse(JSON.stringify(right.frontmatter));
    if (leftFrontmatter.generated) delete leftFrontmatter.generated.at;
    if (rightFrontmatter.generated) delete rightFrontmatter.generated.at;
    return left.body === right.body && canonicalJson(leftFrontmatter) === canonicalJson(rightFrontmatter);
  } catch (_error) {
    return false;
  }
}

function preserveGeneratedAt(existingText, candidateText, filePath) {
  if (!existingText || !sameConceptIgnoringGeneratedAt(existingText, candidateText)) return candidateText;
  const existing = splitFrontmatter(existingText);
  const candidate = splitFrontmatter(candidateText);
  if (!existing.frontmatter.generated || !existing.frontmatter.generated.at) return candidateText;
  const frontmatter = Object.assign({}, candidate.frontmatter, {
    generated: Object.assign({}, candidate.frontmatter.generated, { at: existing.frontmatter.generated.at }),
  });
  return renderConceptMarkdown({ path: filePath, frontmatter, body: candidate.body });
}

function conceptEntries(files) {
  const entries = [];
  files.forEach((text, filePath) => {
    if (!filePath.toLowerCase().endsWith(".md") || path.posix.basename(filePath) === "index.md" || filePath === "log.md") return;
    const split = splitFrontmatter(text);
    if (split.frontmatter && split.frontmatter.dbexplain) {
      entries.push({ path: filePath, frontmatter: split.frontmatter });
    }
  });
  return entries.sort((left, right) => compareText(left.path, right.path));
}

function indexMarkdown(title, entries, directory) {
  const active = entries.filter((entry) => entry.frontmatter.status !== "deprecated");
  const deprecated = entries.filter((entry) => entry.frontmatter.status === "deprecated");
  const lines = [`# ${title}`, ""];
  const append = (heading, values) => {
    if (!values.length) return;
    lines.push(`## ${heading}`, "");
    values.forEach((entry) => {
      const relative = path.posix.relative(directory || ".", entry.path);
      lines.push(`* ${markdownLink(entry.frontmatter.title || path.posix.basename(entry.path, ".md"), relative)}${entry.frontmatter.description ? ` - ${escapeCell(entry.frontmatter.description)}` : ""}`);
    });
    lines.push("");
  };
  append("Current", active);
  append("Deprecated", deprecated);
  if (!active.length && !deprecated.length) lines.push("No concepts in this section.", "");
  return lines.join("\n");
}

function relationshipCatalogMarkdown(title, entries, directory) {
  const groups = new Map();
  entries.forEach((entry) => {
    const identity = entry.frontmatter.dbexplain && entry.frontmatter.dbexplain.identity;
    const from = identity && identity.from || {};
    const group = `${from.instance || "unknown"}/${from.database || "unknown"}`;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(entry);
  });
  const lines = [`# ${title}`, ""];
  Array.from(groups.entries()).sort((left, right) => compareText(left[0], right[0])).forEach(([group, values]) => {
    lines.push(`## ${escapeCell(group)}`, "");
    values.sort((left, right) => compareText(left.path, right.path)).forEach((entry) => {
      const relative = path.posix.relative(directory, entry.path);
      const status = entry.frontmatter.status === "deprecated" ? " (deprecated)" : "";
      lines.push(`* ${markdownLink(entry.frontmatter.title || path.posix.basename(entry.path, ".md"), relative)}${status}`);
    });
    lines.push("");
  });
  if (!entries.length) lines.push("No relationships in this section.", "");
  return lines.join("\n");
}

function directoryIndexMarkdown(title, children) {
  const lines = [`# ${title}`, ""];
  if (!children.length) {
    lines.push("No entries in this section.", "");
    return lines.join("\n");
  }
  children.forEach((child) => {
    lines.push(`* ${markdownLink(child.title, child.href)}${child.description ? ` - ${escapeCell(child.description)}` : ""}`);
  });
  lines.push("");
  return lines.join("\n");
}

function directoryLabel(directory) {
  const segment = path.posix.basename(directory);
  try {
    return decodeURIComponent(segment);
  } catch (_error) {
    return segment;
  }
}

function setTwoLevelConceptIndexes(files, root, entries, labels) {
  const byLeafDirectory = new Map();
  entries.forEach((entry) => {
    const directory = path.posix.dirname(entry.path);
    if (!byLeafDirectory.has(directory)) byLeafDirectory.set(directory, []);
    byLeafDirectory.get(directory).push(entry);
  });
  const byParentDirectory = new Map();
  byLeafDirectory.forEach((values, leafDirectory) => {
    const parentDirectory = path.posix.dirname(leafDirectory);
    if (!byParentDirectory.has(parentDirectory)) byParentDirectory.set(parentDirectory, []);
    byParentDirectory.get(parentDirectory).push({ leafDirectory, values });
    files.set(`${leafDirectory}/index.md`, indexMarkdown(
      `${labels.leaf} ${directoryLabel(leafDirectory)}`,
      values,
      leafDirectory,
    ));
  });
  byParentDirectory.forEach((groups, parentDirectory) => {
    const children = groups.sort((left, right) => compareText(left.leafDirectory, right.leafDirectory)).map((group) => ({
      title: directoryLabel(group.leafDirectory),
      href: `${path.posix.relative(parentDirectory, group.leafDirectory)}/`,
      description: `${group.values.filter((entry) => entry.frontmatter.status !== "deprecated").length} current concept(s).`,
    }));
    files.set(`${parentDirectory}/index.md`, directoryIndexMarkdown(
      `${labels.parent} ${directoryLabel(parentDirectory)}`,
      children,
    ));
  });
  const roots = Array.from(byParentDirectory.entries()).sort((left, right) => compareText(left[0], right[0])).map(([directory, groups]) => ({
    title: directoryLabel(directory),
    href: `${path.posix.relative(root, directory)}/`,
    description: `${groups.reduce((count, group) => count + group.values.length, 0)} concept(s).`,
  }));
  files.set(`${root}/index.md`, directoryIndexMarkdown(labels.root, roots));
}

function setOneLevelConceptIndexes(files, root, entries, labels) {
  const groups = new Map();
  entries.forEach((entry) => {
    const directory = path.posix.dirname(entry.path);
    if (!groups.has(directory)) groups.set(directory, []);
    groups.get(directory).push(entry);
  });
  groups.forEach((values, directory) => {
    files.set(`${directory}/index.md`, indexMarkdown(
      `${labels.child} ${directoryLabel(directory)}`,
      values,
      directory,
    ));
  });
  files.set(`${root}/index.md`, directoryIndexMarkdown(labels.root, Array.from(groups.entries())
    .sort((left, right) => compareText(left[0], right[0]))
    .map(([directory, values]) => ({
      title: directoryLabel(directory),
      href: `${path.posix.relative(root, directory)}/`,
      description: `${values.length} concept(s).`,
    }))));
}

function rootIndexMarkdown(options) {
  const lines = [
    "---",
    'okf_version: "0.2"',
    "---",
    "",
    "# Database Schema Bundle",
    "",
    "* [Bundle identity](bundle.md) - Generator ownership and synchronized scope.",
    "",
    "## Business Knowledge",
    "",
    "* [Business overlay](business/) - Terms, datasets, and approved joins.",
    "* [Metrics](metrics/) - Reviewed measures and expressions.",
    "* [Saved queries](queries/) - Executed and reviewed SQL examples.",
    "* [References](references/) - Enumerations and shared notes.",
    "",
    "## Physical Facts",
    "",
    "* [Instances](instances/) - Configured database instances.",
    "* [Databases](databases/) - Database namespaces and schemas.",
    "* [Tables](tables/) - Current and deprecated table structures.",
    "* [Observations](observations/) - Latest operational facts and diagnostics.",
    "",
    "## Optional Extensions",
    "",
    "* [Policies](policies/) - Index of query rules. Read the folder index first.",
    "* [Computations](computations/) - Index of attested computations. Read the folder index first.",
    "* [Skills](skills/) - Index of consumer skills. Read the folder index first.",
    "* [Attesters](attesters/) - Index of reviewers. Read the folder index first.",
  ];
  if (options && options.relationships) {
    const observationIndex = lines.findIndex((line) => line.includes("](observations/)"));
    lines.splice(observationIndex, 0, "* [Relationships](relationships/) - Declared and inferred physical relationships.");
  }
  lines.push("");
  return lines.join("\n");
}

function relationshipsIndexMarkdown(options) {
  const lines = [
    "# Physical Relationships",
    "",
  ];
  if (options && options.declared) {
    lines.push("* [Declared relationships](declared/) - Foreign keys reported by the database schema.");
  }
  if (options && options.inferred) {
    lines.push("* [Inferred candidates](inferred/) - Unverified naming-based candidates from dbexplain.");
  }
  lines.push("");
  return lines.join("\n");
}

function observationsIndexMarkdown(tableEntries) {
  const lines = [
    "# Database Observations",
    "",
    "* [Current landscape](current.md) - Latest topology and operational summary.",
    "* [Table observations](tables/) - Latest per-table facts and diagnostics.",
    "",
  ];
  if (!tableEntries.length) lines.push("No table observations are available.", "");
  return lines.join("\n");
}

function objectChanges(existing, candidate) {
  const changes = { added: [], updated: [], deprecated: [], restored: [] };
  conceptEntries(candidate).forEach((entry) => {
    const kind = entry.frontmatter.dbexplain.object_kind;
    if (["current_observation", "table_observation", "bundle"].includes(kind)) return;
    const beforeText = existing.files.get(entry.path);
    if (!beforeText) {
      changes.added.push(entry.path);
      return;
    }
    const before = splitFrontmatter(beforeText).frontmatter;
    if (before.status !== "deprecated" && entry.frontmatter.status === "deprecated") changes.deprecated.push(entry.path);
    else if (before.status === "deprecated" && entry.frontmatter.status !== "deprecated") changes.restored.push(entry.path);
    else if (beforeText !== candidate.get(entry.path)) changes.updated.push(entry.path);
  });
  Object.values(changes).forEach((values) => values.sort(compareText));
  return changes;
}

function observationChangeCount(existing, candidate) {
  let count = 0;
  candidate.forEach((text, filePath) => {
    if (filePath === "observations/current.md" || filePath.startsWith("observations/tables/")) {
      if (existing.files.get(filePath) !== text) count += 1;
    }
  });
  return count;
}

function updateLog(existingText, generatedAt, changes, observationChanges) {
  const date = generatedAt.slice(0, 10);
  const time = generatedAt.slice(11);
  const entries = [];
  if (changes.added.length) entries.push(`* **Creation**: Added ${changes.added.length} database structure concept(s) at ${time}.`);
  if (changes.updated.length) entries.push(`* **Update**: Updated ${changes.updated.length} database structure concept(s) at ${time}.`);
  if (changes.deprecated.length) entries.push(`* **Deprecation**: Marked ${changes.deprecated.length} missing database object(s) deprecated at ${time}.`);
  if (changes.restored.length) entries.push(`* **Restoration**: Restored ${changes.restored.length} database object(s) at ${time}.`);
  if (observationChanges) entries.push(`* **Observation**: Refreshed ${observationChanges} observation concept(s) at ${time}.`);
  if (!entries.length) return existingText || ["# Database Schema Update Log", ""].join("\n");
  const current = existingText || "# Database Schema Update Log\n";
  const heading = `## ${date}`;
  if (current.includes(`${heading}\n`)) {
    return current.replace(`${heading}\n`, `${heading}\n${entries.join("\n")}\n`);
  }
  const firstBreak = current.indexOf("\n");
  const title = firstBreak >= 0 ? current.slice(0, firstBreak) : "# Database Schema Update Log";
  const remainder = firstBreak >= 0 ? current.slice(firstBreak + 1).replace(/^\n*/, "") : "";
  return `${title}\n\n${heading}\n${entries.join("\n")}\n\n${remainder}`.replace(/\n+$/g, "\n");
}

function validateGeneratedAt(value) {
  const text = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(text) || !Number.isFinite(Date.parse(text))) {
    throw new DbExplainError("--generated-at must be an ISO 8601 UTC datetime with seconds, for example 2026-08-25T09:00:00Z.", "invalid_generated_at");
  }
  return text;
}

function bundleIdFor(root) {
  return safeSlug(path.basename(root), "database-schema");
}

function writeExtraFile(root, relativePath, extra) {
  const absolute = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  if (Buffer.isBuffer(extra)) {
    fs.writeFileSync(absolute, extra, { mode: 0o600 });
    return;
  }
  fs.writeFileSync(absolute, extra.bytes, { mode: extra.mode || 0o644 });
}

function writeFiles(root, files, extras) {
  fs.mkdirSync(root, { recursive: true });
  files.forEach((text, relativePath) => {
    const absolute = path.join(root, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, text, "utf8");
  });
  extras.forEach((extra, relativePath) => writeExtraFile(root, relativePath, extra));
}

function combinedExtras(existing, overlayExtras) {
  const extras = new Map();
  (existing.preserved || new Map()).forEach((bytes, filePath) => extras.set(filePath, bytes));
  (overlayExtras || existing.overlay || new Map()).forEach((entry, filePath) => extras.set(filePath, entry));
  return extras;
}

function mergeOverlayScaffolds(existingOverlay) {
  const previous = existingOverlay || new Map();
  const extras = new Map();
  previous.forEach((entry, filePath) => extras.set(filePath, entry));
  const scaffoldsRemoved = [];
  legacyOverlayScaffoldFiles().forEach((text, filePath) => {
    const existing = extras.get(filePath);
    if (!existing || extraFileText(existing) !== text) return;
    extras.delete(filePath);
    scaffoldsRemoved.push(filePath);
  });
  overlayScaffoldFiles().forEach((text, filePath) => {
    if (extras.has(filePath)) return;
    extras.set(filePath, { bytes: Buffer.from(text, "utf8"), mode: 0o644 });
  });
  refreshOverlayIndexes(extras);
  let seeded = 0;
  extras.forEach((_entry, filePath) => {
    if (!previous.has(filePath)) seeded += 1;
  });
  return {
    extras,
    overlaySeeded: seeded,
    overlayPreserved: previous.size - scaffoldsRemoved.length,
    scaffoldsRemoved: scaffoldsRemoved.sort(compareText),
  };
}

function countBundleFiles(files, extras) {
  let count = files.size;
  extras.forEach((_entry, filePath) => {
    if (!files.has(filePath) && filePath.toLowerCase().endsWith(".md")) count += 1;
  });
  return count;
}

function extraFileText(extra) {
  const bytes = Buffer.isBuffer(extra) ? extra : extra && extra.bytes;
  return Buffer.isBuffer(bytes) ? bytes.toString("utf8") : "";
}

function overlayConceptEntries(extras, directory) {
  const prefix = `${directory}/`;
  const entries = [];
  extras.forEach((extra, filePath) => {
    if (!filePath.startsWith(prefix) || !filePath.toLowerCase().endsWith(".md")) return;
    const rest = filePath.slice(prefix.length);
    if (rest.includes("/") || rest.toLowerCase() === "index.md" || rest.toLowerCase() === "guide.md") return;
    try {
      const split = splitFrontmatter(extraFileText(extra));
      const title = split.frontmatter && split.frontmatter.title
        ? String(split.frontmatter.title)
        : path.posix.basename(rest, ".md");
      const description = split.frontmatter && split.frontmatter.description
        ? String(split.frontmatter.description)
        : "";
      entries.push({ path: filePath, title, description });
    } catch (_error) {
      return;
    }
  });
  return entries.sort((left, right) => compareText(left.path, right.path));
}

function renderOverlayCatalog(catalog, extras) {
  const lines = [
    `# ${catalog.title}`,
    "",
    catalog.purpose,
    "",
    "## Browse / 浏览",
    "",
    `* ${markdownLink("Bundle root / Bundle 根目录", "/index.md")}`,
  ];
  catalog.children.forEach((child) => {
    lines.push(`* ${markdownLink(child.label, child.href)} - ${child.detail}`);
  });
  lines.push("", "## Concepts / 概念", "");
  const concepts = overlayConceptEntries(extras, catalog.directory);
  if (!concepts.length) {
    lines.push("* No Concepts in this folder yet. Copy a template from the authoring guide. / 本目录尚无概念，请从编写说明复制模板。");
  } else {
    concepts.forEach((entry) => {
      const href = path.posix.relative(catalog.directory, entry.path);
      const suffix = entry.description ? ` - ${escapeCell(entry.description)}` : "";
      lines.push(`* ${markdownLink(entry.title, href)}${suffix}`);
    });
  }
  lines.push("");
  return lines.join("\n");
}

function refreshOverlayIndexes(extras) {
  OVERLAY_CATALOGS.forEach((catalog) => {
    extras.set(catalog.path, {
      bytes: Buffer.from(renderOverlayCatalog(catalog, extras), "utf8"),
      mode: 0o644,
    });
  });
}

function overlayCatalogPlan(previous, extras, scaffoldsRemoved) {
  const indexes = [];
  OVERLAY_CATALOGS.forEach((catalog) => {
    const before = previous && previous.get(catalog.path);
    const after = extras.get(catalog.path);
    const beforeText = before ? extraFileText(before) : "";
    const afterText = after ? extraFileText(after) : "";
    indexes.push({
      path: catalog.path,
      sha256: sha256(afterText),
      change: !before ? "added" : beforeText === afterText ? "unchanged" : "updated",
    });
  });
  const removed = (scaffoldsRemoved || []).slice().sort(compareText);
  return {
    digest: `sha256:${sha256(canonicalJson({
      indexes: indexes.map((entry) => ({ path: entry.path, sha256: entry.sha256 })),
      removed,
    }))}`,
    changes: {
      indexesAdded: indexes.filter((entry) => entry.change === "added").map((entry) => entry.path),
      indexesUpdated: indexes.filter((entry) => entry.change === "updated").map((entry) => entry.path),
      scaffoldsRemoved: removed,
    },
  };
}

function validateSemanticOverlayTargets(files, extras) {
  const documents = new Map();
  files.forEach((text, filePath) => {
    if (filePath.toLowerCase().endsWith(".md") && !reservedMarkdownName(filePath)) {
      const split = splitFrontmatter(text);
      documents.set(filePath, { path: filePath, frontmatter: split.frontmatter, body: split.body });
    }
  });
  (extras || new Map()).forEach((extra, filePath) => {
    if (!overlayRoot(filePath) || !filePath.toLowerCase().endsWith(".md") || reservedMarkdownName(filePath)) return;
    const text = extraFileText(extra);
    if (!text) return;
    const split = splitFrontmatter(text);
    documents.set(filePath, { path: filePath, frontmatter: split.frontmatter, body: split.body });
  });

  const semanticDocuments = [];
  documents.forEach((document) => {
    const contract = validateSemanticOverlayShape(document.frontmatter, document.path);
    if (contract) semanticDocuments.push({ document, contract });
  });

  const requireDocument = (owner, targetPath, field) => {
    const target = documents.get(targetPath);
    if (!target || target.frontmatter.status === "deprecated") {
      semanticOverlayError(owner.path, field, `${field} does not resolve to an active Concept: /${targetPath}.`);
    }
    return target;
  };
  const requirePhysicalTable = (owner, targetPath, field) => {
    const target = requireDocument(owner, targetPath, field);
    const extension = target.frontmatter.dbexplain;
    if (!extension || extension.object_kind !== "table" || !extension.sql_binding || extension.sql_binding.version !== SQL_BINDING_VERSION) {
      semanticOverlayError(owner.path, field, `${field} must reference a query-ready physical Table Concept.`);
    }
    return target;
  };
  const requireColumn = (owner, tableDocument, column, field) => {
    const columns = tableDocument.frontmatter.dbexplain.sql_binding.columns || [];
    if (!columns.some((entry) => entry && entry.name === column)) {
      semanticOverlayError(owner.path, field, `Column ${column} does not exist in /${tableDocument.path}.`);
    }
  };
  const requireDataset = (owner, targetPath, field) => {
    const target = requireDocument(owner, targetPath, field);
    const contract = validateSemanticOverlayShape(target.frontmatter, target.path);
    if (!contract || contract.kind !== "dataset") {
      semanticOverlayError(owner.path, field, `${field} must reference a semantic dataset.`);
    }
    return target;
  };
  const requirePhysicalRelationship = (owner, targetPath, field) => {
    const target = requireDocument(owner, targetPath, field);
    const extension = target.frontmatter.dbexplain;
    if (!extension || extension.object_kind !== "declared_relationship" || !extension.join_binding) {
      semanticOverlayError(owner.path, field, `${field} must reference a declared physical Relationship Concept.`);
    }
    if (!extension.join_binding.executable) {
      semanticOverlayError(owner.path, field, `${field} references a relationship that is not safe for automatic SQL assembly.`);
    }
    return target;
  };

  const requireOverlayJoin = (owner, overlayJoin, field) => {
    const fromTable = requirePhysicalTable(owner, overlayJoin.from.table, `${field}.from.table`);
    const toTable = requirePhysicalTable(owner, overlayJoin.to.table, `${field}.to.table`);
    overlayJoin.from.columns.forEach((column, index) => {
      requireColumn(owner, fromTable, column, `${field}.from.columns[${index}]`);
    });
    overlayJoin.to.columns.forEach((column, index) => {
      requireColumn(owner, toTable, column, `${field}.to.columns[${index}]`);
    });
    const fromLabel = fromTable.frontmatter.dbexplain.sql_binding.instance_label;
    const toLabel = toTable.frontmatter.dbexplain.sql_binding.instance_label;
    if (fromLabel !== toLabel) {
      semanticOverlayError(owner.path, field, `${field} endpoints must share the same instance label.`);
    }
    return { fromTable, toTable };
  };
  const requireJoinSource = (owner, targetPath, field) => {
    const target = requireDocument(owner, targetPath, field);
    const extension = target.frontmatter.dbexplain;
    if (extension && extension.object_kind === "declared_relationship" && extension.join_binding) {
      if (!extension.join_binding.executable) {
        semanticOverlayError(owner.path, field, `${field} references a relationship that is not safe for automatic SQL assembly.`);
      }
      return { kind: "declared", target, binding: extension.join_binding };
    }
    const contract = validateSemanticOverlayShape(target.frontmatter, target.path);
    if (!contract || contract.kind !== "relationship") {
      semanticOverlayError(owner.path, field, `${field} must reference a declared physical relationship or a semantic relationship.`);
    }
    if (contract.physicalRelationship) {
      const physical = requirePhysicalRelationship(owner, contract.physicalRelationship, field);
      return { kind: "declared", target: physical, binding: physical.frontmatter.dbexplain.join_binding };
    }
    return { kind: "overlay", target, overlayJoin: contract.overlayJoin };
  };

  const normalizeLocalTarget = (ownerPath, value) => {
    const raw = String(value || "").trim().split("#")[0];
    if (!raw || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(raw)) return raw;
    return raw.startsWith("/")
      ? path.posix.normalize(raw.slice(1))
      : path.posix.normalize(path.posix.join(path.posix.dirname(ownerPath), raw));
  };

  const expectedProjection = (contract) => {
    if (contract.kind === "term") {
      return contract.bindings.map((binding) => ({ type: "related_to", target: binding.table, label: `binding:${binding.column}` }));
    }
    if (contract.kind === "dataset") {
      return [{ type: "depends_on", target: contract.physicalTable, label: "physical_table" }];
    }
    if (contract.kind === "relationship") {
      const values = [
        { type: "depends_on", target: contract.fromDataset, label: "from_dataset" },
        { type: "depends_on", target: contract.toDataset, label: "to_dataset" },
      ];
      if (contract.physicalRelationship) {
        values.push({ type: "depends_on", target: contract.physicalRelationship, label: "physical_relationship" });
      } else {
        values.push(
          { type: "depends_on", target: contract.overlayJoin.from.table, label: "join_from_table" },
          { type: "depends_on", target: contract.overlayJoin.to.table, label: "join_to_table" },
        );
      }
      return values;
    }
    if (contract.kind === "query") {
      return contract.tables.map((table) => ({ type: "depends_on", target: table, label: "query_table" }));
    }
    if (contract.kind === "metric") {
      return [
        { type: "depends_on", target: contract.baseTable, label: "base_table" },
        ...contract.requiredRelationships.map((target) => ({ type: "depends_on", target, label: "required_relationship" })),
      ];
    }
    return [];
  };

  const requireProjection = (document, contract) => {
    const expected = expectedProjection(contract);
    const relations = Array.isArray(document.frontmatter.relations) ? document.frontmatter.relations : [];
    const links = extractMarkdownLinks(document.body).map((link) => normalizeLocalTarget(document.path, link.href));
    expected.forEach((projection) => {
      const relation = relations.find((entry) => isPlainObject(entry)
        && entry.type === projection.type
        && entry.label === projection.label
        && normalizeLocalTarget(document.path, entry.target) === projection.target);
      if (!relation) {
        semanticOverlayError(
          document.path,
          "relations",
          `Missing ${projection.type} relation labeled ${projection.label} to /${projection.target}.`,
        );
      }
      if (!links.includes(projection.target)) {
        semanticOverlayError(document.path, "body", `Markdown body must link to /${projection.target}.`);
      }
    });
  };

  const requireBodyTerms = (document, field, values) => {
    const body = String(document.body || "").normalize("NFKC").toLowerCase();
    Array.from(new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim())))
      .forEach((value) => {
        if (!body.includes(value.normalize("NFKC").toLowerCase())) {
          semanticOverlayError(document.path, field, `Markdown body must expose ${JSON.stringify(value)} for domain-neutral search.`);
        }
      });
  };

  const requireSearchProjection = (document, contract) => {
    if (contract.kind === "dataset") {
      const terms = [];
      contract.semantic.fields.forEach((field) => {
        terms.push(field.name, field.column, field.datatype);
        if (Array.isArray(field.synonyms)) terms.push(...field.synonyms);
        const values = field.enum && Array.isArray(field.enum.values) ? field.enum.values : [];
        values.forEach((entry) => {
          terms.push(entry.code);
          if (entry.labels) terms.push(entry.labels.en, entry.labels.zh);
        });
      });
      requireBodyTerms(document, "body", terms);
    } else if (contract.kind === "enumeration") {
      requireBodyTerms(document, "body", contract.values.flatMap((entry) => [entry.code, entry.labels.en, entry.labels.zh]));
    } else if (contract.kind === "metric") {
      requireBodyTerms(document, "body", Object.entries(contract.semantic.expressions).flat());
    }
  };

  const requireSavedQueryVerification = (document, contract, tables) => {
    const blocks = markdownStructure(document.body).codeBlocks.filter((block) => block.language.toLowerCase() === "sql");
    if (blocks.length !== 1 || !blocks[0].fenced || !blocks[0].closed) {
      semanticOverlayError(document.path, "body", "A Saved Query requires exactly one closed fenced sql block.");
    }
    const statement = blocks[0].content.replace(/\r\n/g, "\n").trim();
    if (!statement) semanticOverlayError(document.path, "body", "The Saved Query sql block must not be empty.");
    const expectedDigest = `sha256:${sha256(statement)}`;
    const verified = document.frontmatter.verified;
    const events = isPlainObject(verified) ? [verified] : Array.isArray(verified) ? verified : [];
    const event = events.find((entry) => isPlainObject(entry)
      && entry.by === "process:dbexplain"
      && entry.method === "dbexplain_execute");
    if (!event) {
      semanticOverlayError(document.path, "verified", "Saved Query SQL must be verified by process:dbexplain using dbexplain_execute.");
    }
    if (event.statement_sha256 !== expectedDigest) {
      semanticOverlayError(document.path, "verified.statement_sha256", "Saved Query SQL changed after dbexplain execution verification.");
    }
    const labels = Array.from(new Set(tables.map((table) => table.frontmatter.dbexplain.sql_binding.instance_label)));
    if (labels.length !== 1 || event.instance_label !== labels[0]) {
      semanticOverlayError(document.path, "verified.instance_label", "Saved Query verification must name the single physical instance used by semantic.tables.");
    }
    tables.forEach((table, index) => {
      const binding = table.frontmatter.dbexplain.sql_binding;
      const relation = String(binding.relation || "");
      const quoted = String(binding.source_sql || "");
      const relationPattern = relation
        ? new RegExp(`(^|[^A-Za-z0-9_])${relation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_]|$)`, "i")
        : null;
      if (!quoted || (!statement.includes(quoted) && !(relationPattern && relationPattern.test(statement)))) {
        semanticOverlayError(
          document.path,
          `semantic.tables[${index}]`,
          `Saved Query SQL does not reference declared table /${table.path}.`,
        );
      }
    });
  };

  semanticDocuments.forEach(({ document, contract }) => {
    requireProjection(document, contract);
    requireSearchProjection(document, contract);
    if (contract.kind === "term") {
      contract.bindings.forEach((binding, index) => {
        const table = requirePhysicalTable(document, binding.table, `semantic.bindings[${index}].table`);
        requireColumn(document, table, binding.column, `semantic.bindings[${index}].column`);
      });
      return;
    }
    if (contract.kind === "dataset") {
      const table = requirePhysicalTable(document, contract.physicalTable, "semantic.physical_table");
      contract.fields.forEach((field, index) => {
        requireColumn(document, table, field.column, `semantic.fields[${index}].column`);
      });
      return;
    }
    if (contract.kind === "enumeration") {
      return;
    }
    if (contract.kind === "query") {
      const tables = contract.tables.map((tablePath, index) => (
        requirePhysicalTable(document, tablePath, `semantic.tables[${index}]`)
      ));
      requireSavedQueryVerification(document, contract, tables);
      return;
    }
    if (contract.kind === "relationship") {
      const fromDataset = requireDataset(document, contract.fromDataset, "semantic.from_dataset");
      const toDataset = requireDataset(document, contract.toDataset, "semantic.to_dataset");
      const fromContract = validateSemanticOverlayShape(fromDataset.frontmatter, fromDataset.path);
      const toContract = validateSemanticOverlayShape(toDataset.frontmatter, toDataset.path);
      if (contract.physicalRelationship) {
        const physical = requirePhysicalRelationship(document, contract.physicalRelationship, "semantic.physical_relationship");
        const binding = physical.frontmatter.dbexplain.join_binding;
        if (String(binding.from.table || "").replace(/^\//, "") !== fromContract.physicalTable
          || String(binding.to.table || "").replace(/^\//, "") !== toContract.physicalTable) {
          semanticOverlayError(document.path, "semantic", "Dataset physical tables must match the declared relationship endpoints in the same direction.");
        }
      } else {
        requireOverlayJoin(document, contract.overlayJoin, "semantic.join");
        if (contract.overlayJoin.from.table !== fromContract.physicalTable
          || contract.overlayJoin.to.table !== toContract.physicalTable) {
          semanticOverlayError(document.path, "semantic", "Dataset physical tables must match the overlay join endpoints in the same direction.");
        }
      }
      return;
    }
    const baseTable = requirePhysicalTable(document, contract.baseTable, "semantic.base_table");
    const baseBinding = baseTable.frontmatter.dbexplain.sql_binding;
    if (!Object.prototype.hasOwnProperty.call(contract.semantic.expressions, baseBinding.dialect)
      && !Object.prototype.hasOwnProperty.call(contract.semantic.expressions, "ansi_sql")) {
      semanticOverlayError(document.path, "semantic.expressions", `Metric requires a ${baseBinding.dialect} or ansi_sql expression.`);
    }
    const relationshipEdges = contract.requiredRelationships.map((relationshipPath, index) => {
      const field = `semantic.required_relationships[${index}]`;
      const source = requireJoinSource(document, relationshipPath, `semantic.required_relationships[${index}]`);
      if (source.kind === "declared") {
        const binding = source.binding;
        if (binding.from.instance_label !== baseBinding.instance_label || binding.to.instance_label !== baseBinding.instance_label) {
          semanticOverlayError(document.path, field, "Metric relationships must remain inside the base table instance label.");
        }
        const fromTable = requirePhysicalTable(document, String(binding.from.table).replace(/^\//, ""), field);
        const toTable = requirePhysicalTable(document, String(binding.to.table).replace(/^\//, ""), field);
        return { field, fromTable, toTable };
      }
      const joined = requireOverlayJoin(document, source.overlayJoin, field);
      if (joined.fromTable.frontmatter.dbexplain.sql_binding.instance_label !== baseBinding.instance_label
        || joined.toTable.frontmatter.dbexplain.sql_binding.instance_label !== baseBinding.instance_label) {
        semanticOverlayError(document.path, field, "Metric relationships must remain inside the base table instance label.");
      }
      return { field, fromTable: joined.fromTable, toTable: joined.toTable };
    });
    const reachable = new Set([baseTable.path]);
    let changed = true;
    while (changed) {
      changed = false;
      relationshipEdges.forEach((edge) => {
        if (!reachable.has(edge.fromTable.path) && !reachable.has(edge.toTable.path)) return;
        [edge.fromTable.path, edge.toTable.path].forEach((tablePath) => {
          if (!reachable.has(tablePath)) {
            reachable.add(tablePath);
            changed = true;
          }
        });
      });
    }
    relationshipEdges.forEach((edge) => {
      if (!reachable.has(edge.fromTable.path) || !reachable.has(edge.toTable.path)) {
        semanticOverlayError(document.path, edge.field, "Metric relationship is disconnected from semantic.base_table.");
      }
    });
    const availableTables = new Map([[baseBinding.relation, baseTable]]);
    relationshipEdges.forEach((edge) => {
      [edge.fromTable, edge.toTable].forEach((table) => {
        availableTables.set(table.frontmatter.dbexplain.sql_binding.relation, table);
      });
    });
    Object.entries(contract.semantic.expressions).forEach(([dialect, expression]) => {
      const placeholders = Array.from(String(expression).matchAll(/\{\{([^{}]+)\}\}/g), (match) => match[1]);
      placeholders.forEach((placeholder) => {
        const separator = placeholder.indexOf(".");
        if (separator <= 0 || separator === placeholder.length - 1) {
          semanticOverlayError(document.path, `semantic.expressions.${dialect}`, `Invalid Metric placeholder: {{${placeholder}}}.`);
        }
        const relation = placeholder.slice(0, separator);
        const column = placeholder.slice(separator + 1);
        const table = availableTables.get(relation);
        if (!table) {
          semanticOverlayError(document.path, `semantic.expressions.${dialect}`, `Metric placeholder references an unavailable table: ${relation}.`);
        }
        requireColumn(document, table, column, `semantic.expressions.${dialect}`);
      });
    });
  });
  return { count: semanticDocuments.length };
}

function validateCandidateFiles(files, extras, bundleId) {
  const extraFiles = extras || new Map();
  if (countBundleFiles(files, extraFiles) > MAX_BUNDLE_FILES) {
    throw new DbExplainError(`Generated Bundle exceeds ${MAX_BUNDLE_FILES} Markdown files.`, "bundle_too_large", { files: countBundleFiles(files, extraFiles) });
  }
  const semantic = validateSemanticOverlayTargets(files, extraFiles);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "okf-dbexplain-validate-"));
  try {
    writeFiles(root, files, extraFiles);
    const index = buildIndex([{ id: bundleId, root }], { strictLinks: true });
    const validation = validateIndex(index);
    if (!validation.validForProject) {
      throw new DbExplainError("Generated database Bundle failed OKF validation.", "generated_bundle_invalid", {
        diagnostics: validation.diagnostics,
      });
    }
    return Object.assign({}, validation, { semanticOverlays: semantic.count });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function buildBundleCandidate(capture, root, generatedAt, packageVersion) {
  const existing = readExistingBundle(root);
  const model = capture.model;
  const relationships = relationshipMap(model);
  const files = new Map();
  files.set("bundle.md", renderConceptMarkdown({
    path: "bundle.md",
    frontmatter: generatedFrontmatter("bundle", { bundle: "database-schema" }, capture.dbexplainVersion, generatedAt, {
      type: "Database Schema Bundle",
      title: "Database Schema Bundle",
      description: `Synchronized database structure for ${model.instances.length} instance(s).`,
      tags: ["database", "schema", "dbexplain"],
      status: "stable",
      sources: captureSources(),
    }, {
      selected_instances: model.instances.map((instance) => instance.label),
      okf_mcp_version: packageVersion,
    }),
    body: [
      "# Managed Scope",
      "",
      "This Bundle is generated from dbexplain database metadata. Generated concepts must be changed through the synchronizer.",
      "",
      "Inferred relationships are unverified physical-reference candidates, not approved business joins.",
      "",
      "Human overlay directories (`business/`, `metrics/`, `queries/`, `computations/`, `policies/`, `skills/`, `attesters/`, `references/`) use reserved index resources for progressive browsing. Authoring templates live in the bundled Skills so templates do not pollute runtime search. Existing user-authored overlay Concepts are preserved byte-for-byte.",
      "",
    ].join("\n"),
  }));
  model.instances.forEach((instance) => {
    files.set(instance.path, renderInstance(instance, capture.dbexplainVersion, generatedAt));
    instance.databases.forEach((database) => {
      files.set(database.path, renderDatabase(database, capture.dbexplainVersion, generatedAt));
      database.tables.forEach((table) => {
        files.set(table.path, renderTable(table, relationships.get(tableKey(table.identity)) || [], capture.dbexplainVersion, generatedAt));
        const observation = renderTableObservation(table, capture.dbexplainVersion, generatedAt);
        files.set(observation.path, observation.text);
      });
    });
  });
  model.declaredRelationships.forEach((relationship) => files.set(
    relationship.path,
    renderDeclaredRelationship(relationship, capture.dbexplainVersion, generatedAt),
  ));
  model.inferredRelationships.forEach((relationship) => files.set(
    relationship.path,
    renderInferredRelationship(relationship, capture.dbexplainVersion, generatedAt),
  ));
  files.set("observations/current.md", renderCurrentObservation(
    model,
    capture.context,
    capture.dbexplainVersion,
    generatedAt,
    capture.rawInputSha256,
  ));

  existing.concepts.forEach((concept, filePath) => {
    const kind = concept.frontmatter.dbexplain.object_kind;
    if (!files.has(filePath) && DEPRECATABLE_OBJECT_KINDS.has(kind)) {
      files.set(filePath, deprecateConcept(concept, generatedAt));
    }
  });

  files.forEach((text, filePath) => {
    const kind = filePath === "bundle.md" ? "bundle" : (() => {
      try { return splitFrontmatter(text).frontmatter.dbexplain.object_kind; } catch (_error) { return ""; }
    })();
    if (kind && !["current_observation", "table_observation"].includes(kind)) {
      files.set(filePath, preserveGeneratedAt(existing.files.get(filePath), text, filePath));
    }
  });

  const entries = conceptEntries(files);
  const byKind = (kinds) => entries.filter((entry) => kinds.includes(entry.frontmatter.dbexplain.object_kind));
  const declaredEntries = byKind(["declared_relationship"]);
  const inferredEntries = byKind(["inferred_relationship"]);
  files.set("index.md", rootIndexMarkdown({ relationships: declaredEntries.length || inferredEntries.length }));
  files.set("instances/index.md", indexMarkdown("Database Instances", byKind(["instance"]), "instances"));
  setOneLevelConceptIndexes(files, "databases", byKind(["database"]), {
    root: "Database Instances",
    child: "Database Namespaces for",
  });
  setTwoLevelConceptIndexes(files, "tables", byKind(["table"]), {
    root: "Database Table Catalog",
    parent: "Database Namespaces for",
    leaf: "Database Tables in",
  });
  if (declaredEntries.length || inferredEntries.length) {
    files.set("relationships/index.md", relationshipsIndexMarkdown({
      declared: declaredEntries.length,
      inferred: inferredEntries.length,
    }));
  }
  if (declaredEntries.length) {
    files.set("relationships/declared/index.md", relationshipCatalogMarkdown("Declared Physical Relationships", declaredEntries, "relationships/declared"));
  }
  if (inferredEntries.length) {
    files.set("relationships/inferred/index.md", relationshipCatalogMarkdown("Inferred Physical Relationship Candidates", inferredEntries, "relationships/inferred"));
  }
  const tableObservations = byKind(["table_observation"]);
  files.set("observations/index.md", observationsIndexMarkdown(tableObservations));
  setTwoLevelConceptIndexes(files, "observations/tables", tableObservations, {
    root: "Table Observation Catalog",
    parent: "Observation Namespaces for",
    leaf: "Table Observations in",
  });

  const changes = objectChanges(existing, files);
  const observationChanges = observationChangeCount(existing, files);
  files.set("log.md", updateLog(existing.files.get("log.md"), generatedAt, changes, observationChanges));

  const overlay = mergeOverlayScaffolds(existing.overlay);
  const extras = combinedExtras(existing, overlay.extras);
  const catalogPlan = overlayCatalogPlan(existing.overlay, overlay.extras, overlay.scaffoldsRemoved);
  const structuralManifest = Array.from(files.entries())
    .filter(([filePath]) => filePath !== "log.md" && !filePath.startsWith("observations/"))
    .sort((left, right) => compareText(left[0], right[0]))
    .map(([filePath, text]) => ({ path: filePath, sha256: sha256(text) }));
  const observationManifest = Array.from(files.entries())
    .filter(([filePath]) => filePath.startsWith("observations/"))
    .sort((left, right) => compareText(left[0], right[0]))
    .map(([filePath, text]) => ({ path: filePath, sha256: sha256(text) }));
  const structuralDigest = `sha256:${sha256(canonicalJson(structuralManifest))}`;
  const observationDigest = `sha256:${sha256(canonicalJson(observationManifest))}`;
  const planDigest = `sha256:${sha256(canonicalJson({
    format: BUNDLE_FORMAT_VERSION,
    packageVersion,
    dbexplainVersion: capture.dbexplainVersion,
    generatedAt,
    targetDigest: existing.targetDigest,
    structuralDigest,
    catalogDigest: catalogPlan.digest,
    selectedSources: capture.selectedSources.map((entry) => ({ label: entry.label, kind: entry.kind })),
  }))}`;
  const validation = validateCandidateFiles(files, extras, bundleIdFor(root));
  return {
    files,
    extras,
    existing,
    changes,
    observationChanges,
    overlaySeeded: overlay.overlaySeeded,
    overlayPreserved: overlay.overlayPreserved,
    catalogDigest: catalogPlan.digest,
    catalogChanges: catalogPlan.changes,
    structuralDigest,
    observationDigest,
    planDigest,
    validation,
  };
}

function acquireLock(root) {
  const parent = path.dirname(root);
  fs.mkdirSync(parent, { recursive: true });
  const lockPath = path.join(parent, `.${path.basename(root)}.okf-dbexplain.lock`);
  let handle;
  try {
    handle = fs.openSync(lockPath, "wx", 0o600);
    fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }) + "\n");
  } catch (error) {
    throw new DbExplainError(`Database Bundle is locked by another synchronizer: ${lockPath}`, "bundle_locked");
  }
  return () => {
    try { if (handle !== undefined) fs.closeSync(handle); } catch (_error) { /* ignore */ }
    try { fs.unlinkSync(lockPath); } catch (_error) { /* ignore */ }
  };
}

function applyCandidate(root, candidate) {
  const current = readExistingBundle(root);
  if (current.targetDigest !== candidate.existing.targetDigest) {
    throw new DbExplainError("Bundle changed after planning; run dry-run again.", "bundle_target_changed", {
      expected: candidate.existing.targetDigest,
      actual: current.targetDigest,
    });
  }
  const parent = path.dirname(root);
  const base = path.basename(root);
  fs.mkdirSync(parent, { recursive: true });
  const stage = fs.mkdtempSync(path.join(parent, `.${base}.okf-dbexplain-stage-`));
  const backup = path.join(parent, `.${base}.okf-dbexplain-backup-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  let backedUp = false;
  let published = false;
  try {
    writeFiles(stage, candidate.files, candidate.extras);
    fs.chmodSync(stage, current.rootMode || 0o755);
    validateCandidateFiles(candidate.files, candidate.extras, bundleIdFor(root));
    if (fs.existsSync(root)) {
      fs.renameSync(root, backup);
      backedUp = true;
    }
    fs.renameSync(stage, root);
    published = true;
    if (backedUp) fs.rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (published && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
    if (backedUp && fs.existsSync(backup) && !fs.existsSync(root)) fs.renameSync(backup, root);
    throw error;
  } finally {
    if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
  }
}

function datasetSlug(tableName) {
  return String(tableName || "").trim().toLowerCase().replace(/_/g, "-").replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "table";
}

function datasetTitleFromTable(tableName, conceptTitle) {
  if (conceptTitle && typeof conceptTitle === "string") {
    const trimmed = conceptTitle.trim();
    if (trimmed) return trimmed.includes(".") ? trimmed.split(".").pop() : trimmed;
  }
  return String(tableName || "table").replace(/_/g, " ");
}

function parseEnumFromComment(comment) {
  const text = String(comment || "").trim();
  if (!text) return [];
  const values = [];
  const seen = new Set();
  const add = (code, label) => {
    const normalizedCode = String(code).trim();
    const normalizedLabel = String(label).trim();
    if (!normalizedCode || !normalizedLabel || seen.has(normalizedCode)) return;
    seen.add(normalizedCode);
    values.push({
      code: normalizedCode,
      labels: { en: normalizedLabel, zh: normalizedLabel },
    });
  };
  const bracketList = text.match(/\[([^\]]+)\]/);
  if (bracketList) {
    bracketList[1].split(/[,，]/).forEach((segment) => {
      const match = segment.trim().match(/^(\d+)\s*[:：]\s*(.+)$/);
      if (match) add(match[1], match[2]);
    });
  }
  if (!values.length) {
    const bracketPattern = /\[(\d+)\s*[:：]\s*([^\],]+)/g;
    let match = bracketPattern.exec(text);
    while (match) {
      add(match[1], match[2]);
      match = bracketPattern.exec(text);
    }
  }
  if (!values.length) {
    const listPattern = /(?:^|[,，;；|])\s*(\d+)\s*[-–—]\s*([^,\d，;；|\]]+)/g;
    let match = listPattern.exec(text);
    while (match) {
      add(match[1], match[2]);
      match = listPattern.exec(text);
    }
  }
  return values;
}

function loadBundleTableConcepts(concepts) {
  const tables = [];
  concepts.forEach((concept, filePath) => {
    const extension = concept.frontmatter && concept.frontmatter.dbexplain;
    if (!extension || extension.object_kind !== "table") return;
    const binding = extension.sql_binding;
    if (!binding || !Array.isArray(binding.columns) || !binding.columns.length) return;
    tables.push({
      path: filePath,
      name: path.posix.basename(filePath, ".md"),
      title: concept.frontmatter.title,
      description: concept.frontmatter.description,
      columns: binding.columns.map((column) => ({
        name: column.name,
        datatype: column.datatype,
        default_is_time: Boolean(column.default_is_time),
        comment: column.comment || "",
      })),
    });
  });
  return tables.sort((left, right) => compareText(left.path, right.path));
}

function loadBundleDeclaredRelationships(concepts) {
  const relationships = [];
  concepts.forEach((concept, filePath) => {
    const extension = concept.frontmatter && concept.frontmatter.dbexplain;
    if (!extension || extension.object_kind !== "declared_relationship") return;
    const binding = extension.join_binding;
    if (!binding || !binding.executable) return;
    relationships.push({
      path: filePath,
      title: concept.frontmatter.title,
      fromTable: String(binding.from.table || "").replace(/^\//, ""),
      toTable: String(binding.to.table || "").replace(/^\//, ""),
      binding,
    });
  });
  return relationships.sort((left, right) => compareText(left.path, right.path));
}

function relationshipOverlaySlug(fromTablePath, toTablePath) {
  const fromName = path.posix.basename(fromTablePath, ".md");
  const toName = path.posix.basename(toTablePath, ".md");
  return `${datasetSlug(fromName)}-to-${datasetSlug(toName)}`;
}

function projectionRelation(type, target, label, description) {
  return { type, target, label, description };
}

function enumProjection(field) {
  const values = field.enum && Array.isArray(field.enum.values) ? field.enum.values : [];
  return values.map((entry) => {
    const labels = entry && entry.labels || {};
    return `${entry.code}: ${labels.en || ""}${labels.zh && labels.zh !== labels.en ? ` / ${labels.zh}` : ""}`;
  }).join("; ");
}

function renderDatasetProjection(title, description, physicalTable, fields) {
  const lines = [
    `# ${title}`,
    "",
    description,
    "",
    "## Physical Binding",
    "",
    `* ${markdownLink("Physical table", physicalTable)}`,
    "",
    "## Semantic Fields",
    "",
    "| Business field | Physical column | Datatype | Time | Synonyms | Enumeration |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  fields.forEach((field) => {
    lines.push(`| ${escapeCell(field.name)} | ${escapeCell(field.column)} | ${escapeCell(field.datatype || "Opaque")} | ${field.dimension && field.dimension.is_time ? "yes" : "no"} | ${escapeCell((field.synonyms || []).join(", "))} | ${escapeCell(enumProjection(field))} |`);
  });
  lines.push("");
  return lines.join("\n");
}

function renderRelationshipProjection(title, description, relationship, fromDataset, toDataset) {
  const binding = relationship.binding;
  return [
    `# ${title}`,
    "",
    description,
    "",
    "## Dataset Endpoints",
    "",
    `* From dataset: ${markdownLink("source dataset", fromDataset)}`,
    `* To dataset: ${markdownLink("target dataset", toDataset)}`,
    `* Physical relationship: ${markdownLink("declared foreign key", `/${relationship.path}`)}`,
    `* Cardinality: ${binding.cardinality}`,
    "",
    "## Join Template",
    "",
    "```sql",
    binding.predicate_template,
    "```",
    "",
  ].join("\n");
}

function buildDatasetDraft(table) {
  const slug = datasetSlug(table.name);
  const datasetPath = `business/datasets/${slug}.md`;
  const fields = table.columns.map((column) => {
    const field = {
      name: column.name,
      column: column.name,
      datatype: column.datatype || "Opaque",
    };
    if (column.default_is_time) {
      field.dimension = { is_time: true };
    }
    const enumValues = parseEnumFromComment(column.comment);
    if (enumValues.length) {
      field.enum = { values: enumValues };
    }
    return field;
  });
  const title = datasetTitleFromTable(table.name, table.title);
  const description = table.description || `${table.name} semantic dataset draft generated from physical schema.`;
  const physicalTable = `/${table.path}`;
  return {
    path: datasetPath,
    text: renderConceptMarkdown({
      path: datasetPath,
      frontmatter: {
        type: "Semantic Dataset",
        title,
        description,
        aliases: [],
        status: "draft",
        relations: [projectionRelation(
          "depends_on",
          physicalTable,
          "physical_table",
          "Physical SQL table for this semantic dataset.",
        )],
        semantic: {
          profile: SEMANTIC_PROFILE,
          kind: "dataset",
          physical_table: physicalTable,
          fields,
        },
      },
      body: renderDatasetProjection(title, description, physicalTable, fields),
    }),
  };
}

function buildDeclaredRelationshipDraft(relationship, datasetPathByTable) {
  const fromDataset = datasetPathByTable.get(relationship.fromTable);
  const toDataset = datasetPathByTable.get(relationship.toTable);
  if (!fromDataset || !toDataset) return null;
  const relationshipPath = `business/relationships/${relationshipOverlaySlug(relationship.fromTable, relationship.toTable)}.md`;
  const description = "Declared foreign-key relationship draft generated from physical schema.";
  return {
    path: relationshipPath,
    text: renderConceptMarkdown({
      path: relationshipPath,
      frontmatter: {
        type: "Semantic Relationship",
        title: relationship.title,
        description,
        aliases: [],
        status: "draft",
        relations: [
          projectionRelation("depends_on", fromDataset, "from_dataset", "Source semantic dataset."),
          projectionRelation("depends_on", toDataset, "to_dataset", "Target semantic dataset."),
          projectionRelation("depends_on", `/${relationship.path}`, "physical_relationship", "Declared executable foreign key."),
        ],
        semantic: {
          profile: SEMANTIC_PROFILE,
          kind: "relationship",
          physical_relationship: `/${relationship.path}`,
          from_dataset: fromDataset,
          to_dataset: toDataset,
        },
      },
      body: renderRelationshipProjection(
        relationship.title,
        description,
        relationship,
        fromDataset,
        toDataset,
      ),
    }),
  };
}

function tableMatchesSelector(table, selector) {
  const normalized = String(selector || "").trim().toLowerCase();
  if (!normalized) return false;
  const base = path.posix.basename(table.path, ".md").toLowerCase();
  const tablePath = table.path.toLowerCase();
  const stripped = normalized.replace(/^\//, "");
  return normalized === base
    || normalized === tablePath
    || stripped === tablePath
    || stripped === base
    || tablePath.endsWith(`/${stripped}.md`)
    || tablePath.endsWith(`/${stripped}`);
}

function selectDraftTablePaths(tables, concepts, options) {
  if (options.tables) {
    const selectors = String(options.tables).split(",").map((entry) => entry.trim()).filter(Boolean);
    const selected = tables.filter((table) => selectors.some((selector) => tableMatchesSelector(table, selector)));
    if (!selected.length) {
      throw new DbExplainError(
        "No physical tables matched --tables selection.",
        "no_matching_tables",
        { tables: selectors },
      );
    }
    return selected.map((table) => table.path);
  }
  if (options.allTables) {
    return tables.map((table) => table.path);
  }
  if (options.useCoreTables) {
    const current = concepts.get("observations/current.md");
    const extension = current && current.frontmatter && current.frontmatter.dbexplain;
    const corePaths = extension && Array.isArray(extension.core_table_paths)
      ? extension.core_table_paths.map((entry) => String(entry).replace(/^\//, ""))
      : [];
    if (!corePaths.length) {
      throw new DbExplainError(
        "observations/current.md has no core_table_paths; use --tables instead.",
        "missing_core_tables",
      );
    }
    const allowed = new Set(corePaths);
    return tables.filter((table) => allowed.has(table.path)).map((table) => table.path);
  }
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : 0;
  if (limit) {
    return tables.slice(0, limit).map((table) => table.path);
  }
  throw new DbExplainError(
    "overlay-draft requires an explicit scope: --tables <names>, --all-tables, --use-core-tables, or --limit <n>.",
    "missing_overlay_scope",
  );
}

function overlayFileExists(overlay, filePath) {
  return overlay.has(filePath);
}

function overlayCatalogConceptCounts(extras) {
  const counts = {};
  OVERLAY_CATALOGS.forEach((catalog) => {
    counts[catalog.path] = overlayConceptEntries(extras, catalog.directory).length;
  });
  return counts;
}

function applyOverlayIndexFiles(root, extras, scaffoldsRemoved) {
  OVERLAY_CATALOGS.forEach((catalog) => {
    const entry = extras.get(catalog.path);
    if (!entry) return;
    const absolute = path.join(root, catalog.path);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, extraFileText(entry), { mode: entry.mode || 0o644 });
  });
  const legacy = legacyOverlayScaffoldFiles();
  (scaffoldsRemoved || []).forEach((filePath) => {
    const absolute = path.join(root, ...filePath.split("/"));
    if (!fs.existsSync(absolute) || !legacy.has(filePath)) return;
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) return;
    if (fs.readFileSync(absolute, "utf8") === legacy.get(filePath)) fs.unlinkSync(absolute);
  });
}

function validateOverlayExtras(root, existing, extras) {
  const bundleId = bundleIdFor(root);
  const validateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "okf-dbexplain-overlay-validate-"));
  try {
    const managedFiles = new Map(Array.from(existing.files.entries()).filter(([filePath]) => !overlayRoot(filePath)));
    writeFiles(validateRoot, managedFiles, extras);
    const index = buildIndex([{ id: bundleId, root: validateRoot }], { strictLinks: true });
    const validation = validateIndex(index);
    const semantic = validateSemanticOverlayTargets(managedFiles, extras);
    return { validation, semantic };
  } finally {
    fs.rmSync(validateRoot, { recursive: true, force: true });
  }
}

function overlayValidationPayload(validation, semantic) {
  return {
    conformant: validation.conformant,
    validForProject: validation.validForProject,
    semanticOverlays: semantic.count,
    diagnostics: validation.diagnostics,
  };
}

function validateDbExplainBundle(config) {
  const root = path.resolve(config.bundleRoot || "");
  if (!config.bundleRoot || root === path.parse(root).root) {
    throw new DbExplainError("--bundle-root must identify a dedicated Bundle directory, not a filesystem root.", "invalid_bundle_root");
  }
  const existing = readExistingBundle(root);
  if (!existing.concepts.size) {
    throw new DbExplainError("Bundle contains no managed database Concepts; run dbexplain sync first.", "missing_physical_tables");
  }
  const semantic = validateSemanticOverlayTargets(existing.files, existing.overlay);
  const index = buildIndex([{ id: bundleIdFor(root), root }], { strictLinks: true });
  const validation = validateIndex(index);
  return {
    bundleRoot: root,
    valid: validation.validForProject,
    conformant: validation.conformant,
    validForProject: validation.validForProject,
    semanticOverlays: semantic.count,
    diagnostics: validation.diagnostics,
  };
}

function refreshDbExplainOverlayIndexes(config) {
  const root = path.resolve(config.bundleRoot || "");
  if (!config.bundleRoot || root === path.parse(root).root) {
    throw new DbExplainError("--bundle-root must identify a dedicated Bundle directory, not a filesystem root.", "invalid_bundle_root");
  }
  const existing = readExistingBundle(root);
  if (!existing.files.size) {
    throw new DbExplainError("Bundle contains no managed physical tables; run dbexplain sync first.", "missing_physical_tables");
  }
  const overlay = mergeOverlayScaffolds(existing.overlay);
  refreshOverlayIndexes(overlay.extras);
  const { validation, semantic } = validateOverlayExtras(root, existing, overlay.extras);
  const result = {
    bundleRoot: root,
    action: "overlay-index",
    dryRun: Boolean(config.dryRun),
    indexesRefreshed: OVERLAY_CATALOGS.map((catalog) => catalog.path),
    scaffoldsRemoved: overlay.scaffoldsRemoved,
    conceptCounts: overlayCatalogConceptCounts(overlay.extras),
    validation: overlayValidationPayload(validation, semantic),
  };
  if (!validation.validForProject) {
    throw new DbExplainError("Overlay index refresh failed OKF validation.", "invalid_overlay_index", {
      diagnostics: validation.diagnostics,
    });
  }
  if (config.dryRun) return result;
  applyOverlayIndexFiles(root, overlay.extras, overlay.scaffoldsRemoved);
  return Object.assign(result, { applied: true });
}

function draftDbExplainOverlay(config) {
  const root = path.resolve(config.bundleRoot || "");
  if (!config.bundleRoot || root === path.parse(root).root) {
    throw new DbExplainError("--bundle-root must identify a dedicated Bundle directory, not a filesystem root.", "invalid_bundle_root");
  }
  const existing = readExistingBundle(root);
  const tables = loadBundleTableConcepts(existing.concepts);
  if (!tables.length) {
    throw new DbExplainError("Bundle contains no managed physical tables; run dbexplain sync first.", "missing_physical_tables");
  }
  const selectedPaths = new Set(selectDraftTablePaths(tables, existing.concepts, config));
  const selectedTables = tables.filter((table) => selectedPaths.has(table.path));
  const declaredRelationships = loadBundleDeclaredRelationships(existing.concepts);
  const overlay = mergeOverlayScaffolds(existing.overlay);
  const drafts = new Map();
  const datasetPathByTable = new Map();

  selectedTables.forEach((table) => {
    const draft = buildDatasetDraft(table);
    datasetPathByTable.set(table.path, `/${draft.path}`);
    if (overlayFileExists(overlay.extras, draft.path)) return;
    drafts.set(draft.path, draft.text);
    overlay.extras.set(draft.path, { bytes: Buffer.from(draft.text, "utf8"), mode: 0o644 });
  });

  declaredRelationships.forEach((relationship) => {
    const draft = buildDeclaredRelationshipDraft(relationship, datasetPathByTable);
    if (!draft) return;
    if (overlayFileExists(overlay.extras, draft.path)) return;
    drafts.set(draft.path, draft.text);
    overlay.extras.set(draft.path, { bytes: Buffer.from(draft.text, "utf8"), mode: 0o644 });
  });

  refreshOverlayIndexes(overlay.extras);
  const { validation, semantic } = validateOverlayExtras(root, existing, overlay.extras);
  const result = {
    bundleRoot: root,
    dryRun: Boolean(config.dryRun),
    selectedTables: selectedTables.length,
    datasetsDrafted: Array.from(drafts.keys()).filter((filePath) => filePath.startsWith("business/datasets/")).length,
    relationshipsDrafted: Array.from(drafts.keys()).filter((filePath) => filePath.startsWith("business/relationships/")).length,
    indexesRefreshed: OVERLAY_CATALOGS.map((catalog) => catalog.path),
    scaffoldsRemoved: overlay.scaffoldsRemoved,
    files: Array.from(drafts.keys()).sort(compareText),
    validation: overlayValidationPayload(validation, semantic),
  };
  if (!validation.validForProject) {
    throw new DbExplainError("Overlay draft failed OKF validation.", "invalid_overlay_draft", {
      diagnostics: validation.diagnostics,
    });
  }
  if (config.dryRun) return result;

  drafts.forEach((text, filePath) => {
    const absolute = path.join(root, filePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, text, { mode: 0o644 });
  });
  applyOverlayIndexFiles(root, overlay.extras, overlay.scaffoldsRemoved);
  return Object.assign(result, { applied: true });
}

function syncDbExplain(config) {
  const generatedAt = validateGeneratedAt(config.generatedAt);
  const root = path.resolve(config.bundleRoot || "");
  if (!config.bundleRoot || root === path.parse(root).root) {
    throw new DbExplainError("--bundle-root must identify a dedicated Bundle directory, not a filesystem root.", "invalid_bundle_root");
  }
  if (config.dryRun && config.expectPlan) {
    throw new DbExplainError("--dry-run cannot be combined with --expect-plan.", "conflicting_sync_modes");
  }
  if (!config.dryRun && !config.expectPlan) {
    throw new DbExplainError("Apply requires --expect-plan <sha256:digest> from a dry-run.", "missing_expected_plan");
  }
  const capture = collectDbExplain(config);
  let release = null;
  try {
    if (!config.dryRun) release = acquireLock(root);
    const candidate = buildBundleCandidate(capture, root, generatedAt, config.packageVersion || "unknown");
    const base = {
      action: config.dryRun ? "dry-run" : "apply",
      applied: false,
      bundleRoot: root,
      dbexplainVersion: capture.dbexplainVersion,
      selectedSources: capture.selectedSources,
      inputSha256: capture.rawInputSha256,
      counts: {
        instances: capture.model.instances.length,
        databases: capture.model.instances.reduce((count, instance) => count + instance.databases.length, 0),
        tables: capture.model.tables.length,
        columns: capture.model.tables.reduce((count, table) => count + table.columns.length, 0),
        declaredRelationships: capture.model.declaredRelationships.length,
        queryableDeclaredRelationships: capture.model.declaredRelationships.filter((relationship) => joinBinding(relationship, false).executable).length,
        inferredRelationships: capture.model.inferredRelationships.length,
        semanticOverlays: candidate.validation.semanticOverlays,
        overlaySeeded: candidate.overlaySeeded,
        overlayPreserved: candidate.overlayPreserved,
        scaffoldsRemoved: candidate.catalogChanges.scaffoldsRemoved.length,
      },
      changes: candidate.changes,
      observationChanges: candidate.observationChanges,
      structuralDigest: candidate.structuralDigest,
      observationDigest: candidate.observationDigest,
      catalogDigest: candidate.catalogDigest,
      catalogChanges: candidate.catalogChanges,
      targetDigest: candidate.existing.targetDigest,
      planDigest: candidate.planDigest,
      validation: {
        conformant: candidate.validation.conformant,
        validForProject: candidate.validation.validForProject,
        diagnostics: candidate.validation.diagnostics,
        semanticOverlays: candidate.validation.semanticOverlays,
      },
    };
    if (config.dryRun) return base;
    if (config.expectPlan !== candidate.planDigest) {
      return Object.assign(base, {
        planChanged: true,
        expectedPlanDigest: config.expectPlan,
      });
    }
    applyCandidate(root, candidate);
    return Object.assign(base, { applied: true, planChanged: false });
  } finally {
    if (release) release();
  }
}

module.exports = {
  BUNDLE_FORMAT_VERSION,
  DbExplainError,
  GENERATOR,
  IDENTITY_VERSION,
  SQL_KINDS,
  assertSupportedDbExplainVersion,
  buildBundleCandidate,
  canonicalJson,
  checkDbExplain,
  collectDbExplain,
  identityDigest,
  inspectDbExplain,
  draftDbExplainOverlay,
  refreshDbExplainOverlayIndexes,
  validateDbExplainBundle,
  normalizeSnapshot,
  objectPath,
  sanitizeProcessText,
  syncDbExplain,
  validateGeneratedAt,
};
