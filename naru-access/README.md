# Naru Play Access System

Access control for the paid play and dining zone at Naru Hartamas: paper wristbands, a self-scan
gate with separate IN and OUT lanes, 3-hour timers, the kids exit rule, overtime, birthday parties,
visit packages, a live dashboard and daily reports. Built to the *Naru Hartamas — Play Access System:
Developer Brief* (23 Sep 2026).

Payments never happen here. StoreHub takes every payment; this system records the StoreHub receipt
number so every band traces back to a sale.

- Runs entirely on the on-site PC. **No internet needed** for activation, gate decisions or timers.
- **No third-party runtime dependencies.** Bun (with its built-in SQLite) is the only requirement.
- Every rule in section 2 of the brief is a setting a manager can change. Nothing is hard-coded.
- Every scan, override and settings change is kept in append-only tables the app cannot edit or delete,
  plus a hash-chained audit log that shows if anyone tampers with the database directly.

## Try it now (simulator)

```bash
cd naru-access
bun run sim          # starts on http://localhost:8080 with demo staff and data
```

Open these in a browser:

| Page | URL | What it is |
|---|---|---|
| Staff app | `http://localhost:8080/` | Log in with a demo PIN (below) |
| Simulator | `http://localhost:8080/sim` | Two virtual gates, a controllable clock, a fire alarm switch, one-click families |
| Gate displays | `http://localhost:8080/gate?lane=in`, `?lane=out` | What guests see at each lane |

Demo PINs: Owner `1000`, Manager `1111`, Cashier `2222`, Runner `2223`, Reception `3333`,
Supervisor `4444`, Events `5555`.

The simulator always starts from a clean database at 11:00 am today. It seeds a family that is
about to run over time, a second family, a birthday party starting soon, and a package account.

**A five-minute walkthrough**

1. Log in as **Cashier (2222)** → *Activate bands* → enter a receipt and table → scan `A-000101`,
   `K-000101`, `K-000102` (type them and press Enter; a USB scanner does the same).
2. In the **Simulator**, scan the three bands *IN*. The group's timer starts at the first scan.
3. Scan `K-000101` *OUT* on its own: red, *"Adult must scan out first"*.
4. Click *+1 hour* three times and *+15 min* once, then *+1 min* (3:16). Scan `A-000101` *OUT*:
   red, *"Please see our host"*.
5. Log in as **Supervisor (4444)** → *Live dashboard*. The group shows under *Overtime* as
   **1 block × 2 kids = RM 60**, marked *AT GATE*. Tap it → *Overtime paid — clear* → enter the
   StoreHub receipt.
6. Back in the simulator, scan the adult then the kids *OUT*: green, *"See you again!"*.
7. Log in as **Manager (1111)** → *Reports* to see the day, and download the CSV files.

## Run it for real

```bash
bun run start                    # http://<pc-address>:8080, data in ./data/
```

On first start it creates an **Owner** account and prints its PIN once. Log in, add staff under
*Staff*, and change the owner PIN. Set `NARU_OWNER_PIN` to choose the first PIN yourself.

| Option | Default | |
|---|---|---|
| `--port` / `NARU_PORT` | `8080` | |
| `--data` / `NARU_DATA_DIR` | `./data` | Database, daily backups, lane key |
| `NARU_LANE_KEY` | generated into `data/lane-key.txt` | Shared secret the lane controllers send |
| `NARU_BACKUP_COMMAND` | none | Off-site copy, run after each daily backup, e.g. `rclone copy {file} gdrive:naru-backups` |

`bun run compile` builds a single executable (`dist/naru-access`) for the on-site PC, so the PC
doesn't need Bun installed. Copy the `public/` folder next to it.

**Backups.** The server writes a consistent snapshot to `data/backups/naru-YYYY-MM-DD.db` once a
day while the gates keep running, and keeps 60 days. `bun run backup` makes one immediately.
*Reports → Export all data* downloads every record as JSON at any time.

## How it connects to the gates

```
 band ─► lane reader ─► lane controller ──HTTP──► server (on-site PC, on UPS)
                          │      ▲                    │
                          │      └──── websocket ◄────┘  "open" / "hold open" / display text
                          ▼
                   relay ─► gate "OPEN" dry-contact input

 fire panel relay ─────────────► gate FIRE input (hard-wired, no software involved)
 staff release button ─────────► gate FIRE / free-pass input (hard-wired)
```

One **lane controller** runs beside each gate (a Raspberry Pi or any small PC):

```bash
bun run lane --lane in --server http://192.168.1.10:8080 --key <data/lane-key.txt> \
  --reader /dev/ttyACM0 \
  --relay-on  "gpioset -t0 GPIOCHIP0 17=1" --relay-off "gpioset -t0 GPIOCHIP0 17=0" \
  --fire-sense "gpioget GPIOCHIP0 27"
```

- `--reader`: a barcode reader in USB-serial mode (one barcode per line), or `stdin` for keyboard mode.
- `--relay-on/--relay-off`: shell commands that close and open the relay. This works with a Pi GPIO
  relay HAT, a USB relay or a network relay board. The exact `gpioset` syntax depends on the libgpiod version.
  Without them the controller only prints what it would do, which is useful for bench testing.
- `--fire-sense`: optional. Lets the dashboard show *FIRE MODE*. The gates are opened by the
  hard-wired fire input whether or not this is connected.
- **Fail-safe:** if the controller loses the server for 5 seconds (`--fail-open-seconds`), it holds
  its gate **open** and keeps retrying. This covers "if the PC fails, gates default open".
- The lane display is a browser in kiosk mode on `http://<server>/gate?lane=in`.

**What the gate supplier must provide** (checklist for the quote)

- A separate dry-contact (or relay) **open input for each lane**. The gate lets one person through per pulse.
- A **fire-alarm input** that forces both lanes open, and **fail-open on power loss**.
- One lane at least **900 mm** wide for strollers, fitting the ~2000 mm opening.
- Passage sensors that detect **small children**, and anti-pinch protection on the swing arms.
- The gate's own card logic can be switched off so this system makes the decisions.

## Birthday party e-invites

When the events coordinator creates a party, the app shows an **e-invite card**: a 1080 × 1500 image
with the venue name, party name, date, time, room, a **QR code** and the 6-character invite code.
Staff can **Download** it to send to the host (for example on WhatsApp), **Print** it, or **Share** it
directly on tablets and phones that support sharing. Open it again any time with *Invite* in
*Party setup*, or *E-invite & QR* on the check-in screen.

At arrival, reception scans the guest's QR with the counter scanner (or types the code) into *Party
check-in*, and the party opens. The QR holds only the invite code, at error-correction level Q, so it
still scans from a cracked phone screen or a creased printout.

QR codes are generated by `src/qr.ts`, a small built-in encoder, so there is still no third-party
runtime dependency. `test/qr.test.ts` decodes every QR size it can produce with an independent
decoder (jsQR, a test-only dependency).

## The rules as built

| Brief rule | Where | Default setting |
|---|---|---|
| Timer starts at the group's first gate scan | `src/core/system.ts` `applyPassage` | 180 min session |
| Grace after play time (walk-ins only) | `src/core/rules.ts` `groupTiming` | 15 min (parties: 0) |
| Overtime per kid per block, counted from the end of play time | `overtimeBlocks` | RM 30 / 30 min |
| Exit held past play time + grace until a supervisor clears the group | `groupTiming` → `exitLocked` | — |
| Kid band opens the exit only within 1 min after an adult of the same group | `evaluate` | 60 s |
| Re-entry allowed; timer keeps running | `evaluate` | — |
| Party bands work only during the party block | `evaluate` | early entry 0 min |
| Capacity: warn at 90%, block activations at 100% | `capacity` | 150 people |
| Fire alarm overrides everything | `evaluate` (first check) | — |
| Package: 12 visits, 1 per kid, transfer needs a manager | `deductInTx`, `transferPackage` | 12 visits, RM 20 fee |

**Choices made where the brief left room.** All of these can be changed. Please confirm them.

1. **Capacity counts** people inside **plus** bands activated but not yet through the gate, so a
   queue of activated guests cannot push the zone over 150. Guests out at the mall toilets don't count.
2. **Under-2s** follow the kids exit rule but are not charged overtime (setting: *Charge overtime for
   under-2s*). The cashier marks a kid-roll band as under-2 with one tap, or you can use a separate
   `U-` roll.
3. **After clearing**, the exit stays open for 10 minutes. If the group stays into another block,
   the exit holds again and only the new block is due.
4. **Party exit after the block** is held for the host, like walk-in overtime. The brief says "no
   grace" for parties but doesn't set a party overtime price. Set *Grace after party ends* if you prefer.
5. **Anti-passback:** a band that is already inside cannot be used to let someone else in (*Please
   see our host*). Exit is never refused for this reason.
6. **End of day** (23:30) closes every group. Anyone somehow still inside can always scan out.

## Tests

```bash
bun test ./test        # 52 tests, a few seconds
bun run typecheck
```

`test/acceptance.test.ts` is **section 9 of the brief, one test per sign-off item**, in the same
order, run against a simulated clock. Item 13, the rush, measures every gate decision. They take
about 1–3 ms against the 1-second requirement. `test/server.test.ts` starts the real server and
a real lane controller, and checks that the relay pulses, that a fire alarm holds the gate open,
and that the controller fails open when the server is killed.

## Not done yet

- **Real hardware.** The relay commands, reader mode and fire input must be confirmed on the chosen
  gate during the bench test.
- **Direct Google Sheets push.** Today, reports download as CSV and import into Sheets. A direct push
  needs a Google service account from Naru.
- **StoreHub phase 2.** This depends on what API access StoreHub gives Naru's account. Phase 1, where
  the cashier types the receipt, works now.
- **Membership tiers with NFC bands** are on hold per the brief. The lane reader just needs to send
  the NFC UID as the "barcode".
- Hardening for production: HTTPS on the venue network, a Windows/Linux service install script, and
  a short staff guide per role.

## Layout

```
src/core/      rules engine (pure rules, settings, permissions, the AccessSystem service)
src/db/        SQLite schema with append-only triggers
src/server/    HTTP API + websocket push
src/lane/      lane controller and relay drivers (runs beside each gate)
src/qr.ts      QR code encoder for e-invites
public/        staff app, gate display, simulator (plain HTML/JS, no build step)
test/          acceptance, rules, QR and server tests
```
