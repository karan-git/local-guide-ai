# Local Guide — a dataset-grounded recommendation assistant

A minimal chat endpoint that recommends from **one fixed dataset of ~18 local
listings and nothing else**. It never invents listings, never answers from the
open web or pretrained knowledge, and refuses or redirects anything out of scope.

The chat part is easy; the point of this build is the **grounding**. Two
independent layers keep it on its data:

1. **The model cannot see the raw dataset.** It reaches the data only through two
   typed tools (`searchListings`, `getListingById`). Nothing from the dataset is
   pasted into the prompt.
2. **A deterministic server-side validator** re-checks the final turn. The
   structured listing references shown to the user (the cards) are built **only**
   from the tool-approved set for that turn, so an invented listing or an
   off-dataset URL can never reach the UI even if the model is jailbroken. Any
   stray id/URL that leaks into prose is stripped and **logged**.

A persistent **"AI can be wrong, verify details"** disclaimer is always visible.

---

## Stack

- **Next.js 16** (App Router) + **React 19** + **TypeScript (strict)**
- **Vercel AI SDK v6** (`streamText`) — provider-swappable
- **OpenAI** provider (`@ai-sdk/openai`, default model `gpt-4o-mini`)
- **Zod** for typed tool inputs and dataset validation
- **Vitest** for the eval/test suite

> ⚠️ **Node 20+ is required** (Next 16 / AI SDK v6). If your system `node` is
> older, use `nvm use 20` before running any script below.

---

## Run it

```bash
nvm use 20                      # ensure Node >= 20
npm install
cp .env.example .env.local      # then put your own OpenAI key in .env.local
npm run dev                     # http://localhost:3000
```

`.env.local` (never committed — only `.env.example` is in the repo):

```
OPENAI_API_KEY=sk-...
# CHAT_MODEL=gpt-4o-mini        # optional override
```

Scripts:

| command | what it does |
| --- | --- |
| `npm run dev` | start the dev server |
| `npm run build` | production build (clean) |
| `npm run lint` | ESLint (clean) |
| `npm test` | Vitest eval suite (live cases need `OPENAI_API_KEY`) |

---

## Streaming contract

`POST /api/chat` accepts `{ messages: UIMessage[] }` and returns an **AI SDK v6 UI
message stream** (SSE). The assistant message is an ordered list of `parts`:

| part | meaning |
| --- | --- |
| `{ type: 'text', text }` | the conversational answer — **streamed live**, token by token |
| `{ type: 'data-listings', data }` | the structured, **server-validated** listing references — emitted **once, after the text**, then the message finishes |

`data` (the `data-listings` payload):

```ts
{
  references: {
    id: string;
    name: string;
    category: 'dining' | 'lodging' | 'attraction' | 'venue';
    city: string;
    priceTier: 'free' | '$' | '$$' | '$$$' | '$$$$';
    tags: string[];
    blurb: string;
    externalUrl: string | null;   // null when the listing has no link (e.g. att-003)
  }[];
  disclaimer: string;             // the "AI can be wrong" notice
  violations: { type: string; value: string; detail: string }[];  // usually empty
}
```

`references` is the **only authoritative source of listing ids and links** — a
front end renders cards from it (see [`app/page.tsx`](app/page.tsx)). It is built
server-side purely from the approved tool results, so it is grounded by
construction. Links are surfaced **only** via `externalUrl` on a card; the model
is instructed never to write a raw URL in prose. The exact types live in
[`lib/contract.ts`](lib/contract.ts).

---

## How the guardrails work

- **Tools are the only data access** — [`lib/listings.ts`](lib/listings.ts) holds
  the validated dataset; [`app/api/chat/route.ts`](app/api/chat/route.ts) exposes
  `searchListings` / `getListingById`. Each call records what it returned into a
  per-turn **approved set**.
- **System prompt** ([`lib/guardrails.ts`](lib/guardrails.ts)) states the absolute
  rules (recommend only from tool results; never invent; never write raw URLs;
  refuse bookings/availability/off-topic and redirect to what it _can_ do).
- **Output validation** (`validateOutput`) runs on the finished turn:
  - builds `references` only from approved listings the reply actually names;
  - scans prose for any URL or listing-id token that is **not** approved, strips
    it from the user-facing channel, and logs the attempt
    ([`lib/logging.ts`](lib/logging.ts) → one JSON line per violation).

Net effect: the worst a jailbreak can do is produce some prose; it can never make
the app surface a listing or link that isn't in the dataset.

---

## Eval / tests

`npm test` — [`tests/`](tests/):

- **`guardrails.test.ts`** (always runs, no key) — deterministic tests of the
  enforcement logic: tools only return real ids; an **invented listing** can't
  reach the card channel; a real-but-unretrieved listing is withheld; leaked
  **ids/URLs** are stripped + logged; **link handling** (`att-003`'s null URL is
  preserved, never fabricated).
- **`route.test.ts`** (always runs, no key) — drives `/api/chat` with a **mock
  model** through a real tool-call → text flow and asserts the streaming
  contract: text streams, then `data-listings` is appended (after the text,
  before finish) with exactly the validated references.
- **`live.test.ts`** (runs only when `OPENAI_API_KEY` is set) — the five required
  behaviour cases end-to-end against the real model: **normal recommendation**,
  **out-of-scope** (flight booking), **prompt injection** ("ignore your rules…"),
  invented-listing resistance, and **no raw URL in prose**.

```bash
npm test                              # deterministic suite (13 tests)
OPENAI_API_KEY=sk-... npm test        # + live model behaviour cases
```

---

## Voice version (written answer, not built)

For a phone-based voice version I'd use a **streaming speech-to-speech pipeline**:
**Twilio** (or LiveKit/Telnyx) for the PSTN/SIP leg and media transport, a
**streaming STT** (Deepgram or `gpt-4o-transcribe`) feeding the **same Next.js
`/api/chat` brain** unchanged, and a low-latency **TTS** (ElevenLabs or OpenAI
`gpt-4o-mini-tts`) for the reply — all wired over a WebSocket media stream with
barge-in (interrupt) handling. The key reason is **architectural**: voice only
changes the transport, not the policy. The grounding that matters here — tools as
the only data access plus the server-side validator — stays exactly where it is,
so the assistant is just as un-pushable over the phone as in text. I'd keep STT,
the LLM/tool brain, and TTS as **separate swappable stages** (rather than one
opaque realtime model) so I can keep the deterministic validation step in the
loop, log every turn, and tune latency/cost per stage. Over voice I'd also have
it **speak listing names and offer to text/email the links** instead of reading
URLs aloud, which fits the "links only via the card channel" rule naturally.

---

## What I'd harden for production

Per-user **rate limiting + auth** on `/api/chat`; ship guardrail violations to a
real **observability sink** with alerting (not stderr); add a streaming-safe prose
sanitizer so a leaked URL is redacted **mid-stream**, not just logged; load the
dataset from a versioned store with caching instead of a bundled JSON; and add an
input-side moderation/length cap plus retries/timeouts around the model call.

## AI coding tools used

Built with **Claude Code** (Anthropic). The Next.js 16 / AI SDK v6 APIs were
verified against the in-repo docs (`node_modules/next/dist/docs`) and the
installed type definitions rather than from memory, since both are newer than the
model's training data.
