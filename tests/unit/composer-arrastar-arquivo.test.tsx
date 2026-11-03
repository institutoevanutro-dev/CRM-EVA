import { createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ARRASTAR UM ARQUIVO PARA A CAIXA DE MENSAGEM (porte do original #3713, issue #3708).
 *
 * O risco não é o gesto, é um SEGUNDO CAMINHO: um drop com upload próprio
 * divergiria do "+" no tipo, no tamanho, na prévia e, principalmente, no
 * bloqueio — o `disabled` do botão não impede ninguém de soltar um arquivo em
 * cima da caixa. Por isso tudo aqui é medido pelo que chega à prévia REAL e
 * pelo que sai do Enviar dela (só a borda de rede é mockada).
 *
 * O fork tem UM anexo por vez (`pendingFile`): vários arquivos de uma vez
 * são recusados com aviso, em vez de um envio parcial parecer completo.
 */

const uploadResult = {
  storage_path: "org/conv-1/doc-ficticio.pdf",
  media_mime: "application/pdf",
  media_size_bytes: 17,
  kind: "document" as const,
};
const uploadMock = vi.fn(
  async (_args: { conversationId: string; file: File; destino?: string }) => uploadResult,
);
const sendMock = vi.fn();
const createNoteMock = vi.fn();

vi.mock("@/hooks/inbox/useUploadMedia", () => ({
  useUploadMedia: () => ({ mutateAsync: uploadMock, isPending: false }),
}));
vi.mock("@/hooks/inbox/useSendMessage", () => ({
  useSendMessage: () => ({ mutate: sendMock, isPending: false }),
}));
vi.mock("@/hooks/inbox/useCreateNote", () => ({
  useCreateNote: () => ({ mutate: createNoteMock, isPending: false }),
}));
// A fixture exercita um atendente autorizado a consultar modelos de mensagem.
vi.mock("@/hooks/auth/AuthProvider", () => ({ usePermission: () => true }));

import { Composer } from "@/components/inbox/Composer";

const aviso = vi.spyOn(toast, "warning").mockImplementation(() => 0);

type Props = Partial<ComponentProps<typeof Composer>>;

function montar(props: Props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (p: Props) => (
    <QueryClientProvider client={qc}>
      <Composer
        conversationId="conv-1"
        contact={{ name: "Paciente Fictícia", display_name: null }}
        {...p}
      />
    </QueryClientProvider>
  );
  const tela = render(ui(props));
  // Mesmo QueryClient: troca só as props, como o Inbox faz ao trocar de conversa.
  return { ...tela, trocar: (p: Props) => tela.rerender(ui({ ...props, ...p })) };
}

const arquivoDe = (nome: string, tipo = "application/pdf", conteudo = "conteudo ficticio") =>
  new File([conteudo], nome, { type: tipo });

const area = () => screen.getByTestId("composer");
const realce = () => screen.queryByTestId("arraste-de-arquivo");
const notaInterna = () => fireEvent.click(screen.getByRole("button", { name: /nota interna/i }));

/** O arraste de ARQUIVO por cima da caixa, como o navegador entrega antes do drop. */
function arrastarArquivo(alvo: HTMLElement = area()) {
  fireEvent.dragEnter(alvo, { dataTransfer: { types: ["Files"] } });
  return fireEvent.dragOver(alvo, { dataTransfer: { types: ["Files"] } });
}

function soltar(alvo: HTMLElement, arquivos: File[]) {
  return fireEvent.drop(alvo, { dataTransfer: { types: ["Files"], files: arquivos } });
}

/**
 * Um dragover medido pelo EVENTO: se foi cancelado e o `dropEffect` que algum
 * handler escreveu (o cursor que a pessoa vê). Lido do evento, e não do objeto
 * passado, para valer com ou sem `DataTransfer` de verdade no jsdom.
 */
function dragOverMedido(alvo: Element, types: string[]) {
  const ev = createEvent.dragOver(alvo, { dataTransfer: { types } });
  fireEvent(alvo, ev);
  const dt = (ev as Event & { dataTransfer?: { dropEffect?: string } }).dataTransfer;
  return { prevented: ev.defaultPrevented, dropEffect: dt?.dropEffect };
}

/** O que a prévia mostra e o que sai do Enviar dela. */
async function percorrerPrevia() {
  const dialog = await screen.findByRole("dialog");
  const previa = {
    nome: within(dialog).getByText(/\.pdf$/).textContent,
    para:
      document.getElementById(dialog.getAttribute("aria-describedby") ?? "")?.textContent ?? null,
  };
  fireEvent.click(within(dialog).getByRole("button", { name: /^enviar$/i }));
  await waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
  const upload = uploadMock.mock.calls[0]![0];
  return {
    previa,
    upload: {
      conversationId: upload.conversationId,
      nome: upload.file.name,
      destino: upload.destino,
    },
    envio: sendMock.mock.calls[0]![0] as Record<string, unknown>,
  };
}

beforeEach(() => {
  uploadMock.mockClear();
  sendMock.mockClear();
  createNoteMock.mockClear();
  aviso.mockClear();
});

describe("o drop cai no MESMO caminho de anexo do botão", () => {
  it("⭐ clique e drop produzem a mesma prévia e o mesmo upload", async () => {
    const arquivo = arquivoDe("exame-ficticio.pdf");

    // ── pelo "+" ──────────────────────────────────────────────────────────
    const peloBotao = montar();
    const inputDoc = document.querySelector('input[accept^=".pdf"]') as HTMLInputElement;
    fireEvent.change(inputDoc, { target: { files: [arquivo] } });
    const caminhoDoBotao = await percorrerPrevia();
    // O `send` mockado nunca confirma, então a prévia não fecharia: sem
    // desmontar, a guarda `!pendingFile` recusaria o drop logo abaixo.
    peloBotao.unmount();
    uploadMock.mockClear();
    sendMock.mockClear();

    // ── pelo drop ─────────────────────────────────────────────────────────
    montar();
    arrastarArquivo();
    soltar(area(), [arquivo]);
    const caminhoDoDrop = await percorrerPrevia();

    expect(caminhoDoDrop).toEqual(caminhoDoBotao);
    expect(caminhoDoDrop.previa).toEqual({
      nome: "exame-ficticio.pdf",
      para: "Para: Paciente Fictícia",
    });
    expect(caminhoDoDrop.upload).toEqual({
      conversationId: "conv-1",
      nome: "exame-ficticio.pdf",
      destino: "mensagem",
    });
    expect(caminhoDoDrop.envio).toEqual({
      conversation_id: "conv-1",
      type: "document",
      body: undefined,
      media_storage_path: uploadResult.storage_path,
      media_mime: uploadResult.media_mime,
      media_size_bytes: uploadResult.media_size_bytes,
    });
    expect(uploadMock).toHaveBeenCalledTimes(1);
  });

  it("em NOTA INTERNA o drop sai pela rota da nota, e nunca para o paciente", async () => {
    montar();
    notaInterna();
    soltar(area(), [arquivoDe("foto-ficticia.png", "image/png")]);

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleDescription("Nota interna · só o time vê");
    fireEvent.click(within(dialog).getByRole("button", { name: /^enviar$/i }));

    await waitFor(() =>
      expect(createNoteMock).toHaveBeenCalledWith(
        expect.objectContaining({
          conversation_id: "conv-1",
          anexo: expect.objectContaining({ storage_path: uploadResult.storage_path }),
        }),
        expect.anything(),
      ),
    );
    expect(uploadMock).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conv-1", destino: "nota" }),
    );
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("vários arquivos de uma vez: aviso, e nenhum é anexado", () => {
    montar();
    soltar(area(), [arquivoDe("exame-a-ficticio.pdf"), arquivoDe("exame-b-ficticio.pdf")]);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(aviso).toHaveBeenCalledWith("Solte um arquivo por vez.");
    expect(uploadMock).not.toHaveBeenCalled();
  });
});

describe("a caixa travada não aceita drop — as mesmas travas do botão", () => {
  it("⭐ conversa encerrada: sem realce, sem prévia, nada sobe", () => {
    montar({ disabled: true });

    // Prometer que aceita e depois ignorar o arquivo seria pior que não avisar.
    arrastarArquivo();
    expect(realce()).toBeNull();

    soltar(area(), [arquivoDe("exame-ficticio.pdf")]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(uploadMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    expect(createNoteMock).not.toHaveBeenCalled();
  });

  it("CONTROLE: a mesma tela, aberta, aceita o mesmo drop", async () => {
    montar({ disabled: false });
    soltar(area(), [arquivoDe("exame-ficticio.pdf")]);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("exame-ficticio.pdf")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: /^enviar$/i }));
    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
  });

  it.each([
    ["janela de 24h fechada", { janelaFechada: "A janela de 24h está fechada." }],
    ["canal que só recebe", { semEnvio: "Este canal só recebe mensagens." }],
  ] as const)("⭐ %s barra o drop na RESPOSTA e libera na NOTA", async (_caso, trava) => {
    const resposta = montar(trava);
    soltar(area(), [arquivoDe("exame-ficticio.pdf")]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(uploadMock).not.toHaveBeenCalled();
    resposta.unmount();

    montar(trava);
    notaInterna();
    soltar(area(), [arquivoDe("exame-ficticio.pdf")]);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleDescription("Nota interna · só o time vê");
    fireEvent.click(within(dialog).getByRole("button", { name: /^enviar$/i }));
    await waitFor(() =>
      expect(uploadMock).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: "conv-1", destino: "nota" }),
      ),
    );
  });
});

describe("dragover cancela o padrão — senão o navegador troca o atendimento pelo arquivo", () => {
  it("⭐ o dragover de arquivo é cancelado e o cursor diz 'copiar'", () => {
    montar();
    expect(dragOverMedido(area(), ["Files"])).toEqual({ prevented: true, dropEffect: "copy" });
  });

  it("CONTROLE: arrastar TEXTO não é cancelado — o navegador segue dono do gesto", () => {
    montar();
    expect(fireEvent.dragOver(area(), { dataTransfer: { types: ["text/plain"] } })).toBe(true);
  });

  it("com a caixa travada o padrão também é cancelado, e o cursor diz 'proibido'", () => {
    montar({ disabled: true });
    expect(dragOverMedido(area(), ["Files"])).toEqual({ prevented: true, dropEffect: "none" });
  });
});

describe("o realce da caixa (dragenter/dragleave também disparam nos filhos)", () => {
  it("⭐ um dragleave ao passar para o filho NÃO apaga o realce; sair de fato apaga", () => {
    montar();

    fireEvent.dragEnter(area(), { dataTransfer: { types: ["Files"] } });
    expect(realce()).not.toBeNull();

    // O ponteiro entrou no campo e o dragleave da caixa chegou: o par que faz
    // um booleano piscar.
    fireEvent.dragEnter(screen.getByLabelText("Mensagem"), { dataTransfer: { types: ["Files"] } });
    fireEvent.dragLeave(area(), { dataTransfer: { types: ["Files"] } });
    expect(realce(), "o realce piscou ao passar sobre o campo").not.toBeNull();

    fireEvent.dragLeave(area(), { dataTransfer: { types: ["Files"] } });
    expect(realce()).toBeNull();
  });

  it("o realce some quando o arquivo é solto", () => {
    montar();
    arrastarArquivo();
    expect(realce()).not.toBeNull();

    soltar(area(), [arquivoDe("exame-ficticio.pdf")]);
    expect(realce()).toBeNull();
  });

  it("arrastar texto não acende o realce", () => {
    montar();
    fireEvent.dragEnter(area(), { dataTransfer: { types: ["text/plain"] } });
    expect(realce()).toBeNull();
  });
});

describe("o que o drop NÃO pode atropelar", () => {
  it("soltar texto não vira anexo nem é cancelado", () => {
    montar();
    const naoCancelado = fireEvent.drop(area(), {
      dataTransfer: { types: ["text/plain"], files: [] },
    });

    expect(naoCancelado).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("com a prévia aberta, um segundo drop não substitui a escolha", async () => {
    montar();
    soltar(area(), [arquivoDe("escolhido.pdf")]);
    expect(await screen.findByText("escolhido.pdf")).toBeInTheDocument();

    soltar(area(), [arquivoDe("outro.pdf")]);

    expect(screen.getByText("escolhido.pdf")).toBeInTheDocument();
    expect(screen.queryByText("outro.pdf")).toBeNull();
  });

  it("áudio na RESPOSTA é recusado com aviso; na NOTA ele entra", async () => {
    const audio = arquivoDe("recado-ficticio.mp3", "audio/mpeg");
    montar();
    soltar(area(), [audio]);

    expect(aviso).toHaveBeenCalledWith(
      "Arquivo de áudio não vai na resposta. Grave pelo microfone ou anexe na nota interna.",
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(uploadMock).not.toHaveBeenCalled();

    notaInterna();
    soltar(area(), [audio]);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleDescription("Nota interna · só o time vê");
    expect(within(dialog).getByText("recado-ficticio.mp3")).toBeInTheDocument();
  });

  it.each([
    ["o arraste diz trazer arquivo e não entrega nenhum", []],
    ["o arquivo tem 0 byte", [arquivoDe("vazio-ficticio.pdf", "application/pdf", "")]],
  ] as const)("%s: aviso, e nenhuma prévia", (_caso, arquivos) => {
    montar();
    soltar(area(), [...arquivos]);

    expect(aviso).toHaveBeenCalledWith(
      "Não consegui ler esse arquivo. Salve no computador e arraste de novo, ou use o +.",
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("arquivo solto FORA da caixa não troca a página pelo arquivo", () => {
  it("⭐ o fio, o cabeçalho e o fundo da prévia aberta recusam; texto segue com o navegador", async () => {
    montar();

    // Fora da caixa (no jsdom, o corpo da página): quem recusa é a guarda da janela.
    expect(dragOverMedido(document.body, ["Files"])).toEqual({
      prevented: true,
      dropEffect: "none",
    });
    const drop = createEvent.drop(document.body, {
      dataTransfer: { types: ["Files"], files: [arquivoDe("perdido-ficticio.pdf")] },
    });
    fireEvent(document.body, drop);
    expect(drop.defaultPrevented).toBe(true);

    // CONTROLE: texto e link continuam com o navegador.
    expect(dragOverMedido(document.body, ["text/plain"]).prevented).toBe(false);

    // Com a prévia aberta, o drop cai no fundo escuro dela — também recusado.
    soltar(area(), [arquivoDe("exame-ficticio.pdf")]);
    const dialog = await screen.findByRole("dialog");
    expect(dragOverMedido(dialog, ["Files"])).toEqual({ prevented: true, dropEffect: "none" });
  });
});

describe("a prévia é da conversa em que o anexo foi escolhido", () => {
  it("⭐ trocar de conversa com a prévia aberta a descarta, sem enviar", async () => {
    const tela = montar();
    soltar(area(), [arquivoDe("laudo-ficticio.pdf")]);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    tela.trocar({ conversationId: "conv-2" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(uploadMock).not.toHaveBeenCalled();

    // A prévia foi LIMPA, e não ficou presa: a conversa nova aceita o próximo drop.
    soltar(area(), [arquivoDe("receita-ficticia.pdf")]);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("receita-ficticia.pdf")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: /^enviar$/i }));
    await waitFor(() =>
      expect(uploadMock).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: "conv-2" }),
      ),
    );
  });
});
