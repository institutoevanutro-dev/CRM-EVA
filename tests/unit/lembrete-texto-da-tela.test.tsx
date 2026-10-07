import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LembreteDoCompromisso, type TipoRow } from "@/app/app/settings/tenant/agenda/_client";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

/**
 * O TEXTO DO LEMBRETE NA TELA — campo, ajuda das variáveis e prévia.
 *
 * O que se mede é o DOM: o campo existe com o limite da rota, nasce com o que
 * está gravado, fica desabilitado com o aviso desligado (campo desabilitado não
 * entra no `FormData`, e o PATCH não sobrescreve o texto guardado), e a prévia
 * usa a MESMA função do cron (`montarLembrete`), então o que a pessoa vê é o
 * que o paciente recebe.
 *
 * NÃO MEDIDO aqui: a gravação de ponta a ponta (PATCH → banco → reload). Quem a
 * cobre é `tests/e2e/agenda-tipos-de-agendamento.spec.ts`.
 */
const TIPO: TipoRow = {
  id: "t1",
  name: "Consulta",
  slug: "consulta",
  description: null,
  category: "consulta",
  duration_minutes: 30,
  catalog_product_id: null,
  required_room_kind: null,
  concurrency_key: null,
  location_kind: "in_person",
  location_details: "Rua das Flores, 100",
  default_owner_user_id: null,
  requires_confirmation: false,
  is_active: true,
  reminder_enabled: true,
  reminder_minutes_before: 1440,
  reminder_extra_offsets_minutes: [],
  reminder_body: "Oi {{nome}}",
};

function montar(tipo: TipoRow = TIPO, locale = "pt-BR") {
  return render(
    <IdiomaProvider locale={locale}>
      <form>
        <LembreteDoCompromisso tipo={tipo} />
      </form>
    </IdiomaProvider>,
  );
}

afterEach(cleanup);

describe("o campo do texto do lembrete", () => {
  it("existe, aceita até 1000 caracteres e nasce com o texto gravado", () => {
    montar();
    const campo = screen.getByTestId("editar-lembrete-texto-t1") as HTMLTextAreaElement;
    expect(campo.maxLength).toBe(1000);
    expect(campo.value).toBe("Oi {{nome}}");
    expect(campo.name).toBe("reminder_body");
  });

  it("a prévia mostra o texto como o paciente recebe", () => {
    montar();
    const campo = screen.getByTestId("editar-lembrete-texto-t1");
    fireEvent.change(campo, { target: { value: "Oi {{primeiro_nome}}, até {{quando}}" } });
    expect(screen.getByTestId("previa-lembrete-t1").textContent).toContain("Oi Maria, até amanhã");
  });

  it("em branco, a prévia mostra a frase padrão", () => {
    montar({ ...TIPO, reminder_body: null });
    expect(screen.getByTestId("previa-lembrete-t1").textContent).toContain(
      "Passando pra lembrar do seu compromisso:",
    );
  });

  it("com o aviso desligado, o campo fica desabilitado — e o texto guardado não é sobrescrito", () => {
    montar({ ...TIPO, reminder_enabled: false });
    expect((screen.getByTestId("editar-lembrete-texto-t1") as HTMLTextAreaElement).disabled).toBe(true);
  });

  it("a ajuda lista as dez variáveis", () => {
    montar();
    const ajuda = screen.getByTestId("variaveis-lembrete-t1").textContent ?? "";
    for (const v of [
      "primeiro_nome",
      "nome",
      "quando",
      "data",
      "hora",
      "dia_semana",
      "unidade",
      "endereco",
      "profissional",
      "tipo",
    ]) {
      expect(ajuda).toContain(`{{${v}}}`);
    }
  });

  it("variável que não existe aparece como aviso antes de salvar", () => {
    montar();
    fireEvent.change(screen.getByTestId("editar-lembrete-texto-t1"), { target: { value: "Oi {nome}" } });
    expect(screen.getByTestId("aviso-variavel-lembrete-t1").textContent).toContain(
      "Variável que não existe: use só as da lista.",
    );
  });

  it("em espanhol, a prévia e a ajuda saem em espanhol", () => {
    montar({ ...TIPO, reminder_body: "{{quando}}" }, "es");
    expect(screen.getByTestId("previa-lembrete-t1").textContent).toContain("mañana");
    expect(screen.getByText("Mensaje del recordatorio")).toBeTruthy();
  });
});

describe("o módulo do texto não puxa servidor para a tela", () => {
  it("lib/agenda/texto-do-lembrete.ts não importa supabase, env nem logger", () => {
    const fonte = readFileSync(join(process.cwd(), "lib/agenda/texto-do-lembrete.ts"), "utf8");
    expect(fonte).not.toMatch(/from "@\/lib\/(supabase|env|logger)/);
  });
});
