import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TarefasDoAtendimento } from "@/components/inbox/TarefasDoAtendimento";

/**
 * "Tarefas deste contato" no painel do Inbox (porte do upstream #2842).
 *
 * Prende o vínculo (a tarefa criada no Inbox sai com o `contact_id` da conversa
 * e o `lead_id` do negócio ativo), a consulta (só as abertas DESTE contato) e o
 * portão de papel (viewer e suporte só leem).
 */
const EU = "u-eu";
const papel = vi.hoisted(() => ({ role: "agent" as string }));
const hook = vi.hoisted(() => ({ criarTarefa: vi.fn(async () => ({})), chamadas: [] as unknown[][] }));

vi.mock("@/hooks/tasks/useTasks", () => ({
  useTasks: (...args: unknown[]) => {
    hook.chamadas.push(args);
    return {
      tarefas: [],
      carregando: false,
      falhou: false,
      recarregar: vi.fn(),
      criarTarefa: hook.criarTarefa,
      editarTarefa: vi.fn(),
      apagarTarefa: vi.fn(),
      alternarConcluida: vi.fn(),
    };
  },
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ user: { id: EU, is_platform_admin: false }, activeOrg: { orgId: "o1", role: papel.role } }),
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ isSuccess: true, data: [{ user_id: EU, role: "agent", full_name: "Eu" }] }),
}));

beforeEach(() => {
  papel.role = "agent";
  hook.chamadas = [];
  vi.clearAllMocks();
});

describe("TarefasDoAtendimento", () => {
  it("cria a tarefa presa ao contato da conversa e ao negócio ativo, sem sair do Inbox", async () => {
    render(<TarefasDoAtendimento contactId="c-1" leadId="l-1" readonly={false} />);
    expect(hook.chamadas.at(-1)).toEqual([{ contact_id: "c-1", aberto: true }]);

    await userEvent.click(screen.getByRole("button", { name: "Nova tarefa" }));
    await userEvent.type(screen.getByLabelText("O que precisa ser feito"), "Te chamo amanhã");
    await userEvent.click(screen.getByRole("button", { name: "Salvar" }));

    expect(hook.criarTarefa).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Te chamo amanhã", contact_id: "c-1", lead_id: "l-1", assigned_to: EU }),
    );
  });

  it("viewer e suporte em leitura não veem 'Nova tarefa'", () => {
    papel.role = "viewer";
    const { unmount } = render(<TarefasDoAtendimento contactId="c-1" leadId={null} readonly={false} />);
    expect(screen.queryByRole("button", { name: "Nova tarefa" })).toBeNull();
    unmount();
    papel.role = "admin";
    render(<TarefasDoAtendimento contactId="c-1" leadId={null} readonly />);
    expect(screen.queryByRole("button", { name: "Nova tarefa" })).toBeNull();
  });
});
