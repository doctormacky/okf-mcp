# End-to-End Examples

所有示例：**R1 盘点已有 → R2 提案 → 确认 → R3 写入 → overlay-index**。

---

## Example 1 — 首次写入 token 问数

**User:** 更新 test-bundle：统计 XXXX 用户 2026年5月 token 总量。

**R1：** `okf search token` + 读 `business/datasets/index.md`（尚无 Concept）+ collect。

**R2：** 提案：新建 usage/employee datasets + 一条 query。SQL 例子。等确认。

**User：** XXXX 是 login_name，可以写。

**R3：** `overlay-draft --tables taiyi_agent_model_usage,t_employee` → 写 query → **`overlay-index`**。

---

## Example 2 — 第二次，同一问数要改过滤列（更新）

**User：** 不对，用户应按工号 `employee_no` 过滤，更新刚才那条。

**R1：** 已有 `queries/token-usage-by-user-month.md` 与两张 dataset → **判定更新，不新建**。

**R2：** 提案写明「更新该 query 的 WHERE」；dataset 如需 synonyms 一并更新。

**User：** 同意。

**R3：** 改 query SQL；**不** overlay-draft（文件已在）。**`overlay-index`**（title 若变了）。

---

## Example 3 — 第二次，新问数（部分新建）

**User：** 再加「按部门汇总 5 月 token」。

**R1：** usage dataset 已有 → 更新描述即可；部门表没有 dataset → 新建；新 query。

**R2：** 对照表：更新 usage dataset；新建 department dataset + query。

**R3：** `overlay-draft --tables t_department`（usage 已存在会跳过）→ 新 query → **`overlay-index`**。

---

## Example 4 — 错误：不盘点就再 draft

已有 `business/datasets/orders.md` 时再 `overlay-draft --tables orders`：**不会更新**该文件，只会跳过。正确做法是打开文件手改，再 `overlay-index`。

---

## Prompt

```text
$okf-bundle-business
Bundle: /path/to/test-bundle
label: prod-mysql
业务：统计 XXXX 用户在 2026年5月的 token 消耗总量
请先看已有 business：有则更新，无则新建；确认后再写；写完刷新 index。
```
