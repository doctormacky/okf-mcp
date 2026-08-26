---
type: Overlay Guide
title: Policies overlay
description: Rules about what generated SQL must not do. Copy the template; list only columns whose names or comments already identify a secret or a delete flag.
aliases:
  - 策略覆盖层
tags:
  - overlay
  - policies
  - template
---

# Policies / 策略

## Index / 索引

* [English](#english)
* [中文](#中文)

## English

This folder holds **query rules**: columns that must not appear in `SELECT *`, rows that should be excluded, and similar constraints.

Write only what the physical names or comments already show (for example a column named `login_pwd`). Do not invent a deleted-row filter unless a comment states the 0/1 meaning. Unproven rules stay in this template.

```yaml
---
type: Policy
title: Example query policy
description: Replace with the rule this file enforces.
status: draft
---

# Example query policy

* Do not select column `<column>` from `/tables/<instance>/<namespace>/<table>.md`.
```

## 中文

本目录存放**查询规则**：禁止出现在 `SELECT *` 中的列、应当排除的行等。

只写物理列名或注释已经表明的内容（例如名为 `login_pwd` 的列）。除非注释写明 0/1 含义，否则不要编造逻辑删除过滤。没有把握的规则留在本模板里，不要建成文件。
