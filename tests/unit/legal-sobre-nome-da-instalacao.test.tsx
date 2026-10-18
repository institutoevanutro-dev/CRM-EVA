import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A PÁGINA "SOBRE" DIZ O NOME DA INSTALAÇÃO, E O TÍTULO DA ABA NÃO MUDA DE FORMATO.
 *
 * `/legal/about` é a apresentação pública que o Google lê na verificação do
 * aplicativo (tela de consentimento OAuth). Duas coisas aqui são contrato:
 *
 *  1. o `<h1>` e o título da aba vêm de `nomeDaApresentacao()`, e não de um nome
 *     escrito no código. É o que deixa uma clínica nova instalar sem ver o nome
 *     de outra instalação (`tests/unit/branding.test.ts` vigia o resto do código);
 *  2. o título da aba mantém o formato nome, travessão, "Apresentação". O Google
 *     verificou a página com esse título, e as instalações que já existiam
 *     precisam continuar com o título idêntico. O travessão é a ÚNICA exceção à
 *     regra de não usar travessão em texto novo: aqui ele não é texto novo, é o
 *     formato que já foi aprovado. Por isso o teste o escreve como U+2014: um
 *     hífen ou um traço médio não seria o mesmo título.
 *
 * O resolvedor tem testes próprios (`legal-nome-da-apresentacao.test.ts`); aqui
 * ele é mockado, e o que se mede é o que a página FAZ com o nome que recebe.
 */

const nomeDaApresentacao = vi.hoisted(() => vi.fn());
vi.mock("@/lib/legal/nome-da-apresentacao", () => ({ nomeDaApresentacao }));

vi.mock("@/lib/legal/operador", () => ({
  resolverOperador: vi.fn(async () => ({
    sistema: "Sistema Exemplo",
    nome: null,
    razaoSocial: null,
    cnpj: null,
    dpoEmail: null,
    politicaPropria: null,
    resolvido: false,
  })),
}));
// Visitante sem sessão: é o caso do revisor do Google.
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: null } })) },
  })),
}));
vi.mock("@/lib/i18n/idiomaAnonimo", () => ({ idiomaDoVisitante: vi.fn(async () => "pt-BR") }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...p}>
      {children}
    </a>
  ),
}));

import Pagina, { generateMetadata } from "@/app/legal/about/page";

const NOME = "Clínica Exemplo";
const TRAVESSAO = "\u2014";

beforeEach(() => {
  nomeDaApresentacao.mockReset();
  nomeDaApresentacao.mockResolvedValue(NOME);
});

describe("/legal/about", () => {
  it("o título da aba é nome, travessão e Apresentação, o formato que o Google verificou", async () => {
    expect(await generateMetadata()).toEqual({ title: `${NOME} ${TRAVESSAO} Apresentação` });
    expect(nomeDaApresentacao, "guarda de vacuidade: o título tem de vir do resolvedor").toHaveBeenCalled();
  });

  it("o <h1> é o nome que o resolvedor devolveu", async () => {
    const html = renderToStaticMarkup(await Pagina());

    expect(html).toMatch(new RegExp(`<h1[^>]*>${NOME}</h1>`));
    expect(nomeDaApresentacao).toHaveBeenCalled();
  });

  it("o resto da página não mudou: a frase do operador e o link de acesso seguem lá", async () => {
    const html = renderToStaticMarkup(await Pagina());

    expect(html).toContain("Sistema Exemplo");
    expect(html).toContain('href="/login"');
    expect(html).toContain('href="/legal/privacy"');
  });
});
