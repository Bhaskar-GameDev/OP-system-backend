# Patient Flow OS — Demo Guide

Running demo material for the backend and its clients. See `README.md` for
architecture and `BUILD.md` in each app for build instructions.

---

## Waiting-room display (TV board)

A full-screen, read-only queue board for a wall-mounted TV or tablet in the
waiting area. Patients glance at it instead of checking their phone or asking
reception.

### The URL

```
http://<backend-host>:3000/display/<clinicId>
```

One URL per clinic. For the seeded demo clinic (City Care Clinic):

```
http://localhost:3000/display/00000000-0000-0000-0000-000000000001
```

No login. A TV cannot log in, and the board is built so it does not need to —
see [Why it is unauthenticated](#why-it-is-unauthenticated).

### Setting it up on a TV — for reception staff

1. Open Chrome or Edge on the TV (or the tablet).
2. Go to the display URL for your clinic.
3. Press **F11** for fullscreen.

That is the whole procedure. The board connects itself, updates itself, and
reconnects itself if the network drops. Nothing needs to be clicked again.

Worth doing once, on the TV's browser:

- Set the display URL as the homepage, so a power-cycle comes back to the board.
- Turn off the screensaver and any sleep timer.

On an Android tablet, use Chrome in landscape and add the page to the home
screen — it then opens without browser chrome.

### Filling the board for a demo

`prisma db seed` creates the clinics, doctors and schedules, but deliberately
leaves the live queue empty: it re-runs on every container start, and injecting
fake patients into a queue a real demo is mid-way through would corrupt it.

To get a populated, demo-ready board:

```bash
npm run db:seed        # clinics, doctors, schedules
npm run demo:display   # live queue state
```

This produces three deliberately different cards, because a board where every
card looks the same demonstrates nothing:

| Doctor         | State                                     |
| -------------- | ----------------------------------------- |
| Dr. Anil Smith | busy — serving, 3 waiting, 3 already seen |
| Dr. Arjun Rao  | light — serving, 1 waiting                |
| Dr. Meera Nair | idle — no patients in queue               |

Re-running resets rather than stacks, so the board returns to the same state.
Pass a clinic id as an argument to target a different clinic.

To watch it update live, keep the board open and complete a patient from the
doctor app (or `npx ts-node scripts/inject-booking.ts <patientId>` to add one).
The card flashes and the token changes within a second or so.

### What the board shows

Per doctor: name, specialty, **NOW SERVING** token, the last five completed
tokens, the number waiting, and an estimated wait.

- **Token numbers only — never patient names.** The public screen must not
  identify anyone.
- Recently-seen tokens are there so a patient who stepped out can tell whether
  their number has already been called.
- The estimated wait is hidden when fewer than two people are waiting, where one
  no-show or a short consult would swamp it.
- An idle doctor keeps their card ("No patients in queue") rather than
  disappearing — they are still open for walk-ins, and a missing card reads as
  "gone home".
- If no doctor is consulting at all (holiday, after hours), the board shows a
  single "No sessions scheduled today" message instead of an empty grid.
- If the connection drops, a small "Reconnecting…" pill appears and the
  last-known board stays on screen. A stale token number is far more useful to
  the room than an error page.

### Layout

Dark theme: easier on the eye under bright clinic lighting, and it spares
cheaper panels the burn-in a mostly-white screen would cause over a whole day.

Nothing scrolls. Cards scale to fill the screen — one doctor gets a very large
token, six get smaller ones. Past six doctors the board **pages**, cycling every
10 seconds with dots along the bottom. Paging rather than capping the list: a
capped board would silently hide a doctor, which in a waiting room means a
patient never sees their number called.

---

## Why it is unauthenticated

The board exposes doctor names, specialties, token numbers and waiting counts.
Every one of those is already visible to anyone standing in the waiting room,
and patients see doctor names and specialties before booking. It exposes no
patient name, booking, contact detail or payment data — the display payload is
built as a separate projection that never reads those columns, so their absence
is structural rather than something a future change has to remember to strip.

The `clinicId` in the URL is therefore treated as **public, not secret**. It
grants no ability to read or change anything a passer-by could not already learn
by looking at the wall. A secret URL token was considered and rejected: it would
add key distribution and rotation work for staff without protecting anything.

Two things this does mean, worth being explicit about:

- Anyone with a clinic id can see that clinic's queue depth. This is business
  information (how busy a clinic is), not patient information.
- If a future version adds anything patient-identifying to the board, this
  decision must be revisited. The privacy note on `DisplayDoctorCard` in
  `src/display/display.service.ts` records that constraint next to the code.

Clinic scoping is enforced regardless: a display for one clinic never receives
another's data, including for two clinics inside the same hospital. Unknown
clinic ids return 404 rather than a blank board.

---

## Demo logins

Seeded by `npm run db:seed`.

| Tenant               | Role       | Username     | Password        |
| -------------------- | ---------- | ------------ | --------------- |
| City Health Network  | admin      | `admin`      | `admin123`      |
| City Health Network  | super admin| `superadmin` | `superadmin123` |
| City Health Network  | reception  | `reception`  | `reception123`  |
| Apollo Group         | admin      | `admin2`     | `admin123`      |
| Apollo Group         | reception  | `reception2` | `reception123`  |
| —                    | doctor     | `drsmith`    | `doctor123`     |

All other seeded doctors also use `doctor123`.

Patient login is OTP. With no SMS credentials configured the OTP is written to
the backend log; in the demo build it is `000000`.

---

## Running the stack

```bash
docker compose up -d postgres redis     # infrastructure
npm run prisma:migrate                  # schema
npm run db:seed                         # demo data
npm run start:dev                       # backend on :3000
```

Then open the display URL above.
