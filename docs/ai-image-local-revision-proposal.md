# Local saved-image revision proposal (approved 2026-10-07; implementation in progress)

The user explicitly approved this revised proposal on 2026-10-07: “没问题吗升级吧”.
Implementation and isolated verification are in progress; this status does not
claim the 95-page image acceptance tasks have been completed. This revision replaces the earlier pending proposal that
incorrectly relied only on the paid counter as a rollback fence. The existing
whole-page workflow and its records remain
under the approved contract in `ai-image-revision-proposal.md`.

## Problem and proposed behavior

Real staged edits retained the desired wall and text but changed another cat's
pose while removing an extra paw. Whole-page regeneration has no deterministic
protection for already correct content. Add `image_edit_saved_local` and its
read-only preview: the assistant selects a repair region on the CURRENT saved
base, sees the actual base and coverage, and requests a later paid edit only
after complete visual transmission. Outside that region, the host copies the
current base's exact RGBA pixels. The result still needs full review against
the frozen original and every formal user request; a locally successful edit
does not waive an earlier defect elsewhere on the page.

The actual provider input starts with the bound base viewport, not the frozen
original. Supply the frozen original as a separately labelled context reference
after the necessary identity references. This helps recover original pose,
lettering and scene context without restoring the original action across the
whole result. Record the actual transmitted pixels, reference order and roles;
do not pretend a crop or padded workspace is the full base. Providers without
the required implemented capability or reference capacity are rejected before
a paid submission. No protocol guessing, model fallback or paid POST retry is
introduced.

## Explicit formats and code paths

| Format | Handling |
| --- | --- |
| Existing unversioned generation and original raw v1 | Preserve historical receipts and pixels through explicit readers; no rewritten records or inferred paid-attempt versions. Original raw v1 keeps its original-page meaning. |
| New image_generation v1 | Explicit scope-v3 receipt for original-page generation, reference export or original-page local recomposition. Paid calls require paid-attempt v3; exports have no paid attempt; recompositions validate their immutable original-generation parent. The existing unversioned generation reader does not reinterpret this version. Original raw v1 pixels and original-page mask v2 semantics stay unchanged; parent dispatch explicitly supports the new generation receipt. |
| Existing original-page mask v2 and free recomposition | Preserve their original-page semantics. Reject their use on a saved base or revision raw. |
| Existing image_revision v1 and image_revision_raw v1 | Remain whole-page only. Keep historical receipts, assets, costs and checkpoints unchanged. A verified current v1 saved image can be a base for a new v2 operation; it is not converted. |
| New image_revision v2 | Explicit `mode:whole` or `mode:local`, binding v2 and paid-attempt v3. Local mode additionally requires the base-coordinate region, preview binding, actual viewport transform and resulting current-base canvas. Whole mode does not invent a local region. Both retain original/current-base lineage and actual provider-reference roles. No missing-field defaults. |
| New image_revision_raw v2 | Immutable actual provider pixels, usage and ordered reference/crop/workspace facts for the matching v2 mode. Unknown modes or versions are rejected. Original raw and whole-revision raw v1 readers do not reinterpret it. |
| New local-preview v1 | Separate base-coordinate proof, bound to actor/session, current pointer, scope, requirements, exact base/original bytes, region and workspace. Old original-page previews, SAM and mask proofs do not qualify. |
| Existing batch v3/v4, scope v1/v2 and paid-attempt v1/v2 | Preserve checkpoints, receipt bytes, fees and their verified archive lineage. Untouched tasks retain their explicit existing protocols. Upgrading a selected v4 task is a separate explicit action, never a missing-field fallback. |
| New batch v5, canonical scope v3 and paid-attempt v3 | New tasks use this strict protocol. `image_batch upgrade_local` explicitly validates and upgrades a selected v4 task. The canonical operation ID, original task root, manifest, frozen pages and fee budget stay the SAME. New attempts count every verified v1/v2/v3 attempt, including unknown outcomes; no cleared ordinal or separate local budget. |
| New scope archive v2 | Preserve the exact predecessor scope-v2 operation snapshot and its verified scope-v1 archive chain before replacing the canonical record. Existing archive v1 remains unchanged. No automatic downgrade, restored old registry or dual writes. |

Affected code is the saved-revision contract/service, provider preparation,
strict raw readers, visual proof transport, scope counter, current-asset
selection, complete review, attachment/file readers and web/mobile labels.
Readers must explicitly dispatch v1 whole and v2 whole/local; invalid or unknown
formats fail rather than being repaired. The host revalidates current base,
bytes, permissions, criteria, scope and preview before reserving/submitting and
before adopting the result. Cancellation or a newer current base retains a
returned paid candidate and actual usage without overwriting the newer result.

## Data preservation, validation and rollback

The explicit v4-to-v5 upgrade is a persisted JSON protocol migration: in one
transaction, archive the exact canonical scope-v2 row, then replace that SAME
row with scope v3 using a compare-and-swap against the verified predecessor.
Carry the validated manifest, requests, current images, reviews and progress
into a new v5 checkpoint; never rewrite the historical v4 checkpoint. Reject
malformed or missing lineage, unauthorized tasks, inconsistent counts and
unknown protocol versions. No database-table migration, original receipt
conversion, dual writing, data deletion or automatic old-preview upgrade is
proposed. All original files,
current results, previous generations, raw records, checkpoints, review
evidence and costs remain available.

Read-only investigation with the actual deployed counter found that a v2
revision would prevent another paid reservation but would NOT prevent fresh
old-v4 resume or a completed old checkpoint from passing scope verification
when canonical scope v2 is left unchanged. Therefore retaining canonical v2
is explicitly rejected by this revised proposal.

The strict older scope reader accepts only v1/v2 canonical records. Replacing
the SAME canonical record with v3 rejects fresh initial/retry recovery,
explicit resume, registration and paid reservation from older code even when
it selects a historical v4 checkpoint. Existing historical status and saved
files remain readable under their existing permissions; rollback does not
erase or hide them. Restore the new code to continue a v5 task; do not restore
the old canonical registry to make older code continue it.

An already running old executor can pass scope verification BEFORE an upgrade
and later advance or publish without re-reading the canonical record. The
upgrader must therefore reject every OTHER live executor in the same scope,
including executors with no image call in flight. Only the current new-code
continuation doing the explicit upgrade may be excepted, after verifying that
it has submitted no image operations in that continuation. Use the host user
lock, leases, cancellation state and transactional checks; never silently
cancel another task or clear a lease. The new code must revalidate the current
scope before current-asset adoption, completion and publication as well as
before paid reservation. Failed or concurrent upgrades leave scope v2 and all
data unchanged.

Two private isolated metadata proofs used the actual old reader and counter:
old v4 scope verification accepted a hypothetical v2 revision; the counter
rejected its next reservation; a v3 canonical discriminator stub made the old
scope reader reject. These fixtures are NOT an implementation or validation of
the new v2 schemas or upgrader. After approval, validate complete real new
records with the captured actual older reader in an isolated database,
including recovery from an earlier v4 checkpoint and the live-executor race.

Test source/base/region/workspace changes, partial frames, interrupted EOF,
same-round and concurrent calls, cross-account/session/scope rejection,
viewport restoration, outside-region exact pixels, unknown outcomes, and
unchanged same-page cumulative fees across both explicit revision versions.
Then validate the actual extra-paw, punctuation and family-replacement cases;
only actual image quality and full coverage count as delivery.

This first local extension does not predict unknown background formerly hidden
by a person. Original mask v2 uses E=S∪G∪T and directly copies raw inside E, so
S\\G contains the raw background even with correct segmentation. Background
prediction, a new free-cleanup mode or revision-aware original-page mask would
need a separate concrete agreement. No clone ID, fabricated raw, changed mask
meaning or waived acceptance criterion may bypass this boundary.
