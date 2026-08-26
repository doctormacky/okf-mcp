---
type: Overlay Guide
title: Skills overlay
description: Agent skills that consume this database Bundle. Copy the template; do not claim SQL assembly or query execution inside the generator skill.
aliases:
  - 技能覆盖层
tags:
  - overlay
  - skills
  - template
---

# Skills / 技能

## Index / 索引

* [English](#english)
* [中文](#中文)

## English

This folder holds **agent skills** that read this Bundle (for example a consumer skill that retrieves overlay Concepts and assembles SQL). The bundled `okf-dbexplain` and `okf-bundle-business` skills do not live here and must not execute queries.

If you do not have a real skill to publish, leave this template and do not create a Concept file.

```yaml
---
type: Skill
title: Example consumer skill
description: Replace with what the skill does with this Bundle.
status: draft
---

# Example consumer skill

* Reads overlay guides and reviewed semantic Concepts.
* Must not invent joins, enum codes, or Metrics that are not in this Bundle.
```

## 中文

本目录存放**使用本 Bundle 的 Agent 技能**（例如检索覆盖层并拼 SQL 的消费端技能）。内置的 `okf-dbexplain` 与 `okf-bundle-business` 技能不放在这里，也不得执行查询。

如果没有要发布的真实技能，把模板留在这里，不要新建 Concept 文件。
