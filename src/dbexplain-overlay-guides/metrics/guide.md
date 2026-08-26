---
type: Overlay Guide
title: Metrics overlay
description: Reviewed measures such as SUM or COUNT. Copy the template into a new file only when a human names the measure and every column is known.
aliases:
  - 指标覆盖层
tags:
  - overlay
  - metrics
  - template
---

# Metrics / 指标

## Index / 索引

* [English](#english)
* [中文](#中文)

## English

This folder holds **reviewed measures** used in SQL aggregation: counts, sums, and similar expressions with an explicit grain.

Do not create a Metric file because a column is numeric. Do not invent filters, time grains, or currency. Leave unproven measures in this template until a person names the measure and every `{{relation.column}}` placeholder resolves through the base table or a proven relationship.

Copy into `metrics/<name>.md` only then. Keep `status: draft` until review. Provide the dialect that matches the physical table, or `ansi_sql`.

```yaml
---
type: Metric
title: Example measure
description: Replace with the business name of this measure.
aliases: []
status: draft
semantic:
  profile: dbexplain-okf-v1
  kind: metric
  base_table: /tables/<instance>/<namespace>/<table>.md
  datatype: Integer
  expressions:
    ansi_sql: COUNT({{<relation>.<column>}})
  required_relationships: []
---
```

## 中文

本目录存放经过确认的**度量**：COUNT、SUM 等聚合，以及明确的粒度。

不要因为某列是数字就新建 Metric。不要编造筛选条件、时间粒度或币种。在有人说出指标名称、并且每个 `{{relation.column}}` 都能通过基表或已证明的关系解析之前，不要写成 Metric 文件，只留在本模板里。

确认后再复制为 `metrics/<name>.md`。未审核前保持 `status: draft`。表达式方言须与物理表一致，或使用 `ansi_sql`。
