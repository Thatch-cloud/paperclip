# ADR: TRN-18 node-flip opportunity-cost pricing

Date: 2026-07-31
Author: Grace (Backend / Distributed Systems)
Issue: [THA-6207](/THA/issues/THA-6207)

## Context

Managed fine-tune v1 targets CUDA RTX PRO 6000 nodes. A planner may choose to flip a node or MIG slice from serving (Instant/Batch) to training. That decision must be economically defensible: the training margin per unit-hour must cover the serving revenue we forgo by taking the unit off the serving lane.

This decision builds on the durable training ledger from [THA-6018](/THA/issues/THA-6018) and the serving projection from [THA-6017](/THA/issues/THA-6017). It does not introduce a new source of truth.

## Decision

We compare the durable training margin per unit-hour with the durable serving opportunity-cost per unit-hour for the same node or MIG-slice unit.

- **Justified** when `trainingMarginPerUnitHourCents >= servingOpportunityCostPerUnitHourCents`.
- **Not justified** when the training margin is below that floor.
- **Insufficient data** when either input is not from the durable ledger/projection; modelled values are never silently used.

Below-floor training pricing is rejected by default. An explicit override is accepted only when it carries a durable `actorId`, `reason`, and `timestamp`. The decision surface still records that the floor was breached, so operators and finance can audit it.

## Consequences

- The planner gets a clear three-state signal: `justified`, `not_justified`, or `insufficient_data`.
- The pricing floor is enforced by the decision rule, not by a separate billing check.
- Overrides are auditable by construction.
- Non-durable inputs are surfaced as insufficient data rather than silently driving a flip decision.

## Scope boundaries

- Managed fine-tune only; no Spark customer training, no Tenstorrent, no interactive rental.
- CUDA RTX PRO 6000 path is the v1 customer-training target.
- No changes to the gRPC Management↔Compute seam; this is a control-plane pricing rule.
