import { expect, it } from "vitest";
import { BodyLimitError, readLimitedBody, readLimitedFormData, readWebhookBody } from "./limited-body";
function streamed(chunks: string[], headers: Record<string, string> = {}) {
  return new Request("https://test.invalid", { method: "POST", headers,
    body: new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } }), duplex: "half",
  } as RequestInit);
}
it.each<Record<string, string>>([{}, { "content-length": "1" }])("limita bytes reais sem confiar no cabeçalho %j", async (headers) => {
  await expect(readLimitedBody(streamed(["abc", "def"], headers), 5)).rejects.toMatchObject({ status: 413 });
});
it("preserva bytes exatos para HMAC", async () => {
  expect(new TextDecoder().decode(await readLimitedBody(streamed(["á", "b"]), 3))).toBe("áb");
});
it("cancela entrada lenta", async () => {
  let cancelled = false;
  const request = new Request("https://test.invalid", { method: "POST", body: new ReadableStream({ cancel() { cancelled = true; } }), duplex: "half" } as RequestInit);
  await expect(readLimitedBody(request, 10, 5)).rejects.toBeInstanceOf(BodyLimitError);
  expect(cancelled).toBe(true);
});
it("rejeita webhook grande com 413", async () => {
  const result = await readWebhookBody(streamed([], { "content-length": String(6 * 1024 * 1024) }), "test");
  expect(typeof result !== "string" && result.status).toBe(413);
});
it("multipart válido passa, envelope acima do limite é recusado", async () => {
  const form = new FormData(); form.set("name", "test");
  const make = () => new Request("https://test.invalid", { method: "POST", body: form });
  expect((await readLimitedFormData(make(), 1024)).get("name")).toBe("test");
  await expect(readLimitedFormData(make(), 5)).rejects.toMatchObject({ status: 413 });
});
