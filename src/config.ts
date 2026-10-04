// All runtime knobs live here so the rest of the code never touches process.env.

const env = process.env;

export const config = {
  agentName: env.AGENT_NAME ?? "Juno",
  model: env.MODEL ?? "claude-opus-5",
  // Group chat is latency-sensitive and the decisions are mostly social, not
  // deep reasoning, so low effort is the right default. Raise it if replies
  // feel shallow.
  effort: (env.EFFORT ?? "low") as "low" | "medium" | "high" | "xhigh" | "max",
  dbPath: env.DB_PATH ?? "agent.db",
  // How long to wait after the last message in a burst before deciding.
  debounceMs: {
    dm: Number(env.DEBOUNCE_DM_MS ?? 1200),
    group: Number(env.DEBOUNCE_GROUP_MS ?? 3000),
  },
  // Simulated typing time before each bubble, so replies don't land
  // instantly. Set TYPING_DELAY=0 to disable.
  typingDelay: env.TYPING_DELAY !== "0",
  transcriptLimit: Number(env.TRANSCRIPT_LIMIT ?? 60),
  // Cloud iMessage turns on when both credentials are present; the terminal
  // provider is used when they're missing or when TERMINAL=1.
  hasPhotonCredentials: Boolean(
    env.SPECTRUM_PROJECT_ID && env.SPECTRUM_PROJECT_SECRET,
  ),
  forceTerminal: env.TERMINAL === "1",
};
