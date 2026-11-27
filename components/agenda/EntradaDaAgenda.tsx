"use client";
import { useSearchParams, useRouter } from "next/navigation";
import { usePermission } from "@/hooks/auth/AuthProvider";
import { useEffect } from "react";
import { DetalheDoCompromisso, type RemarcacaoDoPainel } from "./DetalheDoCompromisso";
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
  const podeEditar = usePermission("inbox.reply");
  const podeExcluir = usePermission("agenda.appointment.exclude");
  const podeCompletarNome = usePermission("contact.update");
  const params = useSearchParams();
  const router = useRouter();
  const contact = params.get("contato");
  const conversation = params.get("conversa");
  // ⚠️ SEMPRE avisa, inclusive quando a rota NÃO traz contexto.
  //
  // Era `if (contact) onContext(...)`, e a guarda era o defeito: quem abria
  // "Marcar compromisso" de dentro de uma conversa e depois ia para a Agenda
  // pelo menu continuava com aquele cliente no painel. A rota mudava
  // (`?contato=` sumia), mas esta é a MESMA rota do App Router — o componente
  // não remonta, só a query muda —, e sem a chamada ninguém contava ao painel
  // que o contexto tinha acabado. Quem decide abrir é o `onContext`, pelo
  // valor de `contact`; aqui é só o recado.
  useEffect(() => {
    onContext(contact ?? "", conversation ?? "");
  }, [contact, conversation, onContext]);
  return (
    <DetalheDoCompromisso
      key={params.get("compromisso")}
      podeEditar={podeEditar}
      podeExcluir={podeExcluir}
      podeCompletarNome={podeCompletarNome}
      profissional={profissional}
      remarcacao={remarcacao}
      id={params.get("compromisso")}
      onClose={() => {
        // O `?tipo=` escolhido na grade ATRAVESSA o fecho do detalhe: sem
        // esta linha, abrir um compromisso e fechar apagava a query inteira —
        // inclusive o tipo — e o F5 seguinte voltava ao primeiro (#1657).
        // Os demais parâmetros continuam fora, como sempre: fechar é voltar
        // para a agenda limpa.
        const tipo = params.get("tipo");
        router.replace(tipo ? `/app/agenda?tipo=${encodeURIComponent(tipo)}` : "/app/agenda");
      }}
    />
  );
}
