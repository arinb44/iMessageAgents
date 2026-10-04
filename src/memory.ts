// Persistent memory: transcripts, people, facts, and scheduled follow-ups.
// Everything survives restarts, which is what lets the agent pick a
// conversation back up days later.

import { Database } from "bun:sqlite";
import { config } from "./config";

export const AGENT_ID = "agent";

export interface StoredMessage {
  seq: number;
  spaceId: string;
  platformId: string | null;
  senderId: string;
  text: string;
  ts: number;
}

export interface Fact {
  subject: string;
  spaceId: string;
  fact: string;
  ts: number;
}

export interface Reminder {
  id: number;
  spaceId: string;
  dueAt: number;
  note: string;
}

export interface SpaceRow {
  id: string;
  platform: string;
  kind: "dm" | "group";
  lastSeenSeq: number;
}

const db = new Database(config.dbPath, { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    space_id TEXT NOT NULL,
    platform_id TEXT,
    sender_id TEXT NOT NULL,
    text TEXT NOT NULL,
    ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_space ON messages (space_id, seq);
  CREATE INDEX IF NOT EXISTS messages_platform ON messages (platform_id);

  CREATE TABLE IF NOT EXISTS people (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT NOT NULL,
    space_id TEXT NOT NULL,
    fact TEXT NOT NULL,
    ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS facts_subject ON facts (subject);

  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    space_id TEXT NOT NULL,
    due_at INTEGER NOT NULL,
    note TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS spaces (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    kind TEXT NOT NULL,
    last_seen_seq INTEGER NOT NULL DEFAULT 0
  );
`);

const q = {
  insertMessage: db.query<{ seq: number }, [string, string | null, string, string, number]>(
    "INSERT INTO messages (space_id, platform_id, sender_id, text, ts) VALUES (?, ?, ?, ?, ?) RETURNING seq",
  ),
  recentMessages: db.query<StoredMessage, [string, number]>(`
    SELECT * FROM (
      SELECT seq, space_id AS spaceId, platform_id AS platformId, sender_id AS senderId, text, ts
      FROM messages WHERE space_id = ? ORDER BY seq DESC LIMIT ?
    ) ORDER BY seq ASC`),
  messageBySeq: db.query<StoredMessage, [number]>(
    "SELECT seq, space_id AS spaceId, platform_id AS platformId, sender_id AS senderId, text, ts FROM messages WHERE seq = ?",
  ),
  seqByPlatformId: db.query<{ seq: number }, [string]>(
    "SELECT seq FROM messages WHERE platform_id = ? ORDER BY seq DESC LIMIT 1",
  ),
  participants: db.query<{ senderId: string }, [string, string]>(
    "SELECT DISTINCT sender_id AS senderId FROM messages WHERE space_id = ? AND sender_id != ?",
  ),
  upsertPerson: db.query<never, [string, string]>(
    "INSERT INTO people (id, name) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name",
  ),
  personName: db.query<{ name: string }, [string]>("SELECT name FROM people WHERE id = ?"),
  insertFact: db.query<never, [string, string, string, number]>(
    "INSERT INTO facts (subject, space_id, fact, ts) VALUES (?, ?, ?, ?)",
  ),
  factsAbout: db.query<Fact, [string]>(
    "SELECT subject, space_id AS spaceId, fact, ts FROM facts WHERE subject = ? ORDER BY ts ASC",
  ),
  insertReminder: db.query<never, [string, number, string]>(
    "INSERT INTO reminders (space_id, due_at, note) VALUES (?, ?, ?)",
  ),
  dueReminders: db.query<Reminder, [number]>(
    "SELECT id, space_id AS spaceId, due_at AS dueAt, note FROM reminders WHERE done = 0 AND due_at <= ?",
  ),
  pendingReminders: db.query<Reminder, [string]>(
    "SELECT id, space_id AS spaceId, due_at AS dueAt, note FROM reminders WHERE done = 0 AND space_id = ? ORDER BY due_at",
  ),
  completeReminder: db.query<never, [number]>("UPDATE reminders SET done = 1 WHERE id = ?"),
  upsertSpace: db.query<never, [string, string, string]>(`
    INSERT INTO spaces (id, platform, kind) VALUES (?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET kind = CASE WHEN spaces.kind = 'group' THEN 'group' ELSE excluded.kind END`),
  getSpace: db.query<SpaceRow, [string]>(
    "SELECT id, platform, kind, last_seen_seq AS lastSeenSeq FROM spaces WHERE id = ?",
  ),
  markSeen: db.query<never, [number, string]>("UPDATE spaces SET last_seen_seq = ? WHERE id = ?"),
};

export const memory = {
  addMessage(spaceId: string, platformId: string | null, senderId: string, text: string, ts = Date.now()): number {
    return q.insertMessage.get(spaceId, platformId, senderId, text, ts)!.seq;
  },
  recent(spaceId: string, limit = config.transcriptLimit): StoredMessage[] {
    return q.recentMessages.all(spaceId, limit);
  },
  bySeq(seq: number): StoredMessage | null {
    return q.messageBySeq.get(seq);
  },
  seqForPlatformId(platformId: string): number | null {
    return q.seqByPlatformId.get(platformId)?.seq ?? null;
  },
  participants(spaceId: string): string[] {
    return q.participants.all(spaceId, AGENT_ID).map((r) => r.senderId);
  },

  setName(personId: string, name: string) {
    q.upsertPerson.run(personId, name);
  },
  nameOf(personId: string): string | null {
    return q.personName.get(personId)?.name ?? null;
  },

  addFact(subject: string, spaceId: string, fact: string) {
    q.insertFact.run(subject, spaceId, fact, Date.now());
  },
  factsAbout(subject: string): Fact[] {
    return q.factsAbout.all(subject);
  },

  addReminder(spaceId: string, dueAt: number, note: string) {
    q.insertReminder.run(spaceId, dueAt, note);
  },
  dueReminders(now = Date.now()): Reminder[] {
    return q.dueReminders.all(now);
  },
  pendingReminders(spaceId: string): Reminder[] {
    return q.pendingReminders.all(spaceId);
  },
  completeReminder(id: number) {
    q.completeReminder.run(id);
  },

  // A space that has ever been seen as a group stays a group.
  upsertSpace(id: string, platform: string, kind: "dm" | "group") {
    q.upsertSpace.run(id, platform, kind);
  },
  space(id: string): SpaceRow | null {
    return q.getSpace.get(id);
  },
  markSeen(spaceId: string, seq: number) {
    q.markSeen.run(seq, spaceId);
  },
};
