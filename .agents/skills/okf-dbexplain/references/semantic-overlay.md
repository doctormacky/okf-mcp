# Semantic Overlay Contract

Semantic overlays map business language to generated physical bindings. Files
remain human-owned and byte-preserved by synchronization. Only Concepts with
`semantic.profile: dbexplain-okf-v1` use this strict contract; ordinary overlay
Markdown remains narrative and is not an executable binding.

Use top-level `title`, `description`, and `aliases` plus Markdown body text for
retrieval. okf-mcp deliberately does not interpret or index arbitrary nested
`semantic.*`. Every semantic target must therefore also appear as an existing
top-level `relations` entry and a Markdown link. Field names, synonyms, enum
labels, and expressions must be rendered into the body. Add real `sources` and
keep new claims `status: draft` until reviewed. Unproven joins, enum codes,
Metrics, and SQL remain in Skill proposals and are not written as Concepts.

## Business Term

```yaml
type: Business Term
title: Customer
aliases: [buyer, purchaser]
relations:
  - type: related_to
    target: /tables/prod/app/orders.md
    label: binding:customer_id
semantic:
  profile: dbexplain-okf-v1
  kind: term
  bindings:
    - table: /tables/prod/app/orders.md
      column: customer_id
```

Every table must be active and query-ready; every column must exist.

## Semantic Dataset

```yaml
type: Semantic Dataset
title: Orders
aliases: [purchases]
relations:
  - type: depends_on
    target: /tables/prod/app/orders.md
    label: physical_table
semantic:
  profile: dbexplain-okf-v1
  kind: dataset
  physical_table: /tables/prod/app/orders.md
  fields:
    - name: order_date
      column: created_at
      datatype: DateTimeTz
      dimension:
        is_time: true
      synonyms: [purchase time]
      enum:
        values:
          - code: "2"
            labels:
              en: On sale
              zh: 售卖中
```

`datatype` follows the OSSIE-inspired portable types. `dimension.is_time` is a
role independent of datatype and may override the mechanical default only when
the overlay is reviewed. Write `enum` only when a column comment lists explicit
codes or the user supplied the codes.

## Semantic Relationship

Provide exactly one of `physical_relationship` (a declared executable foreign
key) or `semantic.join` (user-confirmed endpoints). Do not guess from `*_id`
names.

```yaml
type: Semantic Relationship
title: Order customer
relations:
  - {type: depends_on, target: /business/datasets/orders.md, label: from_dataset}
  - {type: depends_on, target: /business/datasets/customers.md, label: to_dataset}
  - {type: depends_on, target: /relationships/declared/orders__customers.md, label: physical_relationship}
semantic:
  profile: dbexplain-okf-v1
  kind: relationship
  physical_relationship: /relationships/declared/orders__customers.md
  from_dataset: /business/datasets/orders.md
  to_dataset: /business/datasets/customers.md
```

```yaml
type: Semantic Relationship
title: Run employee
status: draft
relations:
  - {type: depends_on, target: /business/datasets/runs.md, label: from_dataset}
  - {type: depends_on, target: /business/datasets/employees.md, label: to_dataset}
  - {type: depends_on, target: /tables/prod/app/runs.md, label: join_from_table}
  - {type: depends_on, target: /tables/prod/app/employees.md, label: join_to_table}
semantic:
  profile: dbexplain-okf-v1
  kind: relationship
  from_dataset: /business/datasets/runs.md
  to_dataset: /business/datasets/employees.md
  join:
    cardinality: many-to-one
    predicate_template: "ON {{from}}.employee_id = {{to}}.employee_id"
    from:
      table: /tables/prod/app/runs.md
      columns: [employee_id]
    to:
      table: /tables/prod/app/employees.md
      columns: [employee_id]
```

## Enumeration

```yaml
type: Enumeration
title: Goods status
status: draft
semantic:
  profile: dbexplain-okf-v1
  kind: enumeration
  values:
    - code: "1"
      labels:
        en: Reserved
        zh: 预约中
```

## Saved Query

Record SQL only after the exact statement succeeds through `dbexplain execute`
and the user confirms it. `tables` is required and must list active physical
tables used by that SQL.

```yaml
type: Saved Query
title: Open orders
status: draft
relations:
  - {type: depends_on, target: /tables/prod/app/orders.md, label: query_table}
verified:
  by: process:dbexplain
  at: "2026-08-26T09:00:00Z"
  method: dbexplain_execute
  statement_sha256: sha256:<normalized-sql-digest>
  instance_label: prod
semantic:
  profile: dbexplain-okf-v1
  kind: query
  dialect: mysql
  tables:
    - /tables/prod/app/orders.md
```

Put exactly one closed `sql` fence in the body and link every table before it.
Normalize line endings to LF and trim outer whitespace before hashing.

## Metric

```yaml
type: Metric
title: Revenue
aliases: [sales amount]
relations:
  - {type: depends_on, target: /tables/prod/app/orders.md, label: base_table}
semantic:
  profile: dbexplain-okf-v1
  kind: metric
  base_table: /tables/prod/app/orders.md
  datatype: Decimal
  expressions:
    postgres: SUM({{orders.amount}})
    mysql: SUM({{orders.amount}})
  required_relationships: []
```

Each `{{relation.column}}` placeholder must resolve through the base table or a
required proven relationship (declared executable FK or overlay join). All
dependencies must share the base table's instance label. Filters, time fields,
currency, grain, and joins are optional only when the Metric does not need
them; never fabricate missing semantics.

This profile borrows OSSIE dataset, field, relationship, datatype/time-role,
Metric expression, synonym, and AI-context conventions from draft
`0.2.0.dev0` revision `1d9ebcea2932d3381c0840cc8304f0850d366509`.
It is an OKF mapping, not an OSSIE conformance claim.
