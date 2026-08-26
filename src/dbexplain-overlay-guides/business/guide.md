---
type: Overlay Guide
title: Business overlay
description: Bind business language to physical tables and columns. Copy a template below into a new file. Do not invent joins, enums, aliases, or filters.
aliases:
  - 业务覆盖层
tags:
  - overlay
  - business
  - template
---

# Business overlay / 业务覆盖层

## Index / 索引

* [English](#english)
* [中文](#中文)

## English

This folder holds **business meaning** on top of generated physical tables.

- `terms/` — words people say (`Customer`, `Employee`) bound to real table columns.
- `datasets/` — query-shaped fields on **one** physical table.
- `relationships/` — how two datasets join.

Copy a YAML template into a new Markdown file. Keep `status: draft` until a human reviews it. Write only claims the schema, a column comment with an explicit list, or the user can prove. Unproven joins, enum codes, and aliases stay in this template; do not create those Concept files yet.

Replace `/tables/<instance>/<namespace>/<table>.md` with a real path from `tables/`.

### Business Term — `terms/<name>.md`

```yaml
---
type: Business Term
title: Example term
description: Replace with the business word and why this column is the binding.
aliases: []
status: draft
semantic:
  profile: dbexplain-okf-v1
  kind: term
  bindings:
    - table: /tables/<instance>/<namespace>/<table>.md
      column: <column>
---
```

### Semantic Dataset — `datasets/<name>.md`

Include `enum` on a field only when the column comment lists explicit codes, or the user supplied the codes.

```yaml
---
type: Semantic Dataset
title: Example dataset
description: Replace with the business name of this table.
aliases: []
status: draft
semantic:
  profile: dbexplain-okf-v1
  kind: dataset
  physical_table: /tables/<instance>/<namespace>/<table>.md
  fields:
    - name: example_field
      column: <column>
      datatype: String
      synonyms: []
---
```

### Semantic Relationship — declared foreign key — `relationships/<name>.md`

Use this shape only when `relationships/declared/` already has an executable join.

```yaml
---
type: Semantic Relationship
title: Example declared join
status: draft
semantic:
  profile: dbexplain-okf-v1
  kind: relationship
  physical_relationship: /relationships/declared/<from>__<to>.md
  from_dataset: /business/datasets/<from>.md
  to_dataset: /business/datasets/<to>.md
---
```

### Semantic Relationship — overlay join — `relationships/<name>.md`

Use this shape only after the user confirms both endpoints. Do not guess from `*_id` names alone.

```yaml
---
type: Semantic Relationship
title: Example overlay join
status: draft
semantic:
  profile: dbexplain-okf-v1
  kind: relationship
  from_dataset: /business/datasets/<from>.md
  to_dataset: /business/datasets/<to>.md
  join:
    cardinality: many-to-one
    predicate_template: "ON {{from}}.<from_column> = {{to}}.<to_column>"
    from:
      table: /tables/<instance>/<namespace>/<from_table>.md
      columns:
        - <from_column>
    to:
      table: /tables/<instance>/<namespace>/<to_table>.md
      columns:
        - <to_column>
---
```

## 中文

本目录存放物理表之上的**业务语义**。

- `terms/`：人口中的词（客户、员工）绑定到真实列。
- `datasets/`：一张物理表上的可查询字段。
- `relationships/`：两个数据集如何连接。

把下面的 YAML 复制成新的 Markdown 文件。未人工审核前保持 `status: draft`。只写入 schema、带明确取值列表的列注释、或用户能够证明的内容。没有把握的 JOIN、枚举值和别名留在本模板里，先不要建成 Concept 文件。

请把 `/tables/<instance>/<namespace>/<table>.md` 换成 `tables/` 下的真实路径。
