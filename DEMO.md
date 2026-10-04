# Juno — Demo Script

A 3-minute live demo for judges: one person asks Juno to set up dinner, Juno coordinates with a friend over iMessage, keeps a private detail private, and follows up on its own. Every beat below was rehearsed.

## Before judging

Run Juno on a fresh demo memory, prime it with one private fact, and restart it 5 minutes before you go on. Only one copy of Juno may run at a time, or every text gets two replies.

Each person texts Juno at their own Photon number, shown next to their name under **Users** in the [Photon dashboard](https://app.photon.codes).

**30 minutes before**

- [ ] Check both demo phones are still under Users in the Photon dashboard.
- [ ] Check Anthropic credits under Settings → Billing in the Console.
- [ ] Stop any running Juno (Ctrl + C in its tab), then start it from the project folder on a separate demo memory so dev chats don't leak in:

```bash
DB_PATH=demo.db bun dev
```

- [ ] Prime Juno from each phone and wait for each reply:
  - Arin: `hey juno, it's arin`
  - Arnav: `hey juno it's arnav`
  - Arnav: `lowkey broke this month, trying not to spend much this week`. This private fact is the payoff in the demo.
- [ ] Phones: Do Not Disturb off, message previews on, brightness up, charged, Juno's thread pinned.
- [ ] Laptop: the Juno tab visible and zoomed in (Cmd +), so judges can read lines like `→ texted Arnav`.
- [ ] Paste the demo texts below into Notes on each phone so you can copy them, not type them.

**5 minutes before**

- [ ] Restart Juno with the same command. That refreshes its Photon token and keeps the demo memory.
- [ ] From Arin's phone, send `you there?`. Confirm it shows in the tab and gets a reply.
- [ ] Open a second terminal tab with the backup command from "If something goes wrong" typed in but not run.

## The 3-minute script

Arin drives from their phone and narrates. Arnav holds the second phone up so judges see it buzz. In rehearsal the whole flow took about 2.5 minutes. Live replies take a few seconds longer because Juno pauses to "type" before each bubble.

Juno's exact words change every run. The "Juno should" lines are what it did in rehearsal, so expect the same moves in different words.

1. **0:00 — Hook (Arin, aloud)**
   - Say: "Every friend group has one person who does all the planning, chasing everyone across five different chats. We built Juno: that friend, living in iMessage. It runs on Photon Spectrum and Claude."
2. **0:20 — The ask (Arin's phone)**
   - Send: `can you get me and arnav together for dinner tomorrow night? we're both near central campus in ann arbor`
   - Juno should: text Arnav with a short intro ("this is juno, i help arin sort out plans"), then tell Arin it texted Arnav.
   - Say: "Watch Arnav's phone. Juno writes like a person, texts each friend once, and only tells me after the text actually went through."
3. **0:45 — Arnav answers (Arnav's phone)**
   - Send: `after 8 works, craving butter chicken`
   - Juno should: reply to Arnav, then bring the news back to Arin ("arnav's in, after 8, craving butter chicken, want me to lock a spot?").
4. **1:10 — Hand off the decision (Arin's phone)**
   - Send: `perfect, you pick the spot`
   - Juno should: name a cheap Indian place near campus (Madras Masala in rehearsal), confirm with Arnav, and quietly schedule a reminder for before dinner.
5. **1:35 — The reveal (Arin's phone)**
   - Send: `why there?`
   - Juno should: give its reasons, including "cheap so nobody's dropping $40", without saying anything about Arnav's money.
   - Say: "Before we started, Arnav told Juno privately that money's tight this month. Juno used that to pick the place, and kept it to itself. That's memory with social tact."
6. **2:00 — The proactive closer (Arin's phone)**
   - Send: `text us both a reminder about it 1 minute from now`. Use these exact words: "remind us in a minute" was read as "remind us before dinner" in rehearsal.
   - Juno should: confirm the reminder is set.
   - While you wait, point at the laptop's Juno tab: "Every line here is a decision. Juno only acts through tools, so staying quiet is a real choice. It remembers each person separately, and it keeps one shared plan per friend group."
7. **About 3:00 — Both phones buzz**
   - Juno texts both of you the reminder on its own. In rehearsal it arrived 63 seconds after the ask.
   - Say: "Nobody asked again. Juno just showed up. That's Juno."

## If something goes wrong

Keep talking while you fix it. Most problems show up in the Juno tab within seconds, and every one below happened at least once while building.

| What you see | What to do |
| --- | --- |
| A reply takes 15+ seconds | Keep narrating. The typing pause is deliberate, and the tab shows `→` when Juno has decided. |
| Your text never appears in the Juno tab | Photon didn't deliver it. Resend once. If it's still missing, switch to the backup below. |
| Tab shows `[text_person] couldn't reach Arnav` | Restart Juno (Ctrl + C, then the same command), then text `try again, i fixed it`. |
| Every text gets two replies | Two copies of Juno are running. Stop the extra one with Ctrl + C in its tab. |
| Juno asks a question instead of acting | Answer it naturally. Asking is in character, and judges like seeing it handle real conversation. |
| Juno names a place that's closed or wrong | "It's a suggestion, not a booking." Move on. |
| The reminder hasn't arrived at 3:00 | Go to Q&A. It checks for due reminders every 15 seconds, so it will land during questions. |

**Backup: the same story in the terminal.** If Photon is down, run Juno in the terminal chat from the project folder. Blanking the Photon keys keeps it off iMessage:

```bash
SPECTRUM_PROJECT_ID= SPECTRUM_PROJECT_SECRET= DB_PATH=backup.db bun dev
```

Plain lines are Arin. Start a line with `Arnav: ` to text as Arnav. Juno's texts to Arnav show up as `[to Arnav] …`. Send Arnav's two priming lines first, then run the same script.

## Judge Q&A

Keep each answer to two sentences, then offer to show it in the code or the logs.

**How does Juno decide when to talk?** Claude's own text is never sent. Juno only acts through tools (text, tapback, poll, text a friend, update the plan, remember, schedule a follow-up), so doing nothing is a real option. A burst of texts is batched into one decision.

**How does memory work without leaking secrets?** Every fact is saved with the chat it came from. In any other chat Claude sees it marked private: usable for decisions, never repeated. The crew plan is the only shared state, and it's written to be shareable. The "why there?" moment is this working live.

**Why DMs instead of a group chat?** People tell Juno things one-on-one that they'd never say in the group, like a tight budget, and that makes better plans. Also, Photon's free plan only delivers 1:1 messages. Juno has group-chat behavior built (stays quiet, tapbacks, polls), but it needs a dedicated Photon line to go live.

**How do you use Photon Spectrum?** Spectrum's cloud iMessage provider gives us one message stream for every chat. We use typing indicators, tapbacks, threaded replies, polls, and starting new chats to reach friends. The same code runs on Spectrum's terminal provider, which is how we tested group scenarios without phones.

**What model, and how fast is it?** Claude Opus 5 at low effort. It decides in about 4–8 seconds, then adds a typing pause sized to each message so replies don't land instantly.

**What happens when a text fails?** Juno tells you once, plainly, and logs the reason. Early on it announced "sent" before the send finished, so now it can't report a text until delivery is confirmed.

**Does it scale?** Today it's one process with SQLite, and it makes one decision at a time so two replies can't overwrite the same plan. Next steps are a lock per friend group instead of a global one, Postgres, and a dedicated line for group chats.

**Is it honest about being an AI?** Yes. It introduces itself to anyone it texts first, and it says it's an AI if someone sincerely asks.
