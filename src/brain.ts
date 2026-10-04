// One "think" = Claude looks at the chat and decides what (if anything) to do.
// It acts only through tools; calling none means staying silent.

import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { Emoji, type Message, poll, type Space } from "spectrum-ts";
import { z } from "zod";
import { config } from "./config";
import { AGENT_ID, type Crew, memory, type Reminder, type StoredMessage } from "./memory";
import { SYSTEM_PROMPT } from "./prompt";

const client = new Anthropic();

// Server-side refusal fallbacks are only accepted on some models.
const supportsFallbacks = /^claude-(opus-5$|fable-5)/.test(config.model);

// The slice of a Spectrum Space the brain needs. Real spaces satisfy it; the
// terminal's simulated DMs implement it directly.
export type Chat = Pick<Space, "id" | "send" | "startTyping" | "stopTyping" | "getMessage">;

export interface ThinkInput {
  chat: Chat;
  kind: "dm" | "group";
  images: Anthropic.Beta.BetaImageBlockParam[];
  followups: Reminder[];
  resolveMessage: (seq: number) => Promise<Message | undefined>;
  // Opens someone's 1:1 chat with the agent, starting one if needed.
  openDm: (personId: string) => Promise<Chat>;
  // The id a person will have on this platform. Throws if more info is needed
  // (e.g. a phone number on iMessage).
  personIdFor: (person: { name: string; phone?: string }) => string;
  platform: string;
}

const PLATFORM_NOTES: Record<string, string> = {
  imessage: "You're on iMessage. To add someone to a crew and text them, you need their phone number.",
  terminal:
    "You're in the terminal test harness, where people are simulated. Add crew members by name alone; no phone numbers are needed.",
};

const TAPBACKS = ["love", "like", "dislike", "laugh", "emphasize", "question"] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The model occasionally leaks HTML like "</br>" into a bubble. Line breaks
// become real newlines; other tags are dropped. Only real tags match, so
// things like "<3" survive.
const cleanBubble = (text: string) =>
  text
    .replace(/<\/?br\s*\/?>/gi, "\n")
    .replace(/<\/?[a-z][a-z0-9]*\s*\/?>/gi, "")
    .trim();
const typingMs = (text: string) => Math.min(500 + text.length * 35, 3500);

const fmtTime = (ts: number) =>
  new Date(ts).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

const label = (senderId: string) =>
  senderId === AGENT_ID ? "You" : (memory.nameOf(senderId) ?? senderId);

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Facts about a person, marked private when they were learned in another chat.
function factLines(personId: string, spaceId: string): string[] {
  return memory
    .factsAbout(personId)
    .map((f) => (f.spaceId === spaceId ? `  - ${f.fact}` : `  - [private, learned in another chat] ${f.fact}`));
}

// Crews that anyone in this chat belongs to.
function crewsHere(spaceId: string): Crew[] {
  const seen = new Map<number, Crew>();
  for (const id of memory.participants(spaceId)) {
    for (const crew of memory.crewsOf(id)) seen.set(crew.id, crew);
  }
  return [...seen.values()];
}

function buildContext(input: ThinkInput, transcript: StoredMessage[], lastSeen: number): string {
  const spaceId = input.chat.id;
  const here = memory.participants(spaceId);

  const peopleLines = here.map((id) => {
    const name = memory.nameOf(id);
    return [`- ${name ? `${name} (id: ${id})` : `id: ${id} (name unknown)`}`, ...factLines(id, spaceId)].join("\n");
  });

  const crewBlocks = crewsHere(spaceId).map((crew) => {
    const members = memory.crewMembers(crew.id).map((id) => {
      const name = memory.nameOf(id) ?? id;
      const status = here.includes(id)
        ? "in this chat"
        : memory.dmSpaceOf(id)
          ? "you have a 1:1 chat with them"
          : "you've never texted them";
      const facts = here.includes(id) ? [] : factLines(id, spaceId);
      return [`- ${name} (id: ${id}) — ${status}`, ...facts].join("\n");
    });
    return `<crew id="${crew.id}" name="${crew.name}">\n${members.join("\n")}\nplan: ${crew.plan || "(none yet)"}\n</crew>`;
  });

  const chatFacts = memory.factsAbout(`chat:${spaceId}`).map((f) => `- ${f.fact}`);
  const pending = memory
    .pendingReminders(spaceId)
    .map((r) => `- ${fmtTime(r.dueAt)}: ${r.note}`);

  const lines = transcript.map((m) => {
    const isNew = m.seq > lastSeen && m.senderId !== AGENT_ID;
    return `[#${m.seq} ${fmtTime(m.ts)}]${isNew ? " (new)" : ""} ${label(m.senderId)}: ${m.text}`;
  });

  const sections = [
    [`This is a ${input.kind === "group" ? "group chat" : "DM"}.`, PLATFORM_NOTES[input.platform]].filter(Boolean).join(" "),
    `<people>\n${peopleLines.join("\n") || "(nobody yet)"}\n</people>`,
  ];
  if (crewBlocks.length) sections.push(`<crews>\n${crewBlocks.join("\n")}\n</crews>`);
  if (chatFacts.length) sections.push(`<about_this_chat>\n${chatFacts.join("\n")}\n</about_this_chat>`);
  if (pending.length) sections.push(`<your_scheduled_followups>\n${pending.join("\n")}\n</your_scheduled_followups>`);
  sections.push(`<transcript>\n${lines.join("\n")}\n</transcript>`);

  for (const f of input.followups) {
    sections.push(
      `A follow-up you scheduled on ${fmtTime(f.dueAt)} is due now: "${f.note}". Send it only if it still makes sense given the conversation.`,
    );
  }
  if (input.images.length) sections.push("The new messages include the images attached above.");
  sections.push(`It's now ${fmtTime(Date.now())}. Decide what to do, if anything.`);
  return sections.join("\n\n");
}

// Sends bubbles into a chat with typing pauses and records them in its transcript.
async function deliver(chat: Chat, bubbles: string[], reply?: { target: Message; seq: number }): Promise<string[]> {
  const texts = bubbles.map(cleanBubble).filter(Boolean);
  for (const [i, text] of texts.entries()) {
    if (config.typingDelay) {
      await chat.startTyping();
      await sleep(typingMs(text));
    }
    const threaded = i === 0 && reply;
    const sent = threaded
      ? ((await reply.target.reply(text)) ?? (await chat.send(text)))
      : await chat.send(text);
    memory.addMessage(chat.id, sent?.id ?? null, AGENT_ID, threaded ? `(replying to #${reply.seq}) ${text}` : text);
  }
  if (config.typingDelay) await chat.stopTyping();
  return texts;
}

function buildTools(input: ThinkInput, actions: string[]) {
  const { chat, resolveMessage, openDm, personIdFor } = input;
  const spaceId = chat.id;

  // The tool runner executes parallel tool calls concurrently; chain them so
  // bubbles and reactions land in the order Claude issued them.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn);
    chain = next.catch(() => {});
    return next;
  };

  // Crews are only reachable from a chat that one of their members is in.
  const crewHere = (crewId: number) => crewsHere(spaceId).find((c) => c.id === crewId);

  // Claude can issue a text_person together with a message announcing it
  // worked, before seeing the result. If the text fails, bounce anything that
  // was issued before the failure so Claude rewrites it knowing the outcome.
  let lastFailure: { at: number; what: string } | undefined;
  const staleSince = (issuedAt: number) =>
    lastFailure && lastFailure.at >= issuedAt
      ? `Not done: ${lastFailure.what} failed in this same step, so this may claim something that didn't happen. Redo it knowing that.`
      : undefined;

  // Resolves people to ids (recording their names), collecting any that can't be.
  const resolvePeople = (people: { name: string; phone?: string }[]) => {
    const ids: string[] = [];
    const problems: string[] = [];
    for (const person of people) {
      try {
        const id = personIdFor(person);
        memory.setName(id, person.name);
        ids.push(id);
      } catch (err) {
        problems.push(`${person.name}: ${errorText(err)}`);
      }
    }
    return { ids, problems };
  };

  const personSchema = z.object({
    name: z.string().min(1),
    phone: z.string().optional().describe("Their phone number. Required on iMessage."),
  });

  return [
    betaZodTool({
      name: "send_message",
      description:
        "Send a message to this chat. Each bubble is a separate iMessage bubble, sent in order with a natural typing pause. Use reply_to only to answer an older message in a thread.",
      inputSchema: z.object({
        bubbles: z.array(z.string().min(1)).min(1).max(4),
        reply_to: z.number().int().optional().describe("Message number (#) to thread the first bubble under"),
      }),
      run: ({ bubbles, reply_to }) => {
        const issuedAt = Date.now();
        return serial(async () => {
          const stale = staleSince(issuedAt);
          if (stale) return stale;
          const target = reply_to ? await resolveMessage(reply_to) : undefined;
          const sent = await deliver(chat, bubbles, target && reply_to ? { target, seq: reply_to } : undefined);
          actions.push(`said "${sent.join(" / ")}"`);
          return "sent";
        });
      },
    }),

    betaZodTool({
      name: "text_person",
      description:
        "Text a crew member privately, in their own 1:1 chat with you (not this chat). Use it to invite people, ask availability, or pass along plan updates. person_id must be a member of a crew shown in <crews>.",
      inputSchema: z.object({
        person_id: z.string().min(1),
        bubbles: z.array(z.string().min(1)).min(1).max(3),
      }),
      run: ({ person_id, bubbles }) =>
        serial(async () => {
          const name = memory.nameOf(person_id) ?? person_id;
          if (memory.participants(spaceId).includes(person_id)) {
            return `${name} is in this chat. Use send_message instead.`;
          }
          const reachable = crewsHere(spaceId).some((c) => memory.crewMembers(c.id).includes(person_id));
          if (!reachable) return `${name} isn't in any crew with the people in this chat.`;
          let dm: Chat;
          let sent: string[];
          try {
            dm = await openDm(person_id);
            sent = await deliver(dm, bubbles);
          } catch (err) {
            const reason = errorText(err);
            console.error(`[text_person] couldn't reach ${name} (${person_id}): ${reason}`);
            lastFailure = { at: Date.now(), what: `texting ${name}` };
            memory.addMessage(spaceId, null, AGENT_ID, `[tried to text ${name} privately, but it failed: ${reason}]`);
            actions.push(`failed to text ${name}`);
            return `Couldn't reach ${name}: ${reason}. Nothing was delivered.`;
          }
          // Only now is the 1:1 chat known to work.
          memory.setDmSpace(person_id, dm.id);
          memory.addMessage(spaceId, null, AGENT_ID, `[texted ${name} privately: "${sent.join(" / ")}"]`);
          actions.push(`texted ${name} "${sent.join(" / ")}"`);
          return "sent";
        }),
    }),

    betaZodTool({
      name: "create_crew",
      description:
        "Start a crew: a set of people you'll coordinate through their 1:1 chats with you. Everyone in this chat is added automatically; list the others in members.",
      inputSchema: z.object({
        name: z.string().min(1).describe('Short and casual, e.g. "friday dinner"'),
        members: z.array(personSchema).max(9),
      }),
      run: async ({ name, members }) => {
        const here = memory.participants(spaceId);
        const creator = here[0];
        if (!creator) return "Nobody in this chat yet to start a crew with.";
        const { ids, problems } = resolvePeople(members);
        const crewId = memory.createCrew(name, creator, [...here.slice(1), ...ids]);
        actions.push(`created crew "${name}"`);
        const roster = memory.crewMembers(crewId).map((id) => `${memory.nameOf(id) ?? id} (${id})`);
        return [
          `Crew ${crewId} "${name}": ${roster.join(", ")}.`,
          ...(problems.length ? [`Not added — ${problems.join("; ")}`] : []),
        ].join("\n");
      },
    }),

    betaZodTool({
      name: "add_to_crew",
      description: "Add more people to an existing crew.",
      inputSchema: z.object({
        crew_id: z.number().int(),
        members: z.array(personSchema).min(1).max(9),
      }),
      run: async ({ crew_id, members }) => {
        const crew = crewHere(crew_id);
        if (!crew) return `Crew ${crew_id} isn't one of the crews in <crews>.`;
        const { ids, problems } = resolvePeople(members);
        for (const id of ids) memory.addToCrew(crew_id, id);
        actions.push(`added ${ids.length} to crew "${crew.name}"`);
        return [
          `Added: ${ids.map((id) => memory.nameOf(id) ?? id).join(", ") || "nobody"}.`,
          ...(problems.length ? [`Not added — ${problems.join("; ")}`] : []),
        ].join("\n");
      },
    }),

    betaZodTool({
      name: "update_plan",
      description:
        "Replace a crew's plan: the shared state of what's being organized (what, when, where, who's in or out, what you're waiting on). Every member's chat sees it, so leave out anything private.",
      inputSchema: z.object({
        crew_id: z.number().int(),
        plan: z.string().min(1),
      }),
      run: ({ crew_id, plan }) => {
        const issuedAt = Date.now();
        return serial(async () => {
          const stale = staleSince(issuedAt);
          if (stale) return stale;
          const crew = crewHere(crew_id);
          if (!crew) return `Crew ${crew_id} isn't one of the crews in <crews>.`;
          memory.setPlan(crew_id, plan);
          actions.push(`updated plan for "${crew.name}"`);
          return "updated";
        });
      },
    }),

    betaZodTool({
      name: "react",
      description: "Add an iMessage tapback to a message.",
      inputSchema: z.object({
        message: z.number().int().describe("Message number (#) to react to"),
        reaction: z.enum(TAPBACKS),
      }),
      run: ({ message, reaction }) =>
        serial(async () => {
          const target = await resolveMessage(message);
          if (!target) return `Couldn't find message #${message}.`;
          // Spectrum resolves undefined (rather than throwing) when the
          // platform can't do tapbacks.
          const sent = await target.react(Emoji[reaction]);
          if (!sent) return "Tapbacks aren't supported here; nothing was sent.";
          memory.addMessage(spaceId, null, AGENT_ID, `[reacted ${Emoji[reaction]} to #${message}]`);
          actions.push(`reacted ${Emoji[reaction]} to #${message}`);
          return "reacted";
        }),
    }),

    betaZodTool({
      name: "create_poll",
      description: "Post a native iMessage poll in this chat so people can vote between a few options.",
      inputSchema: z.object({
        question: z.string().min(1),
        options: z.array(z.string().min(1)).min(2).max(6),
      }),
      run: ({ question, options }) =>
        serial(async () => {
          const unsupported = "Polls aren't supported here, so nothing was posted. Ask in a normal message instead.";
          try {
            // Unsupported platforms skip the poll and resolve undefined.
            const sent = await chat.send(poll(question, options));
            if (!sent) {
              actions.push("tried a poll (unsupported)");
              return unsupported;
            }
            memory.addMessage(spaceId, sent.id, AGENT_ID, `[poll] ${question} — ${options.join(" / ")}`);
            actions.push(`posted poll "${question}"`);
            return "poll posted";
          } catch {
            return unsupported;
          }
        }),
    }),

    betaZodTool({
      name: "remember",
      description:
        'Save a durable fact. subject is a person id from <people> or <crews>, or "chat" for something about this chat as a whole.',
      inputSchema: z.object({
        subject: z.string().min(1),
        fact: z.string().min(1),
      }),
      run: async ({ subject, fact }) => {
        memory.addFact(subject === "chat" ? `chat:${spaceId}` : subject, spaceId, fact);
        actions.push(`remembered "${fact}"`);
        return "saved";
      },
    }),

    betaZodTool({
      name: "set_name",
      description: "Record what a person is called, using their id from <people> or <crews>.",
      inputSchema: z.object({
        person_id: z.string().min(1),
        name: z.string().min(1),
      }),
      run: async ({ person_id, name }) => {
        memory.setName(person_id, name);
        actions.push(`learned name "${name}"`);
        return "saved";
      },
    }),

    betaZodTool({
      name: "schedule_followup",
      description:
        "Schedule yourself to check back in on this chat later. note is for you: what to follow up about and why. When it fires you can also text crew members.",
      inputSchema: z.object({
        delay_minutes: z.number().int().min(1).max(60 * 24 * 30),
        note: z.string().min(1),
      }),
      run: async ({ delay_minutes, note }) => {
        const dueAt = Date.now() + delay_minutes * 60_000;
        memory.addReminder(spaceId, dueAt, note);
        actions.push(`scheduled follow-up for ${fmtTime(dueAt)}`);
        return `scheduled for ${fmtTime(dueAt)}`;
      },
    }),
  ];
}

export async function think(input: ThinkInput): Promise<void> {
  const spaceId = input.chat.id;
  const transcript = memory.recent(spaceId);
  const lastSeen = memory.space(spaceId)?.lastSeenSeq ?? 0;
  const newest = transcript.at(-1)?.seq ?? lastSeen;
  const hasNew = transcript.some((m) => m.seq > lastSeen && m.senderId !== AGENT_ID);
  if (!hasNew && input.followups.length === 0) return;

  memory.markSeen(spaceId, newest);

  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    ...input.images,
    { type: "text", text: buildContext(input, transcript, lastSeen) },
  ];

  const actions: string[] = [];
  const final = await client.beta.messages.toolRunner({
    model: config.model,
    max_tokens: 16000,
    // Coordinating a crew can take several rounds: create it, text each
    // person, update the plan, then reply here.
    max_iterations: 10,
    system: SYSTEM_PROMPT,
    output_config: { effort: config.effort },
    tools: buildTools(input, actions),
    messages: [{ role: "user", content }],
    ...(supportsFallbacks && {
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default" as const,
    }),
  });

  if (final.stop_reason === "refusal") {
    console.warn(`[brain] refusal in ${spaceId}:`, final.stop_details?.category ?? "unknown");
  }
  console.log(`  → ${actions.join(" · ") || "stayed quiet"}`);
}
