# OPD read-cutover & app migration playbook

Status of the token-engine cutover and exactly what each client app needs. The
backend runs **legacy `Booking` and the new token engine side by side** (dual
write); reads flip **per clinic** behind a flag, and nothing legacy is deleted
until every app is migrated.

## The mechanism

- **Dual write** (`src/op-mirror/OpMirrorService`): every real channel keeps
  writing its legacy `Booking` **and** drives the new pipeline in parallel.
  - Reception walk-in → **full path**: register → check-in → token → enqueue
    (patient is at the desk).
  - App (payments.confirm) & Voice (voice.book) → **register-only**: an
    `Encounter` in `REGISTERED`, **no token, not enqueued** — because the patient
    is not present and the architecture forbids a token before check-in.
- **Backfill** (`scripts/backfill-opd.ts`, idempotent): projects historical
  `Booking` rows into the new aggregates, **preserving the legacy token number**,
  keyed by `Encounter.legacyBookingId`.
- **Read flag**: per-clinic config `reads.cutover.*` (scope `CLINIC`, default
  **false**), resolved via `OpConfigService.get`. Flip a single clinic on; flip
  back instantly. Off = legacy, so un-flipped clinics and the whole test suite are
  untouched.

## Why reception could cut over but the others can't (yet)

The new engine only has a **token + queue entry** for a patient once they are
**checked in through the new path**. That happens at the **reception desk**.
Therefore:

- New-engine queue data exists today for **reception walk-ins** only.
- App/voice patients are `REGISTERED`-only in the new engine until a desk checks
  them in — at which point they gain a new token + queue entry.

So the cutover is **sequenced**, not per-app-independent:

```
1. Reception desk  ──(new check-in issues new token + enqueue)──►  new queue populated
2. Doctor queue / Patient status  ──(can now read the new queue)──►  cut over
3. Retire legacy Booking + tables  (only after 1–2 are live everywhere)
```

## Per-app status

### Reception app (`reception-dashboard`) — ✅ cut-over ready, no app change
- Roster read `GET /reception/bookings`: served from the new aggregates when
  `reads.cutover.roster` is on for the clinic, in the **identical**
  `BookingRosterView` shape (`src/reception/legacy-roster-compat.service.ts`). The
  flipped roster ALSO surfaces **register-only** (pre-token) encounters — the
  app/voice patients whose mirror is register-only — so the desk can see and
  process them (a token-less row until check-in).
- Actions `PATCH /reception/bookings/:id/checkin` and
  `POST /reception/bookings/:id/collect-payment`: now resolve **either** a legacy
  `bookingId` **or** a new `encounterId`, routing to `CheckInService` /
  `OpPaymentService`. Marking a register-only encounter **arrived issues its token
  and enqueues it** (fully processing the patient into the new queue — this is the
  link that makes app/voice patients workable on a flipped desk). Un-arrive is a
  `409` (the token engine is forward-only).
- **To enable:** `OpConfigService.set('CLINIC', clinicId, 'reads.cutover.roster', true)`.
  Reversible; the reception app needs **zero** changes.

### Doctor app (`doctor-dashboard`) — ⏳ blocked on sequence + needs app change
- Read `GET /doctor/queue` can only be complete once app/voice patients are being
  checked in through the new path (step 1 live for the clinic).
- Actions: `/queue/done` auto-promotes the next token; the new engine separates
  `call-next` → `start` → `complete`. This is a **semantic change** the app must
  adopt (call `/op/sessions/:id/call-next`, `/op/encounters/:id/{start,complete}`,
  `…/skip`, `…/no-show`) — it cannot be transparently compat'd.
- ETA: the new read model has no ETA; synthesize `position × avgConsultMinutes`
  if the app still needs `etaMinutes`.

### Patient app (`hospital-app` / user-app) — ✅ live-status compat ready (no app change)
- `GET /queue/my-status`: served from the new engine when `reads.cutover.patientStatus`
  is on for the clinic **and** the patient's encounter is in the new queue, in the
  identical `MyQueueStatus` shape (`src/queue-engine/patient-status-compat.service.ts`).
  **Falls back to legacy** when the encounter isn't enqueued yet — so during the
  transition a patient tracked only in the legacy queue keeps their legacy status
  until new-path check-in enqueues them. ETA is synthesised
  (`patientsAhead × avgConsultMinutes`). The user-app needs **zero** changes.
- **To enable:** `OpConfigService.set('CLINIC', clinicId, 'reads.cutover.patientStatus', true)`.
- Still to do (app change): `/me/bookings/*` (rich `PublicBooking` — payment/fee/
  clinic) is a heavier shape; migrate the list to the new reads or add per-endpoint
  compat once tokens are single-sourced.

### Voice agent (`hospital-voice-agent`) — ◑ availability cut over; queue-status blocked on a product call
- `/voice/availability` **waiting counts**: served from the new engine when
  `reads.cutover.voiceAvailability` is on for the clinic (aggregate count of the
  doctor's WAITING encounters — no per-caller token, so no divergence). The voice
  agent needs **zero** changes. To enable:
  `OpConfigService.set('CLINIC', clinicId, 'reads.cutover.voiceAvailability', true)`.
- `/voice/queue-status` (a caller's own position) is **blocked on a product
  decision**: legacy issues a **phone token immediately** at booking; the new
  architecture issues the token only at **desk check-in** (registration ≠ token).
  Those tokens differ, so serving new-engine status would show a different token
  than the one quoted on the phone. Resolving this means deciding whether voice
  callers still get a token over the phone — a product/architecture call, not a
  compat. Once decided (and if tokens are single-sourced), add the same
  fallback-safe status compat used for the patient app.
- The voice caller's new-engine token IS issued when they arrive and reception
  checks them in (the reception gap-closer), so they enter the new queue then.

## Recommended order

1. **Enable reception roster cutover** clinic-by-clinic (backend flag only).
   Verify the desk reads + actions against the new engine.
2. Once a clinic's desk checks patients in through the new path, **migrate the
   doctor app** to the `/op/*` console endpoints (encounterId + `EncounterStatus`
   + explicit call/start/complete).
3. **Migrate the patient app** live-status + bookings to the new read models
   (or add per-endpoint compat once tokens are single-sourced).
4. Move the app/voice **booking flows** to issue tokens via the new engine at
   check-in, then retire the register-only mirror.
5. **Final teardown** (irreversible): drop legacy `Booking` tables + delete legacy
   modules + the dual-write bridge, in a final migration — only after 1–4 are live.

## Reference

- Read compat: `src/reception/legacy-roster-compat.service.ts`,
  `src/reception/reception.service.ts` (action fall-through).
- New reads: `GET /op/{clinics/:id/roster, doctors/:id/dashboard,
  sessions/:id/{queue,display}, encounters/:id/tracking}`.
- New console: `POST /op/sessions/:id/{call-next,pause,resume}`,
  `POST /op/encounters/:id/{start,complete,skip,recall,no-show,transfer}`.
- New payments (decoupled): `POST /op/encounters/:id/payments/{online,desk}`.
- Realtime: socket `op:join` → `op:snapshot` / `op:queue:update` /
  `op:tracking:update` (see `src/queue-engine/queue.gateway.ts`).
- Verification specs: `test/op-backfill-cutover.spec.ts`,
  `test/op-read-cutover.spec.ts`, `test/op-e2e.spec.ts`.
