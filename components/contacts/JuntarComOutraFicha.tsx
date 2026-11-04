"use client";
/**
 * JuntarComOutraFicha — juntar a ficha aberta com outra, a partir da própria
 * ficha (porte do #3640). O gestor acha a outra por nome ou telefone, confere
 * as duas lado a lado e junta com a mesma confirmação nomeada do `MergeDialog`.
 *
 * A fusão é o mesmo `POST /api/v1/contacts/merge` (que recusa absorver a ficha
 * ligada ao prontuário e passa as travas da IA para quem fica). "Este fica"
 * começa na ficha ligada ao prontuário, ou na que tem CPF, mesmo quando o gestor
 * partiu da outra; senão, na ficha aberta. Quando a ficha aberta é a absorvida,
 * a tela vai para a que ficou.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/hooks/i18n/useT";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ComparacaoDeFichas } from "@/components/contacts/ComparacaoDeFichas";
import { ConfirmarJuncao, avisarResultadoDaJuncao } from "@/components/contacts/ConfirmarJuncao";
import { useCompararFichas } from "@/hooks/contacts/useCompararFichas";
import { useContactList } from "@/hooks/contacts/useContactList";
import { useMergeContacts } from "@/hooks/contacts/useMergeContacts";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { avisosDaJuncao, motivoQueImpedeAJuncao, quemFicaPorPadrao } from "@/lib/contacts/juncao";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { buscaValeConsulta } from "@/lib/inbox/termo-de-busca";
import type { Contact } from "@/lib/types/contacts";

type FichaAtual = Pick<Contact, "id" | "name" | "display_name" | "phone_number">;

interface Props {
  contatoAtual: FichaAtual;
  open: boolean;
  onOpenChange: (aberto: boolean) => void;
}

/** O intervalo entre a última tecla e a busca. */
const ESPERA_DA_BUSCA_MS = 300;

/** Montada só com um termo que vale consulta: antes disso, nada vai ao servidor. */
function ResultadosDaBusca({
  busca,
  contatoAtualId,
  onComparar,
}: {
  busca: string;
  contatoAtualId: string;
  onComparar: (c: Contact) => void;
}) {
  const t = useT();
  const q = useContactList({ search: busca, limit: 10 });

  if (q.isLoading) return <Skeleton className="h-16 w-full" />;
  if (q.isError) return <p className="text-sm text-error-fg">{t("Não foi possível buscar agora.")}</p>;

  // Anonimizada ou já absorvida não é ficha que se junta (a fusão recusaria).
  const candidatos = (q.data?.pages.flatMap((p) => p.data) ?? []).filter(
    (c) => c.id !== contatoAtualId && !c.is_anonymized && !c.is_merged_into,
  );
  if (candidatos.length === 0) {
    return <p className="py-4 text-center text-sm text-muted-foreground">{t("Nenhuma ficha encontrada.")}</p>;
  }

  return (
    <ul className="divide-y divide-border">
      {candidatos.map((c) => (
        <li key={c.id} className="flex items-center justify-between gap-3 py-2">
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{rotuloDoContato(c, t)}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {c.phone_number ? phoneForDisplay(c.phone_number) : (c.email ?? "—")}
            </span>
          </span>
          <Button size="sm" variant="outline" onClick={() => onComparar(c)}>
            {t("Comparar")}
          </Button>
        </li>
      ))}
    </ul>
  );
}

export function JuntarComOutraFicha({ contatoAtual, open, onOpenChange }: Props) {
  const t = useT();
  const router = useRouter();
  const merge = useMergeContacts();
  const [termo, setTermo] = useState("");
  const [busca, setBusca] = useState("");
  const [escolhida, setEscolhida] = useState<Contact | null>(null);
  const [escolhido, setEscolhido] = useState<string | null>(null);
  const [confirmando, setConfirmando] = useState(false);

  useEffect(() => {
    const h = setTimeout(() => setBusca(termo.trim()), ESPERA_DA_BUSCA_MS);
    return () => clearTimeout(h);
  }, [termo]);

  const comparacao = useCompararFichas(escolhida ? [contatoAtual.id, escolhida.id] : null);
  const fichas = comparacao.data?.data.contatos ?? [];
  const atual = fichas.find((f) => f.id === contatoAtual.id);
  const outra = escolhida ? fichas.find((f) => f.id === escolhida.id) : undefined;
  const principal = escolhido ?? (atual && outra ? quemFicaPorPadrao(atual, outra, contatoAtual.id) : contatoAtual.id);
  const fica = principal === contatoAtual.id ? atual : outra;
  const sai = principal === contatoAtual.id ? outra : atual;
  const impede = fica && sai ? motivoQueImpedeAJuncao(fica, sai, t) : null;
  const avisos = fica && sai ? avisosDaJuncao(fica, sai, t) : [];

  function voltarABusca() {
    setEscolhida(null);
    setEscolhido(null);
    setConfirmando(false);
  }

  function fechar(aberto: boolean) {
    if (!aberto) {
      setTermo("");
      setBusca("");
      voltarABusca();
    }
    onOpenChange(aberto);
  }

  async function juntar() {
    if (!fica || !sai) return;
    setConfirmando(false);
    try {
      const res = await merge.mutateAsync({ primary_contact_id: fica.id, secondary_contact_ids: [sai.id] });
      avisarResultadoDaJuncao(res.data, t);
      fechar(false);
      // A ficha aberta virou lápide: a tela vai para a que ficou.
      if (sai.id === contatoAtual.id) router.push(`/app/contacts/${fica.id}`);
    } catch {
      /* showApiError já falou no toast */
    }
  }

  return (
    <Dialog open={open} onOpenChange={fechar}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("Juntar com outra ficha")}</DialogTitle>
          <DialogDescription>
            {t("Escolha a ficha que vai ser absorvida. Confira os dois cadastros antes de juntar.")}
          </DialogDescription>
        </DialogHeader>

        {escolhida === null ? (
          <div className="space-y-3">
            <Input
              type="search"
              value={termo}
              onChange={(e) => setTermo(e.target.value)}
              placeholder={t("Buscar por nome ou telefone…")}
              aria-label={t("Buscar por nome ou telefone…")}
              autoFocus
            />
            {buscaValeConsulta(busca) ? (
              <ResultadosDaBusca
                busca={busca}
                contatoAtualId={contatoAtual.id}
                onComparar={(c) => {
                  setEscolhida(c);
                  setEscolhido(null);
                }}
              />
            ) : (
              <p className="text-sm text-muted-foreground">{t("Digite um nome ou telefone para achar a outra ficha.")}</p>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <ComparacaoDeFichas
              ids={[contatoAtual.id, escolhida.id]}
              principalId={principal}
              onEscolherPrincipal={setEscolhido}
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button variant="ghost" size="sm" onClick={voltarABusca}>
                {t("Voltar à busca")}
              </Button>
              {impede ? <p className="text-xs text-warning-fg">{impede}</p> : null}
              <Button
                size="sm"
                onClick={() => setConfirmando(true)}
                disabled={merge.isPending || !fica || !sai || impede !== null}
              >
                {merge.isPending ? t("Juntando…") : t("Juntar")}
              </Button>
            </div>
            <ConfirmarJuncao
              aberto={confirmando}
              onAbertoChange={setConfirmando}
              nomeDeQuemFica={rotuloDoContato(fica, t)}
              nomesAbsorvidos={rotuloDoContato(sai, t)}
              pendente={merge.isPending}
              onConfirmar={() => void juntar()}
              avisos={avisos}
            />
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => fechar(false)}>
            {t("Fechar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
