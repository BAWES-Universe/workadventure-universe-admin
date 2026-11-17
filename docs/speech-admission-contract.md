# Speech admission contract (version 2)

For game #2080 and thread G (game side) and Orbit thread F (this side). Source: billing consensus v2, section 6.3 point 2 and Brief F.
Orbit goes to a server first. The game starts sending `contract: 2` only after Orbit has it. An old game against this Orbit, and a new game against an old Orbit, both keep working as today (section 7).

## 1. The one id

One funded utterance has one id: **the reply's `turnId`**, the same one `POST /api/bots/:id/voice-allowance` already takes. It links three things:

1. **Admission** (before the reply is spoken): Orbit sets money aside.
2. **Partial use** (while it is spoken, optional): not needed. The receipt carries what was played.
3. **Final receipt** (after the reply is over): the `speech` event with the same `turnId`. When it arrives Orbit releases what was set aside. **Never on a timer.**

A reply that is never spoken is given back with `POST /api/bots/:id/voice-allowance/release { turnId }` (as today). A reply whose receipt never arrives stays counted as **unknown** until a receipt, a release, or a reconcile settles it.

Live hearing has its own id: the **windowId** (section 4), renewed in the background. Never one admission per audio frame.

## 2. Admit a spoken reply

`POST /api/bots/:id/voice-allowance` (service token).

Request (new fields are optional; Orbit ignores what it does not know):

| field | type | meaning |
|---|---|---|
| `userId`, `isGuest`, `turnId` | as today | |
| `contract` | `2` | The game promises to send the receipt carrying `turnId`. Without it the admission is version 1 (section 7). |
| `provider` | string | Adapter name of the speaking voice company (as `voice_providers.adapter`), when the game knows it. Else Orbit uses the default speaking provider. |
| `model` | string | Speaking model, when known. |

Response, allowed:

```json
{
  "allowed": true,
  "left": 22,
  "resetsAt": "2026-11-18T09:00:00.000Z",
  "admission": {
    "contract": 2,
    "turnId": "…",
    "rateVersion": 7,
    "provider": "elevenlabs",
    "admittedSeconds": 12,
    "maxSeconds": 60,
    "admittedMicros": 32000
  }
}
```

- `admittedSeconds`: the member estimate (the usual length of a reply). It counts against the person's own entitlement.
- `maxSeconds`: the enforceable longest reply (the voice limit `replySeconds`). The game must stop the reply at it.
- `admittedMicros`: Universe's exposure for this reply, in millionths of a dollar, at rate version `rateVersion`. It counts against the Speech budget until the receipt arrives.
- `left` and `resetsAt` keep their meaning. An Orbit that does not send `admission` is a version-1 Orbit.

Response, refused:

```json
{ "allowed": false, "resetsAt": "…", "stoppedBy": "budget", "retryAfterSeconds": 20 }
```

`stoppedBy` is always one of:

| value | meaning | visitor sees |
|---|---|---|
| `person` | The person's own entitlement (`speechMemberCeilingSeconds`, or the reply window) is used up. | their own line |
| `budget` | The platform Speech budget (`speechBudgetMicros`) is spent or counted unknown. | a general line, no number |
| `hold` | Would fit if what is only set aside right now were released. Waiting helps. `retryAfterSeconds` is given when it can be known. | "busy, try again" |
| `provider` | The voice company's funds or key are unavailable. | a general line |
| `capacity` | Full right now (notes at once, notes an hour). | "busy" |

`allowed` and `resetsAt` stay exactly as before, so an old game reads the refusal as it always did. No private balance, budget figure or other person's use is ever in a refusal.

## 3. The receipt: speaking

`POST /api/meter/events` (service token), the event #2080 already sends, plus these **top-level** fields (an Orbit from before ignores them):

| field | type | meaning |
|---|---|---|
| `turnId` | string | The reply's id from section 2. Required for a speaking event of a funded reply. |
| `contract` | `2` | |
| `admission` | object | Echo of what Orbit sent: `{ rateVersion, admittedSeconds, admittedMicros }`. Orbit trusts its own record; a mismatch is recorded, not refused. |
| `provider`, `model` | string | What actually spoke. |
| `characters` | whole number | Characters sent to the voice company, when it bills by characters. Else Orbit estimates them from the seconds and says so. |
| `detail.part` | `"speaking"` | as today |
| `quantity` | whole number | Seconds actually played, rounded up (partial use). `0` is a real zero: the reply was admitted and nothing was heard. |
| `providerStatus` | `"ok"` or `"funds_unavailable"` | Optional. When the voice company refused for money, say so; Orbit stops new funded speech on that company with reason `provider`. |

Rules:

- With a `turnId`, Orbit counts the utterance under **one canonical event id** made from the bot and the `turnId`. A retry, a duplicate, an event sent again after a restart (a different `eventId`) is a duplicate, never a second charge. Same `turnId` with other figures is a `conflict` and adds nothing.
- `costMicros` may stay `null`. Orbit prices it from the rate version admitted (never 0), basis `estimated` with the rate's basis in `detail`.
- The result for each event gains `admission`: `settled` (the hold was released by this event), `already_settled`, `no_admission` (no admission under that id; the event still counts), or `not_applicable`.
- An event for a reply from before the month turned is counted in the month it occurred and releases the old hold.

## 4. Live hearing: windows

`POST /api/bots/:id/voice-hearing-window` (service token). Asked when a funded call starts hearing a person, and **renewed in the background** before the window is used up. Not per audio frame, not blocking audio.

Request: `{ userId, isGuest, windowId, contract: 2, provider?, model? }`. `windowId` is stable for one window (for example `<session>:<n>`); asking again with the same one answers the same window.

Response allowed: `{ "allowed": true, "windowId", "rateVersion", "provider", "admittedSeconds", "renewAfterSeconds", "admittedMicros" }`. Orbit sets `admittedSeconds` aside, at the hearing rate, for this person. The game keeps hearing for up to that long and asks for the next window when `renewAfterSeconds` has passed. If the next window is refused, the game stops hearing for Universe's account at the end of the current one and says why from `stoppedBy`.

Response refused: same shape as section 2.

Hearing receipts: the `speech` event with `detail.part: "hearing"` carries `windowId` (top-level) and `quantity` = seconds heard. Each reduces what the window holds. `POST /api/bots/:id/voice-hearing-window/release { windowId }` gives back what was not used when the call or window ends (safe to send twice). A window never released and never fully used stays counted as unknown until reconciled.

## 5. Voice notes

Reserved and heard by Orbit itself (`lib/voice-note-turns.ts`), nothing new for the game except the refusal: a refused note carries `stoppedBy` (same five words) and `transcribed: false`. A note refused after it was heard says `transcribed: true`. The existing `reason`, `limit`, `resetsAt` stay.

## 6. What Orbit settles by itself (no call needed)

- **Missing receipt:** the hold stays counted, shown as unknown after a saved grace (`speech-admission` setting `receiptGraceSeconds`), until a receipt or release arrives. A timer alone never proves the provider charged nothing.
- **Interrupted call, duplicate, missing, retried events, month turning:** the reconcile pass (`reconcileSpeech`, run with the existing sweep) counts what each id still holds, ends holds from an earlier month as "unreconciled last month" (reported, not counted into the new month), and never double counts.
- Every price, rate version, window length and grace is a **saved setting** read on every check. A change affects the next admission with no restart.

## 7. Pairings

| Game | Orbit | Behaviour |
|---|---|---|
| old (no `contract`, no receipt id) | new | Version 1: the admission holds what it held before and releases on the saved legacy hold time (`legacyHoldSeconds`, from the old 10 minutes), because no receipt can name it. Hearing is not admitted (as today) and is counted when its event arrives. Refusals keep `allowed`/`resetsAt`. |
| new (`contract: 2`) | old | Old Orbit ignores the new fields and answers with no `admission` object and no hearing-window route (404). The game falls back to version 1 behaviour for the process. |
| new | new | This document. |

## 8. Rates (for the receipt and the page)

`lib/speech-rates.ts` holds one versioned rate per voice company and job: hearing by time, speaking by characters where the company bills so, an integrated audio model as one bundled charge counted once. Each rate says whether it is `published` or an `estimate`, with its basis. Changing any rate makes a new version; admissions record the version they used; receipts are priced at the version admitted.
