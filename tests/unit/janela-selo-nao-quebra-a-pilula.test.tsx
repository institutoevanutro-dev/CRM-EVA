import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { JanelaSelo } from "@/components/inbox/JanelaSelo";

/**
 * "Janela 23h 59m" quebrava em três linhas DENTRO de uma pílula de 16px quando o
 * cabeçalho apertava (print do dono, 16/10/2026; reproduzido em 390px). Duas
 * causas, as duas presas aqui: a pílula deixava o texto quebrar, e o selo
 * encolhia na linha do nome em vez de o NOME truncar. A medida em pixels (uma
 * linha, altura da pílula) está na spec e2e `inbox-aparencia-e-acoes-sob-demanda`.
 */
describe("selo da janela — uma linha, sempre", () => {
  it("não quebra e não encolhe", () => {
    vi.useFakeTimers({ now: new Date("2026-10-16T12:00:00Z") });
    render(<JanelaSelo provider="meta_cloud" lastInboundAt="2026-10-16T11:59:00Z" />);
    const selo = screen.getByText(/Janela/);
    const classes = selo.className.split(/\s+/);
    expect(classes).toContain("whitespace-nowrap");
    expect(classes).toContain("shrink-0");
    vi.useRealTimers();
  });
});
