# Retrieval And Grounding

Use this guide when one knowledge hit does not uniquely cover the business
question.

## Atomic Retrieval

1. Split the question into measure, entity, dimensions, time, filters, and grain.
2. For each unresolved slot, search with one or two atomic user terms. Add a
   common translation, synonym, or abbreviation only as a separate recall query;
   an expansion is not business evidence.
3. Search across Bundles before selecting one. Group results by Bundle and merge
   repeated hits by URI. Do not add BM25 scores from separate queries.
4. Retrieve likely Metrics, Business Terms, Semantic Datasets, Saved Queries,
   Policies, and physical Table Concepts. Read full candidates with `get_concept`
   and follow their graph edges with the available neighbor/subgraph tools.
5. Select a Bundle only when one Bundle and one instance label cover every
   required slot. If several business domains fully match, ask the user to choose
   the domain in business language.

## Evidence Ledger

For each required slot record:

| Slot | Business meaning | Evidence | Physical binding | Confidence issue |
| --- | --- | --- | --- | --- |
| measure | what is calculated | user/Metric/comment | expression or column | unresolved meaning |
| grain | one output row represents | user/Dataset/PK | base table/key | possible fanout |
| time | business time axis | user/field role/comment | time column | timezone/axis |
| filter | included population | user/Policy/enum | predicate/code | ambiguous code |
| dimension | grouping label | Dataset/comment | dimension column | unmatched rows |

Business authority and SQL executability are separate axes:

- Business authority: current user clarification, then human-reviewed Business,
  then explicit stable comments, then draft/unverified Business.
- Executability: matching machine-confirmed Saved Query logic, then SQL binding
  v2 and executable declared relationship, then current live metadata.

An executable statement does not upgrade its business authority.

## Saved Query Evidence

A Saved Query is evidence for assembling the current SQL, not a separate runtime.
Use it only after reading the full Concept through MCP and matching its purpose,
fixed population, metric meaning, output grain, and source label to the current
question.

Add its reusable parts to the evidence ledger: established JOINs, fixed filters,
aggregates, output aliases, physical tables, and documented parameter roles. Keep
current user clarification, human-reviewed Metrics, and Policies authoritative
when they conflict with the query.

- If the Concept says it has no parameters and every intent slot matches, the
  assembled SQL may remain identical to the stored statement.
- If it documents parameters, obtain current values from the user's question and
  render them using the recorded type, shape, timezone, escaping, and SQL literal
  rules. Example values never fill missing intent.
- If parameter meaning, type, or current value is missing, ask in business terms.
  Do not infer parameters from undocumented literals in older Saved Queries.
- A smaller output can use an outer projection. Add columns only from grounded
  bindings and re-check grain and grouping; a new JOIN, population, metric, or
  grain returns to the normal planning and fanout workflow.

The stored verification proves only the exact saved example executed. Execute the
fully assembled current SQL through dbexplain before using its result.

## Comments

- Use a table comment to identify business subject and possible grain.
- Use column comments to identify measures, dimensions, time fields, state codes,
  and explicit enumerations.
- An explicit comment such as `state[1:open,2:closed]` supports that code-label
  mapping. A generic comment such as `user id` does not prove a JOIN.
- Current user clarification or human-reviewed Business overrides a conflicting
  physical comment. Surface the conflict rather than silently combining both.

## Policies And Graph

After choosing tables, enumerate Policy Concepts for the selected Bundle even if
their text does not match the question, then inspect inbound graph neighbors of
the selected tables. Apply only rules whose scope resolves to the query.

## Fanout Validation

- Choose one base fact grain before JOIN planning.
- A many-to-one or one-to-one dimension can join directly from the fact side.
- Aggregate a one-to-many input to the base grain before joining.
- Pre-aggregate multiple fact tables independently to their shared requested
  grain, then join the aggregates.
- If cardinality remains unknown, validate uniqueness and joined row count with
  aggregate probes before executing the final calculation.
