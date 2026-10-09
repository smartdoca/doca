# Saved-image revision contract (approved 2026-10-07)

This corrected proposal supersedes the initial batch-v3-unchanged proposal.
The initial approval question is withdrawn: its rollback protection was not
valid because old counters skip `image_revision` and old v3 checkpoints can
still resume. Only explicit agreement to the corrected version below authorizes
implementation. The user explicitly agreed to the corrected proposal after
the rollback behavior was explained on 2026-10-07. Source implementation and
isolated validation are in progress; this approval is not proof that the two
real 95-page acceptance tasks have passed.

The current batch `image_edit` uses its first image reference both as the
frozen original page identity and as the provider's actual editing base. A saved
candidate supplied as another reference does not preserve its pixels. A local
text repair can consequently restore the original action outside the selected
area. Repeating all page changes is the current workaround, with no guarantee
that a previously correct change survives another generation.

## Proposed contract

Add an explicit `image_edit_saved` business tool. It uses the same configured
provider `edit` capability. Require the frozen page reference ID and the current
saved base asset ID separately. The host binds the actual base to its saved
operation receipt, bytes SHA256, dimensions, actor, session, batch attempt scope,
and requirements digest. Only the current `delivered[page]` asset qualifies;
historical, unreviewable, deleted, inaccessible or changed assets are rejected.
Revalidate the current pointer and binding immediately before generation and
before adopting its result.

The first release permits whole-page revision inside a batch v4 only; standalone
revision is rejected before a paid call. Existing original-page
polygons, masks, SAM proposals, and viewport bindings cannot be reused on this
base. Unsupported local revision returns a specific error without a paid call.
Original-page `image_edit`, its masks and free recomposition remain available
under their existing, separately validated contract.

Store a new strict `image_revision` version 1 operation and a separate strict
revision-raw version 1 record in the existing operation store. They explicitly
distinguish the original page from the actual base and actual ordered provider
references. Do not change the meaning of the first reference in existing
`image_generation` or raw version 1 records. Dispatch readers by explicit kind
and version; unknown revision versions are rejected with no missing-field
defaults. No database table migration is proposed.

The resulting page always undergoes full independent review against the frozen
original and all formal user requests. A successful revision of one defect
does not waive other criteria. Paid attempts accumulate on the same original
page and scope; changing base, model or job never resets them. Existing usage
facts, including unknown calls, retain their state. Whole-page editing does not
promise exact protected pixels; strict preservation is still an actual review
requirement and failures remain unqualified.

## Batch and canonical fee-scope versions

Use a strict batch v4 and paid-attempt v2 for the revision workflow. Upgrade the
canonical attempt-scope record at the SAME task-root operation ID to strict
scope-record v2 and scope-pointer v2. Before replacing that single registry
record, archive its exact original result, digest, owner, root-job binding and
timestamp as an immutable host-owned upgrade audit record. Existing jobs and
their v3 checkpoints are not rewritten. Keep the existing canonical scope-ID
derivation (including its fixed namespace string); the record's new format
version must not generate a second registry ID. Do not create a second live scope or
restore the old registry on code rollback.

Perform an explicit, transactional upgrade only with no in-flight image
operations and after validating actor/session, original request and formal
clarifications, complete frozen manifest and page order, existing scope digest,
all page attempt records, current saved assets and latest review bindings. New
v4 progress can carry forward the validated current artifacts and criteria;
the original v3 checkpoints remain intact. Invalid or unknown formats are
rejected, never repaired with invented defaults. New task roots register the
strict v2 canonical scope before any paid request.
Historical dormant attempts with unknown fees are retained and counted; they
are not called active network requests or reset to make the upgrade possible.

The new counter accepts exactly two explicit facts: historical generation
paid-attempt v1 that matches the archived original scope, and current generation
or revision paid-attempt v2 that matches the active canonical scope. It counts
both, including pending or unknown-fee requests, in the SAME original-page
budget. It does not alter existing attempt ordinals or usage ledger rows.
After establishing an active or archived scope association, reject an unknown
paid kind/version rather than skipping it. Only explicitly verified nonpaid
raw, export and free-composition records may be excluded. Base and selection
validation compares historical paid v1 to the exact archived predecessor, and
paid v2 to the active scope; it must not compare old v1 directly to v2, infer
missing fields or modify an old receipt to make equality pass.

## Existing formats, validation and rollback

Keep existing generation receipts, raw v1, masks v2 and old batch-v3 checkpoints
unchanged. The only existing record replacement is the explicitly authorized
canonical scope upgrade, with its exact predecessor archived as described above.
Accept a current existing saved generation only as a verified base asset for a
new revision, through its explicit existing reader; do not convert, backfill,
rewrite or dual-write its receipt. New revision readers do not reinterpret old
generation or mask records. An old-code rollback retains all files, costs and
records. Its existing strict scope-v1 reader rejects the canonical scope-v2
record; even explicitly resuming an older v3 checkpoint cannot reopen that
retired scope. Its strict batch-v3 reader also rejects new v4 checkpoints. This
rejection is the rollback behavior, not continued operation of new revisions.

Validate in isolated databases: current-base lineage, cross-user/session/scope
rejection, changed bytes/pointer, cancellation, concurrent base replacement,
same-page fee limits across both explicit attempt versions, invalid/unknown
versions, original-page complete review, exact scope-predecessor preservation,
and actual old-reader rollback refusal for both new and older checkpoints.
Validate real staged edits using
the user's PDFs, preserving their original requirements and accounting. This
contract does not waive the real image-quality and complete-delivery checks.
