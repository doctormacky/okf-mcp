---
type: Overlay Guide
title: Saved queries overlay
description: Business-accumulated SQL that already works in production or review. Copy the template; paste only SQL a person actually ran or supplied. Do not invent queries.
aliases:
  - 已知查询
  - 业务 SQL
tags:
  - overlay
  - queries
  - template
---

# Saved queries / 已知查询

## Index / 索引

* [English](#english)
* [中文](#中文)

## English

This folder holds **SQL the business already trusts**: reports, operational lookups, and other statements people have run and kept.

Paste SQL only when a person supplied it (an analyst, a DBA, a ticket, or an existing script). Do not generate a query from table comments, observations, or a guessed join. If nobody has given you the statement, leave this template in place and do not create a Concept file.

Put one query per file under `queries/<name>.md`. Keep `status: draft` until review. Use dialect-quoted identifiers from the physical Table Concepts. Do not include credentials, host names, or query result rows.

Optional `semantic.tables` lists physical tables the statement actually uses. Omit that list unless you can name those tables from the SQL.

```yaml
---
type: Saved Query
title: Example known query
description: Replace with when humans use this statement.
aliases: []
status: draft
semantic:
  profile: dbexplain-okf-v1
  kind: query
  dialect: mysql
  tables:
    - /tables/<instance>/<namespace>/<table>.md
---
```

```sql
SELECT t0.<column>
FROM <quoted_source> AS t0
WHERE t0.<column> = :example
```

## 中文

本目录存放**业务已经在用、并且信得过的 SQL**：报表、运维查询、以及大家跑过并留下来的语句。

只有人真正提供过的 SQL 才能写成文件（分析师、DBA、工单或现有脚本）。不要从表注释、观测数据或猜测的 JOIN 生成语句。如果没有人给出这条 SQL，把模板留在这里，不要新建 Concept 文件。

每个文件一条查询：`queries/<name>.md`。未审核前保持 `status: draft`。标识符使用物理 Table Concept 里的方言引号。不要写入凭据、主机名或查询结果行。

可选的 `semantic.tables` 列出语句实际用到的物理表。除非能从 SQL 里确认这些表，否则不要写这个列表。
