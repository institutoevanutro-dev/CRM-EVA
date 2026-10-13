"use client";

import { useId, useState, useTransition } from "react";
import Link from "next/link";

import {
  contarPacientesPeloCadastro,
  definirPacientePeloCadastro,
  type ErroPacientePeloCadastro,
  type ResultadoPacientePeloCadastro,
} from "@/app/actions/settings/definirPacientePeloCadastro";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";

/**
 * PACIENTES PELO CADASTRO: o interruptor da regra da migration 0360.
 *
 * Mora logo abaixo de "Clientes pela agenda" porque responde à mesma pergunta
 * (quem entra pelo funil de clientes) por outro fato: o cadastro, e não o
 * horário marcado. As duas são independentes.
 *
 * ⚠️ O NÚMERO VEM ANTES DE CONFIRMAR. Ligar o interruptor primeiro CONTA (a
 * action de prévia não grava nada) e só então abre o diálogo, com quantos
 * contatos a regra alcança e o aviso de que nenhum é alterado. Uma recusa (papel,
 * verificação em duas etapas) aparece nesse passo, antes do diálogo.
 *
 * ⚠️ DESLIGAR NÃO PEDE CONFIRMAÇÃO: a regra não escreve em contato nenhum, então
 * não há o que desfazer nem o que perder.
 */

/** A frase de cada recusa. Textos que o produto já usa em outras telas. */
const TEXTO_DO_ERRO: Record<ErroPacientePeloCadastro, string> = {
  sessao: "Sua sessão expirou. Entre de novo.",
  somente_leitura: "Acompanhamento somente leitura ou encerrado.",
  sem_empresa: "Nenhuma empresa ativa.",
  sem_permissao: "Só um administrador pode mudar essa regra.",
  mfa: "Confirme a verificação em duas etapas.",
  falha: "Não consegui salvar essa mudança agora.",
};

function frasesDaContagem(r: ResultadoPacientePeloCadastro, t: (texto: string) => string) {
  const alcance =
    r.pacientes > 1
      ? t(
          "{n} contatos têm cadastro de paciente e passam a entrar pelo funil de clientes quando escreverem.",
        ).replace("{n}", String(r.pacientes))
      : r.pacientes === 1
        ? t(
            "1 contato tem cadastro de paciente e passa a entrar pelo funil de clientes quando escrever.",
          )
        : t(
            "Nenhum contato tem cadastro de paciente ainda. Quem ganhar CPF ou for ligado ao prontuário daqui em diante passa a entrar pelo funil de clientes.",
          );
  const jaEram =
    r.ja_clientes_pela_agenda > 1
      ? t("{k} deles já entravam por ter horário marcado.").replace(
          "{k}",
          String(r.ja_clientes_pela_agenda),
        )
      : r.ja_clientes_pela_agenda === 1
        ? t("1 deles já entrava por ter horário marcado.")
        : null;
  return { alcance, jaEram };
}

export function PacientePeloCadastro({
  ligadoInicial,
  podeLigar,
}: {
  ligadoInicial: boolean;
  /** Espelha o papel `admin` que `fn_definir_paciente_pelo_cadastro` cobra. Cortesia, não autorização. */
  podeLigar: boolean;
}) {
  const t = useT();
  const idDoRotulo = useId();
  const [ligado, setLigado] = useState(ligadoInicial);
  /** A contagem que o diálogo mostra. Não nula = diálogo aberto. */
  const [previa, setPrevia] = useState<ResultadoPacientePeloCadastro | null>(null);
  /** `false` só depois de o banco dizer que não há funil de clientes marcado. */
  const [temFunil, setTemFunil] = useState<boolean | null>(null);
  const [erro, setErro] = useState<ErroPacientePeloCadastro | null>(null);
  const [salvando, iniciar] = useTransition();

  function aoMudar(novo: boolean) {
    setErro(null);
    iniciar(async () => {
      const r = novo ? await contarPacientesPeloCadastro() : await definirPacientePeloCadastro(false);
      if (!r.ok) {
        setErro(r.erro);
        return;
      }
      setTemFunil(r.tem_funil_de_clientes);
      if (novo) setPrevia(r);
      else setLigado(r.ligado);
    });
  }

  function confirmar() {
    setPrevia(null);
    iniciar(async () => {
      const r = await definirPacientePeloCadastro(true);
      if (!r.ok) {
        setErro(r.erro);
        return;
      }
      setLigado(r.ligado);
      setTemFunil(r.tem_funil_de_clientes);
    });
  }

  const frases = previa ? frasesDaContagem(previa, t) : null;
  const avisoSemFunil = t(
    "Nenhum funil está marcado como funil de clientes. Até marcar um, todos continuam entrando pelo funil padrão.",
  );

  return (
    <section className="space-y-3 rounded-xl border p-4" data-testid="paciente-pelo-cadastro">
      <h2 className="font-semibold">{t("Pacientes pelo cadastro")}</h2>

      <div className="flex items-center gap-3">
        <Switch
          checked={ligado}
          onCheckedChange={aoMudar}
          disabled={!podeLigar || salvando}
          aria-labelledby={idDoRotulo}
          data-testid="paciente-pelo-cadastro-interruptor"
        />
        <span id={idDoRotulo} className="text-sm font-medium">
          {t("Quem já tem cadastro de paciente entra pelo funil de clientes")}
        </span>
      </div>

      <p className="text-sm text-text-muted">
        {t(
          "Com isto ligado, o contato que já tem cadastro de paciente (ligado ao prontuário, ou com CPF guardado) é tratado como cliente quando escreve: o card nasce no funil de clientes, e não no de entrada, mesmo sem horário marcado aqui. Vale para os cards novos; os que já existem não mudam de funil.",
        )}
      </p>

      <p className="text-sm" data-testid="paciente-pelo-cadastro-estado">
        {ligado
          ? t("Ligado: quem tem cadastro de paciente entra pelo funil de clientes.")
          : t("Desligado: o cadastro de paciente não muda o funil de ninguém.")}
      </p>

      <p className="text-sm text-text-muted">
        {t(
          "Esta opção não põe a etiqueta “cliente” em ninguém e não mexe em “Cliente desde”: as duas continuam sendo da regra da agenda. Na lista de contatos, quem entra por aqui aparece com o selo “Cliente”. Quem escreve de um número que não está no cadastro chega como contato novo e entra pelo funil padrão, mesmo sendo paciente.",
        )}
      </p>

      {!podeLigar && (
        <p className="text-sm text-text-muted">{t("Só um administrador pode mudar essa regra.")}</p>
      )}

      {ligado && temFunil === false && (
        <p role="status" className="text-sm" data-testid="paciente-pelo-cadastro-sem-funil">
          {avisoSemFunil}{" "}
          <Link href="/app/kanban" className="underline">
            {t("Abrir Funis")}
          </Link>
        </p>
      )}

      {erro && (
        <p role="alert" className="text-sm text-destructive" data-testid="paciente-pelo-cadastro-erro">
          {t(TEXTO_DO_ERRO[erro])}
        </p>
      )}

      <AlertDialog open={previa !== null} onOpenChange={(aberto) => !aberto && setPrevia(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Ligar pacientes pelo cadastro?")}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2" data-testid="paciente-pelo-cadastro-previa">
                {frases && <p>{frases.alcance}</p>}
                {frases?.jaEram && <p>{frases.jaEram}</p>}
                <p>
                  {t(
                    "Nenhum contato é alterado: não entra etiqueta nem data. Os cards que já existem ficam onde estão, e desligar depois volta tudo ao que era.",
                  )}
                </p>
                {previa?.tem_funil_de_clientes === false && <p>{avisoSemFunil}</p>}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <Button onClick={confirmar} data-testid="paciente-pelo-cadastro-confirmar">
              {t("Ligar")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
