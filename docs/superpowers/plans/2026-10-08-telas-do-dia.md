# Parte 5, grupo 1 — telas do dia a dia

O André aprovou este desenho em 08/10/2026, a partir dos prints de produção e
de uma leitura do código. As telas cobertas são Agenda, Contatos, Tarefas,
Respostas rápidas e Radar. Este grupo não traz migration nem muda nenhuma API.

## Comum a todas
- `components/shell/CabecalhoDaPagina.tsx` monta o topo de cada tela: o título,
  uma frase e as ações à direita. Ele substitui os cinco cabeçalhos escritos à
  mão.
- A tela vazia usa `components/empty/EmptyState.tsx`, que já existe.

## Agenda
- **Defeito do cabeçalho:** a linha dos dias da semana, que é `sticky`, subia
  por cima da barra do topo do app ao rolar a página. A causa é o `z-index`
  dela.
- **Ordem da tela:** o cabeçalho vem antes do cartão do Google. O cartão vira
  uma linha discreta, e "Desconectar" passa a pedir confirmação e a mostrar o
  erro quando falha.
- **O que aparece primeiro:** o calendário. O histórico (Próximos, Aguardando,
  Passados, Cancelados) fica atrás de um alternador "Calendário | Lista".
- **Nome no bloco:** o título do compromisso quebra em duas linhas em vez de
  cortar.

## Contatos
- **Textos:**
  - o subtítulo perde o "Customer 360";
  - "Importar CSV" vira "Importar planilha";
  - "Tag" vira "Etiqueta".
- **Selo "Ativo":** sai. A linha só mostra o que foge do normal.
- **Coluna Email:** só aparece se algum contato da página tiver email.
- **"Última atividade":** cabe numa linha só, sem quebrar.
- **Seletor "N por página":** sai. A página usa 25 itens fixos e mantém o
  "Carregar mais".
- **Filtro sem resultado:** mostra `EmptyFilterResults`.

## Tarefas
- **Cabeçalho:** cabe numa linha só. O botão "Atualizar" sai.
- **Filtros:** "Em aberto" e "Pendente" viram uma opção só.
- **Título do calendário:** troca `capitalize` por `first-letter:uppercase`.
- **Cor da prioridade:** usa os tokens de aviso.

## Respostas rápidas
- **Textos:** "template" vira "resposta" na tela e no diálogo.
- **Botão de criar:** vai para o cabeçalho.
- **Organização:**
  - a lista ganha uma busca;
  - as respostas são agrupadas pelo prefixo do título, o trecho antes do
    primeiro " · ".
- **Variáveis:** `{{variavel}}` aparece como uma etiqueta legível.
- **Estados:** a tela ganha um estado de erro e um estado vazio próprio.

## Radar
- **Tempo:** "aberta há 587h" vira dias.
- **Termos:** "em voo" vira "retorno agendado".
- **Lista de pendentes:** o bloco "N sem próximo passo" mostra os 5 primeiros e
  um "ver todas".
- **Erro de carga:** aparece como erro, não como "nenhum risco".
