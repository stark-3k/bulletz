/**
 * Make sure the agent running inside this app has an identity of its own.
 *
 * The agent pane is a pty with the MCP bridge wired into it, and the bridge
 * authenticates with `BULLETZ_TOKEN`. Until now the only thing that ever put a
 * credential there was the onboarding checklist — one button, on a panel most
 * people dismiss. Skip it and the agent starts, connects, and answers 401 on
 * every workspace call, which looks exactly like a broken app rather than a
 * step not taken.
 *
 * The credential is NOT the signed-in person's. An agent posts under its own
 * actor so that "ada said" and "ada's agent said" are different claims, and
 * borrowing the human's token collapses that distinction permanently — the
 * event log would record the person as the author of everything their tools
 * did. So this mints the agent's own token, using the human's session only as
 * the authority to do so.
 *
 * One credential per workspace, minted once and kept by the main process; this
 * is a no-op on every launch after the first, and in a browser, where there is
 * no local agent to hand it to.
 */
import type { Api } from "./api.ts";
import { bridge } from "./Terminal.tsx";

export type CredentialOutcome =
  | { state: "present" }
  | { state: "minted"; handle: string }
  | { state: "unavailable"; reason: string };

export async function ensureAgentCredential(api: Api): Promise<CredentialOutcome> {
  const agent = bridge()?.agent;
  // A browser tab has no pty and nowhere to keep a secret. Nothing to do.
  if (!agent?.hasToken || !agent.setToken) return { state: "unavailable", reason: "no desktop app" };

  try {
    if (await agent.hasToken()) return { state: "present" };
  } catch {
    return { state: "unavailable", reason: "could not read the stored credential" };
  }

  try {
    const r = await api.createAgentToken();
    await agent.setToken(r.token);
    return { state: "minted", handle: r.agent_handle };
  } catch (e) {
    // A reader has no permission to mint one, and an account with no agent
    // identity has nothing to mint for. Both are fine — the agent pane still
    // runs, it just cannot read the workspace, and Settings → Agent says so.
    return { state: "unavailable", reason: (e as Error).message };
  }
}
