/**
 * EQUIPE › HORÁRIO: O DIÁLOGO FALA O IDIOMA ESCOLHIDO E CABE NO CELULAR.
 *
 * Porte de melgarafael/DeskcommCRM#5202 (contribuição de @ningsiyuan1024,
 * issue #5014 do upstream). Em espanhol, "Adicionar janela", "Salvar" e
 * "Cancelar" seguiam em português, e três rótulos acessíveis do mesmo diálogo
 * também ("Dia da semana", "Fim", "Remover janela").
 *
 * No celular, o que rolava o diálogo para o lado aqui não era a linha da
 * janela (abaixo de `sm` ela já empilha, dia em cima e horários embaixo): era
 * o botão "Copiar estes horários…", que não quebra o texto e levava `ml-2`
 * mesmo quando descia sozinho para a linha de baixo. Medido no Chromium com o
 * CSS compilado do repositório: 376/373 de `scrollWidth/clientWidth` a 375 px
 * e 376/358 a 360 px antes; 373/373 e 358/358 depois, sem mudança a 1280 px.
 * O jsdom não calcula layout, então o caso de baixo prende as classes.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import { ScheduleDialog } from "@/app/app/team/_components/AttendantsClient";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

vi.mock("@/lib/api/client", () => ({ apiClient: { get: vi.fn(async () => ({ data: [] })) } }));

const ID = "11111111-1111-4111-8111-111111111111";

function abrir(locale: "pt-BR" | "es") {
  return render(
    <IdiomaProvider locale={locale}>
      <ScheduleDialog
        attendant={{
          userId: ID,
          name: "Ana",
          email: null,
          availability: {
            user_id: ID,
            role: "agent",
            name: "Ana",
            email: "ana@exemplo.com.br",
            is_available: true,
            capacity: 5,
            schedule: {
              timezone: "America/Sao_Paulo",
              windows: [{ dow: 1, start: "08:00", end: "18:00" }],
            },
            updated_at: "2026-10-01T12:00:00.000Z",
            current_load: 0,
          },
        }}
        open
        onOpenChange={vi.fn()}
        onSave={vi.fn(async () => [])}
        isPending={false}
      />
    </IdiomaProvider>,
  );
}

afterEach(cleanup);

describe("Equipe › Horário: as ações seguem o idioma", () => {
  it("em espanhol, botões e rótulos aparecem em espanhol", () => {
    abrir("es");
    for (const nome of ["Agregar ventana", "Guardar", "Cancelar", "Eliminar ventana"]) {
      expect(screen.getByRole("button", { name: nome })).toBeInTheDocument();
    }
    expect(screen.getByRole("combobox", { name: "Día de la semana" })).toBeInTheDocument();
    expect(screen.getByLabelText("Fin")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Adicionar janela" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Salvar" })).toBeNull();
  });

  it("em português, o texto continua o mesmo", () => {
    abrir("pt-BR");
    for (const nome of ["Adicionar janela", "Salvar", "Cancelar", "Remover janela"]) {
      expect(screen.getByRole("button", { name: nome })).toBeInTheDocument();
    }
    expect(screen.getByRole("combobox", { name: "Dia da semana" })).toBeInTheDocument();
    expect(screen.getByLabelText("Fim")).toBeInTheDocument();
  });
});

describe("Equipe › Horário no celular", () => {
  it("o botão de copiar quebra o texto e só afasta do vizinho a partir de sm", () => {
    abrir("pt-BR");
    const copiar = screen.getByRole("button", { name: /copiar estes horários/i });
    expect(copiar).toHaveClass("max-sm:whitespace-normal", "sm:ml-2");
    expect(copiar).not.toHaveClass("ml-2");
  });
});
