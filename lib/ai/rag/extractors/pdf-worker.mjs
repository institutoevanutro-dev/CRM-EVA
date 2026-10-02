// Runs in a disposable process: parsing cannot block the HTTP/worker event loop.
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_PAGES = 200;
const MAX_CHARS = 1_000_000;
const chunks = [];
let size = 0;
let task;
let result;
try {
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error("pdf_input_limit");
    chunks.push(chunk);
  }
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  task = getDocument({ data: new Uint8Array(Buffer.concat(chunks)), verbosity: 0, isEvalSupported: false });
  const document = await task.promise;
  if (document.numPages > MAX_PAGES) throw new Error("pdf_page_limit");
  const pages = [];
  let length = 0;
  for (let n = 1; n <= document.numPages; n++) {
    const page = await document.getPage(n);
    const content = await page.getTextContent();
    const parts = [];
    for (const item of content.items) {
      if (!("str" in item)) continue;
      const text = item.str + (item.hasEOL ? "\n" : "");
      length += text.length;
      if (length > MAX_CHARS) throw new Error("pdf_text_limit");
      parts.push(text);
    }
    const text = parts.join("").trim();
    if (text) pages.push(text);
    page.cleanup();
  }
  const text = pages.join("\n\n").trim();
  result = text ? { text } : { error: "image_only" };
} catch (error) {
  const message = error instanceof Error ? error.message : "";
  result = { error: /DOMMatrix|@napi-rs\/canvas/.test(message) ? "canvas_missing"
    : /^pdf_(input|page|text)_limit$/.test(message) ? message : "invalid_pdf" };
} finally {
  await task?.destroy();
}
process.stdout.write(JSON.stringify(result));
