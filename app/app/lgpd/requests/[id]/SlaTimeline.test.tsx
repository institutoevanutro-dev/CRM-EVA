/**
 * Linha do tempo do prazo: concluído para o relógio; aberto não marca etapa como
 * feita só porque a data passou.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { SlaTimeline } from "./SlaTimeline";

// Pedido de apagar dados recebido em 01/10/2026, prazo em 22/10 (15 dias úteis).
const BASE = {
  received_at: "2026-10-01T12:00:00.000Z",
  due_at: "2026-10-22T00:00:00.000Z",
  request_type: "redact",
  fuso: "America/Sao_Paulo",
};

beforeEach(() => vi.useFakeTimers({ now: new Date("2026-10-27T15:00:00Z"), toFake: ["Date"] }));
afterEach(() => vi.useRealTimers());

describe("SlaTimeline", () => {
  it("concluído mostra quando terminou e não diz 'vencido'", () => {
    render(<SlaTimeline {...BASE} status="completed" completed_at="2026-10-20T14:00:00.000Z" />);
    expect(screen.getByText(/Concluído em 20\/10\/2026/)).toBeInTheDocument();
    expect(screen.queryByText(/vencido/)).not.toBeInTheDocument();
    expect(screen.getByText("Anonimização concluída")).toHaveClass("text-success-fg");
  });

  it("aberto e atrasado: a etapa final é atraso, não 'concluída'", () => {
    render(<SlaTimeline {...BASE} status="processing" completed_at={null} />);
    expect(screen.getByText(/vencido há/)).toBeInTheDocument();
    expect(screen.getByText("Anonimização concluída")).toHaveClass("text-error-fg");
    expect(screen.getByText("Processamento")).not.toHaveClass("text-success-fg");
  });
});
