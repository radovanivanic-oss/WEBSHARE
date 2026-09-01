# B54 maintenance orchestration runbook

B54 provides a restart-safe coordinator around the proven Webshare Atlas additive-maintenance and publication stages. It creates an immutable, auditable cycle directory and keeps production apply and public-pointer activation behind separate, identity-bound authorizations.

## Operating policy

- Daily anonymous discovery remains read-only at 03:17 Europe/Bratislava.
- A maintenance cycle consumes only completed observations at its frozen cutoff.
- Semantic compatibility is checked independently of implementation build identity.
- Same-day duplicate and diagnostic observations are not counted as independent dates.
- The default plan limit is 500; the hard limit is 1000.
- No candidate is applied without persistence, deep-audit, B39, ownership, conflict, and live-baseline checks.
- Weekly stale verification remains a separate disabled track.
- Apply and publication are never scheduled automatically.

The B54 implementation does not change the current production database or AG_repo merely by being installed. The first real cycle prepared during B54 is intentionally left at `APPLY_AUTHORIZATION_REQUIRED` and has not been authorized or applied.

## Cycle layout

Each cycle is stored below:

    runtime/maintenance-cycles/<cycle-id>/

The cycle contains the immutable contract and, as stages complete, these artifacts:

- `cycle.json` — versioned contract, semantic contract, implementation identity, source cutoff, baselines, and policy.
- `observation-inventory.json` — all discovered artifacts and selected compatible independent dates.
- `.source-observations/` — frozen copies of selected observation artifacts.
- `persistence-ledger.json` — rebuildable persistence evidence.
- `eligibility.json` — current production/B39/deep-audit eligibility result.
- `candidate-set.json` and `plan.json` — deterministic bounded candidate identity.
- `dry-run-validation.json` — proof that preparation performed no production write.
- `apply-authorization.json`, `apply-intent.json`, `backup/`, and `apply-result.json` — apply audit chain.
- `publication-source/`, `publication-candidate/`, and `publication-plan.json` — local-only publication preparation after a verified apply.
- `publication-authorization.json` and `publication-result.json` — publication audit chain.
- `state.json` and `state-history.jsonl` — lifecycle state and transition history.
- `artifact-index.json` — file and canonical hashes for all cycle artifacts.

Artifacts are written with exclusive creation. Existing immutable artifacts are never overwritten. State is updated atomically and every transition is appended to the history file.

## Normal operator workflow

### 1. Prepare a cycle

Choose a unique cycle ID and a cutoff. The cutoff freezes the observation portfolio for this cycle:

    npm run maintenance:prepare -- \
      --cycle-id b54-YYYYMMDDTHHMMSSZ \
      --observation-cutoff 2026-09-01T16:20:00.000Z \
      --max-candidates 500

Preparation performs inventory, semantic compatibility filtering, diagnostic and duplicate-date exclusion, persistence rebuild, current-production exclusion, B39 exclusion, deep audit, deterministic ranking, and live dry-run validation. It stops at `APPLY_AUTHORIZATION_REQUIRED` when candidates exist.

Preparation never invokes `--apply`, never advances production state, and never publishes.

### 2. Inspect status

    npm run maintenance:status -- --cycle-id b54-YYYYMMDDTHHMMSSZ

Status reports the lifecycle state, frozen dates, eligible and planned counts, cycle and live production digests, public baseline, authorization presence, last apply, and next required action. A changed live baseline is reported as a blocker by plan validation.

### 3. Authorize apply explicitly

Read `plan.json` and `candidate-set.json`, then use both hashes. The confirmation must be the exact cycle- and plan-bound phrase:

    AUTHORIZE APPLY <cycle-id> <plan-sha256>

Example command:

    npm run maintenance:authorize-apply -- \
      --cycle-id b54-YYYYMMDDTHHMMSSZ \
      --plan-sha <plan-sha256> \
      --candidate-set-sha <candidate-set-sha256> \
      --confirm "AUTHORIZE APPLY b54-YYYYMMDDTHHMMSSZ <plan-sha256>" \
      --identity <operator-id>

A generic `--yes` or `--force` is not accepted. The authorization artifact is single-cycle, single-plan, single-baseline, and marked non-reusable.

### 4. Apply one authorized plan

    npm run maintenance:apply -- --cycle-id b54-YYYYMMDDTHHMMSSZ

The coordinator revalidates the exact plan, live baseline, candidate absence, B39 state, and backup conditions; creates and validates a streaming-safe SQLite backup; records an execution intent; invokes the established atomic additive apply path; checks exact inserted identifiers; runs postflight integrity checks; and prepares a local publication candidate. It stops at `PUBLICATION_AUTHORIZATION_REQUIRED`.

The apply path permits additive inserts only. It does not delete, deactivate, reconcile, enrich, or publish. A transaction failure is fail-closed. A post-commit invariant failure enters an explicit apply-failure state and must be recovered from the retained validated backup rather than repaired by ad hoc row edits.

### 5. Review publication preparation

After `APPLY_VERIFIED`, local publication preparation may be resumed with:

    npm run maintenance:prepare-publication -- \
      --cycle-id b54-YYYYMMDDTHHMMSSZ \
      --generation-id b54-<fixed-generation-id>

This freezes the post-apply source, exports and validates the public generation locally, and writes `publication-plan.json`. It performs no remote upload and does not change `current.json`.

### 6. Authorize publication separately

Use the canonical hash of `publication-plan.json` and the exact phrase:

    AUTHORIZE PUBLICATION <cycle-id> <publication-plan-sha256>

    npm run maintenance:authorize-publication -- \
      --cycle-id b54-YYYYMMDDTHHMMSSZ \
      --plan-sha <publication-plan-sha256> \
      --confirm "AUTHORIZE PUBLICATION b54-YYYYMMDDTHHMMSSZ <publication-plan-sha256>" \
      --identity <operator-id>

The authorization binds the post-apply database digest, generation, manifest, expected current pointer, and rollback generation. Any identity change invalidates it.

### 7. Publish only through the explicit adapter

    npm run maintenance:publish -- --cycle-id b54-YYYYMMDDTHHMMSSZ

The command fails closed unless `MAINTENANCE_PUBLICATION_ADAPTER` points to a repository-local adapter implementing the established immutable-release, remote verification, AG_repo generation, pointer-last switch, and rollback protocol. B54 does not install or enable that adapter automatically. No publication scheduler is created.

## State machine

Normal transitions are:

    CREATED
      -> OBSERVATIONS_SELECTED
      -> PERSISTENCE_REFRESHED
      -> ELIGIBILITY_READY
      -> PLAN_READY
      -> APPLY_AUTHORIZATION_REQUIRED
      -> APPLY_AUTHORIZED
      -> APPLY_RUNNING
      -> APPLY_VERIFIED
      -> PUBLICATION_AUTHORIZATION_REQUIRED
      -> PUBLICATION_AUTHORIZED
      -> PUBLICATION_RUNNING
      -> PUBLICATION_VERIFIED
      -> COMPLETE

`NO_ELIGIBLE_ITEMS` is a safe terminal no-op after plan generation. Failure states are explicit: `BLOCKED`, `APPLY_FAILED`, `APPLY_ROLLED_BACK`, `PUBLICATION_FAILED`, and `PUBLICATION_ROLLED_BACK`. Illegal transitions are rejected. A cycle cannot jump over an authorization gate.

## Resume and locking

The shared lock is:

    runtime/maintenance-cycles/.maintenance-cycle.lock

It uses the existing process-identity lock implementation with stale-lock recovery. It covers preparation, authorization, apply, publication preparation, and publication, preventing concurrent cycles from using shared production/publication boundaries.

Preparation resumes only an existing `PLAN_READY` or `APPLY_AUTHORIZATION_REQUIRED` cycle after revalidating the immutable plan against the current database and B39 sidecar. A failed resume validation changes the cycle to `BLOCKED`; it never silently regenerates the plan. An already prepared no-op resumes as `NO_ELIGIBLE_ITEMS`. Apply and publication stages similarly require their exact prior authorization and bound identities.

A newer observation after cycle creation is not silently incorporated. It is available to a later cycle.

## Recovery

If a failure occurs before the SQLite transaction commits, the cycle is blocked or marked `APPLY_FAILED` and the transaction must leave the database unchanged. If a committed apply fails an invariant, retain the cycle backup and restore the exact pre-cycle database through the validated SQLite backup/recovery procedure, then verify the original logical digest, quick check, foreign keys, duplicate checks, B39 leakage, unclassified count, and API health. Do not perform row-by-row improvisation.

If publication fails before pointer switch, leave the previous public generation authoritative. If a pointer was switched and remote consumer validation fails, use the recorded previous pointer and perform a pointer-only rollback; retain the failed immutable generation for audit.

## Security and boundaries

Runtime artifacts are checked for secret-shaped fields before writing. Do not place WST values, passwords, cookies, authorization headers, GitHub tokens, signed playback URLs, or private credentials in cycle input or output. Discovery remains anonymous. Account-authenticated operations remain separate and are not introduced by the coordinator.

B54 never enables automatic apply, automatic publication, weekly stale mutation, deletion, deactivation, reconciliation, Kodi changes, or TMDb enrichment.

## Current B54 validation cycle

The production-like preparation completed for:

    runtime/maintenance-cycles/b54-20260901T162000Z/

It selected seven independent compatible dates, produced a 500-item plan, validated the current production baseline, and stopped at `APPLY_AUTHORIZATION_REQUIRED`. Its plan was not authorized and no production mutation was performed. This is the intended B54 demonstration of the pre-authorization boundary.