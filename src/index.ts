import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { type Attachment, type Content, type ContentInput, type Message, type Space, Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { terminal } from "spectrum-ts/providers/terminal";
import { type Chat, think } from "./brain";
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
    (useTerminal ? ' — tip: type "Maya: hey" to text Juno privately as Maya' : ""),
);

// ---------------------------------------------------------------------------
// Live object caches. Spectrum objects can't be persisted, so we keep recent
// ones in memory and fall back to looking them up by id.

const spaces = new Map<string, Chat>();
const liveMessages = new Map<number, Message>();
const LIVE_MESSAGE_CAP = 2000;

function cacheMessage(seq: number, message: Message) {
  liveMessages.set(seq, message);
  if (liveMessages.size > LIVE_MESSAGE_CAP) {
    liveMessages.delete(liveMessages.keys().next().value!);
  }
}

async function resolveSpace(id: string): Promise<Chat | undefined> {
  const cached = spaces.get(id);
  if (cached) return cached;
  if (id.startsWith(SIM_DM_PREFIX)) return terminalBase && simChat(id.slice(SIM_DM_PREFIX.length));
  const row = memory.space(id);
  try {
    if (row?.platform === "imessage" && config.hasPhotonCredentials) return await imessage(app).space.get(id);
    if (row?.platform === "terminal" && useTerminal) return await terminal(app).space.get(id);
  } catch (err) {
    console.error(`[spaces] couldn't resolve ${id}:`, err);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Reaching people 1:1, so the agent can coordinate a crew across their DMs.

// Spectrum identifies iMessage users by E.164 phone number (or email).
function normalizeHandle(raw: string): string | null {
  const s = raw.trim();
  if (s.includes("@")) return s.toLowerCase();
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (s.startsWith("+") && digits.length >= 8) return `+${digits}`;
  return null;
}

// In the terminal, "Maya: hi" is Maya texting the agent privately. Each
// simulated person gets a virtual DM; the agent's replies to them show up in
// the one real terminal chat, prefixed with who they're for.
const SIM_DM_PREFIX = "sim-dm:";
let terminalBase: Space | undefined;

function simChat(personId: string): Chat {
  const base = terminalBase;
  if (!base) throw new Error("the terminal chat isn't open");
  const name = memory.nameOf(personId) ?? personId.replace(/^sim:/, "");
  const send = ((content: ContentInput) =>
    base.send(typeof content === "string" ? `[to ${name}] ${content}` : content)) as Chat["send"];
  return {
    id: `${SIM_DM_PREFIX}${personId}`,
    send,
    startTyping: async () => {},
    stopTyping: async () => {},
    getMessage: (id) => base.getMessage(id),
  };
}

async function openDm(personId: string): Promise<Chat> {
  if (personId.startsWith("sim:")) return simChat(personId);

  const known = memory.dmSpaceOf(personId);
  const existing = known && (await resolveSpace(known));
  if (existing) return existing;

  if (!config.hasPhotonCredentials) throw new Error("iMessage isn't connected");
  const im = imessage(app);
  // Recorded as this person's DM only after a send succeeds (see text_person):
  // Photon can create the chat and still refuse to deliver into it.
  const space = await im.space.create(await im.user(personId));
  spaces.set(space.id, space);
  memory.upsertSpace(space.id, "imessage", "dm");
  return space;
}

function personIdFor(platform: string) {
  return ({ name, phone }: { name: string; phone?: string }): string => {
    if (platform === "terminal") return `sim:${name.toLowerCase().replace(/\s+/g, "-")}`;
    if (!phone) throw new Error("need their phone number to text them");
    const handle = normalizeHandle(phone);
    if (!handle) throw new Error(`"${phone}" doesn't look like a phone number`);
    return handle;
  };
}

async function resolveMessage(space: Chat, seq: number): Promise<Message | undefined> {
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
// Scheduling. Messages in a burst are debounced into one think per chat, and
// only one think runs at a time overall: thinks in different DMs can edit the
// same crew plan, and running them one by one keeps those edits from racing.

interface ChatState {
  timer?: ReturnType<typeof setTimeout>;
  running: boolean;
  dirty: boolean;
  images: Anthropic.Beta.BetaImageBlockParam[];
  followups: Reminder[];
}
const chatStates = new Map<string, ChatState>();

function stateOf(spaceId: string): ChatState {
  let state = chatStates.get(spaceId);
  if (!state) {
    state = { running: false, dirty: false, images: [], followups: [] };
    chatStates.set(spaceId, state);
  }
  return state;
}

let thinking: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const next = thinking.then(fn);
  thinking = next.catch(() => {});
  return next;
}

function schedule(spaceId: string) {
  const state = stateOf(spaceId);
  clearTimeout(state.timer);
  const kind = memory.space(spaceId)?.kind ?? "dm";
  state.timer = setTimeout(() => void run(spaceId), config.debounceMs[kind]);
}

async function run(spaceId: string) {
  const state = stateOf(spaceId);
  if (state.running) {
    state.dirty = true;
    return;
  }
  const chat = await resolveSpace(spaceId);
  if (!chat) return;

  state.running = true;
  try {
    await oneAtATime(() => {
      // Taken once the think actually starts, so anything that arrived while
      // waiting for the lock is included.
      const images = state.images.splice(0);
      const followups = state.followups.splice(0);
      const platform = memory.space(spaceId)?.platform ?? "imessage";
      return think({
        chat,
        kind: memory.space(spaceId)?.kind ?? "dm",
        images,
        followups,
        resolveMessage: (seq) => resolveMessage(chat, seq),
        openDm,
        personIdFor: personIdFor(platform),
        platform,
      });
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
    stateOf(reminder.spaceId).followups.push(reminder);
    void run(reminder.spaceId);
  }
}, 15_000);

// ---------------------------------------------------------------------------
// /memory: a quick way to show (or demo) what the agent has retained.

async function sendMemoryDump(chat: Chat) {
  const lines: string[] = [];
  const people = memory.participants(chat.id);
  for (const id of people) {
    const facts = memory.factsAbout(id).filter((f) => f.spaceId === chat.id);
    lines.push(`${memory.nameOf(id) ?? id}${facts.length ? "" : ": (nothing yet)"}`);
    for (const f of facts) lines.push(`  • ${f.fact}`);
  }
  for (const f of memory.factsAbout(`chat:${chat.id}`)) lines.push(`chat • ${f.fact}`);
  const crews = new Map(people.flatMap((id) => memory.crewsOf(id)).map((c) => [c.id, c]));
  for (const crew of crews.values()) {
    const members = memory.crewMembers(crew.id).map((id) => memory.nameOf(id) ?? id);
    lines.push(`👥 ${crew.name}: ${members.join(", ")}`);
    if (crew.plan) lines.push(`  plan: ${crew.plan}`);
  }
  for (const r of memory.pendingReminders(chat.id)) {
    lines.push(`⏰ ${new Date(r.dueAt).toLocaleString()}: ${r.note}`);
  }
  await chat.send(lines.join("\n") || "nothing remembered here yet");
}

// ---------------------------------------------------------------------------
// Main loop.

const SIMULATED_SPEAKER = /^([A-Za-z][\w'-]{0,19}):\s+([\s\S]+)$/;

async function ingest(space: Space, message: Message) {
  const described = await describe(message.content);
  if (!described) return;

  let chat: Chat = space;
  let senderId = message.sender?.id ?? "unknown";
  let text = described.text;

  // Terminal only: "Name: text" is that person texting the agent privately,
  // so one developer can act out a whole crew.
  if (message.platform === "terminal") {
    terminalBase = space;
    const match = SIMULATED_SPEAKER.exec(text);
    if (match) {
      const [, name, rest] = match;
      senderId = `sim:${name!.toLowerCase()}`;
      memory.setName(senderId, name!);
      text = rest!;
      chat = simChat(senderId);
    }
  }
  spaces.set(chat.id, chat);

  if (text.trim() === "/memory") {
    await sendMemoryDump(chat);
    return;
  }

  const isGroup = (space as { type?: string }).type === "group";
  memory.upsertSpace(chat.id, message.platform, isGroup ? "group" : "dm");
  if (!isGroup) memory.setDmSpace(senderId, chat.id);

  const seq = memory.addMessage(chat.id, message.id, senderId, text, message.timestamp.getTime());
  cacheMessage(seq, message);
  console.log(
    `[${isGroup ? "group" : "dm"} …${chat.id.slice(-6)}] #${seq} ${memory.nameOf(senderId) ?? senderId}: ${text.slice(0, 100)}`,
  );
  stateOf(chat.id).images.push(...described.images);

  if (described.triggers) schedule(chat.id);
}

for await (const [space, message] of app.messages) {
  if (message.direction === "outbound") continue;
  try {
    await ingest(space, message);
  } catch (err) {
    console.error("[ingest]", err);
  }
}
