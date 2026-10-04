# VYUHA demo script (about 12 minutes)

Scenario: **Op Silent Ridge**, Leh, Ladakh. Real OpenStreetMap tiles, real terrain elevation and
weather; the events are synthetic and doctrinally plausible.

## Before the demo

1. `docker compose up -d db`, then `pnpm db:seed` (or `docker compose up --build` for the full stack).
2. `pnpm dev` and open http://localhost:5173 (full-stack Docker: http://localhost:8080).
3. Four browser windows: one instructor and three trainees (separate profiles or private windows).
   Instructor `instructor@vyuha.local`, trainees `trainee1@vyuha.local` to `trainee3@vyuha.local`,
   password `Vyuha@123`.

## 1. Set the scene (2 min)

- Instructor home: open Op Silent Ridge, then **MSEL** to show the authored timeline and the JSON
  import and export. Mention the scripted events: VHF jamming from 01:00, conflicting reports at
  02:00, a hostile mechanised advance at 03:00 and a spoofed HQ order at 04:00.
- Create a session and read out the 6-character code.

## 2. Lobby (1 min)

- Trainees sign in and join with the code. The instructor creates team Alpha, assigns Platoon
  Commander, Section Commander and ISR Operator, and shows the PACE plan editor.
- Switch the language to Hindi on one window and back.

## 3. Information asymmetry (3 min)

- Instructor: **Start exercise**, speed 4x.
- Show the God View: truth map on the left, the chosen trainee's picture on the right, drift meter.
- Put the Section Commander and ISR Operator windows side by side: different maps, different contact
  ages, "last known" friendly markers. Hostile units appear only as reports with an Admiralty grade.
- ISR Operator: grade a contact (for example F6) in the Reports tab, then record a decision on it
  with a confidence and a rationale.

## 4. Degraded communications (3 min)

- Instructor: raise VHF jamming with the manual slider. Trainees see the signal drop and messages
  arrive late, garbled or not at all. A message sent across the ridge fails even without jamming
  (terrain line of sight).
- A trainee switches channel along the PACE plan: note the added delay and that the switch is logged.
- At 04:00 the spoofed HQ order reaches the Section Commander. Show **Authenticate** (15 s cost)
  against complying immediately. Comply without authenticating.

## 5. After Action Review (3 min)

- Instructor: **End exercise**, then **Open after action review**.
- Key learning points: "acted on an order that had not been authenticated", "did not switch away
  from heavily jammed VHF".
- Ghost Replay: drag the scrubber, choose a trainee and click a decision marker to compare what they
  saw with what was true.
- Charts: drift, latency, calibration (Brier), channel usage against jamming. Then the message flow graph.
- Download the **PDF**, **CSV** and **JSON**. The replay is deterministic: the same seed and inputs
  give an identical exercise.
