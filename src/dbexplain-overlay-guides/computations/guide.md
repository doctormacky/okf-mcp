---
type: Overlay Guide
title: Computations overlay
description: Attested computation contracts for sanctioned SQL or scripts. Copy the template only when a real computation and attester exist.
aliases:
  - 计算覆盖层
tags:
  - overlay
  - computations
  - template
---

# Computations / 计算

## Index / 索引

* [English](#english)
* [中文](#中文)

## English

This folder holds **attested computations**: a declared runtime, parameters, one sanctioned computation, and an attester. okf-mcp does not execute these contracts.

Do not invent a computation from a table comment. If you do not have a real script, executor, and attester, leave this template in place and do not create a Concept file.

```yaml
---
type: Attested Computation
title: Example computation
description: Replace when a real sanctioned computation exists.
status: draft
---

# Example computation

Describe the computation, its parameters, and the attester. Do not paste credentials or sample results.
```

## 中文

本目录存放**可证明的计算**：声明运行时、参数、一份被批准的计算，以及证明方。okf-mcp 不会执行这些合同。

不要从表注释编造计算。如果没有真实脚本、执行器和证明方，把模板留在这里，不要新建 Concept 文件。
