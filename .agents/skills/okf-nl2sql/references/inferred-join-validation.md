# Inferred Join Validation

Use an inferred relationship only when no suitable semantic or executable
declared relationship exists. It is a naming-based candidate, not an approved
Business join.

## Eligibility

Require all of the following:

- same-label execution scope and the final query label;
- dbexplain confidence at least 85, the same-instance/same-database inference
  level;
- one semantically plausible candidate for the requested business relation;
- comments, Business Terms, or current user clarification support the endpoint
  meaning;
- complete current endpoint columns and key facts;
- at most one inferred edge in the final query.

## Aggregate Validation

Use exact source and column bindings to run aggregate probes, never raw detail:

1. Target uniqueness: group by every target key column. Duplicate key groups
   must be zero.
2. Source population: non-null source-key rows in the final query scope must be
   greater than zero.
3. Match coverage: count matched source rows in the same scope. At least one row
   must match; report the coverage percentage rather than enforcing a universal
   percentage threshold.
4. Grain preservation: a source `LEFT JOIN` must not increase row count. Composite
   key NULL and grouping logic must include every join column.

Execute bounded validation with the current label and a 30-second timeout. Empty,
truncated, timed-out, denied, duplicate, fanout, zero-match, or semantically
conflicting validation rejects the inferred join.

## Final Query And Reporting

Use `LEFT JOIN` for an optional dimension. Preserve unmatched base rows in an
explicit `unknown`/null group and report match coverage. Use `INNER JOIN` only
when the user's business population explicitly means matched records.

Do not loosen validation, reverse the relation, or silently try multiple
candidates. Keep the inferred relation, confidence, duplicate-key result, and
grain check in the internal evidence ledger. In the final result, mention only
match coverage or unmatched-group limitations that materially affect its
interpretation, without exposing physical identifiers or validation details.
This evidence applies only to the current query and is not Bundle verification.
