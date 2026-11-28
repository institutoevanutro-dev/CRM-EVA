# Agenda redesenhada: marcação com relógio, painel do paciente e grade mais limpa

Pedido do André em 27/11/2026, com prints da Agenda do Instituto. As decisões abaixo
foram fechadas com ele uma a uma, na conversa "Memória central".

## Objetivo

A recepção marca, confirma, remarca e cancela sem procurar botão. A grade mostra só o
que importa: profissionais que atendem, de segunda a sábado e com cartões legíveis.

Sucesso:
- marcar uma aplicação para paciente antigo sem ver campo que não serve;
- achar a agenda de um profissional com um clique;
- resolver tudo de uma consulta clicando nela.

## Decisões do André

| # | Tema | Decisão |
|---|------|---------|
| 1 | Hora no "Novo agendamento" | Campo de hora com relógio **e** lista de horários livres embaixo como atalho (opção 1) |
| 2 | Quem converteu / Origem do lead | Acima deles, "Paciente novo / Paciente antigo". Os dois campos só aparecem em **Paciente novo**. O padrão vem do procedimento: Primeira consulta = novo; acompanhamento, retorno e aplicações = antigo. Troca com um clique |
| 3 | Fileira de profissionais | Botões com nome e cor + "Todos"; só quem tem atendimento na semana da tela; clicar mostra só a agenda dele; a legenda repetida embaixo da grade sai |
| 4 | Domingo | Semana e mês de segunda a sábado; o domingo volta só na semana que tiver algo marcado nele |
| 5 | Lista de baixo (Próximos / Aguardando / Passados / Cancelados) | **Sai inteira** (opção 2) |
| 6 | Clicar numa consulta | Painel com a cara da janela de marcação: cabeçalho, três botões grandes (Confirmar, Remarcar, Cancelar), Compareceu/Faltou depois do horário e "Mais detalhes" fechado |
| 7 | Visual da grade | Cartão com a cor do profissional (faixa + fundo claro), linhas leves, hora só nas cheias, linha do "agora" visível, bloqueio listrado discreto, topo numa linha só |

## Desenho por parte

### 1. Novo agendamento (`components/agenda/MarcacaoSimples.tsx`)
- **Hora.** No lado "quando" entra um campo `<input type="time" step=300>` com ícone de relógio, ao lado da data. Clicar num horário livre preenche o campo. Digitar uma hora fora da lista é aceito, mas só aparece **"Fora dos horários livres"** quando ela cai fora deles. O servidor continua conferindo conflito como hoje (`POST /api/v1/agenda/agendamentos`). O "Outro horário"/encaixe atual (`permiteEncaixe`) é absorvido pelo campo e some.
- **Paciente novo / antigo.** É um controle segmentado acima de "Quem converteu".
  - O padrão vem de `calendar_event_types.category` e do nome:
    - novo quando `category = 'consulta'` e o nome começa com "Primeira";
    - antigo nos outros casos (consulta de acompanhamento, teleconsulta, `retorno`, `procedimento`).
  - Para isso, `category` passa a vir pela rota/hook de tipos até o tipo `Tipo` do formulário. É leitura de coluna que já existe, sem migration.
  - Em **antigo**, "Quem converteu" e "Origem do lead" ficam escondidos e não são enviados. `quemConverteu` não vai no POST, e o PATCH de origem do contato não acontece.
  - Em **novo**, tudo segue como hoje.
  - A escolha **não** é gravada: é só um modo da tela (DIRC: calcular, não duplicar).
- **Visual.** Os campos ganham ritmo e grupos com título ("Quem e o quê", "Paciente", "Quando"), com espaçamento consistente e os tokens do `app/globals.css`. Nada muda de nome nem de comportamento além do descrito.

### 2. Fileira de profissionais (`components/agenda/FiltroDePessoas.tsx`)
- A lista passa a ser **derivada dos compromissos já carregados da semana visível**: as pessoas que são dono de pelo menos um compromisso nela. Não é mais a equipe inteira de `usePessoasDaAgenda`, que segue servindo para o nome e a cor.
- Cada pessoa vira um botão com um ponto na cor dela e o primeiro nome + inicial do sobrenome. "Todos" vem primeiro e começa marcado.
- Clicar escolhe **uma** pessoa: a grade mostra só a agenda dela, e clicar de novo ou em "Todos" volta a mostrar todos.
  - Hoje o filtro é multisseleção. Escolher uma pessoa só é mais simples e é o que o André pediu.
  - O provider continua vendo só a si mesmo.
- Se ninguém tem atendimento na semana, a fileira some.
- A legenda de pessoas no rodapé da grade sai. A legenda de estados fica (Aguardando confirmação, Realizado, Não compareceu…).

### 3. Grade (`components/agenda/GradeDaAgenda.tsx`)
- **Domingo.** `diasDaSemanaDe` passa a devolver segunda→sábado (`weekStartsOn: 1`, 6 dias). Quando algum compromisso da semana cai no domingo, o domingo entra no fim da semana. Na visão de mês, `grid-cols-6`, com a mesma regra por semana do mês (a semana com domingo marcado ganha a 7ª coluna). Na visão de dia, nada muda.
- **Cartões.**
  - Faixa de 3px à esquerda na cor do profissional (`paleta.ts`) e fundo com essa cor bem clara.
  - Conteúdo: nome em negrito, depois "HH:mm · procedimento" em texto secundário.
  - O ícone de estado vai para o canto, e não mais na frente do nome.
  - Cartão curto (≤ 30 min) mostra só "HH:mm Nome".
- **Grade.** As linhas de meia hora ficam pontilhadas mais claras, e o rótulo de hora aparece só nas horas cheias. A linha do "agora" tem 2px, com bolinha na coluna de hoje.
- **Bloqueios.** Fundo cinza listrado (`repeating-linear-gradient`) e uma linha só ("Bloqueado"). O motivo vai para o `title`.
- **Topo** (em `app/app/agenda/_client.tsx`):
  - Uma linha com ‹ › período, Hoje, Dia/Semana/Mês e Novo agendamento.
  - Logo abaixo, a fileira de profissionais.
  - "Horários livres de" fica à direita da fileira.

### 4. Lista de baixo
- O `HistoricoDaAgenda` sai do `_client.tsx` (l.~1293), e o componente e os testes dele são apagados. A busca por paciente que o André usar depois é outra conversa (YAGNI).
- O que a lista fazia passa para o painel do paciente (abaixo):
  - confirmar;
  - remarcar;
  - cancelar.
- Antes de apagar, conferir quem mais importa o `HistoricoDaAgenda` ou as props dele.

### 5. Painel do paciente (`components/agenda/DetalheDoCompromisso.tsx`)
- Abre ao clicar no cartão e pelo `?compromisso=`, como hoje. O formato passa a ser o `Dialog` central, igual ao do Novo agendamento, em vez do `Sheet` lateral. Fecha com Esc e com o X.
- **Cabeçalho.** Iniciais, nome do paciente e etiqueta de estado (Agendado, Confirmado, Realizado, Faltou, Cancelado). Embaixo: procedimento, dia e hora, profissional e unidade.
- **Três botões grandes.**
  - **Confirmar:** usa a ação que já existe ("Confirmar horário"). Some quando já está confirmado.
  - **Remarcar:** abre, dentro do painel, data + campo de hora com relógio + horários livres. Usa o **mesmo componente de "quando" do Novo agendamento**, extraído de `MarcacaoSimples` para um componente próprio (`QuandoDaMarcacao`). Ele manda `starts_at` pela rota que a lista usava. O `Sheet` antigo de remarcação (`PainelDeMarcacao`, `_client.tsx:905-1087`) deixa de ser aberto por aqui, e é apagado se ficar sem uso.
  - **Cancelar:** abre, no painel, o campo "Motivo do cancelamento" e o botão "Cancelar consulta". Usa a rota atual. O `Sheet` de cancelamento (`_client.tsx:1093-1161`) é apagado se ficar sem uso.
- **Depois do horário de início:** Compareceu / Faltou, com o texto de evidência que já existe.
- **"Mais detalhes"** (`<details>`, fechado):
  - Ver contato e conversa;
  - observação e anotação;
  - "Marcada por";
  - quem converteu;
  - Google (`SincronizacaoDoCompromisso`) e Meet;
  - "Lembrar em uma hora";
  - excluir.
- Compromisso pessoal (sem paciente): mesmo painel, sem Compareceu/Faltou e sem contato.

## O que não muda
- Nenhuma tabela, coluna ou migration.
- As rotas de API seguem iguais, e só passa a sair `category` na leitura de tipos.
- As regras de conflito, lembrete, Google e IA não mudam.
- O Bloquear horário segue igual, mudando só o visual dos blocos na grade.
- Dia, Semana e Mês continuam.

## Riscos e cuidados
- **Remarcar no painel.** Tem de manter tudo o que o fluxo antigo de remarcação fazia: avisar o paciente, lembrete e Google. Antes de apagar `PainelDeMarcacao`, ler o que o `onConfirmar` dele chama e reaproveitar exatamente as mesmas chamadas.
- **Filtro de uma pessoa.** Os testes de `FiltroDePessoas` mudam de multisseleção para seleção única.
- **Mês com 6 colunas.** Os testes de `GradeDaAgenda` que contam 7 colunas mudam.
- **Navegação em cima, conteúdo embaixo** (regra do André): o painel não abre colunas lado a lado.
- **Safari:** o André usa Safari. A prova visual final é no Safari de verdade (memória "provar no Safari").

## Como provar
- Testes unitários dos componentes tocados:
  - padrão novo/antigo pelo tipo;
  - campos escondidos em antigo e não enviados;
  - fileira derivada dos compromissos;
  - domingo só com compromisso;
  - painel com os três botões e remarcação mandando `starts_at`.
- `pnpm typecheck`, `pnpm lint` e `pnpm test:unit` inteiros.
- Spec Playwright nova em `tests/e2e/`, dirigindo a tela:
  - marcar aplicação para paciente antigo;
  - clicar na consulta;
  - remarcar pelo relógio;
  - cancelar com motivo.
- Prints antes e depois em `.superpowers/evidence/`, mais conferência no Safari.
- Fragmento em `.changes/`, com `impacto: capacidade_nova`.
