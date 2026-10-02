// @vitest-environment node
import type { ExecFileOptionsWithStringEncoding, ExecFileException } from "node:child_process";
import { pdfBudgetFixture } from "../fixtures/pdf-budget-fixture";
import * as childProcess from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { extractPdfText } from "@/lib/ai/rag/extractors/pdf";

vi.mock("node:child_process", { spy: true });
beforeEach(async () => {
  vi.mocked(childProcess.execFile).mockImplementation((await vi.importActual<typeof childProcess>("node:child_process")).execFile);
});
afterEach(() => vi.restoreAllMocks());

it("kills an unresponsive parser; its deadline and heap budget are enforced outside pdfjs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pdf-budget-"));
  const script = join(directory, "blocked.cjs");
  writeFileSync(script, "process.stdin.resume(); while (true) {};");
  const original = (await vi.importActual<typeof childProcess>("node:child_process")).execFile;
  const spy = vi.spyOn(childProcess, "execFile").mockImplementation(((file: string, args: readonly string[], options: ExecFileOptionsWithStringEncoding, callback: (error: ExecFileException | null, stdout: string, stderr: string) => void) => {
    expect(args?.[0]).toBe("--max-old-space-size=128");
    expect(options).toMatchObject({ timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024 });
    return original(file, ["--max-old-space-size=128", script], { ...options, timeout: 100 }, callback);
  }) as typeof childProcess.execFile);
  try {
    await expect(extractPdfText(Buffer.from("%PDF"))).rejects.toThrow(/limite de processamento/);
    expect(spy).toHaveBeenCalledOnce();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("limits extracted text, even when a small PDF reuses a large text page", async () => {
  await expect(extractPdfText(pdfBudgetFixture(6, "A".repeat(210_000)))).rejects.toThrow(/milhão de caracteres/);
});
