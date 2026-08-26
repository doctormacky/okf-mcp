---
type: Overlay Guide
title: References overlay
description: Shared enumerations and notes that are not a table, join, or measure. Copy a template; do not invent codes that are not in a comment or supplied by the user.
aliases:
  - 参考覆盖层
tags:
  - overlay
  - references
  - template
---

# References / 参考

## Index / 索引

* [English](#english)
* [中文](#中文)

## English

This folder holds **shared lookup material** that several datasets may reuse: enumerations, glossary notes, and pointers that are not themselves a table or a Metric.

Row counts and diagnostics in `observations/` are not value dictionaries. Do not copy sample rows. If a column comment says only “see state machine” and lists no codes, do not write an Enumeration file; keep the template here until the user supplies codes.

### Enumeration — `enums/<name>.md`

```yaml
---
type: Enumeration
title: Example status codes
description: Replace with the field this list describes.
status: draft
semantic:
  profile: dbexplain-okf-v1
  kind: enumeration
  values:
    - code: "<code>"
      labels:
        en: "<English label>"
        zh: "<中文标签>"
---
```

You may also attach the same `enum.values` list to a Semantic Dataset field when the codes belong to one column.

## 中文

本目录存放可被多个数据集复用的**共享参考**：枚举、名词说明，以及既不是表也不是指标的指针。

`observations/` 里的行数和诊断不是取值字典。不要复制样例行。如果列注释只有「见状态机」而没有列出代码，不要写成 Enumeration 文件，把模板留在这里，等用户提供代码再新建。

### 枚举 — `enums/<name>.md`

把上面的 YAML 复制成新文件。也可以把同样的 `enum.values` 写在某个 Semantic Dataset 字段上（当这些代码只属于那一列时）。
