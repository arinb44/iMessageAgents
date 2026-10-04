# Juno — a group-chat member, not a chatbot

An AI that lives in your iMessage group chats the way a friend does. It reads everything, but mostly stays out of the way. It chimes in when it's actually useful, drops a tapback when that's enough, settles plans with native polls, remembers what people tell it, and checks back in later on its own.

Built on [Photon Spectrum](https://photon.codes/spectrum) (iMessage) + Claude.

## Run it

You need [Bun](https://bun.sh) and an Anthropic API key.

```bash
bun install
cp .env.example .env    # add ANTHROPIC_API_KEY
bun dev
```

With no Photon credentials it opens Spectrum's **terminal chat UI**, so you can develop without a phone line. To act out a group chat by yourself, prefix messages with a name:

```
Maya: anyone down for dinner friday?
Jay: im vegetarian btw
Maya: juno where should we go
```

Each name becomes a separate person with their own memory. `/memory` shows what Juno has retained in the current chat.

**To go live on iMessage**, put `SPECTRUM_PROJECT_ID` and `SPECTRUM_PROJECT_SECRET` (from Settings at [app.photon.codes](https://app.photon.codes)) in `.env` and restart. Text the Photon line, or add it to a group chat. Set `TERMINAL=1` to keep the terminal UI open alongside.

## How it works

```
iMessage ──Spectrum──▶ ingest ──▶ SQLite (transcript, people, facts, follow-ups)
                         │
                   debounce per chat (bursts → one decision)
                         │
                         ▼
               Claude + tools ──▶ send_message · react · create_poll
                                  remember · set_name · schedule_followup
```

- **Silence is the default.** Claude's plain text is never sent. It affects the chat only through tools, so "do nothing" is a first-class choice. In groups it's prompted to behave like a friend reading along, not an assistant answering every message.
- **Burst-aware.** People send three short texts in a row, so each chat waits for a lull (3s in groups, 1.2s in DMs) and then makes one decision about the whole burst.
- **Feels native.** Uses iMessage tapbacks, threaded replies, polls, typing indicators, and a typing pause before each bubble that scales with message length. Longer thoughts are split into several bubbles.
- **Memory with social tact.** Facts are stored per person and tagged with the chat they came from. In other chats they're shown to Claude as *private context*: usable for being thoughtful (picking a place with veggie options for Jay), never to be revealed. Memory survives restarts.
- **Proactive.** `schedule_followup` lets Juno decide on its own to ask "how'd the interview go?" two days later. When a follow-up comes due, Claude first rereads the chat to check it still makes sense.
- **Sees photos.** Image attachments go to Claude with vision. HEIC files from iPhones are converted with macOS `sips`.

## Code

| File | What |
|---|---|
| `src/index.ts` | Spectrum setup, content → transcript, debounce/queueing, follow-up timer |
| `src/brain.ts` | Context building and the Claude tool loop |
| `src/memory.ts` | SQLite store |
| `src/prompt.ts` | The agent's personality and judgment rules |
| `src/config.ts` | Env-driven knobs (model, effort, delays) |

Defaults: `claude-opus-5` at low effort, which works well for social judgment calls at chat latency. Override with `MODEL` / `EFFORT`.
