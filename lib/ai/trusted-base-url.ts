/** Tenant settings cannot choose where provider credentials are sent. */
export function trustedAiBaseUrl(provider: string, value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const canonical: Record<string, string> = {
    openai: "https://api.openai.com/v1",
    openrouter: "https://openrouter.ai/api/v1",
  };
  const configured = provider === "openrouter" ? process.env.OPENROUTER_BASE_URL
    : provider === "openai" ? process.env.AI_GATEWAY_BASE_URL : undefined;
  const normalize = (raw: string): string => {
    const url = new URL(raw);
    if (url.username || url.password || url.search || url.hash || !["https:", "http:"].includes(url.protocol)) {
      throw new Error("ai_endpoint_not_authorized");
    }
    return url.href.replace(/\/+$/, "");
  };
  const candidate = normalize(value);
  const allowed = [canonical[provider], configured].filter((url): url is string => Boolean(url));
  if (!allowed.some((url) => normalize(url) === candidate)) throw new Error("ai_endpoint_not_authorized");
  return candidate;
}
