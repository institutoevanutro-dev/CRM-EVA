# Agenda redesenhada — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A recepção marca, confirma, remarca e cancela sem procurar botão: hora com relógio, "Paciente novo/antigo", fileira de profissionais de uma pessoa por vez, semana de segunda a sábado, cartões limpos e um painel do paciente que substitui a lista de baixo.

**Architecture:** Tudo é tela. O "quando" do `MarcacaoSimples` vira um componente próprio (`QuandoDaMarcacao`) e é reusado no Remarcar do painel do paciente (`DetalheDoCompromisso`, agora `Dialog`). `_client.tsx` continua dono da consulta de horários livres (marcação nova e remarcação usam a mesma); a remarcação chama exatamente o mesmo `PATCH` de antes via `useRemarcarAgendamento`. A fileira de profissionais é derivada dos compromissos carregados; a grade passa a semana para segunda→sábado (+domingo só com compromisso), e a busca (`recorteDaVisao`) e a semente do servidor (`semanaSemente`) acompanham, para "o que se desenha é o que se busca".

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript estrito (`noUncheckedIndexedAccess`), Tailwind 4 (CSS-first), shadcn/ui (Radix Dialog), TanStack Query, date-fns, Vitest + Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-27-agenda-redesenho-design.md`

## Global Constraints

- "Nenhuma tabela, coluna ou migration." Nada em `supabase/`.
- "As rotas de API seguem iguais, e só passa a sair `category` na leitura de tipos." Na prática a categoria chega ao formulário pelo `select` de `app/app/agenda/page.tsx` (a rota `GET /api/v1/agenda/tipos` já devolve `category`); nenhuma rota muda.
- "As regras de conflito, lembrete, Google e IA não mudam." Remarcar = `useRemarcarAgendamento().mutate({ id, revision, starts_at })` → `PATCH /api/v1/agenda/agendamentos`, a mesma chamada do `onConfirmar` do `PainelDeMarcacao` em `_client.tsx:1044-1064`. Confirmar = `PATCH` com `status: "confirmed"`. Cancelar = `DELETE /api/v1/agenda/agendamentos` com `reason` (mínimo 3).
- "O Bloquear horário segue igual, mudando só o visual dos blocos na grade." "Dia, Semana e Mês continuam."
- Hora: `<input type="time" step=300>` com ícone de relógio, "Fora dos horários livres" só quando a hora digitada cai fora da lista.
- Paciente novo quando `category = 'consulta'` e o nome começa com "Primeira"; antigo nos outros casos. A escolha **não** é gravada. Em antigo, `quemConverteu` não vai no POST e o PATCH de origem do contato não acontece.
- "Navegação em cima, conteúdo embaixo": o painel não abre colunas lado a lado.
- Safari: a prova visual final é no Safari de verdade (memória "provar no Safari").
- i18n: todo texto novo de tela passa por `t()` **e** ganha linha `es` no fim de `DICIONARIO` em `lib/i18n/dicionario.ts` (antes do `};`). Confira antes que a chave não existe (`grep -n '^  "Texto":' lib/i18n/dicionario.ts`): chave duplicada é erro de compilação. Vigiado por `tests/unit/i18n-espanhol-cobre-a-tela.test.ts`.
- Marca própria: nenhuma cor em hex; só tokens do `app/globals.css` e `corDaTrilha`/`fundoDaTrilha` de `components/agenda/paleta.ts`.
- Sem `console.log`. Comentários e nomes em português, no estilo do arquivo.
- Ambiente: trabalhe só em `~/crm-eva-agenda` (branch `feat/agenda-redesenho`); não toque em `~/CRM-EVA`. Antes da Tarefa 1: `cd ~/crm-eva-agenda && git fetch origin && git merge --ff-only origin/main && pnpm install --frozen-lockfile` (node_modules REAL, nunca atalho).
- Commits: `git add <arquivos>` um a um, **nunca** `git add -A`; toda mensagem termina com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Publicar (push/PR/deploy) está fora deste plano.
- Gates de cada tarefa: os testes da tarefa; ao fim de cada tarefa, `NODE_OPTIONS=--max-old-space-size=8192 pnpm typecheck` e `pnpm lint`. Na Tarefa 9, `pnpm test:unit` inteiro (o **exit code** é a autoridade; leia também a linha `Errors`).

## Review Focus

1. Profissional escolhido e a grade navega para uma semana em que ele não tem atendimento → ele continua na fileira, marcado, com "Todos" para desfazer (senão a grade fica filtrada sem saída). Teste na Tarefa 3.
2. Painel aberto por link (`?compromisso=` do Radar/Central) de compromisso fora da semana carregada, e a pessoa clica em Remarcar → a grade vai até a semana dele e nenhum horário é pedido com o procedimento/dono da grade. Teste na Tarefa 6.
3. Hora digitada e depois troca de dia (ou de profissional/procedimento) → o campo limpa; hora fora da lista avisa e só vira horário para quem pode encaixar. Testes na Tarefa 2.
4. Abrir a Agenda num domingo sem nada marcado → o domingo (dia aberto) aparece; sem isso a semana não teria "hoje" e, no celular, nenhuma coluna. Teste na Tarefa 4.
5. Recepção mexe na Origem em "novo" e troca para "antigo", ou troca o modo à mão e depois troca de procedimento → nada de origem é gravado, e o modo volta ao padrão do novo procedimento. Testes na Tarefa 1.

---

## File Structure

| Arquivo | Papel | Tarefa |
|---|---|---|
| `lib/agenda/marcacao-simples.ts` | + `pacienteNovoPeloTipo` (regra pura do padrão novo/antigo) | 1 |
| `components/agenda/CampoDaMarcacao.tsx` | + `TITULO_DO_GRUPO` (título de grupo do modal) | 1 |
| `components/agenda/MarcacaoSimples.tsx` | novo/antigo, grupos; depois usa `QuandoDaMarcacao` | 1, 2 |
| `app/app/agenda/page.tsx` | `category` no `select` dos tipos → `categoria` | 1 |
| `components/agenda/QuandoDaMarcacao.tsx` | **novo**: calendário + hora com relógio + horários livres | 2 |
| `lib/agenda/pessoas-da-grade.ts` | + `pessoasComAtendimento` | 3 |
| `components/agenda/FiltroDePessoas.tsx` | fileira de seleção única | 3 |
| `components/agenda/GradeDaAgenda.tsx` | sem legenda de pessoas; seg→sáb; mês; visual | 3, 4, 5 |
| `lib/agenda/recorte-da-grade.ts`, `lib/agenda/semana-semente.ts` | semana começa na segunda | 4 |
| `components/agenda/rotulo-do-bloco.ts` | cartão curto = ≤ 30 min | 5 |
| `components/agenda/DetalheDoCompromisso.tsx` | painel do paciente em `Dialog` | 6 |
| `components/agenda/EntradaDaAgenda.tsx` | repassa `profissional` e `remarcacao` | 6 |
| `app/app/agenda/_client.tsx` | fiação de tudo; remove Sheets e lista de baixo; topo | 1, 3, 4, 6, 7, 8 |
| `components/agenda/AgendaInterativa.tsx` | + slot `fileira` ao lado de "Horários livres de" | 8 |
| `hooks/agenda/useRemarcarAgendamento.ts` | remove `useCancelarAgendamento`/`useRegistrarDesfecho` (sem uso) | 7 |
| `components/agenda/HistoricoDaAgenda.tsx` | **apagado** | 7 |
| `app/vitrine-agenda/_client.tsx` | tira a seção do histórico | 7 |
| `tests/e2e/agenda-painel-do-paciente.spec.ts` | **nova** spec pela tela | 9 |
| `.changes/agenda-redesenhada.md` | fragmento `capacidade_nova` | 9 |

**Fica, e por quê:** `components/agenda/PainelDeMarcacao.tsx` continua — a vitrine (`app/vitrine-agenda/_client.tsx:239,261,289`) e quatro testes unitários o usam (`agenda-do-atendente-diz-por-que`, `agenda-encaixe-no-painel`, `agenda-painel-abre-no-mes-com-vaga`, `agenda-lista-de-horarios-nao-estica`). O spec manda apagá-lo "se ficar sem uso"; ele sai só do produto. `AvatarDaPessoa` também fica (o `PainelDeMarcacao` usa).

**Usos conferidos antes de apagar** (`git grep -n -E "HistoricoDaAgenda|PainelDeMarcacao"`): `HistoricoDaAgenda` — `app/app/agenda/_client.tsx:19,1293`, `app/vitrine-agenda/_client.tsx:13,275`, `tests/unit/agenda-confirmar-pela-tela.test.tsx`, `tests/unit/agenda-separar-historico.test.tsx`, e2e `agenda-excluir-lancado-por-engano`, `agenda-kit-visual`, `agenda-ocupacao-do-google-no-historico`, `agenda-remarcar-e-cancelar`, `agenda-tela-do-produto`. O Sheet de cancelamento só existe em `_client.tsx:1093-1161`.

---

### Task 1: Categoria do tipo + "Paciente novo / antigo"

**Files:**
- Modify: `lib/agenda/marcacao-simples.ts` (fim do arquivo)
- Modify: `components/agenda/CampoDaMarcacao.tsx` (depois de `ROTULO`)
- Modify: `components/agenda/MarcacaoSimples.tsx:15-46,66-90,256-278,363-391,494-543,652-728`
- Modify: `app/app/agenda/page.tsx:129,283-298`
- Modify: `app/app/agenda/_client.tsx:127-135,885-886`
- Modify: `lib/i18n/dicionario.ts` (fim do `DICIONARIO`)
- Modify: `tests/e2e/agenda-procedimento-e-unidade-do-profissional.spec.ts:286-290`
- Test: `tests/unit/agenda-marcacao-simples.test.tsx`

**Interfaces:**
- Consumes: nada de tarefas anteriores.
- Produces: `pacienteNovoPeloTipo(tipo: { categoria?: string | null; nome: string } | null | undefined): boolean`; `TITULO_DO_GRUPO: string` em `CampoDaMarcacao.tsx`; `MarcacaoConfirmada.quemConverteu` passa a ser **opcional**; tipo do formulário ganha `categoria?: string | null`; test ids `paciente-novo`, `paciente-antigo`, `tipo-de-paciente`.

- [ ] **Step 1: Escrever os testes que falham**

Em `tests/unit/agenda-marcacao-simples.test.tsx`:

1a. Troque o import de React (linha 16) por:

```ts
import { useState, type ComponentProps } from "react";
```

1b. Acrescente `pacienteNovoPeloTipo` ao import de `@/lib/agenda/marcacao-simples` (linhas 47-58), em ordem alfabética depois de `ofertaDeUnidades`.

1c. Substitua a função `montarMarcacao` inteira (linhas 160-195) por:

```tsx
function propsBase(): ComponentProps<typeof MarcacaoSimples> {
  return {
    ancora: new Date(2026, 9, 22, 12),
    agora: new Date(2026, 9, 22, 8),
    usuarioId: ANA,
    pessoas: PESSOAS,
    tipos: TIPOS,
    profissionalId: "",
    onProfissional: vi.fn(),
    tipoId: "",
    onTipo: vi.fn(),
    contactId: "",
    conversationId: "",
    onVinculo: vi.fn(),
    unidades: [],
    unidadeId: "",
    onUnidade: vi.fn(),
    fuso: "America/Sao_Paulo",
    horariosPorDia: {},
    publicouHorarios: true,
    erroAoCarregar: false,
    fusoSuposto: false,
    onMesVisivel: vi.fn(),
    mesCarregado: new Date(2026, 9, 1),
    permiteEncaixe: true,
    podeBloquearDeOutros: true,
    onConfirmar: vi.fn(() => Promise.resolve()),
    onVerNaAgenda: vi.fn(),
  };
}

function montarMarcacao(props: Partial<ComponentProps<typeof MarcacaoSimples>> = {}, semCanal = false) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const r = render(
    <QueryClientProvider client={qc}>
      <MarcacaoSimples {...propsBase()} {...props} />
    </QueryClientProvider>,
  );
  return semCanal ? r : comCanal(r);
}
```

1d. No `describe("quem converteu e a origem do lead (21/11/2026)")`, troque o `comHorario` por um procedimento de paciente NOVO (os dois campos só existem nele agora):

```ts
  const PRIMEIRA = {
    id: "t-primeira",
    nome: "Primeira consulta",
    duracaoMin: 60,
    donoId: ANA,
    localDetalhes: null,
    exigePaciente: false,
    categoria: "consulta",
  };
  const comHorario = {
    profissionalId: ANA,
    tipoId: "t-primeira",
    tipos: [...TIPOS, PRIMEIRA],
    horarioInicial: { instante, rotulo: "13:00" },
    horariosPorDia: { "2026-10-22": [{ instante, rotulo: "13:00" }] },
  };
```

1e. Acrescente no fim do arquivo:

```tsx
describe("paciente novo ou antigo (decisão do André, 27/11/2026)", () => {
  const instante = "2026-10-22T16:00:00.000Z";
  const PRIMEIRA = {
    id: "t-primeira",
    nome: "Primeira consulta",
    duracaoMin: 60,
    donoId: ANA,
    localDetalhes: null,
    exigePaciente: false,
    categoria: "consulta",
  };
  const APLICACAO = {
    id: "t-aplicacao",
    nome: "Aplicação de vitamina D",
    duracaoMin: 15,
    donoId: ANA,
    localDetalhes: null,
    exigePaciente: false,
    categoria: "procedimento",
  };
  const PACIENTE = {
    id: "c-ficticio-2",
    name: "Paciente Fictícia Rocha",
    display_name: null,
    phone_number: "+5527900000001",
    tags: ["Meta"],
    source: "whatsapp",
    source_metadata: {},
  };
  const comHorario = (tipoId: string) => ({
    profissionalId: ANA,
    tipoId,
    tipos: [...TIPOS, PRIMEIRA, APLICACAO],
    horarioInicial: { instante, rotulo: "13:00" },
    horariosPorDia: { "2026-10-22": [{ instante, rotulo: "13:00" }] },
  });
  afterEach(() => {
    ficha = null;
    patch.mockClear();
  });

  it("regra pura: só a 'Primeira…' de categoria consulta é paciente novo", () => {
    expect(pacienteNovoPeloTipo({ categoria: "consulta", nome: "Primeira consulta" })).toBe(true);
    expect(pacienteNovoPeloTipo({ categoria: "consulta", nome: "  primeira vez" })).toBe(true);
    expect(pacienteNovoPeloTipo({ categoria: "consulta", nome: "Consulta de acompanhamento" })).toBe(false);
    expect(pacienteNovoPeloTipo({ categoria: "retorno", nome: "Primeira revisão" })).toBe(false);
    expect(pacienteNovoPeloTipo({ categoria: null, nome: "Primeira consulta" })).toBe(false);
    expect(pacienteNovoPeloTipo(null)).toBe(false);
  });

  it("primeira consulta abre em Paciente novo, com Quem converteu e Origem", () => {
    montarMarcacao(comHorario("t-primeira"));
    expect(screen.getByTestId("paciente-novo")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("quem-converteu")).toBeInTheDocument();
    expect(screen.getByTestId("origem-do-lead")).toBeInTheDocument();
  });

  it("aplicação abre em Paciente antigo: os dois campos somem e o confirmar não leva quem converteu", async () => {
    const onConfirmar = vi.fn((_m: unknown) => Promise.resolve());
    montarMarcacao({ ...comHorario("t-aplicacao"), onConfirmar });
    expect(screen.getByTestId("paciente-antigo")).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByTestId("quem-converteu")).toBeNull();
    expect(screen.queryByTestId("origem-do-lead")).toBeNull();
    fireEvent.click(screen.getByTestId("confirmar-marcacao"));
    await waitFor(() => expect(onConfirmar).toHaveBeenCalled());
    expect(onConfirmar.mock.calls[0]?.[0]).not.toHaveProperty("quemConverteu");
  });

  it("mexer na Origem e trocar para antigo: nada é gravado na ficha", async () => {
    ficha = PACIENTE;
    const onConfirmar = vi.fn((_m: unknown) => Promise.resolve());
    montarMarcacao({ ...comHorario("t-primeira"), contactId: PACIENTE.id, onConfirmar });
    const origem = screen.getByTestId("origem-do-lead") as HTMLSelectElement;
    await waitFor(() => expect(origem.value).toBe("meta"));
    fireEvent.change(origem, { target: { value: "indicacao" } });
    fireEvent.click(screen.getByTestId("paciente-antigo"));
    expect(screen.queryByTestId("origem-do-lead")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("confirmar-marcacao")).toBeEnabled());
    fireEvent.click(screen.getByTestId("confirmar-marcacao"));
    await waitFor(() => expect(onConfirmar).toHaveBeenCalled());
    expect(patch).not.toHaveBeenCalled();
    expect(onConfirmar.mock.calls[0]?.[0]).not.toHaveProperty("quemConverteu");
  });

  it("a troca vale só para o procedimento em que foi feita: outro procedimento volta ao padrão dele", () => {
    function ComProcedimento() {
      const [tipoId, setTipoId] = useState("t-aplicacao");
      return <MarcacaoSimples {...propsBase()} {...comHorario(tipoId)} onTipo={setTipoId} />;
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ComProcedimento />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByTestId("paciente-novo"));
    expect(screen.getByTestId("quem-converteu")).toBeInTheDocument();
    // "Avaliação facial" (t-ana) não tem categoria: o padrão dela é antigo.
    fireEvent.change(screen.getByTestId("procedimento-da-marcacao"), { target: { value: "t-ana" } });
    expect(screen.getByTestId("paciente-antigo")).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByTestId("quem-converteu")).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run tests/unit/agenda-marcacao-simples.test.tsx`
Expected: FAIL — `pacienteNovoPeloTipo is not a function` e `Unable to find an element by: [data-testid="paciente-novo"]`.

- [ ] **Step 3: A regra pura**

No fim de `lib/agenda/marcacao-simples.ts`:

```ts
/**
 * O tipo de paciente que a marcação supõe pelo procedimento (decisão do André,
 * 27/11/2026): só a PRIMEIRA consulta é de paciente novo — categoria
 * `consulta` e nome começando por "Primeira". Acompanhamento, teleconsulta,
 * retorno e aplicação são de quem já é paciente. A recepção troca com um
 * clique, e a escolha não é gravada: é modo da tela, não dado.
 *
 * ponytail: lê o nome. "1ª consulta" cai em antigo; se aparecer, a recepção troca.
 */
export function pacienteNovoPeloTipo(
  tipo: { categoria?: string | null; nome: string } | null | undefined,
): boolean {
  if (!tipo || tipo.categoria !== "consulta") return false;
  return tipo.nome.trim().toLowerCase().startsWith("primeira");
}
```

Em `components/agenda/CampoDaMarcacao.tsx`, logo depois de `export const ROTULO = ...`:

```ts
/** Título de grupo do modal ("Quem e o quê", "Paciente", "Quando"): menor e mais calado que o rótulo. */
export const TITULO_DO_GRUPO = "text-[11px] font-semibold uppercase tracking-wide text-text-subtle";
```

- [ ] **Step 4: A categoria chega ao formulário**

`app/app/agenda/page.tsx:129` — acrescente `category` ao `select`:

```ts
      .select("id, name, duration_minutes, location_kind, location_details, is_active, default_owner_user_id, requires_patient, category")
```

No `tiposIniciais={(tipos ?? []).map((t) => ({` (l.283), depois de `exigePaciente: t.requires_patient,`:

```ts
        // A categoria decide o "Paciente novo / antigo" padrão da marcação
        // (`pacienteNovoPeloTipo`). Leitura de coluna que já existe.
        categoria: t.category,
```

`app/app/agenda/_client.tsx:127-135` — no tipo de `tiposIniciais`, depois de `exigePaciente: boolean;`:

```ts
    /** `calendar_event_types.category` — decide o "Paciente novo / antigo" padrão. */
    categoria?: string | null;
```

`app/app/agenda/_client.tsx:885-886` — quem converteu passa a ser opcional:

```ts
                  converted_by_kind: m.quemConverteu?.kind,
                  converted_by_user_id: m.quemConverteu?.kind === "user" ? m.quemConverteu.userId : undefined,
```

- [ ] **Step 5: O seletor no modal**

Em `components/agenda/MarcacaoSimples.tsx`:

5a. Import (l.15-21): acrescente `pacienteNovoPeloTipo` ao bloco de `@/lib/agenda/marcacao-simples`; e troque a l.43 por:

```ts
import { CAMPO, ROTULO, Seletor, TITULO_DO_GRUPO } from "./CampoDaMarcacao";
```

5b. `type Tipo` (l.66-74): depois de `exigePaciente: boolean;`:

```ts
  /** `calendar_event_types.category`: decide o "Paciente novo / antigo" padrão. */
  categoria?: string | null;
```

5c. `MarcacaoConfirmada` (l.88-89): troque a linha de `quemConverteu` por:

```ts
  /**
   * Quem converteu o lead (migration 0422). Só em PACIENTE NOVO: paciente antigo
   * não leva o campo, e o POST sai sem `converted_by_*` (27/11/2026).
   */
  quemConverteu?: { kind: "user"; userId: string } | { kind: "ai" };
```

5d. Depois da linha `const origemMudou = origem !== null && origemDaFicha !== null && origem !== origemDaFicha;` (l.277):

```ts

  // PACIENTE NOVO OU ANTIGO (decisão do André, 27/11/2026). O padrão sai do
  // procedimento (`pacienteNovoPeloTipo`); a troca da recepção vale só para o
  // procedimento em que foi feita — escolher outro volta ao padrão dele. Não é
  // gravado em lugar nenhum: é modo da tela (DIRC: calcular, não duplicar).
  const [modoEscolhido, setModoEscolhido] = React.useState<{ tipoId: string; novo: boolean } | null>(null);
  const pacienteNovo =
    modoEscolhido !== null && modoEscolhido.tipoId === (tipo?.id ?? "")
      ? modoEscolhido.novo
      : pacienteNovoPeloTipo(tipo);
```

5e. Em `confirmar` (l.375-391), troque do `if (pedeNome || origemMudou) {` até o fim do `await onConfirmar({...});` por:

```ts
      // Paciente antigo não mexe na origem: os campos nem estão na tela.
      const origemParaGravar = pacienteNovo && origemMudou ? origem : null;
      if (pedeNome || origemParaGravar) {
        await gravarContato.mutateAsync({
          ...(pedeNome ? { name: nomeCompletoLimpo(nomeCompleto) } : {}),
          ...(origemParaGravar ? { origem_informada: origemParaGravar } : {}),
        });
      }
      const conversao: NonNullable<MarcacaoConfirmada["quemConverteu"]> = quemConverteu.startsWith("user:")
        ? { kind: "user", userId: quemConverteu.slice("user:".length) }
        : { kind: "ai" };
      await onConfirmar({
        instante: horario.instante,
        duracaoMin: duracao === null ? undefined : (duracaoMin ?? undefined),
        convidado: convidadoLimpo || undefined,
        endereco: endereco.trim(),
        observacao: observacao.trim(),
        canal,
        // Paciente antigo NÃO leva quem converteu: a conversão foi na primeira consulta.
        ...(pacienteNovo ? { quemConverteu: conversao } : {}),
      });
```

5f. Grupo "Quem e o quê": logo depois de `<div className="flex min-w-0 flex-col gap-4">` (l.496), antes da `<div className="grid gap-x-3 gap-y-4 sm:grid-cols-2 md:grid-cols-1 lg:grid-cols-2">`:

```tsx
              <h3 className={cn(TITULO_DO_GRUPO, "-mb-2")}>{t("Quem e o quê")}</h3>
```

5g. Grupo "Paciente" com o seletor na MESMA linha do título (economiza altura: `agenda-painel-cabe-na-tela.spec.ts` mede 1280×800 sem rolar). Imediatamente antes de `              <div>\n                <VinculoDaMarcacao` (l.652):

```tsx
              <div className="-mb-2 flex flex-wrap items-center justify-between gap-2">
                <h3 className={TITULO_DO_GRUPO}>{t("Paciente")}</h3>
                <fieldset data-testid="tipo-de-paciente" className="flex items-center">
                  <legend className="sr-only">{t("Tipo de paciente")}</legend>
                  <span className="inline-flex rounded-md border border-border-input bg-surface p-0.5">
                    {(
                      [
                        ["novo", "Paciente novo"],
                        ["antigo", "Paciente antigo"],
                      ] as const
                    ).map(([valor, rotulo]) => {
                      const ativo = (valor === "novo") === pacienteNovo;
                      return (
                        <button
                          key={valor}
                          type="button"
                          data-testid={`paciente-${valor}`}
                          aria-pressed={ativo}
                          onClick={() => setModoEscolhido({ tipoId: tipo?.id ?? "", novo: valor === "novo" })}
                          className={cn(
                            "h-7 rounded-sm px-3 text-xs font-medium transition-colors duration-fast toque:h-10",
                            FOCO,
                            ativo ? "bg-accent text-accent-foreground shadow-xs" : "text-text-muted hover:text-text",
                          )}
                        >
                          {t(rotulo)}
                        </button>
                      );
                    })}
                  </span>
                </fieldset>
              </div>
```

5h. "Quem converteu" e "Origem do lead" só em paciente novo: troque a abertura `              <div className="grid gap-x-3 gap-y-4 sm:grid-cols-2">` (l.675) por

```tsx
              {pacienteNovo ? (
              <div className="grid gap-x-3 gap-y-4 sm:grid-cols-2">
```

e o fechamento dessa grade (l.727-728, logo antes de `<div>\n                <label htmlFor="observacao-do-compromisso"`) por

```tsx
                </div>
              </div>
              ) : null}
```

5i. `lib/i18n/dicionario.ts`, antes do `};` final do `DICIONARIO`:

```ts
  "Paciente novo": { es: "Paciente nuevo" },
  "Paciente antigo": { es: "Paciente recurrente" },
  "Tipo de paciente": { es: "Tipo de paciente" },
  "Quem e o quê": { es: "Quién y qué" },
```

- [ ] **Step 6: Rodar e ver passar**

Run: `pnpm vitest run tests/unit/agenda-marcacao-simples.test.tsx tests/unit/agenda-duracao-escolhida.test.tsx tests/unit/agenda-aviso-sem-lembrete.test.tsx tests/unit/agenda-nome-completo-do-paciente.test.tsx tests/unit/agenda-clique-e-profissionais.test.tsx tests/unit/i18n-espanhol-cobre-a-tela.test.ts`
Expected: PASS.

- [ ] **Step 7: A spec e2e que escolhe quem converteu**

`tests/e2e/agenda-procedimento-e-unidade-do-profissional.spec.ts`, imediatamente antes de `await expect(page.getByTestId("quem-converteu")).toHaveValue(...)` (l.290):

```ts
  // "Avaliação facial" não é "Primeira…": a marcação abre em Paciente antigo, e
  // "Quem converteu"/"Origem" só existem em Paciente novo (27/11/2026).
  await page.getByTestId("paciente-novo").click();
```

- [ ] **Step 8: Gates e commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 pnpm typecheck && pnpm lint
git add lib/agenda/marcacao-simples.ts components/agenda/CampoDaMarcacao.tsx components/agenda/MarcacaoSimples.tsx app/app/agenda/page.tsx app/app/agenda/_client.tsx lib/i18n/dicionario.ts tests/unit/agenda-marcacao-simples.test.tsx tests/e2e/agenda-procedimento-e-unidade-do-profissional.spec.ts
git commit -m "feat(agenda): Paciente novo/antigo na marcação, com padrão pelo procedimento

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `QuandoDaMarcacao` — hora com relógio e horários livres como atalho

**Files:**
- Create: `components/agenda/QuandoDaMarcacao.tsx`
- Modify: `components/agenda/MarcacaoSimples.tsx` (estado do calendário/encaixe e coluna da direita)
- Modify: `lib/i18n/dicionario.ts`
- Test: `tests/unit/agenda-quando-da-marcacao.test.tsx` (novo)

**Interfaces:**
- Consumes: `TITULO_DO_GRUPO`, `CAMPO`, `ROTULO` (Tarefa 1); `HorarioLivre` de `components/agenda/tipos.ts`; `instanteDe` de `lib/agenda/fuso.ts`.
- Produces:

```ts
export type QuandoDaMarcacaoProps = {
  ancora: Date; agora: Date; fuso?: string;
  horariosPorDia: Record<string, HorarioLivre[]>;
  publicouHorarios: boolean; erroAoCarregar: boolean; fusoSuposto: boolean;
  fontesDefasadas?: Array<{ nome?: string; desde?: string }>;
  googleCoberturaParcial?: boolean;
  onMesVisivel: (mes: Date) => void; mesCarregado: Date | null;
  temTipo: boolean; avisoSemTipo: string; permiteEncaixe: boolean; abriuComHorario: boolean;
  dia: Date; onDia: (d: Date) => void;
  horario: HorarioLivre | null; onHorario: (h: HorarioLivre | null) => void;
};
export function QuandoDaMarcacao(props: QuandoDaMarcacaoProps): JSX.Element;
```
Test ids mantidos do modal: `dia-yyyy-MM-dd` (com `data-disponivel`), `mes-anterior`, `mes-seguinte`, `lista-de-horarios`, `horario-HH:mm`, `sem-jornada-publicada`, `ir-configurar-horarios`, `motivo-do-bloqueio`, `fontes-defasadas`, `fuso-suposto`. Novos: `quando-da-marcacao`, `hora-da-marcacao`, `fora-dos-horarios-livres`. Somem do modal: `encaixe`, `abrir-encaixe`, `hora-do-encaixe`, `usar-hora-do-encaixe` (o `PainelDeMarcacao` da vitrine mantém os dele).

- [ ] **Step 1: Escrever os testes que falham**

Crie `tests/unit/agenda-quando-da-marcacao.test.tsx`:

```tsx
/**
 * O "quando" da marcação (decisão 1 do André, 27/11/2026): campo de hora com
 * relógio e os horários livres embaixo como atalho. Clicar num horário preenche
 * o campo; digitar uma hora da lista escolhe aquele horário; digitar uma hora de
 * fora vale como encaixe (para quem pode) e avisa "Fora dos horários livres".
 *
 * Nomes e datas fictícios.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

import { QuandoDaMarcacao } from "@/components/agenda/QuandoDaMarcacao";
import type { HorarioLivre } from "@/components/agenda/tipos";

afterEach(cleanup);

const DIA = new Date(2026, 9, 22, 12);
/** 13:00 e 14:00 em São Paulo (UTC-3). */
const H13: HorarioLivre = { instante: "2026-10-22T16:00:00.000Z", rotulo: "13:00" };
const H14: HorarioLivre = { instante: "2026-10-22T17:00:00.000Z", rotulo: "14:00" };

function Montar({
  aoEscolher,
  ...props
}: Partial<ComponentProps<typeof QuandoDaMarcacao>> & { aoEscolher?: (h: HorarioLivre | null) => void }) {
  const [dia, setDia] = useState(DIA);
  const [horario, setHorario] = useState<HorarioLivre | null>(null);
  return (
    <>
      <QuandoDaMarcacao
        ancora={DIA}
        agora={new Date(2026, 9, 22, 8)}
        fuso="America/Sao_Paulo"
        horariosPorDia={{ "2026-10-22": [H13, H14], "2026-10-23": [H13] }}
        publicouHorarios
        erroAoCarregar={false}
        fusoSuposto={false}
        onMesVisivel={vi.fn()}
        mesCarregado={new Date(2026, 9, 1)}
        temTipo
        avisoSemTipo="Escolha o profissional e o procedimento para ver os horários livres."
        permiteEncaixe
        abriuComHorario={false}
        dia={dia}
        onDia={setDia}
        horario={horario}
        onHorario={(h) => {
          setHorario(h);
          aoEscolher?.(h);
        }}
        {...props}
      />
      <button type="button" onClick={() => setHorario(null)}>
        limpar por fora
      </button>
    </>
  );
}

const campo = () => screen.getByTestId("hora-da-marcacao") as HTMLInputElement;

describe("o quando da marcação", () => {
  it("clicar num horário livre preenche o campo de hora, sem aviso", () => {
    const aoEscolher = vi.fn();
    render(<Montar aoEscolher={aoEscolher} />);
    expect(campo()).toHaveAttribute("type", "time");
    expect(campo()).toHaveAttribute("step", "300");
    fireEvent.click(screen.getByTestId("horario-13:00"));
    expect(campo().value).toBe("13:00");
    expect(aoEscolher).toHaveBeenLastCalledWith(H13);
    expect(screen.queryByTestId("fora-dos-horarios-livres")).toBeNull();
  });

  it("digitar uma hora da lista escolhe aquele mesmo horário", () => {
    const aoEscolher = vi.fn();
    render(<Montar aoEscolher={aoEscolher} />);
    fireEvent.change(campo(), { target: { value: "14:00" } });
    expect(aoEscolher).toHaveBeenLastCalledWith(H14);
    expect(screen.getByTestId("horario-14:00")).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByTestId("fora-dos-horarios-livres")).toBeNull();
  });

  it("hora fora da lista vale como encaixe e avisa", () => {
    const aoEscolher = vi.fn();
    render(<Montar aoEscolher={aoEscolher} />);
    fireEvent.change(campo(), { target: { value: "10:30" } });
    expect(aoEscolher).toHaveBeenLastCalledWith({ instante: "2026-10-22T13:30:00.000Z", rotulo: "10:30" });
    expect(screen.getByTestId("fora-dos-horarios-livres")).toHaveTextContent("Fora dos horários livres");
  });

  it("sem encaixe, a hora de fora não vira horário — o aviso fica", () => {
    const aoEscolher = vi.fn();
    render(<Montar aoEscolher={aoEscolher} permiteEncaixe={false} />);
    fireEvent.change(campo(), { target: { value: "10:30" } });
    expect(aoEscolher).toHaveBeenLastCalledWith(null);
    expect(campo().value).toBe("10:30");
    expect(screen.getByTestId("fora-dos-horarios-livres")).toBeInTheDocument();
  });

  it("quem chama limpa o horário (trocou o profissional): o campo esvazia", () => {
    render(<Montar />);
    fireEvent.change(campo(), { target: { value: "10:30" } });
    fireEvent.click(screen.getByText("limpar por fora"));
    expect(campo().value).toBe("");
  });

  it("trocar de dia limpa a hora, mesmo a digitada e não aplicada", () => {
    render(<Montar permiteEncaixe={false} />);
    fireEvent.change(campo(), { target: { value: "10:30" } });
    fireEvent.click(screen.getByTestId("dia-2026-10-23"));
    expect(campo().value).toBe("");
    expect(screen.queryByTestId("fora-dos-horarios-livres")).toBeNull();
  });

  it("sem procedimento o campo fica desligado e a tela diz por quê", () => {
    render(<Montar temTipo={false} />);
    expect(campo()).toBeDisabled();
    expect(screen.getByText("Escolha o profissional e o procedimento para ver os horários livres.")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run tests/unit/agenda-quando-da-marcacao.test.tsx`
Expected: FAIL — `Failed to resolve import "@/components/agenda/QuandoDaMarcacao"`.

- [ ] **Step 3: Criar o componente**

`components/agenda/QuandoDaMarcacao.tsx` (o calendário e a lista são porte literal de `MarcacaoSimples.tsx:205-211,302-330,458-477,810-942`; o encaixe vira o campo de hora):

```tsx
"use client";

import { addDays, format, isSameDay, isSameMonth, startOfDay, startOfMonth, startOfWeek } from "date-fns";
import Link from "next/link";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { instanteDe } from "@/lib/agenda/fuso";
import { CaretLeft, CaretRight, Clock } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import { CAMPO, ROTULO, TITULO_DO_GRUPO } from "./CampoDaMarcacao";
import type { HorarioLivre } from "./tipos";

/**
 * O "QUANDO" da marcação — o mês, a hora com relógio e os horários livres
 * embaixo como atalho (decisão 1 do André, 27/11/2026).
 *
 * É o MESMO componente no "Novo agendamento" (`MarcacaoSimples`) e no Remarcar
 * do painel do paciente (`DetalheDoCompromisso`): escolher o horário novo é o
 * mesmo gesto de escolher o primeiro. Quem usa guarda o dia e o horário; o mês
 * visível mora aqui.
 *
 * A hora digitada fora da lista vale (é o encaixe que a rota já aceita de quem
 * é da equipe) e só avisa "Fora dos horários livres". Quem decide o conflito
 * continua sendo o servidor.
 */

/** Foco visível dos botões crus (dias, horários). */
const FOCO =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-500";
const HORA = /^([01]\d|2[0-3]):([0-5]\d)$/;

export type QuandoDaMarcacaoProps = {
  /** O dia de hoje NA ORGANIZAÇÃO: é onde o calendário abre. */
  ancora: Date;
  agora: Date;
  /** O fuso da regra (`fuso_da_regra`): sem ele não há como montar o instante digitado. */
  fuso?: string;
  horariosPorDia: Record<string, HorarioLivre[]>;
  publicouHorarios: boolean;
  erroAoCarregar: boolean;
  fusoSuposto: boolean;
  fontesDefasadas?: Array<{ nome?: string; desde?: string }>;
  googleCoberturaParcial?: boolean;
  onMesVisivel: (mes: Date) => void;
  mesCarregado: Date | null;
  /** Já se sabe de que procedimento e de quem são os horários. */
  temTipo: boolean;
  /** O que dizer enquanto `temTipo` é falso. */
  avisoSemTipo: string;
  /** Hora fora da lista vale (encaixe): só para quem é da equipe e pode marcar. */
  permiteEncaixe: boolean;
  /** Abriu com horário escolhido (clique na grade): o mês não pula sozinho. */
  abriuComHorario: boolean;
  dia: Date;
  onDia: (d: Date) => void;
  horario: HorarioLivre | null;
  onHorario: (h: HorarioLivre | null) => void;
};

export function QuandoDaMarcacao({
  ancora,
  agora,
  fuso,
  horariosPorDia,
  publicouHorarios,
  erroAoCarregar,
  fusoSuposto,
  fontesDefasadas,
  googleCoberturaParcial,
  onMesVisivel,
  mesCarregado,
  temTipo,
  avisoSemTipo,
  permiteEncaixe,
  abriuComHorario,
  dia,
  onDia,
  horario,
  onHorario,
}: QuandoDaMarcacaoProps) {
  const t = useT();
  const locale = useLocaleDeData();

  const [mes, setMes] = React.useState(() => startOfMonth(dia));
  React.useEffect(() => {
    onMesVisivel(mes);
  }, [mes, onMesVisivel]);

  const semanas = React.useMemo(() => {
    const primeiro = startOfWeek(startOfMonth(mes), { weekStartsOn: 0 });
    return Array.from({ length: 6 }, (_, s) =>
      Array.from({ length: 7 }, (_, d) => addDays(primeiro, s * 7 + d)),
    );
  }, [mes]);
  const dadosDoMes = mesCarregado !== null && isSameMonth(mesCarregado, mes);
  const temHorario = (d: Date): boolean =>
    temTipo && dadosDoMes && isSameMonth(d, mes) && (horariosPorDia[format(d, "yyyy-MM-dd")]?.length ?? 0) > 0;
  const encaixeLigado = permiteEncaixe && temTipo && Boolean(fuso) && publicouHorarios && !erroAoCarregar;
  const inicioDeHoje = startOfDay(agora).getTime();
  const diaClicavel = (d: Date): boolean =>
    temHorario(d) || (isSameMonth(d, mes) && encaixeLigado && d.getTime() >= inicioDeHoje);

  // O mês de abertura sem vaga nenhuma passa sozinho ao seguinte, uma vez (a
  // mesma regra do painel antigo: no fim do mês a próxima vaga é no outro).
  const aberturaDecidida = React.useRef(false);
  const aberturaCarregada = temTipo && dadosDoMes && isSameMonth(mes, ancora);
  const aberturaSemVaga = aberturaCarregada && !semanas.flat().some(temHorario);
  React.useEffect(() => {
    if (aberturaDecidida.current || !aberturaCarregada || abriuComHorario) return;
    aberturaDecidida.current = true;
    if (aberturaSemVaga && publicouHorarios && !erroAoCarregar) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- decisão única, tomada quando os horários do mês de abertura chegam.
      setMes((m) => startOfMonth(addDays(startOfMonth(m), 32)));
    }
  }, [aberturaCarregada, aberturaSemVaga, publicouHorarios, erroAoCarregar, abriuComHorario]);

  const doDia = temTipo ? (horariosPorDia[format(dia, "yyyy-MM-dd")] ?? []) : [];

  // O TEXTO DO CAMPO e o horário que ele produziu. O campo mostra o horário
  // escolhido; quando quem chama o limpa (trocou o profissional), o texto que
  // tinha virado horário some junto. Texto que NÃO virou horário (encaixe
  // proibido) fica, com o aviso, para a pessoa ver o que digitou.
  const [texto, setTexto] = React.useState<{ valor: string; instante: string | null }>({
    valor: "",
    instante: null,
  });
  const exibido = horario
    ? texto.instante === horario.instante
      ? texto.valor
      : horario.rotulo
    : texto.instante === null
      ? texto.valor
      : "";

  const escolherHora = (valor: string) => {
    const partes = HORA.exec(valor);
    if (!partes || !fuso) {
      setTexto({ valor, instante: null });
      onHorario(null);
      return;
    }
    // A hora de parede do DIA escolhido, no fuso da regra: NUNCA `new Date(ano,
    // mes, ...)`, que é o fuso do navegador.
    const instante = instanteDe(
      {
        ano: dia.getFullYear(),
        mes: dia.getMonth() + 1,
        dia: dia.getDate(),
        hora: Number(partes[1]),
        minuto: Number(partes[2]),
      },
      fuso,
    );
    const livre = doDia.find((h) => Date.parse(h.instante) === instante.getTime());
    const escolhido = livre ?? (permiteEncaixe ? { instante: instante.toISOString(), rotulo: valor } : null);
    setTexto({ valor, instante: escolhido?.instante ?? null });
    onHorario(escolhido);
  };

  const naLista = horario !== null && doDia.some((h) => Date.parse(h.instante) === Date.parse(horario.instante));
  const foraDaLista =
    temTipo && dadosDoMes && publicouHorarios && !erroAoCarregar && HORA.test(exibido) && !naLista;

  const avisoDosHorarios = !temTipo ? (
    <p className="rounded-md bg-surface px-3 py-2.5 text-xs text-text-muted">{avisoSemTipo}</p>
  ) : !publicouHorarios ? (
    <div data-testid="sem-jornada-publicada" className="rounded-md border border-warning/40 bg-warning-bg px-3 py-2.5">
      <p className="text-xs font-semibold text-text">{t("A jornada de atendimento ainda não foi publicada")}</p>
      <Link
        href="/app/team?aba=atendimento"
        data-testid="ir-configurar-horarios"
        className="mt-1 inline-block text-xs font-medium text-accent underline underline-offset-2"
      >
        {t("Configurar meus horários de atendimento")}
      </Link>
    </div>
  ) : erroAoCarregar ? (
    <p data-testid="motivo-do-bloqueio" data-motivo="erro" role="alert" className="text-xs text-warning-fg">
      {t("Não consegui carregar os horários")}
    </p>
  ) : null;

  return (
    <div
      data-testid="quando-da-marcacao"
      className="flex min-w-0 flex-col gap-4 rounded-xl bg-surface-muted/60 p-4 md:self-start"
    >
      <h3 className={cn(TITULO_DO_GRUPO, "-mb-2")}>{t("Quando")}</h3>
      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className={cn(ROTULO, "mb-0")}>{t("Data")} *</span>
          <div className="flex items-center gap-0.5">
            <span className="mr-1.5 text-sm font-semibold tracking-tight first-letter:uppercase">
              {format(mes, t("MMMM 'de' yyyy"), { locale })}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 toque:size-11"
              aria-label={t("Mês anterior")}
              data-testid="mes-anterior"
              onClick={() => setMes((m) => startOfMonth(addDays(startOfMonth(m), -1)))}
            >
              <CaretLeft size={14} weight="bold" aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 toque:size-11"
              aria-label={t("Próximo mês")}
              data-testid="mes-seguinte"
              onClick={() => setMes((m) => startOfMonth(addDays(startOfMonth(m), 32)))}
            >
              <CaretRight size={14} weight="bold" aria-hidden />
            </Button>
          </div>
        </div>
        <div className="grid grid-cols-7 gap-1 text-center">
          {semanas[0]?.map((d) => (
            <span
              key={`c-${d.toISOString()}`}
              className="pb-1 text-[11px] font-medium uppercase tracking-wide text-text-subtle"
            >
              {format(d, "EEEEEE", { locale }).replace(".", "")}
            </span>
          ))}
          {semanas.flat().map((d) => {
            const chave = format(d, "yyyy-MM-dd");
            const disponivel = temHorario(d);
            const clicavel = diaClicavel(d);
            const doMes = isSameMonth(d, mes);
            const escolhido = isSameDay(d, dia) && doMes;
            return (
              <button
                key={chave}
                type="button"
                data-testid={`dia-${chave}`}
                data-disponivel={disponivel}
                disabled={!clicavel}
                aria-pressed={escolhido}
                aria-label={format(d, t("d 'de' MMMM"), { locale })}
                onClick={() => {
                  onDia(d);
                  setTexto({ valor: "", instante: null });
                  onHorario(null);
                }}
                className={cn(
                  "flex h-9 items-center justify-center rounded-md text-sm tabular-nums transition-colors duration-fast",
                  FOCO,
                  disponivel && !escolhido &&
                    "bg-accent-soft font-medium text-accent-strong hover:bg-accent hover:text-accent-foreground",
                  clicavel && !disponivel && !escolhido && "text-text hover:bg-surface",
                  escolhido && "bg-accent font-semibold text-accent-foreground shadow-sm",
                  !clicavel && !escolhido && "cursor-default text-text-subtle",
                  !doMes && "opacity-40",
                  isSameDay(d, agora) && !escolhido && "ring-1 ring-inset ring-border-strong",
                )}
              >
                {format(d, "d")}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <label htmlFor="hora-da-marcacao" className={cn(ROTULO, "mb-0")}>
            {t("Horário")} *
          </label>
          <span className="text-xs text-text-subtle first-letter:uppercase">
            {format(dia, t("EEEE, d 'de' MMM"), { locale })}
          </span>
        </div>
        <div className="relative w-36">
          <Clock
            size={16}
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-subtle"
          />
          <input
            id="hora-da-marcacao"
            data-testid="hora-da-marcacao"
            type="time"
            step={300}
            value={exibido}
            disabled={!temTipo || !fuso}
            aria-describedby={foraDaLista ? "fora-dos-horarios" : undefined}
            onChange={(e) => escolherHora(e.target.value)}
            className={cn(CAMPO, "pl-9 tabular-nums")}
          />
        </div>
        {foraDaLista ? (
          <p id="fora-dos-horarios" data-testid="fora-dos-horarios-livres" role="status" className="mt-1.5 text-xs text-warning-fg">
            {t("Fora dos horários livres")}
          </p>
        ) : null}
        <div className="mt-2 flex flex-col gap-1.5">
          {avisoDosHorarios}
          {googleCoberturaParcial ? (
            <p role="status" className="text-xs text-warning-fg">
              {t("Ocupação do Google ainda não verificada neste período.")}
            </p>
          ) : null}
          {fontesDefasadas && fontesDefasadas.length > 0 ? (
            <p data-testid="fontes-defasadas" className="text-xs text-warning-fg">
              {t("Uma agenda conectada não está atualizando. Os horários dela seguem bloqueados por precaução.")}
            </p>
          ) : null}
          {fusoSuposto && fuso ? (
            <p data-testid="fuso-suposto" className="text-[11px] text-text-subtle">
              {t("Horários no fuso")} <span className="font-mono">{fuso.replace("_", " ")}</span>.
            </p>
          ) : null}
          {temTipo && publicouHorarios && !erroAoCarregar && doDia.length === 0 ? (
            <p className="rounded-md bg-surface px-3 py-2.5 text-xs text-text-muted">
              {t("Nenhum horário livre neste dia.")}
            </p>
          ) : null}
        </div>
        <div
          data-testid="lista-de-horarios"
          className={cn(
            "grid max-h-[136px] grid-cols-4 gap-1.5 overflow-y-auto pr-0.5 sm:grid-cols-5",
            doDia.length > 0 && "mt-1.5",
          )}
        >
          {doDia.map((h) => (
            <button
              key={h.instante}
              type="button"
              data-testid={`horario-${h.rotulo}`}
              aria-pressed={horario?.instante === h.instante}
              onClick={() => {
                setTexto({ valor: h.rotulo, instante: h.instante });
                onHorario(h);
              }}
              className={cn(
                "h-9 rounded-md border text-sm tabular-nums transition-colors duration-fast toque:h-11",
                FOCO,
                horario?.instante === h.instante
                  ? "border-accent bg-accent font-semibold text-accent-foreground shadow-sm"
                  : "border-border bg-surface text-text hover:border-accent hover:bg-accent-soft",
              )}
            >
              {h.rotulo}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
```

`lib/i18n/dicionario.ts`, antes do `};` final:

```ts
  "Fora dos horários livres": { es: "Fuera de los horarios libres" },
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm vitest run tests/unit/agenda-quando-da-marcacao.test.tsx`
Expected: PASS (7 casos).

- [ ] **Step 5: O modal passa a usar o componente**

Em `components/agenda/MarcacaoSimples.tsx`:

5a. Imports: troque a l.3 por `import { format } from "date-fns";`; a l.14 por `import { dataDeParede } from "@/lib/agenda/fuso";`; a l.38 por `import { CaretRight, CheckCircle, Warning } from "@/lib/ui/icons";`; e acrescente depois de `import { NomeCompletoDoPaciente } from "./NomeCompletoDoPaciente";`:

```ts
import { QuandoDaMarcacao } from "./QuandoDaMarcacao";
```

5b. Apague: o `const [mes, setMes] = ...` e o `useEffect` de `onMesVisivel(mes)` (l.208-211); `encaixeAberto`/`horaDoEncaixe` (l.220-221); o bloco `// ── calendário ──` inteiro, de `const semanas = React.useMemo(` até `const doDia = ...` (l.301-330); `partesDaHora` e `usarHoraDoEncaixe` (l.332-348); e `const avisoDosHorarios = ...` (l.458-477). Ficam `dia`/`setDia` e `horario`/`setHorario` (l.205-207, 212).

5c. Substitua a coluna da direita inteira — do comentário `{/* ── direita: dia e horário livre ─────────────────────────────── */}` até o `</div>` que a fecha (l.809-989, logo antes do `</div>` da grade de duas colunas) — por:

```tsx
            {/* ── direita: quando (o mesmo componente do Remarcar do painel) ── */}
            <QuandoDaMarcacao
              ancora={ancora}
              agora={agora}
              fuso={fuso}
              horariosPorDia={horariosPorDia}
              publicouHorarios={publicouHorarios}
              erroAoCarregar={erroAoCarregar}
              fusoSuposto={fusoSuposto}
              fontesDefasadas={fontesDefasadas}
              googleCoberturaParcial={googleCoberturaParcial}
              onMesVisivel={onMesVisivel}
              mesCarregado={mesCarregado}
              temTipo={Boolean(tipo)}
              avisoSemTipo={t("Escolha o profissional e o procedimento para ver os horários livres.")}
              permiteEncaixe={permiteEncaixe}
              abriuComHorario={Boolean(horarioInicial)}
              dia={dia}
              onDia={setDia}
              horario={horario}
              onHorario={setHorario}
            />
```

5d. Na doc da prop (l.159): troque `/** Encaixe ("Outro horário"): só para quem é da equipe e pode marcar. */` por `/** Hora fora dos horários livres vale (encaixe): só para quem é da equipe e pode marcar. */`.

- [ ] **Step 6: Rodar os testes do modal**

Run: `pnpm vitest run tests/unit/agenda-quando-da-marcacao.test.tsx tests/unit/agenda-marcacao-simples.test.tsx tests/unit/agenda-duracao-escolhida.test.tsx tests/unit/agenda-aviso-sem-lembrete.test.tsx tests/unit/agenda-nome-completo-do-paciente.test.tsx tests/unit/agenda-local-e-observacao-na-marcacao.test.ts tests/unit/i18n-espanhol-cobre-a-tela.test.ts`
Expected: PASS.

- [ ] **Step 7: Gates e commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 pnpm typecheck && pnpm lint
git add components/agenda/QuandoDaMarcacao.tsx components/agenda/MarcacaoSimples.tsx lib/i18n/dicionario.ts tests/unit/agenda-quando-da-marcacao.test.tsx
git commit -m "feat(agenda): hora com relógio e horários livres como atalho (QuandoDaMarcacao)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Fileira de profissionais — uma pessoa por vez, só quem tem atendimento

**Files:**
- Modify: `lib/agenda/pessoas-da-grade.ts` (fim)
- Modify: `components/agenda/FiltroDePessoas.tsx` (reescrita)
- Modify: `components/agenda/GradeDaAgenda.tsx:1535-1539,2126,2136-2158` (legenda de pessoas sai)
- Modify: `app/app/agenda/_client.tsx:32,354-362,404-407,772`
- Test: `components/agenda/FiltroDePessoas.test.tsx` (reescrita), `tests/unit/agenda-clique-e-profissionais.test.tsx`
- Modify (e2e): `tests/e2e/agenda-clique-e-profissionais.spec.ts:61-170`, `tests/e2e/agenda-tela-do-produto.spec.ts:66-127,227-252`, `tests/e2e/agenda-procedimento-e-unidade-do-profissional.spec.ts:515-518`

**Interfaces:**
- Consumes: nada novo.
- Produces: `pessoasComAtendimento<P extends { id: string }>(pessoas: readonly P[], agendamentos: ReadonlyArray<{ responsavelId: string; origem: string; situacao: string }>, selecionadas: readonly string[]): P[]`. `FiltroDePessoas` mantém a assinatura (`pessoas`, `selecionadas: readonly string[]`, `onMudar: (ids: string[]) => void`) e os test ids `filtro-de-pessoas` (`data-selecionadas`), `botao-pessoa-<id>`, `botao-todos` — este agora SEMPRE aparece, com `aria-pressed`.

- [ ] **Step 1: Testes que falham**

Substitua `components/agenda/FiltroDePessoas.test.tsx` por:

```tsx
/** A fileira de profissionais (decisão 3 do André, 27/11/2026). Nomes fictícios. */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { pessoasComAtendimento } from "@/lib/agenda/pessoas-da-grade";

import { FiltroDePessoas } from "./FiltroDePessoas";
import type { Agendamento, Pessoa } from "./tipos";

afterEach(cleanup);

const ANA: Pessoa = { id: "ana", nome: "Ana Prado", trilha: 1 };
const BIA: Pessoa = { id: "bia", nome: "Bia Souza", trilha: 2 };
const CAIO: Pessoa = { id: "caio", nome: "Caio Lima", trilha: 3 };

function de(responsavelId: string, extra: Partial<Agendamento> = {}): Agendamento {
  return {
    id: `c-${responsavelId}`,
    titulo: "Consulta",
    responsavelId,
    comeca: "2026-09-16T10:00:00-03:00",
    termina: "2026-09-16T10:30:00-03:00",
    origem: "ui",
    situacao: "confirmed",
    ...extra,
  };
}

describe("quem entra na fileira", () => {
  it("só quem é dono de compromisso nosso no período, na ordem da equipe", () => {
    expect(pessoasComAtendimento([ANA, BIA, CAIO], [de("caio"), de("ana")], []).map((p) => p.id)).toEqual(["ana", "caio"]);
  });

  it("ocupação do Google e cancelado não põem ninguém na fileira", () => {
    const fora = [de("bia", { origem: "google_sync" }), de("caio", { situacao: "cancelled" })];
    expect(pessoasComAtendimento([ANA, BIA, CAIO], fora, [])).toEqual([]);
  });

  it("a escolhida continua na fileira numa semana em que não tem nada", () => {
    expect(pessoasComAtendimento([ANA, BIA], [de("ana")], ["bia"]).map((p) => p.id)).toEqual(["ana", "bia"]);
  });
});

describe("fileira de profissionais", () => {
  it("'Todos' vem primeiro e começa marcado; cada pessoa com ponto de cor e nome curto", () => {
    render(<FiltroDePessoas pessoas={[ANA, BIA]} selecionadas={[]} onMudar={vi.fn()} />);
    const botoes = within(screen.getByTestId("filtro-de-pessoas")).getAllByRole("button");
    expect(botoes[0]).toHaveTextContent("Todos");
    expect(botoes[0]).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("botao-pessoa-ana")).toHaveTextContent("Ana P.");
    expect(screen.getByTestId("botao-pessoa-ana")).toHaveAttribute("title", "Ana Prado");
    expect(screen.getByTestId("botao-pessoa-ana")).toHaveAttribute("aria-pressed", "false");
  });

  it("clicar escolhe UMA pessoa; clicar de novo, ou em Todos, volta a todos", () => {
    const onMudar = vi.fn();
    const { rerender } = render(<FiltroDePessoas pessoas={[ANA, BIA]} selecionadas={[]} onMudar={onMudar} />);
    fireEvent.click(screen.getByTestId("botao-pessoa-ana"));
    expect(onMudar).toHaveBeenLastCalledWith(["ana"]);

    rerender(<FiltroDePessoas pessoas={[ANA, BIA]} selecionadas={["ana"]} onMudar={onMudar} />);
    expect(screen.getByTestId("filtro-de-pessoas")).toHaveAttribute("data-selecionadas", "ana");
    expect(screen.getByTestId("botao-todos")).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByTestId("botao-pessoa-bia"));
    expect(onMudar).toHaveBeenLastCalledWith(["bia"]);
    fireEvent.click(screen.getByTestId("botao-pessoa-ana"));
    expect(onMudar).toHaveBeenLastCalledWith([]);
    fireEvent.click(screen.getByTestId("botao-todos"));
    expect(onMudar).toHaveBeenLastCalledWith([]);
  });

  it("ninguém com atendimento e ninguém escolhido: a fileira some", () => {
    render(<FiltroDePessoas pessoas={[]} selecionadas={[]} onMudar={vi.fn()} />);
    expect(screen.queryByTestId("filtro-de-pessoas")).toBeNull();
  });
});
```

Em `tests/unit/agenda-clique-e-profissionais.test.tsx`:

1a. Cabeçalho, item 2 (l.8-9): troque por `*   2. A fileira de profissionais (27/11/2026): só quem tem atendimento na semana, uma pessoa por vez, "Todos" zera, e a escolha volta no próximo acesso.`

1b. No primeiro `it` ("dia e meia hora do bloco…"), antes de `montar();`:

```ts
    // A fileira só mostra quem TEM atendimento na semana (27/11/2026).
    compromissos.push(compromisso("c-bia", "p-bia", "16:00"));
```

1c. No segundo `it` ("sem pessoa única no filtro…"), apague as duas linhas `fireEvent.click(avatar("p-bia"));` e `fireEvent.click(avatar("p-caio"));` — com "Todos" (padrão) não há pessoa única.

1d. Substitua o `describe("filtro de um ou vários profissionais", …)` inteiro por:

```tsx
describe("fileira: uma pessoa de cada vez (27/11/2026)", () => {
  const tres = () =>
    compromissos.push(
      compromisso("c-ana", "p-ana", "09:00"),
      compromisso("c-bia", "p-bia", "11:00"),
      compromisso("c-caio", "p-caio", "13:00"),
    );
  const visiveis = () =>
    ["c-ana", "c-bia", "c-caio"].filter((id) => screen.queryByTestId(`agendamento-${id}`));

  it("escolhe uma pessoa; clicar de novo ou em Todos volta a todos", () => {
    tres();
    montar();
    expect(visiveis()).toEqual(["c-ana", "c-bia", "c-caio"]);
    expect(screen.getByTestId("botao-todos")).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(avatar("p-ana"));
    expect(visiveis()).toEqual(["c-ana"]);
    fireEvent.click(avatar("p-caio"));
    expect(visiveis()).toEqual(["c-caio"]);
    expect(avatar("p-ana")).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(avatar("p-caio"));
    expect(visiveis()).toEqual(["c-ana", "c-bia", "c-caio"]);

    fireEvent.click(avatar("p-bia"));
    fireEvent.click(screen.getByTestId("botao-todos"));
    expect(visiveis()).toEqual(["c-ana", "c-bia", "c-caio"]);
    expect(screen.getByTestId("botao-todos")).toHaveAttribute("aria-pressed", "true");
  });

  it("só quem tem atendimento na semana entra na fileira", () => {
    compromissos.push(compromisso("c-ana", "p-ana", "09:00"));
    montar();
    expect(avatar("p-ana")).toBeInTheDocument();
    expect(screen.queryByTestId("botao-pessoa-p-bia")).toBeNull();
  });

  it("a escolha volta no próximo acesso; uma antiga de várias vale pela primeira; id invisível cai fora", () => {
    tres();
    const primeira = montar();
    fireEvent.click(avatar("p-bia"));
    expect(JSON.parse(window.localStorage.getItem(CHAVE)!)).toEqual(["p-bia"]);
    primeira.unmount();

    montar();
    expect(screen.getByTestId("filtro-de-pessoas")).toHaveAttribute("data-selecionadas", "p-bia");
    cleanup();

    // Gravada quando o filtro era múltiplo.
    window.localStorage.setItem(CHAVE, JSON.stringify(["p-caio", "p-bia"]));
    montar();
    expect(screen.getByTestId("filtro-de-pessoas")).toHaveAttribute("data-selecionadas", "p-caio");
    cleanup();

    window.localStorage.setItem(CHAVE, JSON.stringify(["p-sumiu"]));
    montar();
    expect(screen.getByTestId("filtro-de-pessoas")).toHaveAttribute("data-selecionadas", "todos");
  });

  it("armazenamento bloqueado não derruba a tela", () => {
    compromissos.push(compromisso("c-ana", "p-ana", "09:00"));
    const ler = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    const gravar = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    montar();
    fireEvent.click(avatar("p-ana"));
    expect(avatar("p-ana")).toHaveAttribute("aria-pressed", "true");
    ler.mockRestore();
    gravar.mockRestore();
  });

  it("ninguém com atendimento: a fileira some", () => {
    render(<FiltroDePessoas pessoas={[]} selecionadas={[]} onMudar={vi.fn()} />);
    expect(screen.queryByTestId("filtro-de-pessoas")).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run components/agenda/FiltroDePessoas.test.tsx tests/unit/agenda-clique-e-profissionais.test.tsx`
Expected: FAIL — `pessoasComAtendimento is not a function`; `botao-todos` sem `aria-pressed`; multisseleção mostrando `["c-ana","c-caio"]`.

- [ ] **Step 3: A regra e o componente**

No fim de `lib/agenda/pessoas-da-grade.ts`:

```ts
/**
 * Quem a fileira de profissionais mostra: quem é DONO de ao menos um
 * compromisso nosso no período carregado (decisão 3 do André, 27/11/2026) —
 * mais quem está escolhido, para a escolha nunca sumir da tela sem um jeito de
 * desfazê-la. Ocupação externa (`google_sync`, que inclui bloqueio e Clinicorp)
 * e cancelado não contam. A ordem é a da equipe: a fileira não pula de semana
 * para semana.
 */
export function pessoasComAtendimento<P extends { id: string }>(
  pessoas: readonly P[],
  agendamentos: ReadonlyArray<{ responsavelId: string; origem: string; situacao: string }>,
  selecionadas: readonly string[],
): P[] {
  const donos = new Set(
    agendamentos
      .filter((a) => a.origem !== "google_sync" && a.situacao !== "cancelled")
      .map((a) => a.responsavelId),
  );
  return pessoas.filter((p) => donos.has(p.id) || selecionadas.includes(p.id));
}
```

Substitua `components/agenda/FiltroDePessoas.tsx` por:

```tsx
"use client";

import { useT } from "@/hooks/i18n/useT";

import { cn } from "@/lib/utils";

import { corDaTrilha } from "./paleta";
import { nomeCurto } from "./rotulo-do-bloco";
import type { Pessoa } from "./tipos";

/**
 * A fileira de profissionais da Agenda (decisão 3 do André, 27/11/2026).
 *
 * "Todos" primeiro, depois um botão por pessoa — o ponto na cor dela e "Ana P.".
 * Clicar escolhe UMA: a grade mostra só a agenda dela; clicar de novo, ou em
 * "Todos", volta a mostrar todos. Era multisseleção com avatares (pedido de
 * 15/10); o André trocou por uma pessoa de cada vez, que é o uso da recepção.
 *
 * Quem entra na fileira é decidido por quem chama (`pessoasComAtendimento`):
 * só quem tem atendimento no período. O filtro é só VISTA sobre o que o
 * servidor já devolveu a quem olha — selecionar não busca nada novo.
 */
const BOTAO =
  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors duration-fast ease-out max-lg:min-h-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500";

export function FiltroDePessoas({
  pessoas,
  selecionadas,
  onMudar,
  className,
}: {
  pessoas: Pessoa[];
  /** Vazio = todos. Só a primeira conta: a escolha é de uma pessoa. */
  selecionadas: readonly string[];
  onMudar: (ids: string[]) => void;
  className?: string;
}) {
  const t = useT();
  const escolhida = selecionadas[0] ?? null;
  // Ninguém com atendimento e ninguém escolhido: não há o que filtrar.
  if (pessoas.length === 0 && escolhida === null) return null;
  const todos = escolhida === null;
  const classe = (ativo: boolean) =>
    cn(
      BOTAO,
      ativo
        ? "border-transparent bg-accent font-semibold text-accent-foreground"
        : "border-border text-text-muted hover:border-border-strong hover:text-text",
    );

  return (
    <div
      data-testid="filtro-de-pessoas"
      data-selecionadas={todos ? "todos" : escolhida}
      role="group"
      aria-label={t("Profissionais na agenda")}
      className={cn("flex flex-wrap items-center gap-1.5", className)}
    >
      <button type="button" data-testid="botao-todos" aria-pressed={todos} onClick={() => onMudar([])} className={classe(todos)}>
        {t("Todos")}
      </button>
      {pessoas.map((p) => {
        const marcada = p.id === escolhida;
        return (
          <button
            key={p.id}
            type="button"
            data-testid={`botao-pessoa-${p.id}`}
            data-trilha={p.trilha}
            aria-pressed={marcada}
            title={p.nome}
            onClick={() => onMudar(marcada ? [] : [p.id])}
            className={classe(marcada)}
          >
            <span
              aria-hidden
              className="size-2.5 shrink-0 rounded-full ring-1 ring-surface"
              style={{ backgroundColor: corDaTrilha(p.trilha) }}
            />
            <span className="max-w-[9rem] truncate">{nomeCurto(p.nome)}</span>
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: A legenda de pessoas sai do rodapé da grade**

`components/agenda/GradeDaAgenda.tsx`: apague o memo `pessoasNaGrade` e o comentário acima dele (l.1535-1539); troque `{visao !== "mes" ? <LegendaDaGrade pessoas={pessoasNaGrade} /> : null}` por `{visao !== "mes" ? <LegendaDaGrade /> : null}`; em `LegendaDaGrade`, troque a assinatura por `function LegendaDaGrade() {` e apague o bloco de pessoas (o comentário `{/* De quem é cada cor… */}`, o `{pessoas.map(...)}` e o separador `{pessoas.length > 0 ? <span aria-hidden className="h-3 w-px bg-border" /> : null}`). A legenda de estados fica.

- [ ] **Step 5: `_client.tsx` deriva a fileira**

5a. l.32: `import { gravarPessoasDaGrade, lerPessoasDaGrade, pessoasComAtendimento, selecaoValida } from "@/lib/agenda/pessoas-da-grade";`

5b. Troque o comentário das l.354-358 por:

```ts
  // AS PESSOAS SÃO REAIS: vêm de `/api/v1/agenda/pessoas`, com a trilha de cor
  // derivada do `user_id`. Servem para nome e cor; quem entra na FILEIRA de
  // profissionais é decidido abaixo (`pessoasDaFileira`).
```

5c. Troque as l.360-362 por:

```ts
  // Só vale quem o servidor devolveu a ESTA pessoa, e só UMA (decisão 3 do
  // André, 27/11/2026): uma escolha antiga de várias pessoas, guardada quando o
  // filtro era múltiplo, vale pela primeira.
  const selecionadas = React.useMemo(() => selecaoValida(pedidas, pessoas).slice(0, 1), [pedidas, pessoas]);
```

5d. Logo depois do `const todos: Agendamento[] = React.useMemo(...)` (l.404-407):

```ts
  // A FILEIRA mostra só quem tem atendimento no período carregado — e quem está
  // escolhido, para a escolha nunca sumir sem um jeito de desfazê-la.
  const pessoasDaFileira = React.useMemo(
    () => pessoasComAtendimento(pessoas, todos, selecionadas),
    [pessoas, todos, selecionadas],
  );
```

5e. l.772: `<FiltroDePessoas pessoas={pessoasDaFileira} selecionadas={selecionadas} onMudar={mudarPessoas} />`

- [ ] **Step 6: Rodar e ver passar**

Run: `pnpm vitest run components/agenda/FiltroDePessoas.test.tsx tests/unit/agenda-clique-e-profissionais.test.tsx tests/unit/agenda-situacao-e-conflito-no-bloco.test.tsx tests/unit/agenda-tipo-da-grade-sobrevive-ao-reload.test.tsx tests/unit/agenda-l1-remarcar-e-relogio.test.tsx`
Expected: PASS.

- [ ] **Step 7: As specs e2e que supunham a fileira sempre presente**

7a. `tests/e2e/agenda-clique-e-profissionais.spec.ts`: substitua o corpo do `test(...)` (l.61-170) por esta ordem — semana seguinte → marca pelo bloco vazio → a fileira aparece com a dona → isola → F5 mantém → "Todos" zera:

```ts
test("uma profissional, um clique no horário vazio, o compromisso na grade", async ({ page }) => {
  const creds = lerCreds();
  const donoId = creds.agenda!.dono_user_id ?? creds.users.agent!.id;
  // Tema escuro, como o dono da clínica usa: as fotos de evidência saem nele.
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("deskcomm-theme", "dark");
    } catch {
      // sem armazenamento, a foto sai no tema claro; a asserção não depende dele
    }
  });
  await entrar(page, creds);
  await escolherOTipoDoSeed(page, creds.agenda!.tipo_nome);

  // ── 1. a semana seguinte ────────────────────────────────────────────────
  // A fileira de profissionais mostra só quem TEM atendimento na semana (decisão
  // 3 do André, 27/11/2026). Num banco limpo ela começa vazia; quem a faz
  // aparecer é o compromisso que esta spec marca no passo 4.
  await irParaASemanaSeguinte(page);

  // ── 2. o horário vazio ──────────────────────────────────────────────────
  const bloco = page.locator('[data-testid^="bloco-"][data-encaixe="true"]').first();
  await expect(bloco, "nenhum horário vazio clicável na semana").toBeAttached({ timeout: 25_000 });
  const testid = (await bloco.getAttribute("data-testid"))!;
  const [, dia, hora] = /^bloco-(\d{4}-\d{2}-\d{2})-(\d{2}:\d{2})$/.exec(testid)!;
  const [, mes, d] = dia!.split("-");
  await expect(bloco).toHaveAttribute("aria-label", `Marcar ${d}/${mes} às ${hora}`);
  await bloco.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(EVIDENCIA, "1-horario-vazio.png") });

  // Pelo TECLADO: foco no bloco e Enter, o caminho de quem não usa mouse.
  await bloco.focus();
  await page.keyboard.press("Enter");

  // ── 3. o painel de sempre, já preenchido com a dona do tipo ─────────────
  const painel = page.getByTestId("painel-de-marcacao");
  await expect(painel).toHaveAttribute("data-tempo", "confirmando", { timeout: 15_000 });
  await expect(page.getByTestId("confirmacao")).toContainText(hora!);
  await expect(painel).toContainText("E2E Agent");
  await expect(painel.locator('[data-disponivel="true"]').first()).toBeAttached({ timeout: 15_000 });
  await page.screenshot({ path: path.join(EVIDENCIA, "2-painel-preenchido.png") });

  // ── 4. confirmar e ver na grade ─────────────────────────────────────────
  const post = page.waitForResponse(
    (r) => r.url().includes("/api/v1/agenda/agendamentos") && r.request().method() === "POST",
  );
  if (await page.getByTestId("canal-mensagem").isVisible()) await page.getByTestId("canal-mensagem").click();
  await page.getByTestId("confirmar-marcacao").click();
  const resposta = await post;
  const corpoPedido = resposta.request().postDataJSON() as Record<string, unknown>;
  const corpo = await resposta.text();
  expect(resposta.status(), corpo).toBe(201);
  expect(corpoPedido.owner_user_id).toBe(donoId);
  const id = /"id":"([0-9a-f-]{36})"/.exec(corpo)?.[1];
  expect(id, corpo).toBeTruthy();

  await page.keyboard.press("Escape");
  const cartao = page.locator(`button:has([data-testid="faixa-${id}"])`);
  await expect(cartao).toBeVisible({ timeout: 20_000 });
  await expect(cartao).toHaveAttribute("aria-label", new RegExp(`${hora} às`));
  await cartao.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(EVIDENCIA, "3-compromisso-na-grade.png") });

  // ── 5. a fileira aparece com ela, e um clique isola a agenda dela ───────
  const filtro = page.getByTestId("filtro-de-pessoas");
  await expect(filtro).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("botao-todos")).toHaveAttribute("aria-pressed", "true");
  const pedidoDela = page.waitForRequest(
    (r) => r.url().includes("/api/v1/agenda/horarios-livres") && r.url().includes(`owner_user_id=${donoId}`),
  );
  await page.getByTestId(`botao-pessoa-${donoId}`).click();
  await expect(page.getByTestId(`botao-pessoa-${donoId}`)).toHaveAttribute("aria-pressed", "true");
  await expect(filtro).toHaveAttribute("data-selecionadas", donoId);
  // A dica "Horários livres de" passou a perguntar pela agenda DELA.
  await pedidoDela;
  await page.screenshot({ path: path.join(EVIDENCIA, "4-fileira-uma-profissional.png") });

  // ── 6. a escolha sobrevive ao F5; "Todos" zera ──────────────────────────
  await page.reload();
  await esperarAgenda(page, 20_000);
  // Na semana de hoje ela pode não ter nada — e continua na fileira, escolhida,
  // senão não haveria como desfazer a escolha.
  await expect(page.getByTestId("filtro-de-pessoas")).toHaveAttribute("data-selecionadas", donoId, {
    timeout: 20_000,
  });
  await irParaASemanaSeguinte(page);
  await page.getByTestId("botao-todos").click();
  await expect(page.getByTestId("filtro-de-pessoas")).toHaveAttribute("data-selecionadas", "todos");
  await expect(page.getByTestId("botao-todos")).toHaveAttribute("aria-pressed", "true");

  // Celular: a fileira cabe sem rolagem horizontal da página.
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByTestId(`botao-pessoa-${donoId}`).click();
  const larguras = await page.evaluate(() => ({
    pagina: document.documentElement.scrollWidth,
    janela: window.innerWidth,
  }));
  expect(larguras.pagina).toBeLessThanOrEqual(larguras.janela);
  await page.screenshot({ path: path.join(EVIDENCIA, "5-celular.png") });
  await page.getByTestId("botao-todos").click();

  const apagou = await page.request.delete("/api/v1/agenda/agendamentos", {
    data: { id, reason: "limpeza da spec do clique na agenda" },
  });
  expect(apagou.ok(), `não consegui cancelar o que a spec criou (${apagou.status()})`).toBe(true);
});
```

7b. `tests/e2e/agenda-tela-do-produto.spec.ts`: apague os testes `"as pessoas da equipe são REAIS — o filtro deixou de ser invisível"` (l.66-127) e `"o filtro por pessoa ISOLA de verdade — clicando, no produto"` (l.227-252). Num banco fresco a fileira não aparece (ninguém tem atendimento), por decisão; o isolamento passa a ser provado com dado controlado em `agenda-clique-e-profissionais.spec.ts`, e a não-colisão de cores segue em `trilhasEfetivasDaEquipe` (unitário).

7c. `tests/e2e/agenda-procedimento-e-unidade-do-profissional.spec.ts:515-518`:

```ts
    // A fileira em cima diz de quem é cada cor (a legenda de pessoas do rodapé saiu em 27/11/2026).
    await expect(page.getByTestId(`botao-pessoa-${f.ana.id}`)).toBeVisible();
    await expect(page.getByTestId(`botao-pessoa-${f.bruno.id}`)).toBeVisible();
```

- [ ] **Step 8: Gates e commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 pnpm typecheck && pnpm lint
git add lib/agenda/pessoas-da-grade.ts components/agenda/FiltroDePessoas.tsx components/agenda/FiltroDePessoas.test.tsx components/agenda/GradeDaAgenda.tsx app/app/agenda/_client.tsx tests/unit/agenda-clique-e-profissionais.test.tsx tests/e2e/agenda-clique-e-profissionais.spec.ts tests/e2e/agenda-tela-do-produto.spec.ts tests/e2e/agenda-procedimento-e-unidade-do-profissional.spec.ts
git commit -m "feat(agenda): fileira de profissionais com uma pessoa por vez e só quem atende na semana

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Semana e mês de segunda a sábado; domingo só com compromisso

**Files:**
- Modify: `components/agenda/GradeDaAgenda.tsx:320-323,1298-1315,1522-1534`
- Modify: `lib/agenda/recorte-da-grade.ts:1-35`
- Modify: `lib/agenda/semana-semente.ts:29-62`, `lib/agenda/semana-semente.test.ts`
- Modify: `app/app/agenda/_client.tsx:10,561-566`
- Test: `tests/unit/agenda-semana-de-segunda-a-sabado.test.tsx` (novo), `components/agenda/GradeDaAgenda.mobile.test.tsx`, `tests/unit/agenda-mes-busca-o-que-desenha.test.ts`
- Modify (e2e): `tests/e2e/helpers/agenda-semana-integra.ts:58,94-98`, `tests/e2e/agenda-clinicorp.spec.ts:218-309,395-448`, `tests/e2e/agenda-ocupacao-do-google-na-grade.spec.ts:158,239,308`, `tests/e2e/agenda-procedimento-e-unidade-do-profissional.spec.ts:456-459`, `tests/e2e/agenda-kit-visual.spec.ts:163-174`

**Interfaces:**
- Consumes: nada novo.
- Produces: `export function diasDaSemanaDe(ancora: Date, agendamentos: ReadonlyArray<Pick<Agendamento, "comeca" | "origem" | "situacao">>, fuso: string): Date[]` (exportada de `GradeDaAgenda.tsx`). `recorteDaVisao("semana", d)` passa a ir de segunda a segunda (7 dias, exclusivo); `inicioDaGradeDoMes` passa a ser a segunda da semana do dia 1.

- [ ] **Step 1: Testes que falham**

Crie `tests/unit/agenda-semana-de-segunda-a-sabado.test.tsx`:

```tsx
/**
 * Semana e mês de segunda a sábado (decisão 4 do André, 27/11/2026): o domingo
 * volta só quando tem compromisso nosso nele — ou quando é o próprio dia aberto.
 */
import { render, screen } from "@testing-library/react";
import { format } from "date-fns";
import { describe, expect, it } from "vitest";

import { GradeDaAgenda, diasDaSemanaDe } from "@/components/agenda/GradeDaAgenda";
import type { Agendamento } from "@/components/agenda/tipos";

const SP = "America/Sao_Paulo";
const QUARTA = new Date(2026, 8, 16, 12); // quarta, 16/09/2026
const chave = (d: Date) => format(d, "yyyy-MM-dd");

function noDomingo(extra: Partial<Agendamento> = {}): Agendamento {
  return {
    id: "dom",
    titulo: "Consulta",
    responsavelId: "ana",
    comeca: "2026-09-20T10:00:00-03:00",
    termina: "2026-09-20T10:30:00-03:00",
    origem: "ui",
    situacao: "confirmed",
    ...extra,
  };
}

describe("os dias da semana desenhada", () => {
  it("segunda a sábado quando ninguém marcou no domingo", () => {
    expect(diasDaSemanaDe(QUARTA, [], SP).map(chave)).toEqual([
      "2026-09-14",
      "2026-09-15",
      "2026-09-16",
      "2026-09-17",
      "2026-09-18",
      "2026-09-19",
    ]);
  });

  it("o domingo entra no FIM quando tem compromisso nosso nele", () => {
    const dias = diasDaSemanaDe(QUARTA, [noDomingo()], SP).map(chave);
    expect(dias).toHaveLength(7);
    expect(dias.at(-1)).toBe("2026-09-20");
  });

  it("ocupação do Google e cancelado no domingo não trazem o domingo", () => {
    expect(diasDaSemanaDe(QUARTA, [noDomingo({ origem: "google_sync" })], SP)).toHaveLength(6);
    expect(diasDaSemanaDe(QUARTA, [noDomingo({ situacao: "cancelled" })], SP)).toHaveLength(6);
  });

  it("abrir num domingo mostra o domingo, mesmo vazio", () => {
    const dias = diasDaSemanaDe(new Date(2026, 8, 20, 12), [], SP).map(chave);
    expect(dias[0]).toBe("2026-09-14");
    expect(dias.at(-1)).toBe("2026-09-20");
  });
});

describe("a grade", () => {
  const grade = (visao: "semana" | "mes", agendamentos: Agendamento[]) =>
    render(
      <GradeDaAgenda
        visao={visao}
        ancora={QUARTA}
        agora={QUARTA}
        fuso={SP}
        pessoas={[{ id: "ana", nome: "Ana Prado", trilha: 1 }]}
        agendamentos={agendamentos}
      />,
    );

  it("semana sem domingo marcado: seis colunas", () => {
    grade("semana", []);
    expect(screen.getAllByTestId(/^coluna-dia-/)).toHaveLength(6);
  });

  it("mês: 6 colunas; um domingo marcado em qualquer semana devolve a 7ª ao mês inteiro", () => {
    const { unmount } = grade("mes", []);
    expect(screen.getAllByTestId(/^celula-mes-/)).toHaveLength(36);
    unmount();
    grade("mes", [noDomingo()]);
    expect(screen.getAllByTestId(/^celula-mes-/)).toHaveLength(42);
  });
});
```

Atualize `components/agenda/GradeDaAgenda.mobile.test.tsx`: no primeiro `it`, troque o título por `"mostra só o dia âncora (quarta) e esconde os outros cinco da semana"` e a lista por `["2026-09-14", "2026-09-15", "2026-09-17", "2026-09-18", "2026-09-19"]` (comentário: `// os outros cinco somem abaixo de md`); no terceiro, `expect(colunas).toHaveLength(6);` e o comentário `// As seis colunas (segunda a sábado) existem no DOM: …`.

Atualize `tests/unit/agenda-mes-busca-o-que-desenha.test.ts`:

```ts
  it("Mês: busca as mesmas 6 semanas que desenha, vizinhos inclusive", () => {
    const ancora = new Date(2026, 8, 27, 10); // domingo, 27/09/2026
    const { de, ate } = recorteDaVisao("mes", ancora);

    expect(dia(de)).toBe("2026-08-31"); // a segunda da semana do dia 1º
    expect(de).toEqual(inicioDaGradeDoMes(ancora));
    expect(dia(ate)).toBe("2026-10-12"); // exclusivo: a última célula é 11/10
    expect(dia(addDays(de, SEMANAS_DA_GRADE_DO_MES * 7 - 1))).toBe("2026-10-11");

    const primeiroDeOutubro = new Date(2026, 9, 1, 15);
    expect(primeiroDeOutubro >= de && primeiroDeOutubro < ate).toBe(true);
  });

  it("Semana vai de segunda a segunda; Dia segue como era", () => {
    const ancora = new Date(2026, 8, 30, 10); // quarta
    expect(dia(recorteDaVisao("semana", ancora).de)).toBe("2026-09-28");
    expect(dia(recorteDaVisao("semana", ancora).ate)).toBe("2026-10-05");
    expect(dia(recorteDaVisao("dia", ancora).de)).toBe("2026-09-30");
    expect(dia(recorteDaVisao("dia", ancora).ate)).toBe("2026-10-01");
  });
```

Atualize `lib/agenda/semana-semente.test.ts` (a borda agora é domingo à noite):

```ts
  it("no domingo à noite em São Paulo, é a semana do DOMINGO — mesmo com UTC já em segunda", () => {
    // 2026-09-21T00:30Z: UTC já é SEGUNDA, São Paulo ainda é domingo, 21:30.
    const { de } = semanaSemente(new Date("2026-09-21T00:30:00Z"), SP);
    expect(diaLocalISO(de, SP)).toBe("2026-09-14");
  });

  it("no fuso do SERVIDOR (UTC), o mesmo instante cai na semana seguinte — a divergência existe", () => {
    const { de } = semanaSemente(new Date("2026-09-21T00:30:00Z"), "UTC");
    expect(diaLocalISO(de, "UTC")).toBe("2026-09-21");
  });

  it("depois da meia-noite de São Paulo, as duas réguas voltam a concordar", () => {
    const instante = new Date("2026-09-21T03:30:00Z"); // 00:30 de segunda em SP
    expect(diaLocalISO(semanaSemente(instante, SP).de, SP)).toBe("2026-09-21");
    expect(diaLocalISO(semanaSemente(instante, "UTC").de, "UTC")).toBe("2026-09-21");
  });

  it("começa na segunda e termina na segunda seguinte, exclusivo", () => {
    const { de, ate } = semanaSemente(new Date("2026-09-16T15:00:00Z"), SP);
    expect(diaLocalISO(de, SP)).toBe("2026-09-14");
    expect(diaLocalISO(ate, SP)).toBe("2026-09-21");
    expect(de.getTime()).toBeLessThan(ate.getTime());
  });

  it("a semana começa à MEIA-NOITE local, não à meia-noite de UTC", () => {
    const { de } = semanaSemente(new Date("2026-09-16T15:00:00Z"), SP);
    expect(de.toISOString()).toBe("2026-09-14T03:00:00.000Z"); // 00:00 em SP (GMT-3)
  });

  it("atravessa a virada do horário de verão sem perder nem inventar hora", () => {
    // Sydney adianta o relógio às 2h de domingo 2026-10-04, o último dia da
    // semana que começa na segunda 28/09: ela tem 167 horas.
    const fuso = "Australia/Sydney";
    const { de, ate } = semanaSemente(new Date("2026-10-01T12:00:00Z"), fuso);
    expect(diaLocalISO(de, fuso)).toBe("2026-09-28");
    expect(diaLocalISO(ate, fuso)).toBe("2026-10-05");
    expect((ate.getTime() - de.getTime()) / 3_600_000).toBe(167);
  });
```

(Substitua os seis primeiros `it` do `describe("a semana que a agenda abre")`; o `describe` do "dia de hoje" fica.)

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run tests/unit/agenda-semana-de-segunda-a-sabado.test.tsx components/agenda/GradeDaAgenda.mobile.test.tsx tests/unit/agenda-mes-busca-o-que-desenha.test.ts lib/agenda/semana-semente.test.ts`
Expected: FAIL — `diasDaSemanaDe is not exported`; 7 colunas; datas de domingo.

- [ ] **Step 3: Implementar**

`components/agenda/GradeDaAgenda.tsx`, troque `diasDaSemanaDe` (l.320-323) por:

```ts
/** Algum compromisso NOSSO (não ocupação externa, não cancelado) cai neste dia da grade? */
function temCompromissoNoDia(
  agendamentos: ReadonlyArray<Pick<Agendamento, "comeca" | "origem" | "situacao">>,
  dia: Date,
  fuso: string,
): boolean {
  const chave = chaveDoDia(dia);
  return agendamentos.some(
    (a) =>
      a.origem !== "google_sync" &&
      a.situacao !== "cancelled" &&
      chaveDoDiaDoInstante(new Date(a.comeca), fuso) === chave,
  );
}

/**
 * Os dias que a semana desenha: segunda a sábado (decisão 4 do André,
 * 27/11/2026). O domingo entra no FIM só quando tem compromisso nosso nele — ou
 * quando é o próprio dia aberto: abrir a agenda num domingo mostraria uma
 * semana sem o dia de hoje e, no celular, sem coluna nenhuma.
 */
export function diasDaSemanaDe(
  ancora: Date,
  agendamentos: ReadonlyArray<Pick<Agendamento, "comeca" | "origem" | "situacao">>,
  fuso: string,
): Date[] {
  const inicio = startOfWeek(ancora, { weekStartsOn: 1 });
  const seis = Array.from({ length: 6 }, (_, i) => addDays(inicio, i));
  const domingo = addDays(inicio, 6);
  return isSameDay(domingo, ancora) || temCompromissoNoDia(agendamentos, domingo, fuso) ? [...seis, domingo] : seis;
}
```

Em `GradeDaAgenda`, apague a linha `const dias = visao === "dia" ? [ancora] : diasDaSemanaDe(ancora);` (l.1522) e acrescente logo depois do memo `cartoes` (l.1531-1534):

```ts
  const dias = visao === "dia" ? [ancora] : diasDaSemanaDe(ancora, cartoes, fuso);
```

Em `VisaoDeMes`, logo depois de `const semanas: Date[][] = ...` (l.1299-1301):

```ts
  // Segunda a sábado; a 7ª coluna (domingo) volta quando ALGUM domingo da grade
  // tem compromisso — no mês inteiro, para as colunas seguirem alinhadas.
  const comDomingo = semanas.some((s) => s[6] !== undefined && temCompromissoNoDia(agendamentos, s[6], fuso));
  const colunas = comDomingo ? 7 : 6;
  const celulas = semanas.flatMap((s) => s.slice(0, colunas));
```

e no JSX: o cabeçalho `<div className="grid grid-cols-7 border-b border-border">` vira `<div className={cn("grid border-b border-border", comDomingo ? "grid-cols-7" : "grid-cols-6")}>` com `{semanas[0]?.slice(0, colunas).map((d) => (`; o corpo `<div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-[repeat(auto-fit,minmax(0,1fr))]">` vira `<div className={cn("grid min-h-0 flex-1 grid-rows-[repeat(auto-fit,minmax(0,1fr))]", comDomingo ? "grid-cols-7" : "grid-cols-6")}>` e `{semanas.flat().map((d) => {` vira `{celulas.map((d) => {`.

`lib/agenda/recorte-da-grade.ts`: em `inicioDaGradeDoMes` e no ramo `semana` troque `weekStartsOn: 0` por `weekStartsOn: 1`, e o comentário `/** Domingo da semana do dia 1 — a primeira célula da visão Mês. */` por `/** A segunda da semana do dia 1 — a primeira célula da visão Mês (27/11/2026: semana de segunda a sábado). */`. O mês continua buscando 6 semanas inteiras (com os domingos), e a semana de segunda a segunda: o domingo do fim só aparece se tiver compromisso, mas precisa ser BUSCADO para a grade saber.

`lib/agenda/semana-semente.ts:29-62`: o comentário `/** Domingo, como a grade desenha (\`weekStartsOn: 0\`). */` vira `/** Sete dias a partir da SEGUNDA, como a grade busca (\`weekStartsOn: 1\`, 27/11/2026). */`; os campos de `SemanaSemente` dizem "segunda" em vez de "domingo"; e no corpo:

```ts
  const hoje = partesNoFuso(agora, fuso);
  const segunda = new Date(Date.UTC(hoje.ano, hoje.mes - 1, hoje.dia));
  segunda.setUTCDate(segunda.getUTCDate() - ((segunda.getUTCDay() + 6) % 7));

  const proxima = new Date(segunda);
  proxima.setUTCDate(proxima.getUTCDate() + DIAS_NA_SEMANA);
```

com o `return { de: meiaNoiteLocal(segunda), ate: meiaNoiteLocal(proxima) };`.

`app/app/agenda/_client.tsx`: tire `startOfWeek` do import da l.10; importe `diasDaSemanaDe` (`import { diasDaSemanaDe } from "@/components/agenda/GradeDaAgenda";`); e troque o ramo `semana` de `periodo` (l.564-565) por:

```ts
      : visao === "semana"
        ? (() => {
            // Os MESMOS dias que a grade desenha: segunda a sábado, domingo só
            // quando tem compromisso.
            const dias = diasDaSemanaDe(ancora, agendamentosDaGrade, fusoDaAgenda);
            const primeiro = dias[0] ?? ancora;
            const ultimo = dias[dias.length - 1] ?? ancora;
            return `${format(primeiro, t("d 'de' MMM"), { locale: localeDaData })} — ${format(ultimo, t("d 'de' MMM"), { locale: localeDaData })}`;
          })()
```

`periodo` está depois de `agendamentosDaGrade` (l.522), então a ordem já serve.

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm vitest run tests/unit/agenda-semana-de-segunda-a-sabado.test.tsx components/agenda/GradeDaAgenda.mobile.test.tsx components/agenda/GradeDaAgenda.fechamentos.test.tsx components/agenda/GradeDaAgenda.toque.test.tsx tests/unit/agenda-mes-busca-o-que-desenha.test.ts lib/agenda/semana-semente.test.ts tests/unit/agenda-mes-abre-o-dia.test.tsx tests/unit/ancora-da-agenda-e-da-organizacao.test.ts tests/unit/agenda-clique-e-profissionais.test.tsx tests/unit/agenda-l1-remarcar-e-relogio.test.tsx tests/unit/grade-da-agenda-no-fuso-da-organizacao.test.tsx`
Expected: PASS.

- [ ] **Step 5: As specs e2e que contavam sete dias ou indexavam a partir do domingo**

5a. `tests/e2e/helpers/agenda-semana-integra.ts`: troque `const DIAS_POR_SEMANA = 7;` e seu comentário por

```ts
/** A semana desenha segunda a sábado; o domingo só entra quando tem compromisso (27/11/2026). */
const DIAS_DA_SEMANA_DESENHADA = [6, 7];
```

e a asserção das l.94-98 por

```ts
  expect(
    DIAS_DA_SEMANA_DESENHADA,
    "a semana desenhada não tem seis nem sete dias — o recorte da grade mudou de forma",
  ).toContain(depois.length);
```

5b. `tests/e2e/agenda-clinicorp.spec.ts`: os dias passam a começar na segunda (`dias[0]`). Troque o comentário da l.218 por `// A grade começa na segunda: [seg, ter, qua, qui, sex, sáb] (+dom só com compromisso).` e diminua 1 de cada índice: `dias[1]`→`dias[0]` (l.223, 255, 266), `dias[2]`→`dias[1]` (l.395, 430, 438, 448), `dias[3]`→`dias[2]` (l.289, 306), `dias[4]`→`dias[3]` (l.309), `dias[5]`→`dias[4]` (l.291, 307).

5c. `tests/e2e/agenda-ocupacao-do-google-na-grade.spec.ts:158,239,308`: `dias[3]!` → `dias[2]!` (o comentário "quarta-feira da semana desenhada" volta a ser verdade).

5d. `tests/e2e/agenda-procedimento-e-unidade-do-profissional.spec.ts:456-459`:

```ts
  // A segunda da semana SEGUINTE à de hoje, no calendário de São Paulo (UTC-3):
  // é a semana que `irParaASemanaSeguinte` desenha (segunda a sábado).
  const agoraSP = new Date(Date.now() - 3 * 3_600_000);
  const segunda = Date.UTC(
    agoraSP.getUTCFullYear(),
    agoraSP.getUTCMonth(),
    agoraSP.getUTCDate() - ((agoraSP.getUTCDay() + 6) % 7) + 7,
  );
```

5e. `tests/e2e/agenda-kit-visual.spec.ts:163-174`: `// SEMANA: seis colunas, de segunda a sábado (a fixture não marca nada no domingo).` + `toHaveCount(6, …)`; e `// 6 semanas × 6 dias (sem domingo marcado) — retangular, senão as células mudam de tamanho de um mês para o outro.` + `toHaveCount(36)`.

- [ ] **Step 6: Gates e commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 pnpm typecheck && pnpm lint
git add components/agenda/GradeDaAgenda.tsx lib/agenda/recorte-da-grade.ts lib/agenda/semana-semente.ts lib/agenda/semana-semente.test.ts app/app/agenda/_client.tsx tests/unit/agenda-semana-de-segunda-a-sabado.test.tsx components/agenda/GradeDaAgenda.mobile.test.tsx tests/unit/agenda-mes-busca-o-que-desenha.test.ts tests/e2e/helpers/agenda-semana-integra.ts tests/e2e/agenda-clinicorp.spec.ts tests/e2e/agenda-ocupacao-do-google-na-grade.spec.ts tests/e2e/agenda-procedimento-e-unidade-do-profissional.spec.ts tests/e2e/agenda-kit-visual.spec.ts
git commit -m "feat(agenda): semana e mês de segunda a sábado, domingo só com compromisso

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Cartão, grade e bloqueio mais limpos

**Files:**
- Modify: `components/agenda/rotulo-do-bloco.ts:19-42`
- Modify: `components/agenda/GradeDaAgenda.tsx` — `FUNDO_DO_FECHAMENTO` (l.510), `FaixaFechada` (l.579-640), `BlocoDeAgendamento` (l.796-911), `IconeDeSituacao` (l.947), `ReguaDoAgora` (l.958-969), `ColunaDeHoras` (l.983-998), `ColunaDeDia` (l.1212-1216)
- Test: `tests/unit/agenda-bloco-diz-quem-vem.test.ts`, `components/agenda/GradeDaAgenda.fechamentos.test.tsx`, `tests/unit/agenda-cartao-e-grade-limpos.test.tsx` (novo)

**Interfaces:**
- Consumes: nada novo.
- Produces: test id `cantos-<id>` (o canto do cartão com os ícones de estado e aviso). Os ids `situacao-`, `conflito-`, `falta-nome-`, `sem-lembrete-`, `faixa-`, `fechamento-`, `regua-do-agora` continuam.

- [ ] **Step 1: Testes que falham**

Em `tests/unit/agenda-bloco-diz-quem-vem.test.ts`, troque o título `"a partir de 45 min: …"` por `"acima de 30 min: paciente em cima, hora e procedimento embaixo"` e acrescente, dentro dele:

```ts
    // 40 min já tem duas linhas (decisão 7 do André, 27/11/2026: curto é ≤ 30).
    expect(rotuloDoBloco({ ...base, duracaoMin: 40, visao: "dia" })).toEqual({
      principal: "Marina Alves",
      apoio: "09:30 · Consulta",
    });
```

Em `components/agenda/GradeDaAgenda.fechamentos.test.tsx`, dentro de `describe("a faixa fechada na semana")`:

```ts
  it("numa linha só; quem e o motivo vão para o title (decisão 7, 27/11/2026)", () => {
    grade([PARCIAL], { pessoas: [ANA, BRUNO] });
    const faixa = coluna("2026-11-03").getByTestId("fechamento-parcial");
    const rotulo = faixa.querySelector("[title]");
    expect(rotulo?.textContent).toBe("Bloqueado");
    expect(rotulo?.getAttribute("title")).toBe("Ana · Banco");
  });
```

Crie `tests/unit/agenda-cartao-e-grade-limpos.test.tsx`:

```tsx
/** O visual da grade (decisão 7 do André, 27/11/2026). Nomes fictícios. */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { GradeDaAgenda } from "@/components/agenda/GradeDaAgenda";
import type { Agendamento } from "@/components/agenda/tipos";

function grade(agendamentos: Agendamento[] = []) {
  return render(
    <GradeDaAgenda
      visao="dia"
      ancora={new Date(2026, 8, 16, 12)}
      agora={new Date("2026-09-16T06:00:00-03:00")}
      fuso="America/Sao_Paulo"
      pessoas={[{ id: "ana", nome: "Ana Prado", trilha: 1 }]}
      agendamentos={agendamentos}
    />,
  );
}

const consulta = (duracaoMin: number): Agendamento => ({
  id: "a",
  titulo: "Consulta",
  quemSeraAtendido: "Marina Alves",
  responsavelId: "ana",
  comeca: "2026-09-16T10:00:00-03:00",
  termina: new Date(Date.parse("2026-09-16T10:00:00-03:00") + duracaoMin * 60_000).toISOString(),
  origem: "ui",
  situacao: "pending",
});

describe("grade mais limpa", () => {
  it("a coluna de horas mostra só as horas cheias", () => {
    grade();
    expect(screen.getByText("09:00")).toBeInTheDocument();
    expect(screen.queryByText("09:30")).toBeNull();
  });

  it("o estado vai para o canto; o nome fica sozinho na linha 1 e a hora com o procedimento embaixo", () => {
    grade([consulta(60)]);
    expect(within(screen.getByTestId("cantos-a")).getByTestId("situacao-a")).toBeInTheDocument();
    const cartao = screen.getByTestId("agendamento-a");
    expect(cartao).toHaveTextContent("Marina Alves");
    expect(cartao).toHaveTextContent("10:00 · Consulta");
  });

  it("cartão curto (30 min) é uma linha só: hora e nome", () => {
    grade([consulta(30)]);
    expect(screen.getByTestId("agendamento-a")).toHaveTextContent("10:00 Marina Alves");
    expect(screen.getByTestId("agendamento-a")).not.toHaveTextContent("· Consulta");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run tests/unit/agenda-bloco-diz-quem-vem.test.ts components/agenda/GradeDaAgenda.fechamentos.test.tsx tests/unit/agenda-cartao-e-grade-limpos.test.tsx`
Expected: FAIL — 40 min ainda numa linha; `rotulo` nulo (sem `[title]`); "09:30" presente; `cantos-a` ausente.

- [ ] **Step 3: Implementar**

`components/agenda/rotulo-do-bloco.ts`: troque `if (duracaoMin < 45) return { principal: \`${hora} ${quem}\`, apoio: null };` por `if (duracaoMin <= 30) return { principal: \`${hora} ${quem}\`, apoio: null };`, e na doc troque a frase dos 45 min por: `Até 30 min o bloco é curto (decisão 7 do André, 27/11/2026): uma linha só, com a hora NA FRENTE do nome. Acima disso, com 56 px por hora, cabem as duas linhas.`

`components/agenda/GradeDaAgenda.tsx`:

3a. Depois de `const FUNDO_DO_FECHAMENTO = ...` (l.510):

```ts
/**
 * Na semana, o bloqueio é LISTRADO e discreto (decisão 7 do André, 27/11/2026),
 * em 45° — a ocupação do Google usa 135°, e os dois não se confundem. No mês
 * fica o fundo liso de `FUNDO_DO_FECHAMENTO`.
 */
const LISTRAS_DO_BLOQUEIO = `repeating-linear-gradient(45deg, ${FUNDO_DO_FECHAMENTO} 0 4px, var(--color-surface-muted) 4px 10px)`;
```

3b. `FaixaFechada`: apague `const alto = pixelsDe(fim - topo) >= 40;`; depois de `if (!primeiro) return null;`:

```ts
  const nomes = mostrarQuem ? quem.map((p) => p.nome).join(", ") : "";
  const detalhe = [nomes, ...motivos].filter(Boolean).join(" · ");
```

e troque o `return (...)` inteiro por:

```tsx
  return (
    <div
      data-testid={`fechamento-${primeiro.id}`}
      data-responsavel={primeiro.responsavelId}
      data-fechamentos={faixa.fechamentos.length}
      className="pointer-events-none absolute overflow-hidden rounded-md px-2 py-1"
      style={{
        top: pixelsDe(topo - janela.primeira * 60),
        height: pixelsDe(fim - topo),
        left: `calc(${(faixa.coluna / faixa.colunas) * 100}% + 2px)`,
        width: `calc(${(1 / faixa.colunas) * 100}% - 4px)`,
        background: LISTRAS_DO_BLOQUEIO,
      }}
    >
      {/* UMA LINHA SÓ (decisão 7 do André, 27/11/2026). Quem e o motivo vão para
          o `title` e para o leitor de tela. Só o rótulo recebe o ponteiro, para o
          `title` aparecer; o resto da faixa segue deixando o clique passar. */}
      <span
        title={detalhe || undefined}
        className="pointer-events-auto inline-flex min-w-0 max-w-full items-center gap-1 text-xs font-semibold leading-4 text-text-muted"
      >
        <Lock aria-hidden size={12} weight="bold" className="shrink-0" />
        <span className="truncate">{t("Bloqueado")}</span>
      </span>
      <span className="sr-only">
        {" · "}
        {rotuloDoTrecho(trecho, t)}
        {detalhe ? ` · ${detalhe}` : ""}
      </span>
    </div>
  );
```

(O teste "não intercepta o ponteiro" continua verde: a raiz segue `pointer-events-none`. "o dia todo", "Ana", "Bruno", "Banco" seguem no `textContent` pelo `sr-only`.)

3c. `BlocoDeAgendamento`:
- No `className`, troque `forma.tracejado ? "border-dashed border-text-muted" : "border-border/60",` por `forma.tracejado ? "border-dashed border-text-muted" : "border-transparent",`.
- No `style`, troque `: fundoDaTrilha(trilha, 22),` por `: fundoDaTrilha(trilha),` e apague a linha `borderColor: doGoogle || forma.tracejado ? undefined : \`color-mix(...)\`,` com o comentário acima dela (a cor do profissional fica na faixa de 3 px e no fundo claro).
- Antes do `return (`, depois de `if (baseMin <= topoMin) return null;`:

```ts
  const nosCantos = [faltaNome, conflito, Boolean(forma.icone), semLembrete].filter(Boolean).length;
```

- Troque o bloco do `{faltaNome ? (<Warning … absolute right-0.5 top-0.5 …/>) : null}` até o fim do `<span className={cn("ml-1 flex max-w-full items-start gap-0.5", faltaNome && "pr-3")}>…</span>` (l.864-906) por:

```tsx
      {/* O ESTADO E OS AVISOS NO CANTO (decisão 7 do André, 27/11/2026): a
          linha 1 é só o nome. Os nomes destes ícones estão no title e no
          aria-label do cartão. */}
      <span data-testid={`cantos-${agendamento.id}`} className="absolute right-0.5 top-0.5 flex items-center gap-0.5">
        {faltaNome ? (
          <Warning aria-hidden data-testid={`falta-nome-${agendamento.id}`} size={12} weight="fill" className="text-warning" />
        ) : null}
        {conflito ? (
          <Warning aria-hidden data-testid={`conflito-${agendamento.id}`} size={12} weight="fill" className="text-error" />
        ) : null}
        <IconeDeSituacao icone={forma.icone} id={agendamento.id} />
        {semLembrete ? (
          <BellSlash aria-hidden data-testid={`sem-lembrete-${agendamento.id}`} size={12} className="text-text-muted" />
        ) : null}
      </span>
      <span className="ml-1 flex max-w-full items-start" style={{ paddingRight: nosCantos * 14 }}>
        <span
          className={cn(
            "min-w-0 text-xs font-semibold leading-4",
            forma.tituloDeApoio ? "text-text-muted" : "text-text",
            duracao >= 90 ? "line-clamp-2 break-words" : "truncate",
            rotulo.apoio === null && "tabular-nums",
          )}
        >
          {rotulo.principal}
        </span>
      </span>
```

- Em `IconeDeSituacao`, troque `className={cn("mt-0.5 shrink-0", icone === "falta" ? "text-error" : "text-text-muted")}` por `className={cn("shrink-0", icone === "falta" ? "text-error" : "text-text-muted")}`.

3d. `ReguaDoAgora`: a `div` ganha `-translate-y-1/2` (`className="pointer-events-none absolute inset-x-0 z-10 flex -translate-y-1/2 items-center"`); a bolinha vira `<span className="-ml-1 size-2.5 shrink-0 rounded-full bg-error" />` e a linha `<span className="h-0.5 flex-1 bg-error" />` (2 px). O `top` não muda (as medidas por `style.top` seguem iguais).

3e. `ColunaDeHoras`: apague o `<span …>{hh}:30</span>` e troque o `border-border/70` da linha por `border-border/50`; atualize a doc para `As horas ao lado da grade: só as CHEIAS (decisão 7 do André, 27/11/2026). A meia hora segue marcada pela linha pontilhada dos dias.`

3f. `ColunaDeDia` (l.1212-1216): a linha da hora `border-b border-border/70` vira `border-b border-border/50`, e a da meia hora `border-t border-dashed border-border/45` vira `border-t border-dotted border-border/30`; no comentário, "tracejada" vira "pontilhada e mais clara (27/11/2026)".

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm vitest run tests/unit/agenda-bloco-diz-quem-vem.test.ts components/agenda/GradeDaAgenda.fechamentos.test.tsx tests/unit/agenda-cartao-e-grade-limpos.test.tsx tests/unit/agenda-situacao-e-conflito-no-bloco.test.tsx tests/unit/grade-da-agenda-no-fuso-da-organizacao.test.tsx tests/unit/agenda-grade-aceita-clique.test.tsx`
Expected: PASS.

- [ ] **Step 5: Gates e commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 pnpm typecheck && pnpm lint
git add components/agenda/rotulo-do-bloco.ts components/agenda/GradeDaAgenda.tsx tests/unit/agenda-bloco-diz-quem-vem.test.ts components/agenda/GradeDaAgenda.fechamentos.test.tsx tests/unit/agenda-cartao-e-grade-limpos.test.tsx
git commit -m "feat(agenda): cartão com a cor do profissional, estado no canto, grade e bloqueio mais leves

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Painel do paciente — Confirmar, Remarcar (com o mesmo "quando") e Cancelar

**Files:**
- Modify: `components/agenda/DetalheDoCompromisso.tsx` (reescrita do JSX; dados, mutações e rascunho ficam)
- Modify: `components/agenda/EntradaDaAgenda.tsx`
- Modify: `components/agenda/MarcacaoSimples.tsx:57-63` (doc)
- Modify: `app/app/agenda/_client.tsx` — imports (l.22,28,34,38,45-49), estado (l.209-229,239), remarcação (l.412-425,464-469,482-497), `aoMudarAbertura` (l.576-585), `EntradaDaAgenda` (l.635), `Dialog` (l.815), Sheet de remarcar (l.905-1087), `AgendaInterativa` (l.1270-1280), `HistoricoDaAgenda` (l.1306-1309)
- Modify: `lib/i18n/dicionario.ts`
- Delete: `tests/unit/agenda-confirmar-alcancavel.test.ts` (media as classes do Sheet de remarcar, que deixa de existir)
- Test: `tests/unit/agenda-painel-do-paciente.test.tsx` (novo); ajustes em `tests/unit/agenda-presenca-draft.test.tsx`, `tests/unit/agenda-excluir-compromisso-dialogo.test.tsx`, `tests/unit/agenda-anotacao-interna-chega-a-tela.test.tsx`, `tests/unit/agenda-nome-completo-do-paciente.test.tsx`, `tests/unit/agenda-local-e-observacao-na-marcacao.test.ts`, `tests/unit/agenda-l1-remarcar-e-relogio.test.tsx`
- Modify (e2e): `tests/e2e/agenda-presenca-recuperacao.spec.ts:161-166,339,347,1172`, `tests/e2e/agenda-google-meet.spec.ts:214-220`, `tests/e2e/agenda-google-sync.spec.ts:192-197`, `tests/e2e/agenda-excluir-lancado-por-engano.spec.ts:107-108`

**Interfaces:**
- Consumes: `QuandoDaMarcacao`, `QuandoDaMarcacaoProps` (Tarefa 2); `useRemarcarAgendamento` (`hooks/agenda/useRemarcarAgendamento.ts`, entrada `{ id; revision?; starts_at?; guest_email?; duration_minutes? }`).
- Produces:

```ts
// components/agenda/DetalheDoCompromisso.tsx
export type RemarcacaoDoPainel = {
  aberta: boolean;
  onAbrir: (comecaEm: string) => void;
  onFechar: () => void;
  quando: Omit<QuandoDaMarcacaoProps, "dia" | "onDia" | "horario" | "onHorario">;
};
// novas props de DetalheDoCompromisso e EntradaDaAgenda:
profissional?: string;
remarcacao?: RemarcacaoDoPainel;
```
Test ids do painel: `painel-do-compromisso`, `estado-do-compromisso`, `compromisso-procedimento`, `compromisso-horario`, `compromisso-local`, `acao-confirmar`, `acao-remarcar`, `acao-cancelar`, `confirmar-remarcacao`, `motivo-do-cancelamento`, `confirmar-cancelamento`, `presenca-do-compromisso`, `mais-detalhes-do-compromisso`, `abrir-mais-detalhes`. Ficam: `compromisso-observacao`, `compromisso-anotacao`, `compromisso-canal`, `compromisso-quem-converteu`, `compromisso-excluido`, `falta-nome-completo`, `excluir-compromisso`.

- [ ] **Step 1: Testes do painel que falham**

Crie `tests/unit/agenda-painel-do-paciente.test.tsx`:

```tsx
/**
 * O painel do paciente (decisão 6 do André, 27/11/2026): a cara da janela de
 * marcação, três botões grandes, Compareceu/Faltou depois do horário e "Mais
 * detalhes" fechado. Remarcar usa o MESMO "quando" da marcação e manda
 * `starts_at` pela rota de sempre. Nomes fictícios.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DetalheDoCompromisso, type RemarcacaoDoPainel } from "@/components/agenda/DetalheDoCompromisso";
import type { HorarioLivre } from "@/components/agenda/tipos";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), delete: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children, "data-testid": id }: { children: React.ReactNode; "data-testid"?: string }) => (
    <div role="dialog" data-testid={id}>
      {children}
    </div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}));

const ID = "11111111-0000-4000-8000-0000000000aa";
const H14: HorarioLivre = { instante: "2030-03-06T17:00:00.000Z", rotulo: "14:00" };
const BASE = {
  id: ID,
  title: "Aplicação de vitamina D",
  notes: "Trazer os exames",
  description: null,
  location_kind: "in_person",
  location_details: "Sala 2",
  starts_at: "2030-03-06T13:00:00Z",
  ends_at: "2030-03-06T13:30:00Z",
  time_zone: "America/Sao_Paulo",
  status: "confirmed",
  revision: 1,
  excluded_at: null,
  exclusion_reason: null,
  booking_channel: "mensagem",
  created_by_kind: "user",
  converted_by_kind: null,
  converted_by_user_id: null,
  contact_id: "c-1",
  contato: { name: "Carla Fictícia Souza", display_name: null },
  conversation_id: "conv-1",
  outcome_source_kind: null,
  outcome_recorded_at: null,
  recovery: null,
  evidence_messages: [],
};

let client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(() => {
  cleanup();
  client.clear();
});

function detalhe(dados: Record<string, unknown>) {
  api.get.mockImplementation((url: string) =>
    Promise.resolve(url.includes("/pessoas") ? { data: [] } : { data: dados }),
  );
}

function Painel({ onAbrir = vi.fn(), onFechar = vi.fn() }: { onAbrir?: (c: string) => void; onFechar?: () => void }) {
  const [aberta, setAberta] = useState(false);
  const remarcacao: RemarcacaoDoPainel = {
    aberta,
    onAbrir: (c) => {
      onAbrir(c);
      setAberta(true);
    },
    onFechar: () => {
      onFechar();
      setAberta(false);
    },
    quando: {
      ancora: new Date(2030, 2, 6, 12),
      agora: new Date(2030, 2, 1, 9),
      fuso: "America/Sao_Paulo",
      horariosPorDia: { "2030-03-06": [H14] },
      publicouHorarios: true,
      erroAoCarregar: false,
      fusoSuposto: false,
      onMesVisivel: () => {},
      mesCarregado: new Date(2030, 2, 1),
      temTipo: true,
      avisoSemTipo: "Carregando…",
      permiteEncaixe: true,
      abriuComHorario: false,
    },
  };
  return (
    <DetalheDoCompromisso id={ID} onClose={() => {}} profissional="Dra. Ana Teste" remarcacao={remarcacao} podeExcluir />
  );
}

function abrir(ui: React.ReactNode = <Painel />) {
  render(
    <IdiomaProvider locale="pt-BR">
      <QueryClientProvider client={client}>{ui}</QueryClientProvider>
    </IdiomaProvider>,
  );
}

describe("painel do paciente", () => {
  it("cabeçalho: iniciais, nome do paciente, estado; embaixo procedimento, hora, profissional e local", async () => {
    detalhe(BASE);
    abrir();
    expect(await screen.findByRole("heading", { name: "Carla Fictícia Souza" })).toBeInTheDocument();
    expect(screen.getByText("CS")).toBeInTheDocument();
    expect(screen.getByTestId("estado-do-compromisso")).toHaveTextContent("Agendado");
    expect(screen.getByTestId("compromisso-procedimento")).toHaveTextContent("Aplicação de vitamina D");
    expect(screen.getByText("Dra. Ana Teste")).toBeInTheDocument();
    expect(screen.getByTestId("compromisso-local")).toHaveTextContent("Sala 2");
  });

  it("Confirmar só quando aguarda confirmação, e manda status confirmed com a revision", async () => {
    detalhe({ ...BASE, status: "pending" });
    api.patch.mockResolvedValue({ data: { id: ID } });
    abrir();
    fireEvent.click(await screen.findByTestId("acao-confirmar"));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/api/v1/agenda/agendamentos", { id: ID, revision: 1, status: "confirmed" }),
    );
  });

  it("já agendado: sem Confirmar, com Remarcar e Cancelar", async () => {
    detalhe(BASE);
    abrir();
    await screen.findByTestId("acao-remarcar");
    expect(screen.queryByTestId("acao-confirmar")).toBeNull();
    expect(screen.getByTestId("acao-cancelar")).toBeInTheDocument();
  });

  it("Remarcar abre o 'quando' no painel e manda starts_at pela rota de sempre", async () => {
    detalhe(BASE);
    api.patch.mockResolvedValue({ data: { id: ID } });
    const onAbrir = vi.fn();
    const onFechar = vi.fn();
    abrir(<Painel onAbrir={onAbrir} onFechar={onFechar} />);
    fireEvent.click(await screen.findByTestId("acao-remarcar"));
    expect(onAbrir).toHaveBeenCalledWith(BASE.starts_at);
    const quando = await screen.findByTestId("quando-da-marcacao");
    expect(screen.getByTestId("confirmar-remarcacao")).toBeDisabled();
    fireEvent.click(within(quando).getByTestId("horario-14:00"));
    expect(within(quando).getByTestId("hora-da-marcacao")).toHaveValue("14:00");
    fireEvent.click(screen.getByTestId("confirmar-remarcacao"));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/api/v1/agenda/agendamentos", {
        id: ID,
        revision: 1,
        starts_at: H14.instante,
      }),
    );
    await waitFor(() => expect(onFechar).toHaveBeenCalled());
  });

  it("Cancelar abre o motivo; o botão só libera com 3 letras e chama a rota atual", async () => {
    detalhe(BASE);
    api.delete.mockResolvedValue({});
    abrir();
    fireEvent.click(await screen.findByTestId("acao-cancelar"));
    const confirmar = screen.getByTestId("confirmar-cancelamento");
    fireEvent.change(screen.getByLabelText("Motivo do cancelamento"), { target: { value: "ok" } });
    expect(confirmar).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Motivo do cancelamento"), { target: { value: "Pediu outro dia" } });
    fireEvent.click(confirmar);
    await waitFor(() =>
      expect(api.delete).toHaveBeenCalledWith("/api/v1/agenda/agendamentos", {
        id: ID,
        revision: 1,
        reason: "Pediu outro dia",
      }),
    );
  });

  it("Compareceu/Faltou só depois do início, e nunca em compromisso pessoal", async () => {
    detalhe(BASE);
    abrir();
    await screen.findByTestId("acao-cancelar");
    expect(screen.queryByRole("button", { name: "Compareceu" })).toBeNull();
    // O cache do detalhe sobreviveria ao `cleanup` e mostraria o compromisso anterior.
    cleanup();
    client.clear();

    detalhe({ ...BASE, starts_at: "2020-01-01T12:00:00Z", ends_at: "2020-01-01T12:30:00Z" });
    abrir();
    expect(await screen.findByRole("button", { name: "Compareceu" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Faltou" })).toBeInTheDocument();
    cleanup();
    client.clear();

    detalhe({ ...BASE, starts_at: "2020-01-01T12:00:00Z", ends_at: "2020-01-01T12:30:00Z", contact_id: null, contato: null });
    abrir();
    await screen.findByTestId("acao-cancelar");
    expect(screen.queryByRole("button", { name: "Compareceu" })).toBeNull();
  });

  it("'Mais detalhes' começa fechado e guarda contato, conversa, anotação e excluir", async () => {
    detalhe(BASE);
    abrir();
    const mais = (await screen.findByTestId("mais-detalhes-do-compromisso")) as HTMLDetailsElement;
    expect(mais.open).toBe(false);
    expect(within(mais).getByText("Ver contato").closest("a")).toHaveAttribute("href", "/app/contacts/c-1");
    expect(within(mais).getByText("Ver conversa").closest("a")).toHaveAttribute("href", "/app/inbox?id=conv-1");
    expect(within(mais).getByTestId("compromisso-anotacao")).toHaveTextContent("Trazer os exames");
    expect(within(mais).getByTestId("excluir-compromisso")).toBeInTheDocument();
  });

  it("compromisso cancelado não oferece ação nenhuma", async () => {
    detalhe({ ...BASE, status: "cancelled" });
    abrir();
    expect(await screen.findByTestId("estado-do-compromisso")).toHaveTextContent("Cancelado");
    expect(screen.queryByTestId("acao-remarcar")).toBeNull();
    expect(screen.queryByTestId("acao-cancelar")).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run tests/unit/agenda-painel-do-paciente.test.tsx`
Expected: FAIL — `RemarcacaoDoPainel` não exportado / `acao-remarcar` inexistente.

- [ ] **Step 3: Reescrever o painel**

Em `components/agenda/DetalheDoCompromisso.tsx`:

3a. Imports (l.1-25) passam a ser:

```tsx
"use client";
import { MeetDoCompromisso, type MeetingDetail } from "./MeetDoCompromisso";
import { SincronizacaoDoCompromisso, type SyncDetail } from "./SincronizacaoDoCompromisso";
import { Fragment, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { usePessoasDaAgenda } from "@/hooks/agenda/usePessoasDaAgenda";
import { useRemarcarAgendamento } from "@/hooks/agenda/useRemarcarAgendamento";
import Link from "next/link";
import { toast } from "sonner";
import { apiClient } from "@/lib/api/client";
import { useUpdateContact } from "@/hooks/contacts/useUpdateContact";
import {
  ehNomeCompleto,
  faltaNomeCompleto,
  nomeCompletoLimpo,
  nomeDoContato,
  sugestaoDeNomeCompleto,
} from "@/lib/contacts/rotulo-do-contato";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { ApiError } from "@/lib/api/types";
import { rotuloDoLocal } from "@/lib/agenda/locais";
import { CaretRight } from "@/lib/ui/icons";
import { CAMPO } from "./CampoDaMarcacao";
import { ExcluirCompromisso } from "./ExcluirCompromisso";
import { NomeCompletoDoPaciente } from "./NomeCompletoDoPaciente";
import { iniciaisDe } from "./paleta";
import { QuandoDaMarcacao, type QuandoDaMarcacaoProps } from "./QuandoDaMarcacao";
import type { HorarioLivre } from "./tipos";
```

3b. Depois de `RESULTS_POS_CONSULTA` (l.83-87):

```tsx
/**
 * O REMARCAR DENTRO DO PAINEL (decisão 6 do André, 27/11/2026). Quem manda é
 * `_client.tsx`: ele sabe de que procedimento e de quem são os horários (a rota
 * de detalhe não devolve nenhum dos dois) e liga a consulta enquanto `aberta`.
 */
export type RemarcacaoDoPainel = {
  aberta: boolean;
  /** `comecaEm`: com o compromisso fora da semana carregada, a grade vai até ele. */
  onAbrir: (comecaEm: string) => void;
  onFechar: () => void;
  quando: Omit<QuandoDaMarcacaoProps, "dia" | "onDia" | "horario" | "onHorario">;
};

/**
 * A etiqueta do cabeçalho. `confirmed` é o estado de quem foi marcado sem pedir
 * aprovação (`requires_confirmation` falso, o padrão) — por isso "Agendado", e
 * não "Confirmado": "Confirmar" só existe para o pedido `pending`.
 */
const ESTADO: Record<string, { rotulo: string; variante: "default" | "neutral" | "success" | "warning" | "error" }> = {
  pending: { rotulo: "Aguardando confirmação", variante: "warning" },
  confirmed: { rotulo: "Agendado", variante: "default" },
  completed: { rotulo: "Realizado", variante: "success" },
  no_show: { rotulo: "Faltou", variante: "error" },
  cancelled: { rotulo: "Cancelado", variante: "neutral" },
};
```

3c. Assinatura: acrescente `profissional,` e `remarcacao,` à desestruturação e ao tipo das props:

```ts
  /** Quem atende, como a GRADE o conhece (a rota de detalhe não devolve o dono). */
  profissional?: string;
  /** Ausente: o painel não oferece Remarcar (quem só lê, ou a vitrine). */
  remarcacao?: RemarcacaoDoPainel;
```

3d. Estado e funções novas, depois de `const [nomeEditado, setNomeEditado] = useState<string | null>(null);`:

```ts
  const remarcar = useRemarcarAgendamento();
  const [cancelando, setCancelando] = useState(false);
  const [diaNovo, setDiaNovo] = useState<Date | null>(null);
  const [horarioNovo, setHorarioNovo] = useState<HorarioLivre | null>(null);
```

e, depois de `function decide(...)`:

```ts
  function fecharRemarcacao() {
    setDiaNovo(null);
    setHorarioNovo(null);
    remarcacao?.onFechar();
  }
  function confirmarRemarcacao() {
    if (!a || !horarioNovo) return;
    // A MESMA chamada do Remarcar de antes (o `PainelDeMarcacao` montado em
    // `_client.tsx` até 27/11/2026): `PATCH /api/v1/agenda/agendamentos` com
    // `starts_at` e a `revision`. Lembrete, Google e a automação de remarcação
    // são do servidor (`alterarAgendamentoHandler`). Sem `guest_email`: ausente,
    // o convidado do Google fica como estava.
    remarcar.mutate(
      { id: a.id, revision: a.revision, starts_at: horarioNovo.instante },
      { onSuccess: fecharRemarcacao },
    );
  }
  const paciente = a?.contato ? nomeDoContato(a.contato) : null;
  const nome = paciente ?? a?.title ?? t("Compromisso");
  const estado = a ? ESTADO[a.status] : undefined;
  const local = a ? rotuloDoLocal(a.location_kind, a.location_details) : null;
  const linha =
    a && formatoDeData
      ? [
          paciente ? (
            <span key="procedimento" data-testid="compromisso-procedimento">
              {a.title}
            </span>
          ) : null,
          <span key="horario" data-testid="compromisso-horario">
            {formatoDeData.formatRange(new Date(a.starts_at), new Date(a.ends_at))}
          </span>,
          profissional ? <span key="profissional">{profissional}</span> : null,
          local ? (
            <span key="local" data-testid="compromisso-local">
              {local}
            </span>
          ) : null,
        ].filter(Boolean)
      : [];
```

3e. Substitua todo o `return (<Sheet …>…</Sheet>);` por:

```tsx
  return (
    <Dialog
      open={!!id}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        data-testid="painel-do-compromisso"
        className="flex max-w-xl flex-col gap-0 overflow-hidden bg-surface p-0"
      >
        {/* A CARA DA JANELA DE MARCAÇÃO (decisão 6 do André, 27/11/2026):
            cabeçalho com quem vem, três botões grandes, e o resto embaixo — uma
            coluna só, navegação em cima e conteúdo embaixo. */}
        <DialogHeader className="border-b border-border px-5 pb-4 pt-5 text-left">
          <div className="flex items-start gap-3 pr-8">
            <span
              aria-hidden
              className="flex size-10 shrink-0 items-center justify-center rounded-full bg-surface-muted text-sm font-semibold text-text"
            >
              {iniciaisDe(nome)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <DialogTitle className="min-w-0 truncate text-lg">{nome}</DialogTitle>
                {estado ? (
                  <Badge data-testid="estado-do-compromisso" variant={estado.variante}>
                    {t(estado.rotulo)}
                  </Badge>
                ) : null}
              </div>
              <DialogDescription className="mt-1 text-sm text-text-muted">
                {linha.length > 0
                  ? linha.map((item, i) => (
                      <Fragment key={i}>
                        {i > 0 ? " · " : null}
                        {item}
                      </Fragment>
                    ))
                  : t("Carregando…")}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {query.isPending ? (
            <p>{t("Carregando…")}</p>
          ) : query.isError ? (
            <div role="alert">
              <p>{t("Este compromisso está indisponível para você.")}</p>
              <Button onClick={() => void query.refetch()}>{t("Tentar novamente")}</Button>
            </div>
          ) : a && formatoDeData ? (
            <>
              {/* MOVER AQUI, inteiros e com a condição deles: o `{faltaNome ? (<div data-testid="falta-nome-completo" …>…</div>) : null}`
                  de hoje (l.276-312), o `{a.excluded_at ? (<div role="status" data-testid="compromisso-excluido">…</div>) : null}`
                  (l.232-237) e o `{staleDraft ? (<div role="alert" …>…</div>) : null}` (l.373-384). */}

              {podeEditar && a.status !== "cancelled" && !a.excluded_at ? (
                <div className="flex flex-wrap gap-2" data-testid="acoes-do-compromisso">
                  {a.status === "pending" ? (
                    <Button
                      data-testid="acao-confirmar"
                      className="h-12 min-w-[8rem] flex-1"
                      disabled={mutation.isPending || staleDraft}
                      onClick={() => decide({ status: "confirmed" })}
                    >
                      {t("Confirmar")}
                    </Button>
                  ) : null}
                  {remarcacao && (a.status === "pending" || a.status === "confirmed") ? (
                    <Button
                      data-testid="acao-remarcar"
                      variant="outline"
                      className="h-12 min-w-[8rem] flex-1"
                      aria-expanded={remarcacao.aberta}
                      disabled={staleDraft}
                      onClick={() => {
                        setCancelando(false);
                        remarcacao.onAbrir(a.starts_at);
                      }}
                    >
                      {t("Remarcar")}
                    </Button>
                  ) : null}
                  <Button
                    data-testid="acao-cancelar"
                    variant="outline"
                    className="h-12 min-w-[8rem] flex-1"
                    aria-expanded={cancelando}
                    onClick={() => {
                      if (remarcacao?.aberta) fecharRemarcacao();
                      setCancelando(true);
                    }}
                  >
                    {t("Cancelar")}
                  </Button>
                </div>
              ) : null}

              {podeEditar && remarcacao?.aberta && a.status !== "cancelled" && !a.excluded_at ? (
                <section data-testid="remarcar-no-painel" className="space-y-3">
                  <p className="text-sm text-text-muted">{t("Escolha o novo dia e o horário.")}</p>
                  <QuandoDaMarcacao
                    {...remarcacao.quando}
                    dia={diaNovo ?? remarcacao.quando.ancora}
                    onDia={setDiaNovo}
                    horario={horarioNovo}
                    onHorario={setHorarioNovo}
                  />
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={fecharRemarcacao}>
                      {t("Voltar")}
                    </Button>
                    <Button
                      size="sm"
                      data-testid="confirmar-remarcacao"
                      disabled={!horarioNovo || remarcar.isPending}
                      onClick={confirmarRemarcacao}
                    >
                      {remarcar.isPending ? t("Remarcando…") : t("Confirmar remarcação")}
                    </Button>
                  </div>
                </section>
              ) : null}

              {podeEditar && cancelando && a.status !== "cancelled" && !a.excluded_at ? (
                <section data-testid="cancelar-no-painel" className="space-y-3">
                  <label className="block text-sm font-medium text-text" htmlFor="motivo-do-cancelamento">
                    {t("Motivo do cancelamento")}
                  </label>
                  <input
                    id="motivo-do-cancelamento"
                    data-testid="motivo-do-cancelamento"
                    className={CAMPO}
                    value={reason}
                    onChange={(e) => {
                      beginDraft();
                      setReason(e.target.value);
                    }}
                  />
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setCancelando(false)}>
                      {t("Voltar")}
                    </Button>
                    <Button
                      size="sm"
                      data-testid="confirmar-cancelamento"
                      // O mínimo de 3 é o da rota (`DELETE /agenda/agendamentos`).
                      disabled={reason.trim().length < MINIMO_DO_MOTIVO || cancel.isPending || staleDraft}
                      onClick={() => cancel.mutate({ revision: draftRevision ?? a.revision, reason: reason.trim() })}
                    >
                      {cancel.isPending ? t("Cancelando…") : t("Cancelar agendamento")}
                    </Button>
                  </div>
                </section>
              ) : null}

              {/* DEPOIS DO HORÁRIO DE INÍCIO, e só com paciente: compromisso
                  pessoal não tem presença a registrar. */}
              {podeEditar && a.status !== "cancelled" && !a.excluded_at && a.contact_id &&
              Date.parse(a.starts_at) <= query.dataUpdatedAt ? (
                <div data-testid="presenca-do-compromisso" className="space-y-3 rounded-lg border border-border p-3">
                  <label className="block">
                    {t("Mensagem do cliente usada como evidência (opcional)")}
                    <select
                      className="mt-2 w-full rounded-md border bg-surface p-2"
                      aria-label={t("Mensagem de evidência")}
                      value={evidence}
                      onChange={(e) => {
                        beginDraft();
                        setEvidence(e.target.value);
                      }}
                    >
                      <option value="">{t("Confirmação da equipe, sem mensagem")}</option>
                      {a.evidence_messages.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.body?.slice(0, 140) ?? t("Mensagem sem texto")}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="text-sm text-text-muted">
                    {t("Ao confirmar, você valida o significado da mensagem para este compromisso.")}
                  </p>
                  {a.outcome_recorded_at ? null : (
                    <p className="text-sm text-text-muted">
                      {t("O horário sozinho não confirma falta. A equipe precisa registrar o que aconteceu.")}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {(
                      [
                        ["completed", "Compareceu"],
                        ["no_show", "Faltou"],
                      ] as const
                    ).map(([status, label]) => (
                      <Button
                        key={status}
                        onClick={() =>
                          decide({
                            status,
                            ...(evidence ? { outcome_message_id: evidence } : {}),
                          })
                        }
                        disabled={mutation.isPending || staleDraft || a.status === status}
                      >
                        {t(label)}
                      </Button>
                    ))}
                  </div>
                </div>
              ) : null}
              {a.outcome_recorded_at ? (
                <p>
                  {t("Presença registrada pela equipe")}: {formatoDeData.format(new Date(a.outcome_recorded_at))}
                </p>
              ) : null}
              {/* MOVER AQUI, inteiro: o bloco de recuperação de hoje, `{a.recovery ? (…) : a.status === "no_show" && … ? (…) : null}` (l.332-372). */}

              <details data-testid="mais-detalhes-do-compromisso" className="group rounded-lg border border-border">
                <summary
                  data-testid="abrir-mais-detalhes"
                  className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2.5 text-sm font-medium text-text [&::-webkit-details-marker]:hidden"
                >
                  <CaretRight
                    size={14}
                    weight="bold"
                    aria-hidden
                    className="transition-transform duration-fast ease-out group-open:rotate-90"
                  />
                  {t("Mais detalhes")}
                </summary>
                <div className="space-y-4 border-t border-border px-3 py-3">
                  {a.contact_id ? (
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                      <Link href={`/app/contacts/${a.contact_id}`} className="underline">
                        {t("Ver contato")}
                      </Link>
                      {a.conversation_id ? (
                        <Link href={`/app/inbox?id=${a.conversation_id}`} className="underline">
                          {t("Ver conversa")}
                        </Link>
                      ) : null}
                    </div>
                  ) : (
                    <p className="text-sm text-text-muted">{t("Compromisso pessoal, sem cliente vinculado.")}</p>
                  )}
                  {/* MOVER AQUI, inteiros e com a condição deles: a observação `data-testid="compromisso-observacao"`
                      (l.220-224), a anotação `data-testid="compromisso-anotacao"` (l.226-231), o "Marcada por"
                      `data-testid="compromisso-canal"` (l.251-267) e "Quem converteu"
                      `data-testid="compromisso-quem-converteu"` (l.268-275). */}
                  {a.google_sync ? (
                    <SincronizacaoDoCompromisso
                      key={a.id}
                      id={a.id}
                      sync={a.google_sync}
                      onSaved={() => void query.refetch()}
                    />
                  ) : null}
                  {a.meeting ? (
                    <MeetDoCompromisso
                      id={a.id}
                      revision={a.google_sync?.revision ?? String(a.revision)}
                      meeting={a.meeting}
                      onSaved={() => void query.refetch()}
                    />
                  ) : null}
                  {podeEditar && ["pending", "confirmed"].includes(a.status) && !a.excluded_at ? (
                    <Button
                      variant="outline"
                      disabled={mutation.isPending || staleDraft}
                      onClick={() =>
                        decide({
                          confirmation_next_at: new Date(Date.now() + 60 * 60_000).toISOString(),
                        })
                      }
                    >
                      {t("Lembrar em uma hora")}
                    </Button>
                  ) : null}
                  {podeExcluir && !a.excluded_at ? <ExcluirCompromisso id={a.id} onExcluido={onClose} /> : null}
                </div>
              </details>
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
```

Os comentários `{/* MOVER AQUI … */}` acima apontam blocos JSX que já existem no arquivo e são **movidos inteiros**, com as mesmas classes, condições e test ids — copie-os de onde estão (linhas do arquivo antes desta tarefa) para o lugar do comentário e apague o comentário. O que não aparece no JSX novo (o `<p data-testid="compromisso-horario">`, o `compromisso-local` solto, a etiqueta de estado em texto, o link "Ver contato" do corpo, o bloco de evidência e cancelamento antigo e o `Confirmar horário`) sai: o cabeçalho, os três botões, o bloco de presença e o "Mais detalhes" o substituem.

3f. `lib/i18n/dicionario.ts`, antes do `};` final:

```ts
  "Agendado": { es: "Agendada" },
  "Mais detalhes": { es: "Más detalles" },
  "Escolha o novo dia e o horário.": { es: "Elija el nuevo día y el horario." },
  "Confirmar remarcação": { es: "Confirmar reprogramación" },
  "Remarcando…": { es: "Reprogramando…" },
```

- [ ] **Step 4: `EntradaDaAgenda` repassa as props**

`components/agenda/EntradaDaAgenda.tsx`: o import vira `import { DetalheDoCompromisso, type RemarcacaoDoPainel } from "./DetalheDoCompromisso";`; a assinatura:

```tsx
export function EntradaDaAgenda({
  onContext,
  profissional,
  remarcacao,
}: {
  onContext: (contact: string, conversation: string) => void;
  /** Quem atende, como a grade o conhece. */
  profissional?: string;
  /** O Remarcar do painel; ausente para quem não pode marcar. */
  remarcacao?: RemarcacaoDoPainel;
}) {
```

e o `<DetalheDoCompromisso …>` ganha `profissional={profissional}` e `remarcacao={remarcacao}`.

- [ ] **Step 5: `_client.tsx` — remarcar no painel, Sheet de remarcar fora**

5a. Imports: apague `rotuloDoLocal` (l.22), `resolverResponsavelDoPainel` (l.28), `PainelDeMarcacao` (l.34) e `quandoCurto` (l.38); o bloco das l.45-49 vira

```ts
import { useCancelarAgendamento, useRegistrarDesfecho } from "@/hooks/agenda/useRemarcarAgendamento";
```

5b. Estado: troque o comentário de `remarcandoId` (l.209-212) por

```ts
  // REMARCAR acontece no PAINEL DO PACIENTE (`DetalheDoCompromisso`, decisão 6
  // do André, 27/11/2026), com o mesmo "quando" da marcação. Este id diz qual
  // compromisso pediu a remarcação; ela só vale enquanto o painel aberto
  // (`?compromisso=`) é o dele.
```

apague `emailConvidado`/`setEmailConvidado`, `emailConvidadoLimpo`, `emailConvidadoInvalido` e os comentários deles (l.218-229), e a linha `const remarcar = useRemarcarAgendamento();` (l.239).

5c. Depois de `escolherTipo` (l.281-291):

```ts
  // O PAINEL ABERTO — o mesmo `?compromisso=` que a Central, o Radar e o Inbox linkam.
  const idAberto = busca.get("compromisso");
  /**
   * Abre o painel de um compromisso, já no Remarcar quando pedido. `push`, e não
   * `replace`: é o voltar do celular que fecha o painel. O `?tipo=` vai junto,
   * senão o F5 depois de fechar voltava ao primeiro tipo (#1657).
   */
  const abrirCompromisso = React.useCallback(
    (id: string, remarcando = false) => {
      setRemarcandoId(remarcando ? id : null);
      const parametros = new URLSearchParams();
      if (tipo) parametros.set("tipo", tipo.id);
      parametros.set("compromisso", id);
      router.push(`/app/agenda?${parametros.toString()}`);
    },
    [router, tipo],
  );
```

5d. Troque as l.412-425 (de `// REMARCAR pergunta pelo procedimento…` até `const donoDaConsulta = …`) por:

```ts
  // Os horários da remarcação perguntam pelo procedimento e pelo dono DO
  // COMPROMISSO (a rota não troca nenhum dos dois), nunca pelo tipo da grade —
  // `lib/agenda/tipo-da-remarcacao.ts` (achado 1, 16/11). Fora da lista
  // carregada não pergunta nada: a grade vai até a semana dele primeiro.
  const remarcandoAtivo = remarcandoId !== null && remarcandoId === idAberto ? remarcandoId : null;
  const alvoDaRemarcacao = remarcandoAtivo ? todos.find((a) => a.id === remarcandoAtivo) : undefined;
  const remarcacao = alvoDaRemarcacao ? tipoDaRemarcacao(alvoDaRemarcacao, tiposIniciais, tipo) : null;
  const abertoNaGrade = idAberto ? todos.find((a) => a.id === idAberto) : undefined;
  // O que a consulta de horários pergunta: na marcação NOVA, o profissional e o
  // procedimento escolhidos no modal; ao REMARCAR, os do compromisso.
  const tipoDaMarcacao = remarcacao
    ? remarcacao.tipo
    : formDonoId
      ? (tiposIniciais.find((t) => t.id === formTipoId) ?? null)
      : null;
  const donoDaConsulta = remarcacao ? remarcacao.donoId : formDonoId || undefined;
```

5e. Troque o memo `duracaoDoCompromisso` (l.464-469) por

```ts
  // A duração do compromisso sendo REMARCADO (upstream #3714): o PATCH preserva
  // o comprimento do bloco, e a lista de horários tem de ser do mesmo tamanho.
  const duracaoDoCompromisso = alvoDaRemarcacao
    ? duracaoDoBloco(alvoDaRemarcacao.comeca, alvoDaRemarcacao.termina, 0) || null
    : null;
```

5f. Na consulta de horários (l.482-497): `marcando && tipoDaMarcacao` vira `(marcando || remarcandoAtivo !== null) && tipoDaMarcacao`, e `duracao_minutos: remarcandoId ? …` vira `duracao_minutos: remarcandoAtivo ? (duracaoDoCompromisso ?? undefined) : (duracaoEscolhida ?? undefined),`. No comentário de `horariosPorDia`, troque "O lookup em `PainelDeMarcacao`" por "O lookup em `QuandoDaMarcacao`".

5g. Em `aoMudarAbertura`, apague `setRemarcandoId(null);` e `setEmailConvidado("");` com os comentários deles (a frase "senão o próximo 'Novo agendamento' remarcaria…" e o parágrafo do convidado).

5h. l.635: a `EntradaDaAgenda` passa a receber o painel:

```tsx
        <EntradaDaAgenda
          onContext={onContext}
          profissional={
            abertoNaGrade ? pessoas.find((p) => p.id === abertoNaGrade.responsavelId)?.nome : undefined
          }
          remarcacao={
            podeMarcar && idAberto
              ? {
                  aberta: remarcandoAtivo !== null,
                  onAbrir: (comecaEm) => {
                    setRemarcandoId(idAberto);
                    // Aberto por link (Central, Radar) e fora da semana
                    // carregada: a grade vai até ele, e os horários esperam o
                    // compromisso aparecer na lista.
                    if (!abertoNaGrade) setAncora(ancoraLocalDoDia(diaLocalISO(new Date(comecaEm), fusoDaAgenda)));
                  },
                  onFechar: () => setRemarcandoId(null),
                  quando: {
                    ancora: ancoraLocalDoDia(hoje),
                    agora,
                    fuso: horarios?.fuso_da_regra,
                    horariosPorDia,
                    publicouHorarios: horarios?.publicou_horarios ?? true,
                    erroAoCarregar: horariosFalharam,
                    fusoSuposto: horarios?.fuso_suposto ?? false,
                    fontesDefasadas: horarios?.fontes_defasadas,
                    googleCoberturaParcial: horarios?.google_cobertura_parcial,
                    onMesVisivel,
                    mesCarregado: horarios ? mesDoPainel : null,
                    temTipo: Boolean(remarcacao?.tipo),
                    avisoSemTipo: t("Carregando…"),
                    // Remarcar fora da lista vale como na marcação: a rota
                    // aplica a mesma regra de encaixe no PATCH.
                    permiteEncaixe: podeMarcar,
                    abriuComHorario: false,
                  },
                }
              : undefined
          }
        />
```

5i. l.815: `<Dialog open={marcando && !remarcandoId} onOpenChange={aoMudarAbertura}>` vira `<Dialog open={marcando} onOpenChange={aoMudarAbertura}>`; e o comentário acima (l.809-814) termina em "REMARCAR acontece no painel do paciente." em vez de "continua no painel lateral de sempre…".

5j. Apague o `<Sheet open={marcando && Boolean(remarcandoId)} …>…</Sheet>` inteiro (l.905-1087).

5k. `AgendaInterativa`: troque o `onAbrirAgendamento={(id) => {…}}` (l.1270-1275) por `onAbrirAgendamento={(id) => abrirCompromisso(id)}` (mantenha o comentário acima dele) e o `onRemarcar` (l.1277-1280) por `onRemarcar={(id) => abrirCompromisso(id, true)}`. No `HistoricoDaAgenda` (l.1306-1309): `onRemarcar={(id) => abrirCompromisso(id, true)}`.

5l. `components/agenda/MarcacaoSimples.tsx:57-63` (doc do componente): troque "O painel antigo, em três colunas, continua existindo para REMARCAR e na vitrine; aqui é só a marcação nova." por "O painel antigo, em três colunas, ficou só na vitrine; remarcar usa o mesmo `QuandoDaMarcacao` no painel do paciente."

- [ ] **Step 6: Testes que mudam com o painel**

6a. Em `tests/unit/agenda-presenca-draft.test.tsx`, `tests/unit/agenda-excluir-compromisso-dialogo.test.tsx`, `tests/unit/agenda-anotacao-interna-chega-a-tela.test.tsx` e `tests/unit/agenda-nome-completo-do-paciente.test.tsx`, troque o `vi.mock("@/components/ui/sheet", …)` por:

```tsx
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h1>{children}</h1>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}));
```

6b. `tests/unit/agenda-presenca-draft.test.tsx`, `open()`: o motivo agora fica atrás do botão "Cancelar":

```tsx
async function open(locale = "pt-BR") {
  render(
    <IdiomaProvider locale={locale}>
      <QueryClientProvider client={client}>
        <DetalheDoCompromisso id="appointment" onClose={() => {}} />
      </QueryClientProvider>
    </IdiomaProvider>,
  );
  fireEvent.click(await screen.findByTestId("acao-cancelar"));
  return screen.getByLabelText(locale === "es" ? "Motivo de cancelación" : "Motivo do cancelamento");
}
```

6c. `tests/unit/agenda-local-e-observacao-na-marcacao.test.ts`, primeiro `it`:

```ts
  it("a tela de marcar tem os dois campos, e só na criação", () => {
    // Os campos moram em `MarcacaoSimples`, montado só para a marcação NOVA.
    // Remarcar acontece no painel do paciente, com `QuandoDaMarcacao` — só dia
    // e hora, sem eles (27/11/2026).
    const modal = readFileSync("components/agenda/MarcacaoSimples.tsx", "utf8");
    const quando = readFileSync("components/agenda/QuandoDaMarcacao.tsx", "utf8");
    expect(modal).toContain('data-testid="endereco-do-compromisso"');
    expect(modal).toContain('data-testid="observacao-do-compromisso"');
    expect(tela).toContain("<Dialog open={marcando}");
    expect(quando).not.toContain("endereco-do-compromisso");
    expect(quando).not.toContain("observacao-do-compromisso");
  });
```

6d. Apague `tests/unit/agenda-confirmar-alcancavel.test.ts` (`git rm`): ele mede as classes do Sheet que envolvia o `PainelDeMarcacao`, e o Sheet saiu; o "cabe na tela" do modal segue em `tests/e2e/agenda-painel-cabe-na-tela.spec.ts`.

6e. `tests/unit/agenda-l1-remarcar-e-relogio.test.tsx`:
- no mock de `next/navigation`, `push: vi.fn(),` vira `push: (url: string) => window.history.pushState(null, "", url),` (o `useSearchParams` do mock lê a URL; é assim que o painel "abre");
- acrescente, junto dos outros mocks:

```tsx
/** O painel real busca o detalhe na rede; aqui só importa o Remarcar que ele recebe. */
vi.mock("@/components/agenda/EntradaDaAgenda", () => ({
  EntradaDaAgenda: (props: { remarcacao?: { onAbrir: (comecaEm: string) => void } }) =>
    props.remarcacao ? (
      <button
        type="button"
        data-testid="abrir-remarcacao-de-fora"
        onClick={() => props.remarcacao!.onAbrir("2030-02-20T10:00:00-03:00")}
      >
        remarcar
      </button>
    ) : null,
}));
```

- apague o `vi.mock("@/components/agenda/PainelDeMarcacao", …)`;
- troque os dois `describe` "achado 1" e "achado 13" por:

```tsx
describe("achado 1: remarcar pergunta pela agenda DO compromisso", () => {
  it("o Remarcar da recusa do arraste pede os horários do procedimento e da dona dele", () => {
    compromissos.push(RETORNO_DA_BIA);
    montar();
    const card = screen.getByTestId("agendamento-c-bia");
    card.focus();
    fireEvent.keyDown(card, { key: "ArrowDown", altKey: true });
    fireEvent.keyDown(card, { key: "Enter" });
    expect(screen.getByTestId("remarcacao-recusada").textContent).toContain("outro profissional ou procedimento");
    expect(remarcarSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("remarcacao-recusada-remarcar"));
    expect(new URLSearchParams(window.location.search).get("compromisso")).toBe("c-bia");
    // A grade (atrás do painel) segue perguntando pelo tipo dela; o REMARCAR não.
    const doRemarcar = pedidos.filter((p) => p !== null && "duracao_minutos" in p);
    expect(doRemarcar.at(-1)).toMatchObject({ event_type_id: "tipo-2", owner_user_id: "p-bia" });
  });
});

describe("remarcar compromisso aberto por link, fora da semana carregada", () => {
  it("a grade vai até a semana dele, e nenhum horário é pedido com o procedimento da grade", () => {
    window.history.replaceState(null, "", "/app/agenda?compromisso=c-fora");
    montar();
    pedidos.length = 0;
    fireEvent.click(screen.getByTestId("abrir-remarcacao-de-fora"));
    expect(screen.getByTestId("periodo").textContent).toContain("fev");
    expect(pedidos.filter((p) => p !== null && "duracao_minutos" in p)).toEqual([]);
  });
});

describe("achado 13: 'Ver na agenda' limpa o horário escolhido", () => {
  it("a marcação seguinte não abre com o horário do bloco clicado antes", async () => {
    montar();
    fireEvent.click(screen.getByTestId(`bloco-${QUARTA}-14:30`));
    expect(await screen.findByTestId("painel-dublê")).toHaveAttribute(
      "data-instante",
      new Date(`${QUARTA}T14:30:00-03:00`).toISOString(),
    );
    fireEvent.click(screen.getByRole("button", { name: "ver na agenda" }));
    expect(screen.queryByTestId("painel-dublê")).toBeNull();

    fireEvent.click(screen.getByTestId("novo-agendamento"));
    expect(await screen.findByTestId("painel-dublê")).toHaveAttribute("data-instante", "");
  });
});
```

- [ ] **Step 7: Rodar e ver passar**

Run: `pnpm vitest run tests/unit/agenda-painel-do-paciente.test.tsx tests/unit/agenda-presenca-draft.test.tsx tests/unit/agenda-excluir-compromisso-dialogo.test.tsx tests/unit/agenda-anotacao-interna-chega-a-tela.test.tsx tests/unit/agenda-nome-completo-do-paciente.test.tsx tests/unit/agenda-local-e-observacao-na-marcacao.test.ts tests/unit/agenda-l1-remarcar-e-relogio.test.tsx tests/unit/agenda-tipo-da-grade-sobrevive-ao-reload.test.tsx tests/unit/agenda-clique-e-profissionais.test.tsx tests/unit/agenda-confirmar-pela-tela.test.tsx tests/unit/controle-decorativo.test.ts tests/unit/i18n-espanhol-cobre-a-tela.test.ts`
Expected: PASS. (`agenda-confirmar-pela-tela` ainda passa: o `onConfirmar={(id)` do `HistoricoDaAgenda` só sai na Tarefa 7, e o painel ainda contém `decide({ status: "confirmed" })` e `a.status === "pending" ?`.)

- [ ] **Step 8: As specs e2e que abriam o painel antigo**

8a. `tests/e2e/agenda-presenca-recuperacao.spec.ts`:
- `detail()` (l.161-166): o título do painel passa a ser o nome do paciente; o procedimento vem na linha de baixo:

```ts
async function detail(page: Page, id: string, title: string) {
  await page.goto(`/app/agenda?compromisso=${id}`);
  // Desde 27/11/2026 o título do painel é o PACIENTE; o compromisso vem na linha de baixo.
  await expect(page.getByRole("dialog").getByText(title, { exact: true }).first()).toBeVisible();
}
```

- l.339: `await expect(page.getByRole("button", { name: "Faltou", exact: true })).toHaveCount(0);` com o comentário `// Antes do início não há presença a registrar: o par Compareceu/Faltou nem aparece.`
- antes da l.347 (`Lembrar em uma hora`): `await page.getByTestId("abrir-mais-detalhes").click();`
- antes da l.1172 (`getByLabel("Motivo do cancelamento").fill`): `await page.getByTestId("acao-cancelar").click();`

8b. `tests/e2e/agenda-google-meet.spec.ts:214-220`:

```ts
async function detail(page: Page, id: string) {
  await page.goto(`/app/agenda?compromisso=${id}`);
  await expect(page.getByRole("dialog").getByText("Consulta Meet", { exact: true }).first()).toBeVisible();
  // O Meet mora em "Mais detalhes", fechado por padrão (27/11/2026).
  await page.getByTestId("abrir-mais-detalhes").click();
  await expect(meet(page)).toBeVisible();
}
```

8c. `tests/e2e/agenda-google-sync.spec.ts:192-197`:

```ts
async function detail(page: Page, id: string) {
  await page.goto(`/app/agenda?compromisso=${id}`);
  await expect(page.getByRole("dialog").getByText("Consulta sincronizada", { exact: true }).first()).toBeVisible();
  // A sincronização do Google mora em "Mais detalhes", fechado por padrão (27/11/2026).
  await page.getByTestId("abrir-mais-detalhes").click();
}
```

8d. `tests/e2e/agenda-excluir-lancado-por-engano.spec.ts`, entre `await page.getByTestId(\`agendamento-${id}\`).click();` e `await page.getByTestId("excluir-compromisso").click();`: `await page.getByTestId("abrir-mais-detalhes").click();`

- [ ] **Step 9: Gates e commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 pnpm typecheck && pnpm lint
git rm tests/unit/agenda-confirmar-alcancavel.test.ts
git add components/agenda/DetalheDoCompromisso.tsx components/agenda/EntradaDaAgenda.tsx components/agenda/MarcacaoSimples.tsx app/app/agenda/_client.tsx lib/i18n/dicionario.ts tests/unit/agenda-painel-do-paciente.test.tsx tests/unit/agenda-presenca-draft.test.tsx tests/unit/agenda-excluir-compromisso-dialogo.test.tsx tests/unit/agenda-anotacao-interna-chega-a-tela.test.tsx tests/unit/agenda-nome-completo-do-paciente.test.tsx tests/unit/agenda-local-e-observacao-na-marcacao.test.ts tests/unit/agenda-l1-remarcar-e-relogio.test.tsx tests/e2e/agenda-presenca-recuperacao.spec.ts tests/e2e/agenda-google-meet.spec.ts tests/e2e/agenda-google-sync.spec.ts tests/e2e/agenda-excluir-lancado-por-engano.spec.ts
git commit -m "feat(agenda): painel do paciente com Confirmar, Remarcar pelo relógio e Cancelar

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: A lista de baixo sai, e o código que ficou sem uso

**Files:**
- Delete: `components/agenda/HistoricoDaAgenda.tsx`, `tests/unit/agenda-separar-historico.test.tsx`, `tests/unit/agenda-confirmar-pela-tela.test.tsx`, `tests/e2e/agenda-remarcar-e-cancelar.spec.ts`, `tests/e2e/agenda-ocupacao-do-google-no-historico.spec.ts`
- Modify: `app/app/agenda/_client.tsx` (import l.19, Sheet l.37, hooks l.45, estado de cancelar, `cancelar`/`desfecho`, `agendamentosAcionaveis`, Sheet de cancelar, comentário longo, `HistoricoDaAgenda`)
- Modify: `hooks/agenda/useRemarcarAgendamento.ts`
- Modify: `app/vitrine-agenda/_client.tsx:13,270-283`
- Modify: `tests/unit/controle-decorativo.test.ts`
- Modify (e2e): `tests/e2e/agenda-kit-visual.spec.ts:512-579`, `tests/e2e/agenda-tela-do-produto.spec.ts` (teste do histórico), `tests/e2e/agenda-excluir-lancado-por-engano.spec.ts:102-104,129-133`, `.github/workflows/e2e.yml` (SPECS_PARTE_5)

**Interfaces:**
- Consumes: Tarefa 6 (painel com Confirmar/Remarcar/Cancelar/Compareceu/Faltou).
- Produces: `hooks/agenda/useRemarcarAgendamento.ts` exporta só `useRemarcarAgendamento`.

- [ ] **Step 1: Conferir os usos antes de apagar**

Run: `git grep -n -E "HistoricoDaAgenda|useCancelarAgendamento|useRegistrarDesfecho|agenda-remarcar-e-cancelar|agenda-ocupacao-do-google-no-historico" -- app components hooks lib tests .github docs/testing`
Expected: só os pontos listados em **Files** (mais `vi.mock` de testes, que listam as funções no objeto do dublê e não quebram, e prosa histórica em comentários). Se aparecer outro uso, pare e trate antes.

- [ ] **Step 2: Remover**

2a. `git rm components/agenda/HistoricoDaAgenda.tsx tests/unit/agenda-separar-historico.test.tsx tests/unit/agenda-confirmar-pela-tela.test.tsx tests/e2e/agenda-remarcar-e-cancelar.spec.ts tests/e2e/agenda-ocupacao-do-google-no-historico.spec.ts`
- `agenda-confirmar-pela-tela`: o Confirmar pela tela agora é o do painel, exercido em `tests/unit/agenda-painel-do-paciente.test.tsx` ("Confirmar só quando aguarda confirmação…").
- `agenda-remarcar-e-cancelar` e `agenda-ocupacao-do-google-no-historico`: o assunto (botões da lista) deixou de existir; remarcar e cancelar pela tela passam para `agenda-painel-do-paciente.spec.ts` (Tarefa 9), e a ocupação do Google segue inerte na grade (`agenda-ocupacao-do-google-na-grade.spec.ts`).

2b. `app/app/agenda/_client.tsx`: apague o import de `HistoricoDaAgenda` (l.19), o de `Sheet…` (l.37) e o de `useCancelarAgendamento, useRegistrarDesfecho`; o estado `cancelandoId`/`motivo` com o comentário; `const cancelar = …` e `const desfecho = …`; o memo `agendamentosAcionaveis` com a doc; o `<Sheet open={cancelandoId !== null} …>…</Sheet>` com o comentário acima; o comentário longo `⚠️ A LISTA DAQUI NÃO É A MESMA DA GRADE…` (l.1163-1191); e o `{/* O histórico vem DEPOIS da grade… */}` + `<HistoricoDaAgenda …/>` inteiro. Troque o comentário de `agendamentosDaGrade` (l.518-521) por:

```ts
  // A GRADE não mostra cancelado: ela responde "o que está de pé". O que
  // aconteceu com um cancelado se vê no painel dele e no contato.
```

2c. `hooks/agenda/useRemarcarAgendamento.ts`: apague `useCancelarAgendamento` e `useRegistrarDesfecho` (com as docs); troque a última frase do cabeçalho (`As duas mutações invalidam…`) por `A mutação invalida \`["agenda"]\`, a mesma chave que \`useAgendamentos\` usa, então a grade e o painel repintam sozinhos. Cancelar e registrar desfecho moram no painel do paciente (\`DetalheDoCompromisso\`).`

2d. `app/vitrine-agenda/_client.tsx`: apague o import da l.13 e a `<Secao id="historico" …>…</Secao>` (l.270-283).

2e. `tests/unit/controle-decorativo.test.ts`: os cinco `disabled={!onAlgo}` do produto moravam todos no `HistoricoDaAgenda`. Extraia o padrão e prove a sonda numa amostra:

```ts
/** `disabled={!onAlgo}` — o padrão que a varredura procura. */
const PADRAO_DO_CONTROLE = /disabled=\{!\s*(on[A-Z][A-Za-z0-9]*)\s*\}/g;
```

(use `PADRAO_DO_CONTROLE` no `fonte.matchAll(...)` de `controlesQueDependemDeCallback`) e troque o primeiro `it` por:

```ts
  it("a varredura enxerga os dois lados (senão ela mede o vazio)", () => {
    // O último `disabled={!onAlgo}` do produto saiu com o `HistoricoDaAgenda`
    // (27/11/2026). A sonda segue valendo para o próximo — provada numa
    // amostra, já que o conjunto real hoje é vazio de propósito.
    const amostra = [..."<Button disabled={!onRemarcar}>".matchAll(PADRAO_DO_CONTROLE)].map((m) => m[1]);
    expect(amostra).toEqual(["onRemarcar"]);
    expect(LIGADAS.size, "nenhuma callback encontrada em app/app").toBeGreaterThanOrEqual(20);
  });
```

2f. e2e:
- `tests/e2e/agenda-kit-visual.spec.ts`: apague os testes `"o histórico separa as quatro abas, e cancelado NÃO aparece em próximos"`, `"o histórico não oferece ação que não pode cumprir"` e `"o passado registra o desfecho — senão \`realizado\` e \`faltou\` ficam sem escritor"` (l.512-579).
- `tests/e2e/agenda-tela-do-produto.spec.ts`: apague `"o histórico está NA TELA DO PRODUTO, com as quatro abas"`.
- `tests/e2e/agenda-excluir-lancado-por-engano.spec.ts`: apague as l.102-104 (`const historico = …` até a linha do `linha-${id}`) e o laço das abas (l.129-133); o "some da grade" (`agendamento-${id}` com contagem 0) fica, e o título do passo vira `// ── 3. Some da grade ──`.
- `.github/workflows/e2e.yml`, em `SPECS_PARTE_5`: apague as linhas `agenda-ocupacao-do-google-no-historico.spec.ts` e `agenda-remarcar-e-cancelar.spec.ts`.

- [ ] **Step 3: Rodar os testes afetados**

Run: `pnpm vitest run tests/unit/controle-decorativo.test.ts tests/unit/e2e-cobertura-completa.test.ts tests/unit/agenda-spec-nao-escolhe-o-periodo-sozinha.test.ts tests/unit/agenda-clique-e-profissionais.test.tsx tests/unit/agenda-l1-remarcar-e-relogio.test.tsx tests/unit/agenda-tipo-da-grade-sobrevive-ao-reload.test.tsx tests/unit/agenda-viewer-nao-ganha-novo-agendamento.test.tsx tests/unit/telas-sem-dado-de-mentira.test.ts tests/unit/i18n-espanhol-cobre-a-tela.test.ts`
Expected: PASS. (`agenda-spec-nao-escolhe-o-periodo-sozinha` exige ≥ 7 specs de agenda que escolhem período: perdemos duas aqui e a Tarefa 9 devolve uma; conte com `grep -l "agenda-semana-integra" tests/e2e/*.spec.ts | wc -l` — deve continuar ≥ 7.)

- [ ] **Step 4: Gates e commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 pnpm typecheck && pnpm lint
git add app/app/agenda/_client.tsx hooks/agenda/useRemarcarAgendamento.ts app/vitrine-agenda/_client.tsx tests/unit/controle-decorativo.test.ts tests/e2e/agenda-kit-visual.spec.ts tests/e2e/agenda-tela-do-produto.spec.ts tests/e2e/agenda-excluir-lancado-por-engano.spec.ts .github/workflows/e2e.yml
git commit -m "refactor(agenda): a lista de baixo sai; confirmar, remarcar e cancelar ficam no painel

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: O topo numa linha só

**Files:**
- Modify: `app/app/agenda/_client.tsx` — `<header>` (l.639-714) e a linha de navegação (l.729-802)
- Modify: `components/agenda/AgendaInterativa.tsx:66-150,470-519`
- Test: `tests/unit/agenda-clique-e-profissionais.test.tsx`

**Interfaces:**
- Consumes: `FiltroDePessoas`/`pessoasDaFileira` (Tarefa 3).
- Produces: `AgendaInterativa` ganha `fileira?: React.ReactNode`; test ids `topo-da-agenda` e `linha-de-filtros`.

- [ ] **Step 1: Teste que falha**

Em `tests/unit/agenda-clique-e-profissionais.test.tsx`, acrescente `within` ao import do Testing Library e, no fim:

```tsx
describe("topo numa linha só (decisão 7 do André, 27/11/2026)", () => {
  it("período, Hoje, visões e Novo agendamento no topo; a fileira de profissionais logo abaixo", () => {
    compromissos.push(compromisso("c-ana", "p-ana", "09:00"));
    montar();
    const topo = screen.getByTestId("topo-da-agenda");
    for (const id of ["periodo-anterior", "periodo-seguinte", "periodo", "alternador-de-visao", "novo-agendamento"]) {
      expect(topo.contains(screen.getByTestId(id)), id).toBe(true);
    }
    expect(within(topo).getByRole("button", { name: "Hoje" })).toBeInTheDocument();
    const fileira = screen.getByTestId("filtro-de-pessoas");
    expect(topo.contains(fileira)).toBe(false);
    expect(screen.getByTestId("linha-de-filtros").contains(fileira)).toBe(true);
    expect(topo.compareDocumentPosition(fileira) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run tests/unit/agenda-clique-e-profissionais.test.tsx -t "topo numa linha"`
Expected: FAIL — `Unable to find an element by: [data-testid="topo-da-agenda"]`.

- [ ] **Step 3: Implementar**

3a. `components/agenda/AgendaInterativa.tsx`: acrescente `fileira,` à desestruturação e, no tipo, depois de `janelaSobre?`:

```ts
  /**
   * A fileira de profissionais, desenhada à ESQUERDA de "Horários livres de",
   * na mesma linha (decisão 7 do André, 27/11/2026): os dois decidem o que a
   * grade mostra, e navegação mora em cima.
   */
  fileira?: React.ReactNode;
```

e troque a abertura do bloco `{tipos.length > 1 && (\n        <div\n          data-testid="tipo-da-grade"` … até o `</div>\n      )}` que o fecha (l.473-519) por:

```tsx
      {(fileira || tipos.length > 1) && (
        <div data-testid="linha-de-filtros" className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          {fileira}
          {tipos.length > 1 && (
            <div data-testid="tipo-da-grade" className="flex flex-wrap items-center gap-1.5 text-xs text-text-muted">
              {/* o conteúdo de hoje do "tipo-da-grade": o rótulo "Horários livres de",
                  o comentário das paredes de botões e o select/botões, sem mudança */}
            </div>
          )}
        </div>
      )}
```

(mova o conteúdo atual de dentro do `tipo-da-grade` — `<span className="shrink-0">{t("Horários livres de")}</span>`, o comentário e o ternário `tipos.length > MUITOS_TIPOS ? <select…> : tipos.map(…)` — inteiro para dentro da nova `div`, sem mudar nada nele).

3b. `app/app/agenda/_client.tsx`: substitua o `<header>…</header>` (l.639-714) por:

```tsx
      {/* O TOPO NUMA LINHA SÓ (decisão 7 do André, 27/11/2026): ‹ › período,
          Hoje, Dia/Semana/Mês e Novo agendamento. A fileira de profissionais
          vem logo abaixo, ao lado de "Horários livres de" (`AgendaInterativa`). */}
      <header data-testid="topo-da-agenda" className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="titulo-tela mr-1">{t("Agenda")}</h1>
        <div className="flex items-center gap-0.5">
          {/* os dois botões "periodo-anterior" e "periodo-seguinte" de hoje (l.732-749), sem mudança */}
        </div>
        {/* o <span data-testid="periodo"> de hoje (l.751-763), com o comentário do `first-letter`, sem mudança */}
        {/* o botão "Hoje" de hoje (l.647-656), com o comentário, sem mudança */}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/* o "alternador-de-visao" de hoje (l.773-800), sem mudança */}
          {/* o "motivo-novo-agendamento" e o botão "novo-agendamento" de hoje (l.657-712), com os comentários, sem mudança */}
        </div>
      </header>
```

(cada comentário acima indica um elemento que já existe e é **movido inteiro** para ali; o subtítulo `t("O que está marcado, com quem, e quem atende — seu e da equipe.")` sai). Apague a antiga linha de navegação inteira (o `<div className="flex flex-wrap items-center justify-between gap-3">…</div>` das l.729-802, depois de mover dela as setas, o período e o alternador) — o `CartaoDaConexaoGoogle` fica entre o topo e a grade, como hoje. Na `AgendaInterativa`, acrescente:

```tsx
        fileira={<FiltroDePessoas pessoas={pessoasDaFileira} selecionadas={selecionadas} onMudar={mudarPessoas} />}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm vitest run tests/unit/agenda-clique-e-profissionais.test.tsx tests/unit/agenda-viewer-nao-ganha-novo-agendamento.test.tsx tests/unit/agenda-l1-remarcar-e-relogio.test.tsx tests/unit/agenda-tipo-da-grade-sobrevive-ao-reload.test.tsx tests/unit/i18n-espanhol-cobre-a-tela.test.ts`
Expected: PASS.

- [ ] **Step 5: Gates e commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 pnpm typecheck && pnpm lint
git add app/app/agenda/_client.tsx components/agenda/AgendaInterativa.tsx tests/unit/agenda-clique-e-profissionais.test.tsx
git commit -m "feat(agenda): topo numa linha só e fileira de profissionais ao lado dos horários livres

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Spec pela tela, fragmento, mapa de jornadas e verificação completa

**Files:**
- Create: `tests/e2e/agenda-painel-do-paciente.spec.ts`
- Modify: `.github/workflows/e2e.yml` (SPECS_PARTE_5)
- Create: `.changes/agenda-redesenhada.md`
- Modify: `docs/testing/user-journey-map.md` (J14)

**Interfaces:**
- Consumes: tudo das Tarefas 1-8; helpers `irParaASemanaSeguinte`, `escolherDiaDesenhado` (`tests/e2e/helpers/agenda-semana-integra.ts`), `escolherProfissionalEProcedimento` (`tests/e2e/helpers/marcacao-simples.ts`), `esperarAgenda` (`tests/e2e/helpers/tela-agenda.ts`); seed `scripts/seed-e2e-agenda.ts` (tipo "Consulta E2E", categoria padrão `outro` → paciente antigo; contato "Paciente Agenda E2E").
- Produces: nada para outras tarefas.

- [ ] **Step 1: Escrever a spec**

Crie `tests/e2e/agenda-painel-do-paciente.spec.ts`:

```ts
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

import { escolherDiaDesenhado, irParaASemanaSeguinte } from "./helpers/agenda-semana-integra";
import { escolherProfissionalEProcedimento } from "./helpers/marcacao-simples";
import { esperarAgenda } from "./helpers/tela-agenda";

/**
 * A AGENDA REDESENHADA, PELA TELA (decisões do André, 27/11/2026) — como a
 * recepção usa:
 *   1. marca para PACIENTE ANTIGO: o procedimento do seed não é "Primeira…",
 *      então "Quem converteu" e "Origem do lead" nem aparecem, e o POST sai sem
 *      `converted_by_kind`;
 *   2. clica na consulta e resolve tudo no painel do paciente;
 *   3. remarca DIGITANDO a hora no campo com relógio (o mesmo "quando" da
 *      marcação), pelo mesmo PATCH de antes;
 *   4. cancela com motivo.
 *
 * Evidência em `.superpowers/evidence/agenda-redesenho/`. Navegações relativas:
 * o `baseURL` do `playwright.config.ts` resolve.
 */
const RAIZ = path.resolve(__dirname, "../..");
const EVIDENCIA = path.join(RAIZ, ".superpowers/evidence/agenda-redesenho");

interface Creds {
  password: string;
  users: Record<string, { email: string; id: string } | undefined>;
  agenda?: { tipo_nome: string; contato_nome: string };
}

function lerCreds(): Creds {
  const p = path.join(RAIZ, ".e2e-creds.json");
  if (!fs.existsSync(p)) throw new Error("`.e2e-creds.json` ausente — rode `scripts/seed-e2e-credentials.ts`");
  let c = JSON.parse(fs.readFileSync(p, "utf8")) as Creds;
  if (!c.agenda) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-agenda.ts"], { stdio: "inherit" });
    c = JSON.parse(fs.readFileSync(p, "utf8")) as Creds;
  }
  if (!c.agenda) throw new Error("seed-e2e-agenda não gravou o bloco `agenda`");
  return c;
}

async function entrar(page: Page, creds: Creds): Promise<string[]> {
  // `manager`: vê a agenda da equipe e marca; o admin do seed tem MFA.
  const usuario = creds.users.manager;
  if (!usuario) throw new Error(".e2e-creds.json sem o usuário `manager`");
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(usuario.email);
  await page.getByLabel(/senha/i).fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 });
  await page.goto("/app/agenda");
  await esperarAgenda(page, 20_000);
  // A semana SEGUINTE tem a jornada inteira em qualquer dia e hora (ver o
  // cabeçalho de `helpers/agenda-semana-integra`): remarcar precisa de dois
  // horários livres.
  return irParaASemanaSeguinte(page);
}

const ehAgendamentos = (url: string) => new URL(url).pathname === "/api/v1/agenda/agendamentos";

test.describe.configure({ timeout: 150_000 });

test("paciente antigo: marca, abre o painel, remarca pelo relógio e cancela com motivo", async ({ page }) => {
  const creds = lerCreds();
  const agenda = creds.agenda!;
  const dias = await entrar(page, creds);
  fs.mkdirSync(EVIDENCIA, { recursive: true });

  // ── 1. marcar para paciente antigo ──────────────────────────────────────
  await page.getByTestId("novo-agendamento").click();
  await expect(page.getByTestId("painel-de-marcacao")).toBeVisible({ timeout: 10_000 });
  await escolherProfissionalEProcedimento(page, new RegExp(`^${agenda.tipo_nome}`));
  await expect(page.getByTestId("paciente-antigo")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("quem-converteu")).toHaveCount(0);
  await expect(page.getByTestId("origem-do-lead")).toHaveCount(0);
  await page.getByRole("combobox", { name: "Paciente" }).fill(agenda.contato_nome);
  await page.getByRole("listbox").getByRole("option", { name: new RegExp(agenda.contato_nome) }).first().click();
  await escolherDiaDesenhado(page, dias);
  const horario = page.locator('[data-testid^="horario-"]').first();
  await expect(horario).toBeVisible({ timeout: 15_000 });
  const rotuloOriginal = (await horario.getAttribute("data-testid"))!.replace("horario-", "");
  await horario.click();
  await expect(page.getByTestId("hora-da-marcacao")).toHaveValue(rotuloOriginal);
  await page.screenshot({ path: path.join(EVIDENCIA, "1-marcar-paciente-antigo.png") });

  const post = page.waitForResponse((r) => ehAgendamentos(r.url()) && r.request().method() === "POST");
  await page.getByTestId("confirmar-marcacao").click();
  const resposta = await post;
  const corpo = await resposta.text();
  expect(resposta.status(), corpo).toBe(201);
  expect(resposta.request().postDataJSON(), "paciente antigo não leva quem converteu").not.toHaveProperty(
    "converted_by_kind",
  );
  const id = /"id":"([0-9a-f-]{36})"/.exec(corpo)?.[1];
  expect(id, corpo).toBeTruthy();
  await page.getByTestId("ver-na-agenda").click();

  // ── 2. o painel do paciente ─────────────────────────────────────────────
  const cartao = page.getByTestId(`agendamento-${id}`);
  await expect(cartao).toBeVisible({ timeout: 20_000 });
  await cartao.click();
  const painel = page.getByTestId("painel-do-compromisso");
  await expect(painel).toBeVisible({ timeout: 15_000 });
  await expect(painel.getByRole("heading", { name: agenda.contato_nome })).toBeVisible();
  await expect(painel.getByTestId("estado-do-compromisso")).toHaveText("Agendado");
  // O tipo do seed não pede aprovação: o compromisso nasce agendado, sem "Confirmar".
  await expect(painel.getByTestId("acao-confirmar")).toHaveCount(0);
  await expect(painel.getByTestId("acao-remarcar")).toBeVisible();
  await expect(painel.getByTestId("acao-cancelar")).toBeVisible();
  const maisDetalhesAberto = await painel
    .getByTestId("mais-detalhes-do-compromisso")
    .evaluate((el) => (el as HTMLDetailsElement).open);
  expect(maisDetalhesAberto, "'Mais detalhes' começa fechado").toBe(false);
  await page.screenshot({ path: path.join(EVIDENCIA, "2-painel-do-paciente.png") });

  // ── 3. remarcar pelo relógio ────────────────────────────────────────────
  await painel.getByTestId("acao-remarcar").click();
  await expect(painel.getByTestId("quando-da-marcacao")).toBeVisible({ timeout: 10_000 });
  await escolherDiaDesenhado(page, dias);
  const outro = painel.locator(`[data-testid^="horario-"]:not([data-testid="horario-${rotuloOriginal}"])`).first();
  await expect(outro, "só havia um horário livre — o cenário não distingue remarcar de repetir").toBeVisible({
    timeout: 15_000,
  });
  const rotuloNovo = (await outro.getAttribute("data-testid"))!.replace("horario-", "");
  await painel.getByTestId("hora-da-marcacao").fill(rotuloNovo);
  await expect(painel.getByTestId("fora-dos-horarios-livres")).toHaveCount(0);
  await expect(painel.getByTestId(`horario-${rotuloNovo}`)).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: path.join(EVIDENCIA, "3-remarcar-pelo-relogio.png") });

  const patch = page.waitForResponse((r) => ehAgendamentos(r.url()) && r.request().method() === "PATCH");
  await painel.getByTestId("confirmar-remarcacao").click();
  const remarcou = await patch;
  expect(remarcou.status(), await remarcou.text()).toBe(200);
  expect(remarcou.request().postDataJSON()).toMatchObject({ id, starts_at: expect.any(String) });
  await expect(painel.getByTestId("compromisso-horario")).toContainText(rotuloNovo, { timeout: 15_000 });

  // ── 4. cancelar com motivo ──────────────────────────────────────────────
  await painel.getByTestId("acao-cancelar").click();
  const confirmar = painel.getByTestId("confirmar-cancelamento");
  await expect(confirmar, "aceitou cancelar sem motivo — a rota devolveria 422").toBeDisabled();
  await painel.getByTestId("motivo-do-cancelamento").fill("ab");
  await expect(confirmar, "dois caracteres passam, e a rota exige três").toBeDisabled();
  await painel.getByTestId("motivo-do-cancelamento").fill("a paciente pediu por telefone");
  await page.screenshot({ path: path.join(EVIDENCIA, "4-cancelar-com-motivo.png") });
  const apagou = page.waitForResponse((r) => ehAgendamentos(r.url()) && r.request().method() === "DELETE");
  await confirmar.click();
  expect((await apagou).ok()).toBe(true);
  await expect(painel.getByTestId("estado-do-compromisso")).toHaveText("Cancelado", { timeout: 15_000 });
  await page.keyboard.press("Escape");
  // A grade responde "o que está de pé": o cancelado sai dela.
  await expect(page.getByTestId(`agendamento-${id}`)).toHaveCount(0, { timeout: 20_000 });
  await page.screenshot({ path: path.join(EVIDENCIA, "5-grade-depois-de-cancelar.png") });
});
```

- [ ] **Step 2: Registrar a spec no CI**

`.github/workflows/e2e.yml`, em `SPECS_PARTE_5`, logo depois de `agenda-nome-completo.spec.ts`: `        agenda-painel-do-paciente.spec.ts` (mesma indentação de 8 espaços).

Run: `pnpm vitest run tests/unit/e2e-cobertura-completa.test.ts tests/unit/agenda-spec-nao-escolhe-o-periodo-sozinha.test.ts`
Expected: PASS.

- [ ] **Step 3: Rodar as specs de agenda tocadas, pela tela**

Ambiente: o de `docs/SETUP.md` (Supabase local com `supabase/baseline.sql`, `.e2e-creds.json` semeado, `next build` + `next start` pelo `webServer` do Playwright). Rode:

```bash
pnpm exec playwright test tests/e2e/agenda-painel-do-paciente.spec.ts tests/e2e/agenda-clique-e-profissionais.spec.ts tests/e2e/agenda-tela-do-produto.spec.ts tests/e2e/agenda-procedimento-e-unidade-do-profissional.spec.ts tests/e2e/agenda-painel-cabe-na-tela.spec.ts tests/e2e/agenda-presenca-recuperacao.spec.ts tests/e2e/agenda-excluir-lancado-por-engano.spec.ts tests/e2e/agenda-kit-visual.spec.ts tests/e2e/agenda-clinicorp.spec.ts tests/e2e/agenda-ocupacao-do-google-na-grade.spec.ts tests/e2e/agenda-google-meet.spec.ts tests/e2e/agenda-google-sync.spec.ts tests/e2e/agenda-grade-interativa.spec.ts tests/e2e/agenda-marcar-pela-tela.spec.ts tests/e2e/agenda-ver-na-agenda.spec.ts
```

Expected: PASS. Se `agenda-painel-cabe-na-tela` ou `agenda-procedimento-e-unidade-do-profissional` reprovarem por altura ("o modal pede rolagem"), corte o respiro do modal em `MarcacaoSimples.tsx` (o `gap-y-5` da grade de duas colunas vira `gap-y-4`, e o `gap-4` da coluna da esquerda vira `gap-3`) e rode de novo; commite junto com esta tarefa. Se o ambiente local não subir, registre isso no relato e no mapa de jornadas como **NÃO MEDIDO em tela local** — o `e2e` do CI vira a prova, e nada é dado como PASS sem ter rodado.

- [ ] **Step 4: Prova no Safari de verdade**

Com o servidor do Step 3 de pé, abra no Safari (`open -a Safari "http://localhost:<porta>/app/agenda"`), entre com o `manager` do `.e2e-creds.json` e repita a jornada à mão: marcar paciente antigo, abrir o cartão, Remarcar digitando a hora no campo com relógio, Cancelar com motivo, e a semana sem domingo. Confira no Safari: o campo `type="time"` aceita digitar e mostra o relógio à esquerda; o `<details>` "Mais detalhes" abre e fecha sem marcador duplicado; o painel não passa da tela em 1280×800. Guarde as capturas em `.superpowers/evidence/agenda-redesenho/safari-*.png` (`screencapture -l <id-da-janela>` ou `screencapture -i`).

- [ ] **Step 5: Fragmento de versão**

Crie `.changes/agenda-redesenhada.md`:

```markdown
---
impacto: capacidade_nova
secao: alterado
titulo: Agenda redesenhada — hora com relógio, painel do paciente e semana de segunda a sábado
---
No "Novo agendamento", a hora ganhou um campo com relógio ao lado da data, com os horários livres
embaixo como atalho, e um seletor "Paciente novo / Paciente antigo": em paciente antigo, "Quem
converteu" e "Origem do lead" somem e não são gravados. A fileira de profissionais mostra só quem
tem atendimento na semana e escolhe uma pessoa por vez. A semana e o mês vão de segunda a sábado;
o domingo aparece só quando tem algo marcado. Clicar numa consulta abre o painel do paciente, com
Confirmar, Remarcar e Cancelar, e a lista de baixo da Agenda saiu. Nada muda no banco nem na
instalação.
```

Run: `pnpm release:conferir`
Expected: o fragmento aparece como `capacidade_nova`, sem erro de forma.

- [ ] **Step 6: Mapa de jornadas**

`docs/testing/user-journey-map.md`: na linha J14.13, depois de "legenda de cor por profissional", acrescente ` (desde 27/11 a legenda de pessoas virou a fileira do topo — J14.16)`; e logo depois dela acrescente as linhas abaixo, escrevendo **PASS** só para o que o Step 3/4 mediu verde (senão **NÃO MEDIDO em tela local**, com o motivo):

```markdown
| J14.14 | (27/11) "Novo agendamento" com campo de hora (relógio) ao lado da data e horários livres como atalho; hora fora da lista avisa "Fora dos horários livres" | **PASS** — `tests/unit/agenda-quando-da-marcacao.test.tsx` e `agenda-painel-do-paciente.spec.ts` (remarca digitando a hora). Evidência: `.superpowers/evidence/agenda-redesenho/` |
| J14.15 | (27/11) "Paciente novo / antigo": padrão pelo procedimento (Primeira consulta = novo); em antigo, "Quem converteu" e "Origem" somem e não vão no POST | **PASS** — `tests/unit/agenda-marcacao-simples.test.tsx` e `agenda-painel-do-paciente.spec.ts` (POST sem `converted_by_kind`) |
| J14.16 | (27/11) Fileira de profissionais: só quem tem atendimento na semana, "Todos" primeiro, uma pessoa por vez; a escolha sobrevive ao F5 | **PASS** — `agenda-clique-e-profissionais.spec.ts` |
| J14.17 | (27/11) Semana e mês de segunda a sábado; o domingo volta só com compromisso (ou quando é o dia aberto) | **PASS** — `tests/unit/agenda-semana-de-segunda-a-sabado.test.tsx` |
| J14.18 | (27/11) Clicar na consulta abre o painel do paciente: Confirmar (só pendente), Remarcar com o mesmo "quando" da marcação, Cancelar com motivo; Compareceu/Faltou depois do horário; "Mais detalhes" fechado; a lista de baixo saiu | **PASS** — `agenda-painel-do-paciente.spec.ts` e conferência no Safari (`safari-*.png`) |
```

- [ ] **Step 7: Verificação completa**

```bash
pnpm test:unit > /tmp/vt.log 2>&1; echo "exit=$?"
grep -aE "^ *(Test Files|Tests|Errors) " /tmp/vt.log | tail -3
grep -aE "^ *FAIL " /tmp/vt.log | sed 's/ > .*//' | sort | uniq -c
NODE_OPTIONS=--max-old-space-size=8192 pnpm typecheck
pnpm lint
git grep -n "console.log" -- components/agenda app/app/agenda lib/agenda hooks/agenda
```

Expected: `exit=0`, rodapé sem `failed`, linha `Errors` ausente; typecheck e lint zerados; nenhum `console.log`. Se o exit for 1 com rodapé verde, leia a linha `Errors` antes de concluir. `lib/ai/dispatcher/rate-limit.test.ts` vermelho só por Redis local fora do ar não é deste PR (ver "Vermelho local que NÃO é seu" no `CLAUDE.md`).

- [ ] **Step 8: Commit**

```bash
git add tests/e2e/agenda-painel-do-paciente.spec.ts .github/workflows/e2e.yml .changes/agenda-redesenhada.md docs/testing/user-journey-map.md
git commit -m "test(agenda): spec pela tela do painel do paciente, fragmento e mapa de jornadas

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(Se o Step 3 exigiu o ajuste de respiro, acrescente `components/agenda/MarcacaoSimples.tsx` ao `git add`.)

- [ ] **Step 9: Relato para quem publica**

O PR (aberto por quem publica, não por este plano) leva no corpo o **Living System Checklist**: entrada = clique no cartão/`?compromisso=`; saída = `PATCH`/`DELETE` de sempre (com `api_audit_log` e `appointment.rescheduled` do servidor); tela = painel do paciente; porta = a própria Agenda (sem tela nova, sem `NAV_CATALOG`); anti-morte = as specs acima; laço de retorno = recusa da rota volta como toast e o painel relê o detalhe (409 trava o rascunho). E as decisões em aberto listadas no relato desta sessão.

---

## Cobertura do spec

| Spec | Tarefa |
|---|---|
| 1. Hora `type=time step=300` com relógio + horários livres; "Fora dos horários livres"; encaixe absorvido | 2 |
| 1. Paciente novo/antigo pela categoria + nome; campos escondidos e não enviados; sem PATCH de origem; não gravado; `category` lida | 1 |
| 1. Grupos com título ("Quem e o quê", "Paciente", "Quando") | 1, 2 |
| 2. Fileira derivada dos compromissos, nome + cor, "Todos" primeiro, uma pessoa, some sem ninguém; legenda de pessoas sai | 3 |
| 3. Seg→sáb, domingo com compromisso; mês 6 colunas; dia igual | 4 |
| 3. Cartão (faixa 3 px + fundo claro, nome / "HH:mm · procedimento", ícone no canto, ≤ 30 min uma linha); linhas leves, hora só nas cheias, agora 2 px com bolinha; bloqueio listrado, uma linha, motivo no `title` | 5 |
| 3. Topo numa linha; fileira abaixo; "Horários livres de" à direita | 8 |
| 4. Lista de baixo sai (componente e testes) | 7 |
| 5. Painel `Dialog`; cabeçalho; Confirmar/Remarcar(`QuandoDaMarcacao`)/Cancelar; Compareceu/Faltou depois do início; "Mais detalhes"; compromisso pessoal | 6 |
| Remarcar reaproveita a chamada antiga; Sheets apagados | 6, 7 |
| Como provar: unitários, typecheck, lint, test:unit, spec Playwright, prints, Safari, `.changes` | 1-9 |
