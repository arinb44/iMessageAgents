import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { type Attachment, type Content, type Message, type Space, Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { terminal } from "spectrum-ts/providers/terminal";
import { think } from "./brain";
import { config } from "./config";
import { memory, type Reminder } from "./memory";

const useTerminal = config.forceTerminal || !config.hasPhotonCredentials;

const app = await Spectrum({
  providers: [
    ...(config.hasPhotonCredentials ? [imessage.config()] : []),
    ...(useTerminal
      ? [terminal.config({ commands: [{ name: "/memory", description: "Show what the agent remembers here" }] })]
      : []),
  ],
});

const shutdown = async () => {
  await app.stop();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

console.log(
  `${config.agentName} is up on ${[config.hasPhotonCredentials && "iMessage", useTerminal && "terminal"].filter(Boolean).join(" + ")}` +
    (useTerminal ? ' — tip: type "Maya: hey all" to speak as someone else and test group behavior' : ""),
);

// ---------------------------------------------------------------------------
// Live object caches. Spectrum objects can't be persisted, so we keep recent
// ones in memory and fall back to looking them up by id.

const spaces = new Map<string, Space>();
const liveMessages = new Map<number, Message>();
const LIVE_MESSAGE_CAP = 2000;

function cacheMessage(seq: number, message: Message) {
  liveMessages.set(seq, message);
  if (liveMessages.size > LIVE_MESSAGE_CAP) {
    liveMessages.delete(liveMessages.keys().next().value!);
  }
}

async function resolveSpace(id: string): Promise<Space | undefined> {
  const cached = spaces.get(id);
  if (cached) return cached;
  const row = memory.space(id);
  try {
    if (row?.platform === "imessage" && config.hasPhotonCredentials) return await imessage(app).space.get(id);
    if (row?.platform === "terminal" && useTerminal) return await terminal(app).space.get(id);
  } catch (err) {
    console.error(`[spaces] couldn't resolve ${id}:`, err);
  }
  return undefined;
}

async function resolveMessage(space: Space, seq: number): Promise<Message | undefined> {
  const live = liveMessages.get(seq);
  if (live) return live;
  const row = memory.bySeq(seq);
  if (!row?.platformId || row.spaceId !== space.id) return undefined;
  return space.getMessage(row.platformId);
}

// ---------------------------------------------------------------------------
// Turning Spectrum content into transcript text (+ images for Claude).

const CLAUDE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MAX_IMAGE_BYTES = 3_500_000; // stays under the API's 5MB base64 limit

async function toImageBlock(att: Attachment): Promise<Anthropic.Beta.BetaImageBlockParam | null> {
  let data = await att.read();
  let mediaType = att.mimeType;

  // iPhone photos are often HEIC and large. macOS ships `sips`, which
  // converts and downsizes in one step.
  if (!CLAUDE_IMAGE_TYPES.has(mediaType) || data.length > MAX_IMAGE_BYTES) {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const src = join(tmpdir(), `in-${stamp}`);
    const out = join(tmpdir(), `out-${stamp}.jpg`);
    try {
      await Bun.write(src, data);
      const proc = Bun.spawn(["sips", "-s", "format", "jpeg", "-Z", "1568", src, "--out", out], {
        stdout: "ignore",
        stderr: "ignore",
      });
      if ((await proc.exited) !== 0) return null;
      data = Buffer.from(await Bun.file(out).arrayBuffer());
      mediaType = "image/jpeg";
    } catch {
      return null;
    }
  }
  if (data.length > MAX_IMAGE_BYTES) return null;

  return {
    type: "image",
    source: {
      type: "base64",
      media_type: mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
      data: data.toString("base64"),
    },
  };
}

interface Described {
  text: string;
  images: Anthropic.Beta.BetaImageBlockParam[];
  // Whether this message should prompt the agent to consider responding.
  triggers: boolean;
}

const seqLabel = (target: Message) => {
  const seq = memory.seqForPlatformId(target.id);
  return seq ? `#${seq}` : "an earlier message";
};

async function describe(content: Content): Promise<Described | null> {
  switch (content.type) {
    case "text":
      return { text: content.text, images: [], triggers: true };
    case "attachment": {
      if (content.mimeType.startsWith("image/")) {
        const block = await toImageBlock(content).catch(() => null);
        return { text: block ? "[sent a photo]" : "[sent a photo you can't see]", images: block ? [block] : [], triggers: true };
      }
      return { text: `[sent a file: ${content.name}]`, images: [], triggers: true };
    }
    case "voice":
      return { text: `[sent a voice memo${content.duration ? `, ${Math.round(content.duration)}s` : ""}]`, images: [], triggers: true };
    case "richlink":
      return { text: content.url, images: [], triggers: true };
    case "contact":
      return { text: `[shared a contact: ${content.name?.formatted ?? "unknown"}]`, images: [], triggers: true };
    case "reaction":
      return { text: `[reacted ${content.emoji} to ${seqLabel(content.target)}]`, images: [], triggers: false };
    case "poll":
      return { text: `[poll] ${content.title} — ${content.options.map((o) => o.title).join(" / ")}`, images: [], triggers: true };
    case "poll_option":
      return { text: `[${content.selected ? "voted for" : "removed vote for"} "${content.title}" in a poll]`, images: [], triggers: true };
    case "reply": {
      const inner = await describe(content.content);
      if (!inner) return null;
      return { ...inner, text: `(replying to ${seqLabel(content.target)}) ${inner.text}` };
    }
    case "group": {
      const parts = (await Promise.all(content.items.map((m) => describe(m.content)))).filter((p) => p !== null);
      if (!parts.length) return null;
      return {
        text: parts.map((p) => p.text).join(" "),
        images: parts.flatMap((p) => p.images),
        triggers: parts.some((p) => p.triggers),
      };
    }
    case "rename":
      return { text: `[renamed the chat to "${content.displayName}"]`, images: [], triggers: false };
    case "addMember":
      return { text: `[added ${content.members.join(", ")} to the chat]`, images: [], triggers: true };
    case "removeMember":
      return { text: `[removed ${content.members.join(", ")} from the chat]`, images: [], triggers: false };
    case "leaveSpace":
      return { text: "[left the chat]", images: [], triggers: false };
    default:
      // typing, read receipts, edits, unsends, custom payloads: not transcript-worthy.
      return null;
  }
}

// ---------------------------------------------------------------------------
// Per-chat scheduling. Messages in a burst are debounced into one think, and
// a chat never has two thinks running at once.

interface ChatState {
  timer?: ReturnType<typeof setTimeout>;
  running: boolean;
  dirty: boolean;
  images: Anthropic.Beta.BetaImageBlockParam[];
  followups: Reminder[];
}
const chats = new Map<string, ChatState>();

function chat(spaceId: string): ChatState {
  let state = chats.get(spaceId);
  if (!state) {
    state = { running: false, dirty: false, images: [], followups: [] };
    chats.set(spaceId, state);
  }
  return state;
}

function schedule(spaceId: string) {
  const state = chat(spaceId);
  clearTimeout(state.timer);
  const kind = memory.space(spaceId)?.kind ?? "dm";
  state.timer = setTimeout(() => void run(spaceId), config.debounceMs[kind]);
}

async function run(spaceId: string) {
  const state = chat(spaceId);
  if (state.running) {
    state.dirty = true;
    return;
  }
  const space = await resolveSpace(spaceId);
  if (!space) return;

  state.running = true;
  const images = state.images.splice(0);
  const followups = state.followups.splice(0);
  try {
    await think({
      space,
      kind: memory.space(spaceId)?.kind ?? "dm",
      images,
      followups,
      resolveMessage: (seq) => resolveMessage(space, seq),
    });
  } catch (err) {
    console.error(`[think] ${spaceId}:`, err);
  } finally {
    state.running = false;
    if (state.dirty) {
      state.dirty = false;
      schedule(spaceId);
    }
  }
}

// Follow-ups the agent scheduled for itself.
setInterval(() => {
  for (const reminder of memory.dueReminders()) {
    memory.completeReminder(reminder.id);
    chat(reminder.spaceId).followups.push(reminder);
    void run(reminder.spaceId);
  }
}, 15_000);

// ---------------------------------------------------------------------------
// /memory: a quick way to show (or demo) what the agent has retained.

async function sendMemoryDump(space: Space) {
  const lines: string[] = [];
  for (const id of memory.participants(space.id)) {
    const facts = memory.factsAbout(id).filter((f) => f.spaceId === space.id);
    lines.push(`${memory.nameOf(id) ?? id}${facts.length ? "" : ": (nothing yet)"}`);
    for (const f of facts) lines.push(`  • ${f.fact}`);
  }
  for (const f of memory.factsAbout(`chat:${space.id}`)) lines.push(`chat • ${f.fact}`);
  for (const r of memory.pendingReminders(space.id)) {
    lines.push(`⏰ ${new Date(r.dueAt).toLocaleString()}: ${r.note}`);
  }
  await space.send(lines.join("\n") || "nothing remembered here yet");
}

// ---------------------------------------------------------------------------
// Main loop.

const SIMULATED_SPEAKER = /^([A-Za-z][\w'-]{0,19}):\s+([\s\S]+)$/;

async function ingest(space: Space, message: Message) {
  spaces.set(space.id, space);

  const described = await describe(message.content);
  if (!described) return;

  let senderId = message.sender?.id ?? "unknown";
  let text = described.text;
  let simulated = false;

  // Terminal only: "Name: text" speaks as a different person, so one
  // developer can act out a whole group chat.
  if (message.platform === "terminal") {
    const match = SIMULATED_SPEAKER.exec(text);
    if (match) {
      const [, name, rest] = match;
      senderId = `sim:${name!.toLowerCase()}`;
      memory.setName(senderId, name!);
      text = rest!;
      simulated = true;
    }
  }

  if (text.trim() === "/memory") {
    await sendMemoryDump(space);
    return;
  }

  const isGroup = (space as { type?: string }).type === "group" || simulated;
  memory.upsertSpace(space.id, message.platform, isGroup ? "group" : "dm");

  const seq = memory.addMessage(space.id, message.id, senderId, text, message.timestamp.getTime());
  cacheMessage(seq, message);
  chat(space.id).images.push(...described.images);

  if (described.triggers) schedule(space.id);
}

for await (const [space, message] of app.messages) {
  if (message.direction === "outbound") continue;
  try {
    await ingest(space, message);
  } catch (err) {
    console.error("[ingest]", err);
  }
}
