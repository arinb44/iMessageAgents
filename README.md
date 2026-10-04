# Juno — the friend who gets the group together

An AI that coordinates your friend group over iMessage. Everyone texts Juno one-on-one. When someone says "get me, maya and sam together for dinner friday", Juno texts each of them, tracks who's in, works out conflicts, reports back when a decision is needed, and confirms the final plan with everyone. It remembers what people tell it, keeps private things private, and checks back in on its own.

Built on [Photon Spectrum](https://photon.codes/spectrum) (iMessage) + Claude.

## What it looks like

```
Arin → Juno   can you get me, maya and sam together for dinner friday?
Juno → Maya   hey maya! this is juno, arin's friend/scheduling sidekick
              arin's putting together dinner friday with you and sam. you in?
Juno → Sam    hey sam, juno here. arin's doing dinner friday with you and maya. you around?
Maya → Juno   omg yes!! fyi i'm vegetarian
Sam  → Juno   can't do friday sorry, saturday works tho
Juno → Arin   sam can't do friday but saturday works for him. want me to check if maya can do saturday?
Arin → Juno   ok saturday then, 7pm. you pick the spot
Juno → Arin   thinking miss kim on main, everyone can find something there
```

Juno picked somewhere with good vegetarian options without ever telling Arin or Sam why.

## Run it

You need [Bun](https://bun.sh) and an Anthropic API key.

```bash
bun install
cp .env.example .env    # add ANTHROPIC_API_KEY
bun dev
```

With no Photon credentials it opens Spectrum's **terminal chat UI**, so you can develop without a phone line. Plain messages are you texting Juno. Prefix a message with a name to text Juno privately as someone else:

```
can you get me, maya and sam together for dinner friday?
Maya: omg yes!! fyi i'm vegetarian
Sam: can't do friday, saturday works
```

Juno's texts to other people show up as `[to Maya] …`. `/memory` shows what Juno has retained in the current chat, including crews and their plans.

**To go live on iMessage**, put `SPECTRUM_PROJECT_ID` and `SPECTRUM_PROJECT_SECRET` (from Settings at [app.photon.codes](https://app.photon.codes)) in `.env` and restart. Everyone who'll text Juno, or whom Juno will text, must be added under **Users** in the Photon dashboard (up to 10 on the free plan). Each user gets their own Photon number shown there, so that's the number they'll get Juno's texts from. If Juno can't reach someone you just added, restart it so it picks up the new user. Give Juno people's numbers when asking it to organize something. Set `TERMINAL=1` to keep the terminal UI open alongside.

> **Group chats:** Juno also behaves well inside group chats: it stays quiet unless it's useful, uses tapbacks, and posts polls. But Photon's free plan only delivers 1:1 messages. Group chats need a dedicated (Business) line.

## How it works

```
iMessage ──Spectrum──▶ ingest ──▶ SQLite (transcripts, people, facts, crews, follow-ups)
                         │
                   debounce per chat (bursts → one decision), one decision at a time
                         │
                         ▼
               Claude + tools ──▶ send_message · react · create_poll
                                  text_person · create_crew · add_to_crew · update_plan
                                  remember · set_name · schedule_followup
```

- **A connector across DMs.** A *crew* is a set of people plus a shared *plan* (what, when, where, who's in, what Juno's waiting on). Whichever person's chat Juno is in, it sees the crews they belong to and the current plan. It can text any crew member privately with `text_person`, and starts a new 1:1 chat if it has never texted them before.
- **Social tact.** Facts are stored per person and tagged with the chat they came from. In other chats they're shown to Claude as *private context*: usable for being thoughtful, never to be revealed. The plan is written to be shareable. Juno passes along availability and decisions, not confidences.
- **Doesn't spam.** One text per person per round. It reports back to the organizer when there's news (a conflict, everyone's answered), not after every reply.
- **Silence is the default.** Claude's plain text is never sent. It acts only through tools, so "do nothing" is a first-class choice.
- **Burst-aware.** Each chat waits for a lull (1.2s in DMs, 3s in groups) and makes one decision about the whole burst. Decisions run one at a time, so two people replying at once can't clobber the same plan.
- **Feels native.** iMessage tapbacks, threaded replies, polls, typing indicators, and a typing pause before each bubble that scales with message length.
- **Proactive.** `schedule_followup` lets Juno nudge someone who hasn't answered or remind the crew before dinner. When a follow-up comes due, Claude first rereads the chat to check it still makes sense.
- **Sees photos.** Image attachments go to Claude with vision. HEIC files from iPhones are converted with macOS `sips`.

## Demo

[DEMO.md](DEMO.md) is the 3-minute judging script: setup checklist, timed beats with the exact texts to send, fallbacks, and judge Q&A.

## Code

| File | What |
|---|---|
| `src/index.ts` | Spectrum setup, content → transcript, opening DMs, terminal simulation, scheduling, follow-up timer |
| `src/brain.ts` | Context building (people, crews, transcript) and the Claude tool loop |
| `src/memory.ts` | SQLite store |
| `src/prompt.ts` | The agent's personality and judgment rules |
| `src/config.ts` | Env-driven knobs (model, effort, delays) |

Defaults: `claude-opus-5` at low effort, which works well for social judgment calls at chat latency. Override with `MODEL` / `EFFORT`.
