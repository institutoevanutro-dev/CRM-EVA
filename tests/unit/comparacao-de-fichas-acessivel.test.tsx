import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * QUEM FICA NA JUNÇÃO, OUVIDO POR LEITOR DE TELA (porte do #3640, revisão).
 *
 * O rádio "Este fica" tinha `aria-label="Manter este cadastro"` nas duas fichas:
 * o rótulo fixo vencia o <label> com o nome, os dois rádios se chamavam igual e
 * quem usa VoiceOver ou NVDA não sabia qual ficha estava escolhendo. Agora o nome
 * do rádio é o do <label>: o nome da ficha e, por extenso, se ela fica ou é
 * absorvida. Sabotagem: devolver o `aria-label` ou tirar o "Será absorvido"
 * deixa este caso vermelho. Nomes fictícios.
 */
const fichas = vi.hoisted(() => {
  const base = {
    display_name: null,
    email: null,
    birthdate: null,
    cpf_available: false,
    endereco: null,
    prontuario_linked: false,
    is_blocked: false,
    force_human: false,
    ai_opt_out: false,
    inbox_hidden_at: null,
    source: null,
    created_at: "2026-01-01T12:00:00.000Z",
    last_activity_at: null,
    conversas: 0,
    negocios: 0,
  };
  return [
    { ...base, id: "a", name: "Ana Exemplo", phone_number: "+5527999990001" },
    { ...base, id: "b", name: "Bia Exemplo", phone_number: "+5527999990002" },
  ];
});

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useLocaleDeData: () => undefined }));
vi.mock("@/hooks/contacts/useCompararFichas", () => ({
  useCompararFichas: () => ({ data: { data: { contatos: fichas } }, isError: false }),
}));

import { ComparacaoDeFichas } from "@/components/contacts/ComparacaoDeFichas";

describe("ComparacaoDeFichas — quem fica, por extenso", () => {
  it("cada rádio se chama pelo nome da ficha e diz se ela fica ou é absorvida", () => {
    render(<ComparacaoDeFichas ids={["a", "b"]} principalId="b" onEscolherPrincipal={() => {}} />);

    // jsdom não carrega o CSS: os <span> do rótulo são inline e o nome junta
    // sem espaço. No navegador o `block` os separa.
    expect(screen.getByRole("radio", { name: /^Bia Exemplo\s*Este fica$/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /^Ana Exemplo\s*Será absorvido por quem fica$/ })).not.toBeChecked();
  });
});
