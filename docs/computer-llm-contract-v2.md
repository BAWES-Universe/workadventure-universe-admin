# Computer model calls: contract version 2

Orbit routes: `POST /api/computer/llm/authorize` and `POST /api/computer/llm/settle` (service token only, as today). Built by thread B (Orbit PR #998), sent by thread C (game relay). Where this file and the code differ, tell thread B: the code changes, not this file's names.

## 0. Versions and pairings

- **Version 1** is today's body. An authorize body with `estimateMicros` and no `contract` field is version 1. Orbit holds exactly that one amount for the member and for the pool, as today, never treats it as the larger version 2 authorisation, and answers only in the version 1 shapes (`reason` is one of `refused | allowance | pool | rule`; no `contract` field in the answer).
- **Version 2** is a body with `"contract": 2`. Orbit answers with `"contract": 2` and the shapes below.
- **Old game, new Orbit:** version 1 works unchanged.
- **New game, old Orbit:** the old route refuses unknown fields with `400 { error: "Invalid input data" }` and no `contract` in the answer. The game tries version 2 once and, on that refusal, sends version 1 for the rest of the process.
- **Both new:** the rules of R1 to R10 of the billing consensus.
- Orbit deploys first.
- Unknown fields in a version 2 body are refused with `400` (strict), so send only the names below.

## 1. Authorize, version 2

Request (JSON). All amounts are whole **micros** of a dollar (1 micro = 0.000001 USD), non-negative integers.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `contract` | `2` | yes | The version. |
| `token` | string, 1 to 200 | yes | The computer's model key for the job (as today). |
| `operationId` | string, 1 to 80, `[A-Za-z0-9._:-]` | yes | One step. **Stable across retries of the same step** (the same id every time the game asks again for that step, including after a wait). A new step gets a new id. It is also the call id in Orbit's books. |
| `payer` | `"universe"` or `"own-key"` | yes | Whose model pays. `own-key` takes no room and no credit (as today). |
| `route` | `"universe-ai"`, `"own-key"` or `"provider"` | yes | The route taken (same words as settle). |
| `model` | string, 1 to 120 | no | The model name used. With `route` and `stepKind` it groups comparable steps for the estimate (R1). Absent means one group of "unknown model". |
| `modelFormat` | `"openai"`, `"gemini-compatible"` or `"other"` | no | The wire format of the route (for the check before a paid wake and for D3). Absent means `"openai"`. |
| `stepKind` | `"reply"`, `"edit"`, `"tool"`, `"vision"` or `"other"` | no | The kind of step where the game knows it. Absent means `"other"`. |
| `inputTokens` | integer 0 to 100,000,000 | yes | Input tokens of this call. |
| `inputMicros` | integer 0 to 2,000,000,000, or `null` | yes | The input side of the cost at the route's price: what these input tokens can cost, in micros. `null` means the relay has no price for this model: a Universe-paid step with no price is refused `unpriced` and nothing is held or sent. |
| `outputMicrosPerMillion` | integer 0 to 2,000,000,000, or `null` | yes | The price of one million output tokens, in micros. `null` means no price is known (same as `inputMicros`). For `payer: "own-key"` send `null` or the numbers; they are not used. |
| `maxOutputTokens` | integer 1 to 10,000,000 | yes | The answer limit this call is **really** allowed (the limit sent to the model). Orbit never lowers it and never asks the game to change it. |
| `providerMaxMicros` | integer 0 to 2,000,000,000, or `null` | no | The game's own reading of the most the provider can bill for this call. Orbit recomputes it as `inputMicros + ceil(outputMicrosPerMillion * maxOutputTokens / 1,000,000)` and holds the **larger** of the two. A smaller figure is never trusted. |

Orbit computes two amounts from these (R1, D1), and both are returned:

- **`memberMicros`**: the amount set aside from the member (or other eligible payer). `inputMicros` plus the output side at the estimated answer length. The estimated answer length is twice the median answer of this job's last 20 comparable settled steps (same `route`, same `model`, same `stepKind` where given), 4,096 tokens until 5 steps have settled, and **never above `maxOutputTokens`**.
- **`providerMaxMicros`**: the most the provider can bill, held in the pool. Never less than `memberMicros`.

None of these numbers changes the model, the reasoning, the tools or the real answer limit.

### 1.1 Answer: allowed

`200`:

```json
{
  "ok": true,
  "contract": 2,
  "operationId": "step-123",
  "jobId": "…",
  "botId": "…",
  "personId": "…",
  "memberMicros": 12000,
  "providerMaxMicros": 90000,
  "authorisation": {
    "id": "auth_…",
    "payer": "owner",
    "fundingAccountId": "funding-platform",
    "tariffVersion": "…",
    "limits": { "taskMicros": null, "botMicros": null, "grantId": null, "periodEnds": "2026-12-01T00:00:00.000Z", "fixedPriceMicros": null }
  },
  "limits": { "maxOutputTokens": 32768, "maxCallsInFlight": 8, "maxWaitSeconds": 600 }
}
```

- `authorisation.payer` is `"owner"` (the owner's own job, riding on their disclosed standing rule), `"visitor"`, `"schedule"` or `"teammate"` (bounded by the limits recorded for that task). For `payer: "own-key"` the whole `authorisation` is `null` and `memberMicros` and `providerMaxMicros` are `0`.
- `authorisation.limits`: a limit that does not apply is `null`. All amounts are micros.
- **`limits`** are the computer Limits Orbit serves from its saved settings (the AppSetting `computer-limits`, shown on the Limits screen), read on every call and in effect at once: `maxOutputTokens` (the longest answer the relay may allow; 32,768 today) and `maxCallsInFlight` (calls at once for one job; 8 today), plus `maxWaitSeconds` (the longest total wait for `busy` and `holds`, below). The game uses these and no longer fixes them in code. If `limits` is absent (version 1 answer), the game keeps its own.
- Asked again with the same `operationId`: the same answer, nothing more held.

### 1.2 Answer: refused

`200` with `ok: false` (a refusal is an answer, not an error):

```json
{ "ok": false, "contract": 2, "operationId": "step-123", "reason": "busy", "retryAfterSeconds": 20, "paused": false, "words": null, "canAskForMore": false }
```

| `reason` | Meaning | `retryAfterSeconds` | What the game does |
|---|---|---|---|
| `refused` | The key is not good (wrong, expired, job over, taken over). | none | Stop the call. Never retry. |
| `allowance` | The paying person's own credit is used up. | none | Stop the turn; see pause below. `canAskForMore` says whether "Ask for more" is offered. |
| `budget` | Universe's monthly budget for new funded computer work is used up (version 1 calls this `pool`). | none | Stop the turn; see pause below. |
| `funds` | A provider's funds are unavailable (only when Orbit knows). **Orbit does not emit this today** (it has no way to read a provider's balance); it is in the contract so the game can already handle it. | none | Stop the turn; see pause below. |
| `busy` | Jobs at once is full: waiting helps. | seconds | Wait and ask again with the **same `operationId`**, within the total wait (below). |
| `holds` | Temporary holds (calls in flight, unknown costs not yet settled) fill what is free: waiting helps. | seconds | Same as `busy`. |
| `rule` | A spending rule the person said in chat stops it. `words` is the rule's own sentence. | none | Stop the turn and show `words`. Never say "bad key". |
| `unpriced` | A Universe-paid model with no price: nothing is sent. | none | Stop the turn. Named in readiness. |
| `unsupported` | This computer cannot run on that route or format. Also answered at job start (`POST /api/bots/:id/computer-jobs`), before a job is written, a room held or a machine woken, when the body's `modelFormat` (`openai`, `gemini-compatible` or `other`; absent means `openai`) names a route a computer cannot run on. | none | Stop. |
| `paused` | The job is already paused (see below). | optional | Stop the turn. |

- `words` is a short sentence in plain words for the person, or `null`. A visitor never gets a balance in it.
- `paused: true` means Orbit has saved the job and paused it (the machine sleeps). The game must not retry the operation and must not end the job.
- **One bounded total wait** (R2): for `busy` and `holds` the game keeps the same `operationId` and asks again after `retryAfterSeconds`, holding no lock while it waits, up to `limits.maxWaitSeconds` from its first ask for that operation. After that the answer is treated as `allowance` for display and the game stops the turn without ending the job.
- Bad bodies: `400 { "error": "Invalid input data" }`. Wrong service token: `401`. Server fault: `500`. None of these is a refusal; the game treats them as "not authorised, try later" and sends nothing to the provider.

### 1.3 Pause and resume (R2)

- A running job that is truly out (`allowance`, `budget`, `funds`) is **saved and paused**, not stopped: Orbit marks the job `status: "queued"`, `queuedFor` the reason, `paused: true`, and the machine rests as it does between jobs. The job keeps its id, its task, its outside-action ledger and its history.
- Orbit remembers what the refused step needed (the member's amount for `allowance`, the provider's most for `budget`). The sweep resumes the job once, when the next stretch **and** that step fit in the person's credit (or the pool), **and** all of these hold: the grant or budget applies to this task, the owner still permits it, the Brick still has control, the job was not cancelled, and no outside action was already done in the step. A job the person cancelled stays cancelled.
- When a job is paused its model keys end with the pause: a step asked with an old key is answered `paused` (never `refused`, so the game does not end the job). The game gets a new key with the new turn after the job resumes.
- When it resumes the job view shows `status: "running"`, `resumed: true`, `resumeCount` up by one. The game, which polls the job as today, then starts a new turn with a **new** `operationId` (never the one that was refused).

## 2. Settle, version 2

Request:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `contract` | `2` | yes | The version. |
| `jobId` | string, 1 to 64 | yes | The job (as today). |
| `operationId` | string | yes | The same id as the authorize. |
| `sent` | boolean, default `true` | no | `false`: nothing went to a provider; the hold is given back and nothing is written. |
| `costMicros` | integer or `null` | no | **The price charged to the person**, in micros. `null` means unknown. Absent means: same as `providerCostMicros`. |
| `providerCostMicros` | integer or `null` | no | **What the provider billed Universe**, in micros. `null` means unknown. Kept beside `costMicros`, never merged (R6). |
| `basis` | `"measured"`, `"estimated"` or `"unknown"` | no | How the figures were known. |
| `payerPersonId` | string or `null` | no | Set when another person's own key paid (as today). |
| `route` | `"universe-ai"`, `"own-key"` or `"provider"` | no | As authorize. |
| `tokens` | `{ input, output, cached, reasoning, cacheWrite, cacheWrite1h }` | no | Each an integer 0 to 2,000,000,000 or `null`. `cacheWrite` and `cacheWrite1h` are cache-write tokens (5 minute and 1 hour; priced apart). |
| `unexplained` | `{ tokens, costMicros }` | no | Tokens or cost the provider reported that its usage fields do not explain (Gemini compatible endpoints). Each an integer or `null`. Never charged to the person as measured use (D3). |
| `cutShort` | boolean | no | The call ended before it finished. |

Rules (R7):

- **A measured zero stays zero.** `costMicros: 0` charges nothing. **Unknown stays unknown:** `null` settles at the amount held in the pool as an estimate of Universe's own exposure and writes the entry as unknown; the person is charged no more than `memberMicros`.
- Capture beyond `memberMicros` happens only from funds that are eligible, still free and inside the recorded authorisation. The rest, if any, is Universe's and recorded as such.
- **A late receipt corrects once:** a second settle for the same `operationId` that carries known figures replaces a first entry that was unknown, once, tied to the original lots. Any other repeat returns what was first recorded.
- **Same answer on replay.**

Answer `200`:

```json
{ "ok": true, "contract": 2, "operationId": "step-123", "state": "settled", "chargedMicros": 4200, "providerCostMicros": 4000 }
```

- `state`: `"settled"`, `"corrected"` (a late receipt replaced an unknown entry) or `"replay"` (nothing changed).
- `chargedMicros` is the person's charge after this call; `providerCostMicros` is what is booked as the provider's bill (`null` if still unknown).
- Unknown call: `404 { ok: false, reason: "unknown_call" }` (as today). With `sent: false`: `200 { ok: true, contract: 2 }`.

## 3. Names thread C may rely on

`contract`, `token`, `operationId`, `payer`, `route`, `model`, `modelFormat`, `stepKind`, `inputTokens`, `inputMicros`, `outputMicrosPerMillion`, `maxOutputTokens`, `providerMaxMicros` (authorize); `contract`, `jobId`, `operationId`, `sent`, `costMicros`, `providerCostMicros`, `basis`, `payerPersonId`, `route`, `tokens.{input,output,cached,reasoning,cacheWrite,cacheWrite1h}`, `unexplained.{tokens,costMicros}`, `cutShort` (settle). Job start (`POST /api/bots/:id/computer-jobs`): the new optional body field `modelFormat`; an `unsupported` answer when a computer cannot run on it. Answers: `ok`, `contract`, `operationId`, `memberMicros`, `providerMaxMicros`, `authorisation`, `limits.{maxOutputTokens,maxCallsInFlight,maxWaitSeconds}`, `reason`, `retryAfterSeconds`, `paused`, `words`, `canAskForMore`, `state`, `chargedMicros`.

Differences from what thread C asked about, in one place: `budget` replaces `pool` in version 2 answers; `holds` is separate from `busy`; `unpriced` and `paused` are added; the job's settle carries `operationId` and `contract`.

## 4. Fencing the job's own calls (same PR)

The job view (`GET /api/bots/:id/computer-jobs/:jobId`) now carries `generation`, the job's control generation. It moves up when the person takes the machine or gives it back, and when the job pauses and again when it resumes. Every action on `POST /api/bots/:id/computer-jobs/:jobId` (`progress`, `renew`, `handover`, `finish`, `plan-effect`, `settle-effect`) takes an optional `generation`. When it is sent and is not the job's current one, nothing happens and Orbit answers `409 { ok: false, reason: "stale", generation: <current> }`; for `finish` the check is part of the write that ends the job. The runner then reads the job again and starts a new turn if it needs one. Absent means no check (an older runner works as before). The model-call routes are fenced already by the computer's key, which ends with a pause, a take over or the job's end.
