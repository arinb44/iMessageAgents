// One "think" = Claude looks at the chat and decides what (if anything) to do.
// It acts only through tools; calling none means staying silent.

import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { Emoji, type Message, poll, type Space } from "spectrum-ts";
import { z } from "zod";
import { config } from "./config";
import { AGENT_ID, memory, type Reminder, type StoredMessage } from "./memory";
import { SYSTEM_PROMPT } from "./prompt";

const client = new Anthropic();

// Server-side refusal fallbacks are only accepted on some models.
const supportsFallbacks = /^claude-(opus-5$|fable-5)/.test(config.model);

export interface ThinkInput {
  space: Space;
  kind: "dm" | "group";
  images: Anthropic.Beta.BetaImageBlockParam[];
  followups: Reminder[];
  resolveMessage: (seq: number) => Promise<Message | undefined>;
}

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

function buildContext(input: ThinkInput, transcript: StoredMessage[], lastSeen: number): string {
  const spaceId = input.space.id;
  const people = memory.participants(spaceId);

  const peopleLines = people.map((id) => {
    const name = memory.nameOf(id);
    const lines = [`- ${name ? `${name} (id: ${id})` : `id: ${id} (name unknown)`}`];
    for (const f of memory.factsAbout(id)) {
      lines.push(
        f.spaceId === spaceId
          ? `  - ${f.fact}`
          : `  - [private, learned in another chat] ${f.fact}`,
      );
    }
    return lines.join("\n");
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
    `This is a ${input.kind === "group" ? "group chat" : "DM"}.`,
    `<people>\n${peopleLines.join("\n") || "(nobody yet)"}\n</people>`,
  ];
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

function buildTools(input: ThinkInput, actions: string[]) {
  const { space, resolveMessage } = input;
  const spaceId = space.id;

  // The tool runner executes parallel tool calls concurrently; chain them so
  // bubbles and reactions land in the order Claude issued them.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn);
    chain = next.catch(() => {});
    return next;
  };

  return [
    betaZodTool({
      name: "send_message",
      description:
        "Send a message to the chat. Each bubble is a separate iMessage bubble, sent in order with a natural typing pause. Use reply_to only to answer an older message in a thread.",
      inputSchema: z.object({
        bubbles: z.array(z.string().min(1)).min(1).max(4),
        reply_to: z.number().int().optional().describe("Message number (#) to thread the first bubble under"),
      }),
      run: ({ bubbles, reply_to }) =>
        serial(async () => {
          const target = reply_to ? await resolveMessage(reply_to) : undefined;
          for (const [i, text] of bubbles.map(cleanBubble).filter(Boolean).entries()) {
            if (config.typingDelay) {
              await space.startTyping();
              await sleep(typingMs(text));
            }
            const threaded = i === 0 && target;
            const sent = threaded
              ? ((await target.reply(text)) ?? (await space.send(text)))
              : await space.send(text);
            memory.addMessage(
              spaceId,
              sent?.id ?? null,
              AGENT_ID,
              threaded ? `(replying to #${reply_to}) ${text}` : text,
            );
          }
          if (config.typingDelay) await space.stopTyping();
          actions.push(`said "${bubbles.join(" / ")}"`);
          return "sent";
        }),
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
      description: "Post a native iMessage poll so the group can vote between a few options.",
      inputSchema: z.object({
        question: z.string().min(1),
        options: z.array(z.string().min(1)).min(2).max(6),
      }),
      run: ({ question, options }) =>
        serial(async () => {
          const unsupported = "Polls aren't supported here, so nothing was posted. Ask in a normal message instead.";
          try {
            // Unsupported platforms skip the poll and resolve undefined.
            const sent = await space.send(poll(question, options));
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
        'Save a durable fact. subject is a person id from <people>, or "chat" for something about the group as a whole.',
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
      description: "Record what a person is called, using their id from <people>.",
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
        "Schedule yourself to check back in on this chat later. note is for you: what to follow up about and why.",
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
  const spaceId = input.space.id;
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
    max_iterations: 6,
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
