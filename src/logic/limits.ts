// Recognise Hermes's "the provider gave up" replies. Pure.
//
// Hermes 0.21.5 tells an ACP client NOTHING machine-readable when a provider
// hits a usage or rate limit: no JSON-RPC error, no `_meta`, no special
// stopReason. The turn ends `end_turn` with one agent_message_chunk of text,
// and its fallback providers never run in `hermes acp`. So the text is all
// there is. The templates below are Hermes's own (quoted from the source):
//   - agent/turn_failure_copy.py:172-179, 278-281, 363-389
//       "{label} rate-limited every one of {n} attempts — …"
//       "{label} reported it was overloaded on all {n} attempts — …"
//       "{label} didn't answer after {n} attempts — …"
//       "{label} sent back an empty or broken reply {n} times — …"
//       "…\n\nLimit resets at HH:MM (in 2h 05m)."
//   - agent/conversation_loop.py + turn_recovery.py:1065-1069
//       "Billing or credits exhausted: {summary}\n\n{guidance}"
//       "Provider reported usage/credit exhaustion (unverified — …): {summary}"
//       guidance: "{label} reported that billing, credits, or account entitlement
//       is exhausted …" / "anthropic reported that your Claude subscription
//       usage is exhausted …"
// Known blind spot (Hermes, server.py:974): if the model streamed any text
// earlier in the turn, the failure text is never sent at all.
// Keep every pattern here, next to its test, so a Hermes wording change is a
// one-file fix.

export type LimitKind = "limit" | "billing" | "overloaded" | "unavailable";

export interface LimitNotice {
  kind: LimitKind;
  /** Hermes's provider label, e.g. "Anthropic", "ChatGPT or Codex Subscription". */
  provider?: string;
  /** When the limit lifts, as Hermes words it: "14:10 (in 2h 05m)" or "in ~3h". */
  resets?: string;
}

const LEADS: readonly [RegExp, LimitKind][] = [
  [/^(.+?) rate-limited every one of \d+ attempts\b/, "limit"],
  [/^(.+?) reported it was overloaded on all \d+ attempts\b/, "overloaded"],
  [/^(.+?) sent back an empty or broken reply \d+ times\b/, "unavailable"],
  [/^(.+?) didn't answer after \d+ attempts\b/, "unavailable"],
];

const BILLING_LEAD =
  /^(?:Billing or credits exhausted:|Provider reported usage\/credit exhaustion \(unverified)/;
/** Who the billing guidance names ("anthropic reported that your Claude …"). */
const BILLING_WHO =
  /^(.+?) reported that (?:your Claude subscription usage|billing, credits, or account entitlement) is exhausted/m;

/** Hermes's provider slugs in the Claude guidance are lowercase ids. */
const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
};

export function detectLimit(reply: string): LimitNotice | undefined {
  const text = reply.trim();
  if (!text) return undefined;
  const resets = resetsFrom(text);

  for (const [re, kind] of LEADS) {
    const m = re.exec(text);
    if (!m) continue;
    return withOptional({ kind }, clean(m[1]), resets);
  }

  if (BILLING_LEAD.test(text)) {
    const who = clean(BILLING_WHO.exec(text)?.[1]);
    const provider = who ? (PROVIDER_NAMES[who.toLowerCase()] ?? who) : undefined;
    return withOptional({ kind: "billing" }, provider, resets);
  }
  return undefined;
}

function resetsFrom(text: string): string | undefined {
  const at = /Limit resets at ([^\n]+?)\.?\s*$/m.exec(text)?.[1]?.trim();
  if (at) return at;
  const within = /usage limit resets in (~?[\w ]+?)\./.exec(text)?.[1]?.trim();
  return within ? `in ${within}` : undefined;
}

function clean(s: string | undefined): string | undefined {
  const t = s?.trim();
  return t && t.length <= 80 ? t : undefined;
}

function withOptional(base: { kind: LimitKind }, provider?: string, resets?: string): LimitNotice {
  return { ...base, ...(provider ? { provider } : {}), ...(resets ? { resets } : {}) };
}
