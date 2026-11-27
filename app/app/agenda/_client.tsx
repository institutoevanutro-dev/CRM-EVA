"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { EntradaDaAgenda } from "@/components/agenda/EntradaDaAgenda";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";

import { useT } from "@/hooks/i18n/useT";

import { addDays, format, startOfDay, startOfMonth } from "date-fns";
import * as React from "react";

import { AvisoDaConexaoGoogle } from "./_components/AvisoDaConexaoGoogle";
import { CartaoDaConexaoGoogle } from "./_components/CartaoDaConexaoGoogle";

import { AgendaInterativa } from "@/components/agenda/AgendaInterativa";
import { diasDaSemanaDe } from "@/components/agenda/GradeDaAgenda";
import { FiltroDePessoas } from "@/components/agenda/FiltroDePessoas";
import { recorteDaVisao } from "@/lib/agenda/recorte-da-grade";
import type { Agendamento, HorarioLivre, VisaoDaAgenda } from "@/components/agenda/tipos";
import { EmptyAgenda } from "@/components/empty";
import { ancoraAoFecharPainel } from "@/lib/agenda/ancora-depois-de-marcar";
import { duracaoDoBloco, duracaoDoCampo } from "@/lib/agenda/duracao-escolhida";
import { dataDeParede, diaLocalISO, partesNoFuso } from "@/lib/agenda/fuso";
import { janelaDoMesVisivel } from "@/lib/agenda/janela-do-mes-visivel";
import { atendeOProcedimento } from "@/lib/agenda/marcacao-simples";
import { tipoDaRemarcacao } from "@/lib/agenda/tipo-da-remarcacao";
import { ancoraLocalDoDia } from "@/lib/agenda/semana-semente";
import { useVinculoDaMarcacao } from "@/lib/agenda/vinculo-da-marcacao";
import { gravarPessoasDaGrade, lerPessoasDaGrade, pessoasComAtendimento, selecaoValida } from "@/lib/agenda/pessoas-da-grade";
import { Button } from "@/components/ui/button";
import { MarcacaoSimples } from "@/components/agenda/MarcacaoSimples";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAgendamentos } from "@/hooks/agenda/useAgendamentos";
import { useAgendaAoVivo } from "@/hooks/agenda/useAgendaAoVivo";
import { useAgora } from "@/hooks/agenda/useAgora";
import { useFechamentosDaGrade } from "@/hooks/agenda/useFechamentosDaGrade";
import { useHorariosLivres } from "@/hooks/agenda/useHorariosLivres";
import { useMarcarAgendamento } from "@/hooks/agenda/useMarcarAgendamento";
import { usePessoasDaAgenda } from "@/hooks/agenda/usePessoasDaAgenda";
import { CalendarPlus, CaretLeft, CaretRight } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import { apiClient } from "@/lib/api/client";

interface UnidadeDaAgenda { id: string; name: string; active: boolean }

const VISOES: Array<{ id: VisaoDaAgenda; rotulo: string }> = [
  { id: "dia", rotulo: "Dia" },
  { id: "semana", rotulo: "Semana" },
  { id: "mes", rotulo: "Mês" },
];

/**
 * A tela da Agenda.
 *
 * ⚠️ SEM DADO NENHUM até a frente 1 (API + motor) integrar. A tela cai no
 * estado vazio de propósito, e a razão é de SEGURANÇA PERCEBIDA, não de
 * pureza:
 *
 * dado falso PLAUSÍVEL numa tela real de produto multi-tenant é
 * indistinguível de VAZAMENTO. "Ana Prado", "Marina Alves", "Visita ao imóvel"
 * são nomes brasileiros críveis nos nichos que este produto atende — e o
 * relato que chega de quem vê isso não é "tem dado de teste na tela", é
 * "estou vendo paciente de outra clínica na minha agenda". O time então queima
 * horas caçando um furo de RLS que não existe. Achado do QAVivo, decisão 18.
 *
 * Repare na inversão, porque ela é o ponto: os MESMOS nomes são ACERTO na
 * vitrine (`/vitrine-agenda`), onde tornam o desenho julgável, e o pior
 * formato possível aqui. Mesmo dado, valor oposto conforme onde está pendurado.
 *
 * E o vazio é mais VERDADEIRO: numa instalação nova a agenda está vazia mesmo.
 * De quebra exercita o estado vazio, que é onde mora a primeira impressão.
 *
 * `data-fonte` declara isso no DOM para ser verificável de fora — e
 * `tests/unit/telas-sem-dado-de-mentira.test.ts` impede que alguém religue os
 * imports sem querer.
 */
export function AgendaClient({
  fusoDaAgenda,
  fusoDeApresentacao,
  hojeNaOrganizacao,
  usuarioId,
  googleConfigurado,
  contaConectada,
  enderecoDeRetorno,
  faltaNoGoogle,
  linkDeConfiguracaoDoGoogle,
  administra = false,
  tiposIniciais,
  agendamentosIniciais,
  podeMarcar,
  podeBloquearDeOutros = false,
}: {
  /**
   * O fuso RESOLVIDO da organização (`fusoUtilizavel(activeOrg.timezone)`,
   * calculado em `page.tsx`). É a régua da grade: sem ele a agenda desenha
   * hora de parede no relógio do navegador (issue #1362).
   */
  fusoDaAgenda: string;
  fusoDeApresentacao: string | null;
  /**
   * A data de HOJE no fuso da ORGANIZAÇÃO, resolvida pelo servidor
   * (`yyyy-MM-dd`). É a mesma que gerou a semente de compromissos.
   */
  hojeNaOrganizacao: string;
  /** Id de quem está logado — a única fonte para o rótulo "Você". */
  usuarioId: string;
  googleConfigurado: boolean;
  contaConectada?: string | null;
  enderecoDeRetorno?: string;
  faltaNoGoogle: string[];
  /** Preenchido só para quem administra a instalação — ver `page.tsx`. */
  linkDeConfiguracaoDoGoogle?: string;
  /** Administra a organização ou a instalação: vê o cartão do Google sem credencial. */
  administra?: boolean;
  /** Tipos ativos, resolvidos no servidor: não há rota que os liste ainda. */
  tiposIniciais: Array<{
    id: string;
    nome: string;
    duracaoMin: number;
    donoId: string | null;
    localKind: string | null;
    localDetalhes: string | null;
    exigePaciente: boolean;
    /** `calendar_event_types.category` — decide o "Paciente novo / antigo" padrão. */
    categoria?: string | null;
  }>;
  /** A semana corrente, resolvida no servidor: `GET /agendamentos` não existe. */
  agendamentosIniciais: Agendamento[];
  /**
   * Quem está logado pode MARCAR — o mesmo piso da rota (`requireRole("agent")`
   * em `app/api/v1/agenda/agendamentos/route.ts`).
   *
   * É a MESMA porta, com o MESMO piso, em todos os gestos de escrita desta tela:
   * o botão "Novo agendamento", o clique num bloco livre da grade, o encaixe
   * ("Outro horário") do painel e o "Marcar compromisso" que chega por
   * `?contato=`. Oferecer qualquer uma delas a quem só lê é oferecer um 403 —
   * com a recusa chegando DEPOIS do gesto, que é o defeito que este nome veio
   * fechar. Esconder aqui é cortesia: quem decide segue sendo a rota.
   */
  podeMarcar: boolean;
  /** manager+: a aba "Bloquear horário" pode fechar a agenda de outra pessoa. */
  podeBloquearDeOutros?: boolean;
}) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  const router = useRouter();
  const telaRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    // O HTML pode aparecer antes de o React ligar os eventos. Este marcador
    // permite que jornadas automatizadas esperem o botão estar realmente ativo.
    telaRef.current?.setAttribute("data-hidratado", "true");
  }, []);
  const [marcando, setMarcando] = React.useState(false);
  // O compromisso criado NESTA abertura do painel. Serve para levar a grade até
  // ele quando o painel fechar por qualquer caminho — ver `ancoraAoFecharPainel`.
  const [marcadoEm, setMarcadoEm] = React.useState<string | null>(null);
  // QUEM SERÁ ATENDIDO. A regra inteira — e por que ela não é "limpar ao
  // fechar" — está em `lib/agenda/vinculo-da-marcacao.ts`. Em uma frase: o
  // painel abre com o vínculo que a ROTA carrega (`?contato=…&conversa=…`, o
  // link "Marcar compromisso" do Inbox), e o que a pessoa escolhe dentro dele
  // vive só enquanto ele está aberto.
  const {
    vinculo,
    registrarRota: registrarVinculoDaRota,
    reiniciar: reiniciarVinculo,
    escolher: escolherVinculo,
  } = useVinculoDaMarcacao();
  const contactId = vinculo.contact;
  const conversationId = vinculo.conversation;
  const onContext = React.useCallback(
    (contact: string, conversation: string) => {
      // Só abre sozinho quando a rota TROUXE um cliente: a chamada sem cliente
      // é a que avisa que a página deixou de ter contexto, e ela não é um
      // pedido para marcar nada.
      const trouxeCliente = registrarVinculoDaRota({ contact, conversation });
      // TERCEIRA PORTA da mesma escrita: o "Marcar compromisso" do Inbox chega
      // por aqui e abriria o painel. Para quem só lê, o vínculo até pode ser
      // registrado — é estado inerte, sem superfície — mas o painel NÃO abre:
      // abri-lo seria a mesma promessa que o botão e a grade fariam, com o 403
      // chegando no fim do gesto.
      if (podeMarcar && trouxeCliente) setMarcando(true);
    },
    [podeMarcar, registrarVinculoDaRota],
  );
  /** Abrir o painel do zero: o vínculo volta a ser o da rota, nunca o da vez anterior. */
  const abrirMarcacao = React.useCallback(() => {
    reiniciarVinculo();
    setMarcando(true);
  }, [reiniciarVinculo]);
  // O horário que veio de um CLIQUE NA GRADE. Preenchido, o painel abre já em
  // "confirmando" naquele instante; vazio, ele abre pedindo o dia, como sempre.
  const [horarioEscolhido, setHorarioEscolhido] = React.useState<HorarioLivre | null>(null);
  // PROFISSIONAL e PROCEDIMENTO da marcação NOVA, nesta ordem (modal simples).
  // São estado próprio, e não o tipo da grade: escolher o procedimento para um
  // paciente não deve trocar o que a grade está mostrando atrás do modal.
  const [formDonoId, setFormDonoId] = React.useState("");
  const [formTipoId, setFormTipoId] = React.useState("");
  // O texto do campo "Duração (min)" da marcação nova; `null` = a do procedimento.
  const [duracaoEditada, setDuracaoEditada] = React.useState<string | null>(null);
  // REMARCAR acontece no PAINEL DO PACIENTE (`DetalheDoCompromisso`, decisão 6
  // do André, 27/11/2026), com o mesmo "quando" da marcação. Este id diz qual
  // compromisso pediu a remarcação; ela só vale enquanto o painel aberto
  // (`?compromisso=`) é o dele.
  const [remarcandoId, setRemarcandoId] = React.useState<string | null>(null);
  const [unidades, setUnidades] = React.useState<UnidadeDaAgenda[]>([]);
  const [unidadeId, setUnidadeId] = React.useState("");

  React.useEffect(() => {
    if (!marcando) return;
    void apiClient
      .get<{ data: UnidadeDaAgenda[] }>("/api/v1/agenda/unidades")
      .then((r) => setUnidades((r as unknown as { data: UnidadeDaAgenda[] }).data ?? []))
      .catch(() => setUnidades([]));
  }, [marcando]);
  const marcar = useMarcarAgendamento();
  // ⚠️ ERA `tiposIniciais[0] ?? null` — uma constante, sem seletor em lugar
  // nenhum. `page.tsx` ordena os tipos por NOME, então a tela marcava sempre o
  // primeiro em ordem alfabética e não havia como marcar outro: numa org com
  // "Atendimento", "Consulta", "Reunião", só "Atendimento" era alcançável pela
  // tela. As categorias existiam no banco, no seed e na API — e a tela oferecia
  // uma. Achado escrevendo a spec de marcar, não lendo o código.
  // ⚠️ E O TIPO ESCOLHIDO ERA SÓ ESTADO DO REACT — o outro lado do mesmo achado.
  // A escolha na grade ia para um `useState` sem URL, sem armazenamento e sem
  // leitor de query nenhuma: no F5 ela morria e a grade voltava ao primeiro tipo
  // em ordem alfabética (#1657). Quem estava olhando "Avaliação" recarregava e
  // via "Atendimento" — e, sem jornada publicada para o primeiro, a tela inteira
  // dizia "a jornada de atendimento ainda não foi publicada". Evidência na
  // issue: as runs 36061761510 e 36164033754, que acharam o defeito pelo aviso
  // nascendo entre duas leituras de bounding box no e2e do arraste (#1656).
  //
  // O tipo passa a viver na URL (`?tipo=`), no mesmo formato do `?id=` da Inbox
  // (#1629). LER no inicializador, e não num efeito: o servidor pinta a página
  // com a MESMA query que o cliente lê, então primeira pintura e recarregamento
  // concordam — sem um piscar voltando ao primeiro tipo. `?tipo=` de um tipo já
  // desativado cai no `?? tiposIniciais[0]` da linha seguinte, que é o
  // comportamento de sempre para quem não escolheu nada.
  const busca = useSearchParams();
  const caminho = usePathname();
  const [tipoId, setTipoId] = React.useState<string | null>(
    () => busca.get("tipo") ?? tiposIniciais[0]?.id ?? null,
  );
  const tipo = tiposIniciais.find((t) => t.id === tipoId) ?? tiposIniciais[0] ?? null;
  // Endereço e observação NA HORA de marcar (porte do upstream #1123) moram
  // agora no modal simples (`MarcacaoSimples`), que os entrega no confirmar.
  /**
   * ESCOLHER O TIPO GRAVA NA URL — a outra metade do `useState` acima.
   *
   * `window.history.replaceState` e não `router.replace`, pela razão medida na
   * Inbox (#1629): a History API troca a query SEM pedir um novo Server
   * Component a cada clique — e esta rota tem cinco consultas de servidor atrás
   * dela (`page.tsx`), que rodariam a cada troca de tipo. `replace` e não
   * `push`: trocar de tipo não é uma navegação nova, e com `push` o "voltar"
   * do navegador acumularia um passo por clique.
   */
  const escolherTipo = React.useCallback(
    (id: string) => {
      setTipoId(id);
      const parametros = new URLSearchParams(busca.toString());
      if (id) parametros.set("tipo", id);
      else parametros.delete("tipo");
      const query = parametros.toString();
      window.history.replaceState(null, "", query ? `${caminho}?${query}` : caminho);
    },
    [busca, caminho],
  );
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
  // Fechar pelo VOLTAR do navegador não passa pelo `onOpenChange` do painel: a
  // remarcação pedida morre quando o painel aberto muda ou fecha, senão o mesmo
  // compromisso reabriria já no Remarcar. Ajuste durante o render, o padrão do
  // React para estado que segue a URL.
  const [idVisto, setIdVisto] = React.useState(idAberto);
  if (idVisto !== idAberto) {
    setIdVisto(idAberto);
    if (remarcandoId !== idAberto) setRemarcandoId(null);
  }
  const [visao, setVisao] = React.useState<VisaoDaAgenda>("semana");
  /**
   * No CELULAR a agenda abre no DIA, não na semana.
   *
   * Duas razões, e a segunda é consequência da primeira. A semana em 360px é
   * ilegível — por isso a grade esconde as outras colunas abaixo de `md`. Mas o
   * passo de navegação da semana é de SETE dias: quem visse um dia só e tocasse
   * em avançar pularia a semana inteira, sem alcançar os outros seis. Abrindo no
   * dia, o passo é 1 e cada toque anda um dia.
   *
   * Em `useEffect`, e não no estado inicial, porque `window` não existe no
   * servidor: decidir a visão na primeira renderização faria o HTML do servidor
   * discordar do cliente. Roda uma vez, na montagem, então não desfaz escolha
   * de quem trocou a visão depois.
   */
  React.useEffect(() => {
    // O aviso da regra é justo em geral; aqui trocar a visão É o ponto do efeito.
    // A largura só existe no cliente, e decidir antes divergiria da hidratação.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (window.matchMedia("(max-width: 767px)").matches) setVisao("dia");
  }, []);
  // QUEM A GRADE MOSTRA: vazio = todos. Lido do navegador DEPOIS da montagem,
  // como a visão do funil, para o HTML do servidor e o do cliente concordarem.
  const [pedidas, setPedidas] = React.useState<string[]>([]);
  React.useEffect(() => {
    const guardadas = lerPessoasDaGrade(usuarioId);
    // Sem nada guardado, nada a renderizar de novo.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- o armazenamento só existe no cliente.
    if (guardadas.length > 0) setPedidas(guardadas);
  }, [usuarioId]);
  const mudarPessoas = React.useCallback(
    (ids: string[]) => {
      setPedidas(ids);
      gravarPessoasDaGrade(usuarioId, ids);
    },
    [usuarioId],
  );
  /**
   * A ÂNCORA NASCE DO RELÓGIO DA ORGANIZAÇÃO, não do navegador.
   *
   * Era `useState(() => new Date())`. O servidor desenha a semana no fuso da
   * organização e o cliente recalculava no fuso do NAVEGADOR: das 21h de sábado
   * à meia-noite em São Paulo, com servidor em UTC, os dois discordavam e a tela
   * piscava a semana seguinte — e, para quem abre o CRM fora do fuso da empresa,
   * discordava sempre.
   *
   * O que atravessa a fronteira é a DATA (`hojeNaOrganizacao`), nunca o
   * instante: `segunda 00:00` em São Paulo é `domingo 22:00` em UTC-5, e
   * `startOfWeek` sobre esse instante, em hora local, cairia na semana anterior.
   * `ancoraLocalDoDia` transforma a data numa `Date` local ao meio-dia — a doze
   * horas de qualquer borda de horário de verão.
   */
  const [ancora, setAncora] = React.useState(() => ancoraLocalDoDia(hojeNaOrganizacao));
  // O relógio ANDA (achado 19, 16/11): a régua do agora, os horários que já
  // passaram e o "Hoje" seguem o minuto, e não o instante em que a aba abriu.
  // "Hoje" é derivado dele no fuso da ORGANIZAÇÃO, a mesma régua do servidor;
  // até o primeiro tique vale a data que o servidor mandou.
  const agora = useAgora();
  const diaDeAgora = diaLocalISO(agora, fusoDaAgenda);
  const [diaDaAbertura] = React.useState(diaDeAgora);
  const hoje = diaDeAgora === diaDaAbertura ? hojeNaOrganizacao : diaDeAgora;

  // AS PESSOAS SÃO REAIS: vêm de `/api/v1/agenda/pessoas`, com a trilha de cor
  // derivada do `user_id`. Servem para nome e cor; quem entra na FILEIRA de
  // profissionais é decidido abaixo (`pessoasDaFileira`).
  const { data: pessoas = [] } = usePessoasDaAgenda();
  // Só vale quem o servidor devolveu a ESTA pessoa, e só UMA (decisão 3 do
  // André, 27/11/2026): uma escolha antiga de várias pessoas, guardada quando o
  // filtro era múltiplo, vale pela primeira.
  const selecionadas = React.useMemo(() => selecaoValida(pedidas, pessoas).slice(0, 1), [pedidas, pessoas]);
  // OS AGENDAMENTOS SÃO REAIS, e agora TAMBÉM se atualizam sem recarregar.
  //
  // ⚠️ O comentário que estava aqui dizia que `GET /api/v1/agenda/agendamentos`
  // "ainda não existe (a rota tem POST, PATCH e DELETE)". Era verdade quando foi
  // escrito e VENCEU: `grep -n "^export async function" app/api/v1/agenda/agendamentos/route.ts`
  // devolve GET:95. A prosa descrevia um estado, o estado mudou, e a frase ficou
  // — junto com o `useAgendamentos`, que existia inteiro e não era montado por
  // ninguém (1 ocorrência no repo: a própria definição).
  //
  // A prop do RSC segue sendo a PRIMEIRA pintura (sem piscar, sem spinner) e o
  // hook assume dali: `useMarcarAgendamento` já invalida `["agenda"]`, então
  // marcar pela tela repinta a grade sozinho.
  // O recorte acompanha o que a grade DESENHA — mesma visão, mesma âncora.
  // Instante ISO, nunca o filtro `dia`: o cabeçalho do hook mede por que
  // (`dia=` corta em UTC e some com o compromisso das 22h no fuso de São Paulo).
  const recorteDaGrade = React.useMemo(() => {
    const { de, ate } = recorteDaVisao(visao, ancora);
    return { de: de.toISOString(), ate: ate.toISOString() };
  }, [visao, ancora]);

  // A janela que o SERVIDOR pintou. Sem esta comparação, navegar para outra
  // semana mostraria os compromissos DESTA por um instante — o fallback estaria
  // respondendo a uma pergunta que ninguém fez. Cair para lista vazia é pior de
  // aparência e melhor de verdade: a grade fica vazia por um piscar, em vez de
  // mostrar compromisso no dia errado.
  // ⚠️ `useState` com inicializador, e NÃO `useRef(...).current`.
  //
  // A intenção é a mesma — congelar a janela da primeira pintura —, mas ler
  // `.current` durante o render é violação de regra do React, e o `pnpm lint`
  // reprova com "Cannot access refs during render". Foi o CI que me disse: eu
  // tinha rodado typecheck e vitest e NÃO tinha rodado lint. O `verify` cai nos
  // três, e eu só olhei dois.
  //
  // `useState(() => x)[0]` faz o mesmo congelamento sem tocar em ref no render.
  const [recorteDoServidor] = React.useState(() => recorteDaGrade);
  const naJanelaDoServidor =
    recorteDaGrade.de === recorteDoServidor.de && recorteDaGrade.ate === recorteDoServidor.ate;

  const { data: agendamentosVivos } = useAgendamentos(recorteDaGrade);
  // Marcado pela IA ou por um colega aparece sem recarregar (achado 2, 16/11).
  useAgendaAoVivo(recorteDaGrade);
  const todos: Agendamento[] = React.useMemo(
    () => agendamentosVivos ?? (naJanelaDoServidor ? agendamentosIniciais : []),
    [agendamentosVivos, naJanelaDoServidor, agendamentosIniciais],
  );
  // A FILEIRA mostra só quem tem atendimento no período carregado — e quem está
  // escolhido, para a escolha nunca sumir sem um jeito de desfazê-la.
  const pessoasDaFileira = React.useMemo(
    () => pessoasComAtendimento(pessoas, todos, selecionadas),
    [pessoas, todos, selecionadas],
  );

  // Uma pessoa só selecionada é o CONTEXTO da marcação: os horários livres da
  // grade, o "com quem" do painel e o dono do compromisso passam a ser dela.
  const profissional = selecionadas.length === 1 ? (pessoas.find((p) => p.id === selecionadas[0]) ?? null) : null;
  // Os horários da remarcação perguntam pelo procedimento e pelo dono DO
  // COMPROMISSO (a rota não troca nenhum dos dois), nunca pelo tipo da grade —
  // `lib/agenda/tipo-da-remarcacao.ts` (achado 1, 16/11). Fora da lista
  // carregada não pergunta nada: a grade vai até a semana dele primeiro.
  const remarcandoAtivo = remarcandoId !== null && remarcandoId === idAberto ? remarcandoId : null;
  const abertoNaGrade = idAberto ? todos.find((a) => a.id === idAberto) : undefined;
  const alvoDaRemarcacao = remarcandoAtivo ? abertoNaGrade : undefined;
  const remarcacao = alvoDaRemarcacao ? tipoDaRemarcacao(alvoDaRemarcacao, tiposIniciais, tipo) : null;
  // O que a consulta de horários pergunta: na marcação NOVA, o profissional e o
  // procedimento escolhidos no modal; ao REMARCAR, os do compromisso — e só
  // eles: enquanto o compromisso não chega à lista, nenhum (nem o do modal).
  const tipoDaMarcacao = remarcandoAtivo
    ? (remarcacao?.tipo ?? null)
    : formDonoId
      ? (tiposIniciais.find((t) => t.id === formTipoId) ?? null)
      : null;
  const donoDaConsulta = remarcandoAtivo ? remarcacao?.donoId : formDonoId || undefined;

  // A JANELA ACOMPANHA O MÊS QUE O PAINEL MOSTRA — e continua ESTÁVEL.
  //
  // ⚠️ Isto era `hoje + 30 dias`, fixo na abertura: "Próximo mês" desligava
  // assim que acabavam os dias já pedidos, e retorno em 60 ou 90 dias não se
  // marcava pelo calendário, mesmo com a janela de agendamento do tipo valendo
  // (porte de melgarafael/DeskcommCRM d5efd698a).
  //
  // A estabilidade é a mesma de antes: a chave do React Query inclui o
  // recorte, e `new Date()` no corpo do render gerava chave nova a cada passagem
  // — um laço de requisições com o painel nunca estabilizando. Aqui o relógio
  // só é lido quando o painel REABRE ou o tipo muda, e o mês só muda pelo
  // `onMesVisivel` do painel.
  const [mesDoPainel, setMesDoPainel] = React.useState(() =>
    startOfMonth(ancoraLocalDoDia(hojeNaOrganizacao)),
  );
  const onMesVisivel = React.useCallback((mes: Date) => {
    const proximo = startOfMonth(mes);
    setMesDoPainel((atual) => (atual.getTime() === proximo.getTime() ? atual : proximo));
  }, []);
  const agoraDaAbertura = React.useMemo(
    () => new Date(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `new Date()` é o ponto: o valor só pode mudar quando a abertura ou o tipo mudam.
    [marcando, tipoDaMarcacao?.id],
  );
  const janelaDeBusca = React.useMemo(() => {
    const { de, ate } = janelaDoMesVisivel(mesDoPainel, agoraDaAbertura);
    return { de: de.toISOString(), ate: ate.toISOString() };
  }, [mesDoPainel, agoraDaAbertura]);



  const agendamentos = React.useMemo(
    () =>
      selecionadas.length === 0 ? todos : todos.filter((a) => selecionadas.includes(a.responsavelId)),
    [selecionadas, todos],
  );

  // A duração do compromisso sendo REMARCADO (upstream #3714): o PATCH preserva
  // o comprimento do bloco, e a lista de horários tem de ser do mesmo tamanho.
  const duracaoDoCompromisso = alvoDaRemarcacao
    ? duracaoDoBloco(alvoDaRemarcacao.comeca, alvoDaRemarcacao.termina, 0) || null
    : null;
  // A duração ESCOLHIDA na marcação nova: `null` = a do procedimento. Texto
  // inválido também não viaja; a tela trava o Confirmar.
  const duracaoEscolhida =
    duracaoEditada !== null && tipoDaMarcacao ? duracaoDoCampo(duracaoEditada, tipoDaMarcacao.duracaoMin) : null;

  // Os horários vêm da rota real — a mesma que a IA usa, então tela e agente
  // oferecem exatamente os mesmos horários. Só consulta quando o painel abre.
  // `isError` junto, e não só `data`: sem ele a tela MENTE por default. O
  // `publicouHorarios={horarios?.publicou_horarios ?? true}` abaixo transforma
  // "a consulta falhou" em "publicou, só não tem vaga" — dias travados e aviso
  // nenhum, que é exatamente o que uma instalação fresca produz (a rota devolve
  // 422 porque ninguém está em `attendant_availability`).
  const { data: horarios, isError: horariosFalharam } = useHorariosLivres(
    (marcando || remarcandoAtivo !== null) && tipoDaMarcacao
      ? {
          event_type_id: tipoDaMarcacao.id,
          owner_user_id: donoDaConsulta,
          de: janelaDeBusca.de,
          ate: janelaDeBusca.ate,
          unit_id: unidadeId || undefined,
          // A DURAÇÃO ENTRA NA CONSULTA (upstream #3714): remarcando, o
          // comprimento do bloco que vai ser movido; marcando, a escolhida na
          // tela. Sem escolha não vai nada, e vale a do procedimento (que pode
          // vir do catálogo, por isso a tela não manda o número dela).
          duracao_minutos: remarcandoAtivo ? (duracaoDoCompromisso ?? undefined) : (duracaoEscolhida ?? undefined),
        }
      : null,
  );

  const horariosPorDia = React.useMemo(() => {
    const mapa: Record<string, Array<{ instante: string; rotulo: string }>> = {};
    for (const s of horarios?.slots ?? []) {
      const d = new Date(s.inicio);
      // A CHAVE E O RÓTULO SAEM DO FUSO DA ORGANIZAÇÃO: o slot das 09:00 da
      // clínica é daquele dia e daquela hora PARA ELA, não para quem está
      // olhando (issue #1362). O lookup em `QuandoDaMarcacao` continua batendo,
      // porque ele indexa pela data de calendário da mesma âncora.
      const chave = diaLocalISO(d, fusoDaAgenda);
      const p = partesNoFuso(d, fusoDaAgenda);
      const dois = (n: number) => String(n).padStart(2, "0");
      (mapa[chave] ??= []).push({
        instante: s.inicio,
        rotulo: `${dois(p.hora)}:${dois(p.minuto)}`,
      });
    }
    return mapa;
  }, [horarios, fusoDaAgenda]);

  // A GRADE não mostra cancelado: ela responde "o que está de pé". O que
  // aconteceu com um cancelado fica na linha do tempo do lead e se abre pelos
  // links da Central (`?compromisso=`), no painel dele.
  const agendamentosDaGrade = React.useMemo(
    () => agendamentos.filter((a) => a.situacao !== "cancelled"),
    [agendamentos],
  );

  // As faixas FECHADAS em "Dias fora da rotina", filtradas pelas MESMAS pessoas
  // que os agendamentos: isolar uma pessoa e ver o fechamento de outra faria a
  // grade dela parecer fechada sem estar. (Porte do DeskcommCRM #3888.)
  const { data: fechamentosVivos } = useFechamentosDaGrade(recorteDaGrade, fusoDaAgenda);
  const fechamentosDaGrade = React.useMemo(
    () =>
      (fechamentosVivos ?? []).filter(
        (f) => selecionadas.length === 0 || selecionadas.includes(f.responsavelId),
      ),
    [fechamentosVivos, selecionadas],
  );

  const passo = visao === "mes" ? 30 : visao === "semana" ? 7 : 1;
  // O PADRÃO de formato também muda de idioma, não só o locale: em português
  // "d 'de' MMMM" tem a preposição escrita à mão dentro do padrão, e em
  // espanhol ela também é "de" — mas quem garante isso é a chave no dicionário,
  // não a coincidência. Passando o padrão por `t()`, um idioma que ordene a
  // data de outro jeito não precisa de código novo aqui.
  const periodo =
    visao === "mes"
      ? format(ancora, t("MMMM 'de' yyyy"), { locale: localeDaData })
      : visao === "semana"
        ? (() => {
            // Os MESMOS dias que a grade desenha: segunda a sábado, domingo só
            // quando tem compromisso.
            const dias = diasDaSemanaDe(ancora, agendamentosDaGrade, fusoDaAgenda);
            const primeiro = dias[0] ?? ancora;
            const ultimo = dias[dias.length - 1] ?? ancora;
            return `${format(primeiro, t("d 'de' MMM"), { locale: localeDaData })} — ${format(ultimo, t("d 'de' MMM"), { locale: localeDaData })}`;
          })()
        : format(ancora, t("EEEE, d 'de' MMMM"), { locale: localeDaData });

  // Fechar o modal de marcar limpa o estado da marcação (ver os porquês linha a
  // linha abaixo). REMARCAR mora no painel do paciente e não passa por aqui.
  const aoMudarAbertura = (aberto: boolean) => {
          setMarcando(aberto);
          // O horário vindo da grade some ao fechar: abrir o painel pelo botão
          // depois de fechar um bloco reabriria no horário do bloco.
          if (!aberto) {
            setHorarioEscolhido(null);
            setFormDonoId("");
            setFormTipoId("");
            setDuracaoEditada(null);
            // A unidade é do profissional (`ofertaDeUnidades`): a da vez anterior
            // não vale para quem for escolhido na próxima.
            setUnidadeId("");
            // E o próprio cliente, que é o pior dos quatro a sobrar: medido numa
            // instalação real em 2026-09-12, "Novo agendamento" abriu com um
            // contato JÁ selecionado, herdado de uma abertura anterior feita a
            // partir da conversa dele (`onContext` preenche os dois). Quem não
            // reparasse marcaria o compromisso no nome de outra pessoa — e o
            // campo parece preenchido de propósito, então não há o que estranhar.
            //
            // ⚠️ MAS NÃO É `setContactId("")`, e o `e2e` mediu a diferença:
            // limpar no fechamento apaga também o contexto que a CONVERSA
            // acabou de dar — `agenda-google-meet.spec.ts:196` e
            // `agenda-presenca-recuperacao.spec.ts:312` reprovaram com
            // `contact_id: null`, porque as duas fecham o painel só para
            // navegar a grade até a semana certa, como uma pessoa faz.
            //
            // `reiniciarVinculo()` devolve o vínculo da ROTA: vazio quando a
            // pessoa está na Agenda sem contexto (o defeito relatado), e o
            // cliente da conversa quando ela chegou pelo link do Inbox.
            reiniciarVinculo();
            // ⛔ E LEVAR A GRADE ATÉ O QUE ACABOU DE NASCER.
            //
            // "Ver na agenda" já fazia isto; fechar no X, clicar fora ou apertar
            // Esc, não — e a grade ficava na semana em que estava, sem o
            // compromisso recém-criado, que quase sempre é de outra semana.
            // ⚠️ O relato que puxou isto NÃO se confirmou (ver o módulo). O que
            // sustenta é a simetria com o caso do botão, esse sim relatado.
            const destino = ancoraAoFecharPainel(marcadoEm, startOfDay);
            if (destino) setAncora(destino);
            setMarcadoEm(null);
          }
  };

  return (
    <div
      ref={telaRef}
      data-testid="tela-agenda"
      data-fonte={agendamentosIniciais.length > 0 ? "api" : "api-sem-dado"}
      data-fuso={fusoDeApresentacao ?? "organizacao"}
      className="flex h-full flex-col gap-4"
    >
      {/*
        Em Suspense porque `useSearchParams` obriga: sem a fronteira, o Next
        reprova o build da rota. Fallback nulo porque a ausência do aviso é o
        estado normal — quem chega pela navegação não tem query nenhuma.
      */}
      <React.Suspense fallback={null}>
        <AvisoDaConexaoGoogle />
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
                  semLembrete: abertoNaGrade?.naoRecebeMensagens
                    ? (abertoNaGrade.quemSeraAtendido ?? t("O paciente"))
                    : undefined,
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
      </React.Suspense>


      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <h1 className="titulo-tela">{t("Agenda")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("O que está marcado, com quem, e quem atende — seu e da equipe.")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* "Hoje" é o hoje DA ORGANIZAÇÃO. Com `new Date()` o botão desfazia a
              âncora do servidor e devolvia a semana do navegador — o defeito que
              a tela acabou de fechar, a um clique de distância. */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAncora(ancoraLocalDoDia(hoje))}
          >
            {t("Hoje")}
          </Button>
          {/*
            DESABILITADO COM O MOTIVO À VISTA, e não ligado a um `onClick` vazio.
            Enquanto a frente 1 não expõe `/api/v1/agenda` não há o que marcar, e
            um botão primário, com cor de ação e sem `disabled`, que não faz nada
            ao clique é pior do que não existir: quem clica conclui que o produto
            está quebrado e não tem o que reportar além de "não abre". É o
            anti-pattern de controle decorativo, e esta base já pagou por ele.

            O motivo vai em texto ao lado, não só no `title`: atributo de
            hover não existe para quem usa toque, que é o dono de clínica no
            celular.
          */}
          {podeMarcar && !tipo && (
            // Sem NENHUM tipo de agendamento cadastrado não há o que marcar — e
            // isto é diferente de "a API não existe": a ação faz sentido, falta
            // configuração. Por isso o motivo à vista, e não um botão mudo.
            //
            // `podeMarcar` vem ANTES de `!tipo`, e a ordem é o ponto: para quem
            // só lê não existe botão desabilitado a explicar, então o motivo
            // seria conversa sobre um gesto que não está na tela dele.
            <span
              data-testid="motivo-novo-agendamento"
              className="hidden text-xs text-text-subtle sm:inline"
            >
              {t("Cadastre um tipo de agendamento para começar")}
            </span>
          )}
          {/* PRIMEIRA PORTA da escrita nesta tela. Quem só lê não vê o botão: o
              403 da rota nunca chega a ser oferecido (upstream #1013). */}
          {podeMarcar && (
            <Button
              size="sm"
              disabled={!tipo}
              // `data-testid` porque o RÓTULO deixou de ser estável: até este PR
              // ele era literal, e `agenda-escopo-da-organizacao.spec.ts` o acha
              // por `getByRole("button", { name: /Novo agendamento/i })`. Com o
              // texto passando por `t()`, casar por rótulo passa a depender do
              // idioma da conta de teste — hoje passa porque a conta nasce em
              // português, mas é acoplamento que não precisa existir. O testid é
              // o caminho estável; trocar a spec para usá-lo é decisão de quem a
              // escreveu, e vai anotada no PR.
              data-testid="novo-agendamento"
              title={tipo ? undefined : t("Cadastre um tipo de agendamento para começar")}
              onClick={() => {
                // Com UMA pessoa no filtro da grade, ela já vem como o
                // profissional; sem isso a recepção escolhe. O procedimento
                // sempre se escolhe depois, porque depende do profissional.
                setFormDonoId(profissional?.id ?? "");
                setFormTipoId("");
                abrirMarcacao();
              }}
            >
              <CalendarPlus size={16} weight="bold" aria-hidden />
              <span>{t("Novo agendamento")}</span>
            </Button>
          )}
        </div>
      </header>

      {/* O cartão do Google vem DEPOIS do título: a tela começava por uma caixa
          de integração, antes até de dizer que era a Agenda (print de 08/10). */}
      {/* Sem as credenciais da instalação, o cartão só aparece a quem
          administra (item 131): para a equipe ele era um aviso sobre algo que
          ela não resolve, com nomes de chave e endereço do servidor. */}
      {(googleConfigurado || administra) && <CartaoDaConexaoGoogle
        configurado={googleConfigurado}
        falta={faltaNoGoogle}
        linkDeConfiguracao={linkDeConfiguracaoDoGoogle}
        contaConectada={contaConectada}
        enderecoDeRetorno={enderecoDeRetorno}
      />}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("Período anterior")}
              data-testid="periodo-anterior"
              onClick={() => setAncora((d) => addDays(d, -passo))}
            >
              <CaretLeft size={16} weight="bold" aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("Próximo período")}
              data-testid="periodo-seguinte"
              onClick={() => setAncora((d) => addDays(d, passo))}
            >
              <CaretRight size={16} weight="bold" aria-hidden />
            </Button>
          </div>
          {/*
            `first-letter:uppercase` e NÃO `capitalize`: o `capitalize` do CSS
            maiúscula toda palavra, e o date-fns em pt-br devolve "23 de ago" —
            virava "23 De Ago". Preposição com maiúscula é o detalhe que faz o
            produto parecer traduzido em vez de escrito, e fica na primeira
            linha abaixo do título.
          */}
          <span
            data-testid="periodo"
            className="truncate text-sm font-semibold first-letter:uppercase"
          >
            {periodo}
          </span>
        </div>

        {/* `flex-wrap` pelo mesmo motivo da vitrine, e aqui é conserto de CLASSE e
            não de instância: esta linha passou no gate por sorte de largura (a
            organização de teste tem cinco pessoas), não por estar certa. Com mais
            gente no filtro, ela estoura igual — e o `overflow-x: hidden` corta o
            alternador de visão em silêncio. */}
        <div className="flex flex-wrap items-center gap-3">
          <FiltroDePessoas pessoas={pessoasDaFileira} selecionadas={selecionadas} onMudar={mudarPessoas} />
          <div
            data-testid="alternador-de-visao"
            className="flex items-center gap-0.5 rounded-md border border-border bg-surface p-0.5"
          >
            {VISOES.map((v) => (
              <button
                key={v.id}
                type="button"
                data-testid={`visao-${v.id}`}
                aria-pressed={visao === v.id}
                onClick={() => setVisao(v.id)}
                className={cn(
                  // 44 px no toque, como os botões (item 135).
                  "rounded-sm px-2.5 py-1 text-xs transition-colors duration-fast ease-out max-lg:min-h-11",
                  // No celular a grade da semana mostra UM dia: o botão
                  // prometia a semana e as setas pulavam 7 dias (item 133). A
                  // tela já abre no Dia abaixo de `md`.
                  v.id === "semana" && "max-md:hidden",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500",
                  visao === v.id
                    ? "bg-accent font-semibold text-accent-foreground"
                    : "text-text-muted hover:bg-surface-elevated hover:text-text",
                )}
              >
                {t(v.rotulo)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/*
        O HISTÓRICO na tela do produto, e não só na vitrine. Ele aparece mesmo
        sem dado: as quatro abas com contador zero respondem "não há nada" sem
        gastar um clique, e some-lo faria a tela parecer menor do que é.
      */}
      {/*
        A MARCAÇÃO NOVA é um modal no centro, em duas abas ("Novo agendamento" e
        "Bloquear horário"), no molde do sistema que a clínica já usava: o painel
        longo em três colunas fazia rolar muito para marcar uma consulta.
        REMARCAR acontece no painel do paciente.
      */}
      <Dialog open={marcando} onOpenChange={aoMudarAbertura}>
        <DialogContent
          className="flex max-w-[1040px] flex-col gap-0 overflow-x-hidden bg-surface p-0"
          // Escape com a lista de pacientes aberta fecha só a lista.
          onEscapeKeyDown={(e) => {
            const alvo = e.target as HTMLElement | null;
            if (alvo?.getAttribute("role") === "combobox" && alvo.getAttribute("aria-expanded") === "true")
              e.preventDefault();
          }}
        >
          <DialogHeader className="px-5 pb-2 pt-5 text-left">
            <DialogTitle>{t("Agenda")}</DialogTitle>
            <DialogDescription className="sr-only">
              {t("Marque um atendimento ou bloqueie um horário da agenda.")}
            </DialogDescription>
          </DialogHeader>
          <MarcacaoSimples
            ancora={ancoraLocalDoDia(hoje)}
            agora={agora}
            usuarioId={usuarioId}
            pessoas={pessoas}
            tipos={tiposIniciais}
            profissionalId={formDonoId}
            onProfissional={setFormDonoId}
            tipoId={formTipoId}
            onTipo={(id) => {
              setFormTipoId(id);
              // O procedimento escolhido passa a ser também o da grade, como era
              // com os botões de tipo do painel antigo: quem marca "Retorno" e
              // fecha o modal vê os horários livres de "Retorno" atrás dele.
              if (id) escolherTipo(id);
            }}
            contactId={contactId}
            conversationId={conversationId}
            onVinculo={(contact, conversation) => escolherVinculo({ contact, conversation })}
            unidades={unidades}
            unidadeId={unidadeId}
            onUnidade={setUnidadeId}
            fuso={horarios?.fuso_da_regra}
            horariosPorDia={horariosPorDia}
            publicouHorarios={horarios?.publicou_horarios ?? true}
            erroAoCarregar={horariosFalharam}
            fusoSuposto={horarios?.fuso_suposto ?? false}
            fontesDefasadas={horarios?.fontes_defasadas}
            googleCoberturaParcial={horarios?.google_cobertura_parcial}
            onMesVisivel={onMesVisivel}
            mesCarregado={horarios ? mesDoPainel : null}
            horarioInicial={horarioEscolhido ?? undefined}
            permiteEncaixe={podeMarcar}
            podeBloquearDeOutros={podeBloquearDeOutros}
            duracao={duracaoEditada}
            onDuracao={setDuracaoEditada}
            onConfirmar={(m) => {
              if (!tipoDaMarcacao) return Promise.reject(new Error("procedimento não escolhido"));
              // O DONO é o profissional escolhido no modal, o MESMO que a
              // consulta de horários perguntou: oferta e marcação falam da mesma
              // agenda por construção.
              return marcar
                .mutateAsync({
                  event_type_id: tipoDaMarcacao.id,
                  owner_user_id: formDonoId || undefined,
                  unit_id: unidadeId || undefined,
                  contact_id: contactId || undefined,
                  conversation_id: conversationId || undefined,
                  starts_at: m.instante,
                  duration_minutes: m.duracaoMin,
                  guest_email: m.convidado,
                  location_details: m.endereco,
                  description: m.observacao || undefined,
                  booking_channel: m.canal,
                  // `null` explícito (paciente antigo) grava sem conversão; ausente seria quem marca.
                  converted_by_kind: m.quemConverteu?.kind ?? null,
                  converted_by_user_id: m.quemConverteu?.kind === "user" ? m.quemConverteu.userId : undefined,
                })
                .then((r) => {
                  // Guardado para o fechamento saber para onde levar a grade.
                  setMarcadoEm(m.instante);
                  return r;
                });
            }}
            onVerNaAgenda={(instante) => {
              // O MESMO fechamento do X/Esc (achado 13, 16/11): fechar por aqui
              // à mão esquecia o horário vindo da grade, e a remarcação
              // seguinte abria com "Confirmar <horário antigo>" já pronto.
              aoMudarAbertura(false);
              setAncora(startOfDay(new Date(instante)));
            }}
          />
        </DialogContent>
      </Dialog>

      {/* ⚠️ O VAZIO NÃO ESCONDE MAIS A GRADE, e o achado veio do CI.
          Isto era um ternário: com zero agendamentos, `EmptyAgenda` entrava NO
          LUGAR de `GradeDaAgenda`. Numa instalação nova — que é o estado de
          primeira impressão — a pessoa abria a Agenda e não via calendário
          NENHUM: sem semana, sem horários, e com o alternador de visão ligado a
          nada, que é controle decorativo.

          A mensagem continua, porque ela é boa: diz de ONDE vem o próximo
          agendamento em vez de constatar a ausência. Ela virou aviso ACIMA da
          grade, e a grade fica.

          Achado porque a cerca nova das três visões passou aqui (banco com
          dados de execuções anteriores) e reprovou no CI, onde o banco nasce
          limpo. O mesmo formato do defeito que `agenda-tela-do-produto` já
          tinha pago: verde por banco sujo. */}
      {agendamentos.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-4">
          <EmptyAgenda />
        </div>
      ) : null}
      {/* A GRADE INTERATIVA — clicar num bloco livre marca ali, arrastar um card
          remarca. Toda a fiação (a consulta de horários da janela desenhada, a
          proposta de remarcação, o otimismo com volta atrás) mora em
          `AgendaInterativa`; aqui fica só o que esta tela já sabia. */}
      <AgendaInterativa
        fuso={fusoDaAgenda}
        visao={visao}
        ancora={ancora}
        agora={agora}
        pessoas={pessoas}
        agendamentos={agendamentosDaGrade}
        fechamentos={fechamentosDaGrade}
        // A janela de horas sai do período INTEIRO: com o filtro de pessoas ela
        // pulava a cada troca (item 136). Cancelado não alarga.
        janelaSobre={todos}
        recorte={recorteDaGrade}
        tipos={tiposIniciais.map((t) => ({ id: t.id, nome: t.nome, duracaoMin: t.duracaoMin }))}
        tipo={tipo ? { id: tipo.id, duracaoMin: tipo.duracaoMin, donoId: tipo.donoId } : null}
        donoId={profissional?.id}
        onEscolherTipo={escolherTipo}
        // SEGUNDA PORTA: o clique num bloco livre da grade. Sem `onMarcarEm`, a
        // `AgendaInterativa` não monta a interação, e a grade volta a ser o que
        // ela é para quem só lê — uma leitura, sem bloco clicável.
        onMarcarEm={
          podeMarcar
            ? (instante) => {
                setHorarioEscolhido({
                  instante,
                  // HH:mm no MESMO fuso em que a grade desenhou o clique: sem
                  // isto o resumo guardava a hora do NAVEGADOR e não batia com
                  // a célula que a pessoa acabou de escolher.
                  rotulo: format(dataDeParede(new Date(instante), fusoDaAgenda), "HH:mm"),
                });
                setRemarcandoId(null);
                // O bloco clicado foi calculado para o tipo da grade e para a
                // pessoa do filtro (ou o dono do tipo): o modal abre com os dois
                // já escolhidos, além do dia e da hora.
                const dono = profissional?.id ?? tipo?.donoId ?? "";
                setFormDonoId(dono);
                // Só se o procedimento da grade é DESTE profissional: o modal não
                // oferece o de outro (`atendeOProcedimento`), e a rota recusaria.
                setFormTipoId(tipo && atendeOProcedimento(tipo.donoId, dono) ? tipo.id : "");
                // `abrirMarcacao` e não `setMarcando(true)`: clicar num bloco
                // livre abre uma marcação NOVA, e ela nasce com o vínculo da rota.
                abrirMarcacao();
              }
            : undefined
        }
        /* Tocar num card abre o detalhe. A prop já atravessava `AgendaInterativa`
           e `GradeDaAgenda` e chegava `undefined` aqui: o toque não fazia nada, e
           o detalhe só abria por `?compromisso=`, que apenas o Radar (e a lista de
           baixo, removida em 27/11/2026) linkavam. Reusa o MESMO parâmetro que
           `EntradaDaAgenda` já lê — e `push`, não `replace`, porque é o que faz
           o botão voltar do celular fechar o detalhe. E o `?tipo=` vai JUNTO:
           sem ele, abrir um card trocava a URL por só `?compromisso=`, o fecho
           não achava tipo nenhum para manter e o F5 seguinte voltava ao
           primeiro (#1657). */
        onAbrirAgendamento={(id) => abrirCompromisso(id)}
        // A recusa do arraste oferece o Remarcar do próprio compromisso (item 137).
        onRemarcar={(id) => abrirCompromisso(id, true)}
        // A7: no Mês, tocar no dia abre aquele dia. A data da célula já é do
        // calendário da grade; `ancoraLocalDoDia` a põe ao meio-dia, como a
        // âncora nasce.
        onAbrirDia={(dia) => {
          setAncora(ancoraLocalDoDia(format(dia, "yyyy-MM-dd")));
          setVisao("dia");
        }}
        className="min-h-0 flex-1"
      />
    </div>
  );
}
