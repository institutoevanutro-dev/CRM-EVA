"use client";
/**
 * Configuração de campanhas — as três coisas que valem para TODAS elas.
 *
 * ═══ Por que uma tela e não três ═══
 *
 * "Cadê a tela de configuração das campanhas?" foi a pergunta que a criou. Três
 * telas separadas (padrões, textos, exclusões) seriam três lugares para
 * procurar, e a pessoa que pergunta isso está procurando UM. O que as une é o
 * escopo: nada aqui pertence a uma campanha, tudo vale para a próxima também.
 *
 * ═══ O que NÃO está aqui, e onde está ═══
 *
 * A proteção do NÚMERO — intervalo, janela, teto diário e aquecimento — vive em
 * Conexões › Proteção de envio, porque protege o número inteiro, inclusive o
 * que o agente manda. Esta tela guarda o padrão da CAMPANHA, e campanha só sabe
 * ir mais devagar que o número. O link está escrito na própria seção: mandar
 * alguém procurar é o mesmo defeito que criou esta tela.
 */
import Link from "next/link";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  useApagarTexto,
  useConfiguracaoDeCampanhas,
  useExclusoes,
  useExcluirNumero,
  useSalvarConfiguracao,
  useSalvarTexto,
  useTextosSalvos,
  useTirarDaExclusao,
} from "@/hooks/campanhas/useConfiguracao";
import { useT } from "@/hooks/i18n/useT";
import { ArrowBendUpLeft } from "@/lib/ui/icons";

import {
  CamposDeRitmo,
  RITMO_EM_BRANCO,
  errosDoRitmo,
  ritmoNosCampos,
  ritmoParaEnviar,
} from "../_components/CamposDeRitmo";

export function ConfiguracaoDeCampanhas() {
  const t = useT();
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        <Link
          href="/app/campaigns"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-text"
        >
          <ArrowBendUpLeft size={14} aria-hidden />
          {t("Campanhas")}
        </Link>
      </div>
      <header>
        <h1 className="titulo-tela">{t("Configuração de campanhas")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("O que vale para todas as campanhas, e não para uma só.")}
        </p>
      </header>

      <Padroes />
      <TextosSalvos />
      <ListaDeExclusao />
    </div>
  );
}

function Padroes() {
  const t = useT();
  const q = useConfiguracaoDeCampanhas();
  const salvar = useSalvarConfiguracao();
  const [atribuicao, setAtribuicao] = useState("");
  const [ritmo, setRitmo] = useState(RITMO_EM_BRANCO);
  const [carregado, setCarregado] = useState(false);

  useEffect(() => {
    const c = q.data?.configuracao;
    if (!c || carregado) return;
    setAtribuicao(String(c.atribuicao_horas));
    setRitmo(ritmoNosCampos(c));
    setCarregado(true);
  }, [q.data, carregado]);

  // Falha ANTES de "carregando": sem isto, um erro deixava o cartão no cinza
  // para sempre, sem "Tentar novamente" (auditoria de 17/11/2026, item 27).
  if (q.isError) return <FalhaAoCarregar onTentar={() => void q.refetch()} />;
  if (q.isLoading || !carregado) return <Skeleton className="h-64 w-full" />;

  const temErro = Object.keys(errosDoRitmo(ritmo)).length > 0;

  return (
    <Card className="space-y-4 p-4">
      <div>
        <h2 className="font-medium">{t("Padrões desta organização")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("Campo vazio significa herdar o número. Toda campanha nova nasce com estes valores e pode ficar mais devagar, nunca mais rápida.")}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="atribuicao">{t("Contar como resposta até (horas depois do envio)")}</Label>
        <Input
          id="atribuicao"
          type="number"
          min={1}
          max={720}
          value={atribuicao}
          onChange={(e) => setAtribuicao(e.target.value)}
        />
        <p className="text-sm text-muted-foreground">
          {t("Uma mensagem que chega depois desse prazo é conversa nova, não resposta à campanha. Isso muda o número de respostas que a tela mostra, inclusive das campanhas já enviadas.")}
        </p>
      </div>

      <CamposDeRitmo prefixo="p" valores={ritmo} onChange={setRitmo} />

      <p className="text-sm text-muted-foreground">
        {t("A proteção do número — ritmo, janela e aquecimento que valem para tudo que sai por ele — fica em")}{" "}
        <Link href="/app/connections" className="underline">
          {t("Conexões › Proteção de envio")}
        </Link>
        .
      </p>

      <div className="flex items-center gap-3">
        <Button
          size="sm"
          disabled={salvar.isPending || temErro}
          onClick={() =>
            salvar.mutate({
              atribuicao_horas: Number(atribuicao) || 72,
              ...ritmoParaEnviar(ritmo),
            })
          }
        >
          {salvar.isPending ? t("Salvando…") : t("Salvar padrões")}
        </Button>
        {salvar.isSuccess && !salvar.isPending && (
          <span className="text-sm text-success-fg">{t("Padrões salvos.")}</span>
        )}
      </div>
    </Card>
  );
}

function TextosSalvos() {
  const t = useT();
  const q = useTextosSalvos();
  const salvar = useSalvarTexto();
  const apagar = useApagarTexto();
  const [nome, setNome] = useState("");
  const [corpo, setCorpo] = useState("");

  return (
    <Card className="space-y-4 p-4">
      <div>
        <h2 className="font-medium">{t("Textos salvos")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("Textos que você reusa entre campanhas: aparecem em Usar texto salvo, na hora de escrever. Mudar um texto aqui não muda mensagem já preparada nem enviada.")}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="t-nome">{t("Nome")}</Label>
        <Input id="t-nome" value={nome} onChange={(e) => setNome(e.target.value)} placeholder={t("Ex.: Retorno de consulta")} />
        <Label htmlFor="t-corpo">{t("Texto")}</Label>
        <Textarea id="t-corpo" rows={4} value={corpo} onChange={(e) => setCorpo(e.target.value)} />
        <Button
          size="sm"
          disabled={nome.trim() === "" || corpo.trim() === "" || salvar.isPending}
          onClick={async () => {
            await salvar.mutateAsync({ name: nome.trim(), body: corpo.trim() });
            setNome("");
            setCorpo("");
          }}
        >
          {salvar.isPending ? t("Salvando…") : t("Salvar texto")}
        </Button>
      </div>

      {q.isError && <FalhaAoCarregar onTentar={() => void q.refetch()} />}
      <div className="divide-y divide-border">
        {(q.data ?? []).map((texto) => (
          <div key={texto.id} className="flex items-start justify-between gap-3 py-2">
            <div className="min-w-0">
              <p className="font-medium">{texto.name}</p>
              {/* Inteiro: cortado numa linha, ninguém sabia qual texto era qual (item 20). */}
              <p className="text-sm whitespace-pre-wrap break-words text-muted-foreground">{texto.body}</p>
            </div>
            <Button size="sm" variant="outline" disabled={apagar.isPending} onClick={() => apagar.mutate(texto.id)}>
              {t("Apagar")}
            </Button>
          </div>
        ))}
        {(q.data ?? []).length === 0 && !q.isLoading && !q.isError && (
          <p className="py-2 text-sm text-muted-foreground">{t("Nenhum texto salvo ainda.")}</p>
        )}
      </div>
    </Card>
  );
}

function ListaDeExclusao() {
  const t = useT();
  const q = useExclusoes();
  const excluir = useExcluirNumero();
  const tirar = useTirarDaExclusao();
  const [telefone, setTelefone] = useState("");
  const [motivo, setMotivo] = useState("");

  return (
    <Card className="space-y-4 p-4">
      <div>
        <h2 className="font-medium">{t("Lista de exclusão")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("Números que nenhuma campanha alcança. Diferente de quem pediu para parar: aqui o atendimento continua normal se a pessoa escrever — isto é uma decisão sua, não dela.")}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="x-tel">{t("Telefone com DDI e DDD")}</Label>
          <Input id="x-tel" value={telefone} onChange={(e) => setTelefone(e.target.value)} placeholder="+5548999990000" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="x-motivo">{t("Motivo (opcional)")}</Label>
          <Input id="x-motivo" value={motivo} onChange={(e) => setMotivo(e.target.value)} />
        </div>
      </div>
      <Button
        size="sm"
        disabled={telefone.trim() === "" || excluir.isPending}
        onClick={async () => {
          await excluir.mutateAsync({ address: telefone.trim(), reason: motivo.trim() || null });
          setTelefone("");
          setMotivo("");
        }}
      >
        {excluir.isPending ? t("Salvando…") : t("Excluir das campanhas")}
      </Button>

      {q.isError && <FalhaAoCarregar onTentar={() => void q.refetch()} />}
      <div className="divide-y divide-border">
        {(q.data ?? []).map((e) => (
          <div key={e.id} className="flex items-center justify-between gap-3 py-2 text-sm">
            <span>
              {/* Só os últimos dígitos: o número inteiro não volta do servidor. */}
              {t("termina em")} {e.address_tail ?? "—"}
              {e.reason ? ` · ${e.reason}` : ""}
            </span>
            <Button size="sm" variant="outline" disabled={tirar.isPending} onClick={() => tirar.mutate(e.id)}>
              {t("Tirar da lista")}
            </Button>
          </div>
        ))}
        {(q.data ?? []).length === 0 && !q.isLoading && !q.isError && (
          <p className="py-2 text-sm text-muted-foreground">{t("Nenhum número excluído.")}</p>
        )}
      </div>
    </Card>
  );
}

/** Erro de carga com saída: "vazio" e "não carregou" não podem ter a mesma cara. */
function FalhaAoCarregar({ onTentar }: { onTentar: () => void }) {
  const t = useT();
  return (
    <Card className="p-6 text-center">
      <p className="text-sm text-error-fg">{t("Não foi possível carregar.")}</p>
      <Button size="sm" variant="outline" className="mt-2" onClick={onTentar}>
        {t("Tentar novamente")}
      </Button>
    </Card>
  );
}
