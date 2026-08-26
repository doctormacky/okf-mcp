# Live Database Discovery

Use this guide only when the selected Bundle lacks current physical evidence for
an unresolved query-plan slot. Discovery supplements the current query; it never
updates the Bundle or decides an ambiguous business definition.

## Resolve The Source

Prefer `dbexplain.sql_binding.instance_label` from a relevant Table Concept. If
no binding supplies a label, run `dbexplain list --json` and use only label, kind,
and database name to match the business domain. Do not expose host, port, config
path, or credentials. Ask the user to choose a business domain only when several
sources remain plausible.

This Skill supports SQL sources on one label. Do not switch to NoSQL, file, or
cross-label DSL queries.

## Comment-First Discovery

1. Check connectivity without sampling:

   ```bash
   dbexplain check --label <label> --json
   ```

2. List tables:

   ```bash
   dbexplain collect --label <label> --tables
   ```

   The compact table view includes table name, engine, row estimate, size, and
   table comment. Rank candidates by unresolved business-slot coverage in table
   comments first, then physical names and topology. Stop when the query plan is
   grounded; do not scan unrelated tables for completeness.

3. For each candidate that can resolve a missing slot, collect its full schema:

   ```bash
   dbexplain collect --label <label> --table <table> --json
   ```

   Use `tables[].comment` and `columns[].comment` together with types, primary and
   unique keys, indexes, and foreign keys. Comments identify candidates and
   explicit enum labels; they do not prove an undeclared JOIN or vague business
   concept.

4. If opaque table names prevent candidate selection, run one no-sample full
   `collect --json` or `collect --context <temporary-directory>`. Search table and
   column comments with atomic intent terms and read only artifacts that cover an
   unresolved slot. Remove temporary discovery output after use.

5. Use minimal aggregate probes only when schema/comments cannot distinguish
   candidates: counts, distinct counts, time `MIN/MAX`, at most 50 non-sensitive
   enum codes, or JOIN cardinality checks. Do not inspect raw detail rows.

## Binding Consistency

Prefer a current Bundle's `source_sql` and `sql_reference_template`. If live
metadata proves a binding stale or a table has no Concept, use one internally
consistent set of exact label, kind, database/schema, table, and column names from
the live result. Quote identifiers for that kind. Never mix stale binding fields
with current metadata in one SQL statement.

## Stopping And Reporting

- Stop when every required plan slot is grounded.
- Stop when remaining candidates add no evidence for an unresolved slot.
- Ask a business-language question when candidates represent different meanings.
- On connectivity, timeout, or permission failure, report the actual error; do
  not try alternate credentials or broaden limits.
- Record schema drift and live comment evidence internally. Surface only a
  material consequence for interpreting the result, without physical names or
  discovery details. Do not write discovery output or result rows into the
  Bundle.
