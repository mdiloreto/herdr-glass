// Resumes a Claude session in a terminal that came back as a bare shell, as
// the herdr TUI's resume_agents_on_restore did. herdr-core keeps a terminal
// across a reboot or core restart but restarts it as a new shell in its last
// folder; the Claude statusline left the session in the claude.session and
// claude.dir labels, and the SessionEnd hook removes them when a session ends
// on purpose. This remembers each terminal's shell pid while Claude runs in
// it: the same labels on a shell with a new pid mean the terminal was lost.
// Memory outlives terminals the core doesn't list for a moment, a session
// already running elsewhere is never resumed, and each loss is tried once.
// Only this machine's terminals. Runs as a zero-size block in the layout.
import { View, div } from "gpui-kit";
import { terminals, shared, setShared, hc, notify } from "herdr";

const SEEN = "agent-resume.seen";
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const quote = (s) => `'${s.replaceAll("'", `'\\''`)}'`;

export default class AgentResume extends View {
  render(cx) {
    const all = terminals().filter((t) => !t.address.includes("/"));
    if (!all.length) return div().id("agent-resume").size(0);
    const seen = shared(SEEN) ?? {};
    const running = new Set(
      all.filter((t) => t.state === "live" && t.program?.agent).map((t) => t.labels?.["claude.session"]),
    );
    const next = Object.fromEntries(
      Object.entries(seen).filter(([address]) => !all.some((t) => t.address === address)),
    );
    for (const t of all) {
      const session = t.labels?.["claude.session"];
      const before = seen[t.address];
      if (t.state !== "live" || !session) continue;
      if (!t.pid || !t.foreground || !t.program?.shell) {
        if (t.program?.agent && t.pid) next[t.address] = { session, pid: t.pid };
        else if (before) next[t.address] = before;
        continue;
      }
      if (before) next[t.address] = before;
      if (!before || before.session !== session || before.pid === t.pid) continue;
      if (!SESSION_ID.test(session) || running.has(session)) continue;
      running.add(session);
      next[t.address] = { session, pid: t.pid };
      const dir = t.labels["claude.dir"];
      const line = `${dir ? `cd ${quote(dir)} && ` : ""}\${HERDR_CLAUDE_BIN:-claude} --resume ${session}`;
      cx.spawn(async () => {
        const result = await hc(["send", t.address, line]);
        notify(
          result.code === 0
            ? { title: "Resumed Claude", body: t.labels["claude.title"] || session, level: "info" }
            : { title: `Couldn't resume Claude in ${t.address}`, body: result.stderr, level: "error" },
        );
      });
    }
    if (JSON.stringify(seen) !== JSON.stringify(next)) setShared(SEEN, next);
    return div().id("agent-resume").size(0);
  }
}
