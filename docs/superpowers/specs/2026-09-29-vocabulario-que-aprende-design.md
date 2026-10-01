# Vocabulário que aprende: a fila encolhe, a régua não afrouxa sozinha

> Spec. O plano de implementação sai depois, com `superpowers:writing-plans`.

## 1. O que se quer, e para quem

O dono de uma instalação abre a aba Comentários e encontra lá coisas que ele
publicaria sem pensar: "muito bom esse conteúdo", "@dr.andreluisc 💪💪💪".
Cada uma custa um clique e uma ida ao CRM. A trava de segurança
(`lib/comentarios/seguranca.ts`) nega por padrão e só libera quando **todo**
token está num vocabulário fechado escrito à mão, então qualquer palavra que
os autores não previram derruba o comentário inteiro para a fila.

**Sucesso é a fila encolher com o uso, sem que a régua afrouxe sozinha.**

Duas fontes de encolhimento, decididas com o dono em 29/09/2026:

1. **Marcação de perfil deixa de atrapalhar.** A trava passa a julgar o resto
   da frase.
2. **O vocabulário cresce com o aval do dono.** O sistema junta as palavras
   que apareceram nos comentários que ELE publicou e pergunta quais podem
   valer para o futuro. **A régua só afrouxa com o dedo dele.**

### O que NÃO muda

- **Os seis gatilhos continuam barrando sempre**: preço, medicação, sintoma,
  agendamento, reclamação e especialidade. Eles rodam ANTES do vocabulário, e
  nenhuma palavra aprovada pode desbloqueá-los. Uma palavra liberada ao lado
  de "quanto custa" não faz o comentário passar.
- **A trava de RQE** (`lib/comentarios/especialidade.ts`) segue intacta. O
  dono é médico, sem RQE, e nenhuma aprovação dele pode autorizar a IA a
  chamá-lo de especialista. Esta é a única regra que o próprio dono não pode
  relaxar, e isso é deliberado: ela protege o registro dele, não o conforto.
- **Resposta pública sobre preço** segue proibida.
- O caminho da regra de palavra por mídia e o Direct por gatilho de compra
  não são tocados.

### Decisões do dono (29/09/2026)

| Pergunta | Resposta |
|---|---|
| Quem libera? | Ele aprova. Nada vira seguro automaticamente. |
| Granularidade? | Palavra por palavra. Uma palavra serve para infinitas frases. |
| Marcação `@`? | Qualquer marcação é ignorada; julga-se o resto. |
| Onde guardar? | Tabela própria, com autoria e data. Não no jsonb da organização. |

## 2. Marcação de perfil

### O problema, medido

Em 30/09/2026 00:41 UTC chegou `@dr.andreluisc 💪💪💪💪💪💪` e foi para
`esperando_voce` com motivo `sem padrão seguro reconhecido`.

A causa é o tokenizador: `TOKEN_RE` corta por letras e dígitos, então
`@dr.andreluisc` vira **dois** tokens, `dr` e `andreluisc`. O primeiro está em
`COMO_CHAMAM_O_DONO`; o segundo não está em lugar nenhum, e um token de fora
reprova o texto inteiro.

### A regra

Antes de tokenizar, remover do texto normalizado toda sequência
`@` + identificador do Instagram (letras, dígitos, ponto, sublinhado). O que
sobra é o que decide.

Consequências, todas queridas:

- `@dr.andreluisc 💪💪💪` vira `💪💪💪` → só emoji → **seguro**.
- `@fulano quanto custa?` vira `quanto custa?` → **gatilho de preço**, barrado.
- `@fulano @ciclano top demais` vira `top demais` → **seguro**.
- `@fulano` sozinho vira texto vazio. `ehObviamenteSeguro` já devolve
  `{seguro: false, gatilho: "vazio"}` para texto vazio, e isso **permanece**:
  um comentário que é só marcação não tem o que responder.

O `@` é removido na análise, nunca do texto guardado nem do que aparece na
tela. O que a pessoa escreveu continua íntegro em `instagram_comments.texto`.

## 3. O vocabulário que aprende

### De onde vêm os candidatos

De `instagram_comments` desta organização com
`situacao = 'respondido_manualmente'`: são os comentários que o dono, com o
próprio dedo, decidiu que mereciam resposta pública. Descartados
(`ignorado`) não entram, e é justamente essa diferença que dá o sinal.

Um candidato é um token que, ao mesmo tempo:

- aparece em pelo menos um comentário `respondido_manualmente` da organização;
- **não** está no vocabulário fixo do código;
- **não** é emoji nem dígito (a trava já os aceita);
- **não** foi decidido antes (nem aprovado, nem recusado);
- **não** casa nenhum dos seis gatilhos. Palavra de gatilho nunca é oferecida
  para aprovação: oferecê-la seria pedir ao dono que desarme a própria
  proteção num momento em que ele está apenas limpando a fila.

A lista é **calculada na hora** a partir da fila. Não há tabela de
candidatos: eles são derivados (Doutrina DIRC — Calcular).

### O que fica guardado

Só a **decisão**: palavra aprovada ou recusada, por quem, quando. Guardar a
recusa é tão importante quanto guardar a aprovação, senão a mesma palavra
volta a ser oferecida toda semana e a tela vira ruído.

### Como a trava passa a decidir

`todosOsTokensSaoSeguros` passa a consultar **vocabulário fixo ∪ palavras
aprovadas desta organização**. A função continua pura: quem carrega as
palavras aprovadas é o chamador, que as passa como argumento. O worker lê uma
vez por rodada, junto com o perfil de voz, e usa para todos os comentários
daquela organização.

**A ordem dos gatilhos não muda.** Eles rodam primeiro, sobre o texto sem
marcações, e continuam soberanos.

## 4. Dados

Tabela `instagram_comment_vocabulario`:

| coluna | o quê |
|---|---|
| `id` | uuid |
| `organization_id` | uuid, FK, `on delete cascade` |
| `palavra` | text, já normalizado (minúsculo, sem acento) — a mesma forma que o tokenizador produz |
| `aprovada` | boolean — `false` é recusa explícita, não ausência |
| `decidida_por` | uuid, FK `auth.users`, `on delete set null` |
| `created_at` | timestamptz |

- Único: `(organization_id, palavra)`. Decidir de novo atualiza a linha.
- RLS: SELECT para membro do tenant (`fn_user_org_ids`); escrita exige
  `fn_role_at_least(organization_id, 'manager')` — mesmo piso de
  `instagram_comment_rules_write`, porque as duas coisas afrouxam o que sai
  sem toque humano.
- Sem coluna de contagem. Quantas vezes a palavra apareceu é derivável da
  fila, e guardar cópia é o anti-pattern nº 2 do CLAUDE.md.

## 5. Onde aparece

Na aba Comentários do Inbox, ao lado de "Frases do Direct": um painel
**"Palavras que a IA pode usar"**.

- Lista os candidatos, cada um com **em quantos comentários seus** ele
  apareceu. Só a palavra e o número: o dono escolheu julgar palavra por
  palavra, explicitamente contra a variante que mostrava o comentário de
  origem ao lado. A contagem entra porque ela ordena a lista pelo que mais
  encolhe a fila, não porque dá contexto.
- Dois botões por palavra: **Pode usar** e **Nunca**.
- Uma linha de rodapé com o que já foi decidido, para poder voltar atrás:
  "12 palavras liberadas, 3 recusadas".
- Vazio é estado normal e tem texto próprio: "Nada novo para decidir. As
  palavras aparecem aqui conforme você responde comentários."

Papel `manager`, o mesmo da rota.

## 6. Sistema vivo

| Invariante | Como esta peça responde |
|---|---|
| Entrada e saída | Entra: a fila de comentários que o dono respondeu. Sai: palavras aprovadas que o worker consulta. |
| Emite log | `comment.vocabulary_decided` na auditoria, com a palavra e a decisão. |
| Aparece na tela | Painel na aba Comentários, com contagem e exemplo. |
| Porta na navegação | Dentro da aba Comentários, que já está no catálogo. Não é tela nova. |
| Anti-morte | Não tem worker nem fila própria. Se ninguém decidir nada, o sistema segue exatamente como hoje: mais coisa na fila humana, nada quebra. |
| Laço de retorno | Palavra aprovada que resultar em resposta ruim aparece como resposta pública da IA na aba, e o dono pode recusá-la depois. A decisão é reversível, e é por isso que a recusa também é gravada. |
| Configuração com superfície | A lista de aprovadas e recusadas é visível e editável na mesma tela. |

## 7. Riscos

**Deriva por acúmulo.** Cada palavra isolada parece inofensiva; o conjunto
pode compor frases que ninguém previu. O que segura é que os gatilhos rodam
antes e não são aprováveis: o pior caso é um elogio esquisito, não uma
resposta sobre medicação. *Mitigação:* a tela mostra o total de palavras
liberadas, e a recusa é sempre possível.

**O dono aprovar no piloto automático.** Limpar fila é chato, e marcar tudo é
tentador. *Mitigação:* nunca oferecer palavra de gatilho, e assim o pior
clique distraído continua sendo inofensivo. **Esta é a mitigação mais fraca
da spec**, e é consequência direta de mostrar a palavra sozinha: quem aprova
"corte" sem ver a frase não sabe qual "corte" está liberando. Se a fila
mostrar que houve aprovação ruim, mostrar o comentário de origem ao lado é o
primeiro ajuste a fazer.

**Palavra ambígua entre nichos.** Este produto é open source: "corte" numa
clínica de estética e numa barbearia não significam a mesma coisa. *Por isso a
tabela é por organização*, nunca global.

**O sinal pode estar errado.** `respondido_manualmente` inclui comentários que
o dono respondeu por educação, não por serem inócuos. *Mitigação:* é ele quem
aprova; o histórico só propõe.

## 8. Fora de escopo

- Aprender **frases**, não só palavras.
- Mostrar o comentário de origem ao lado de cada palavra. Foi oferecido ao
  dono e recusado em favor da tela menor; fica anotado como o primeiro
  ajuste se a aprovação no automático virar problema.
- Sugerir a recusa de palavras já aprovadas com base em resultado ruim.
- Vocabulário compartilhado entre organizações, ou semente por nicho.
- Desligar o gatilho de abertura de conversa (preço/agendamento).
- Qualquer aprovação automática, em qualquer volume.

## 9. Como se prova

- **Unidade, `seguranca.ts`:** marcação removida nos quatro casos da §2;
  palavra aprovada libera, palavra recusada não; gatilho vence palavra
  aprovada (`"@fulano top, quanto custa?"` continua barrado com motivo
  "preço").
- **Unidade, candidatos:** token de gatilho nunca é oferecido; palavra já
  decidida não reaparece; emoji e dígito não viram candidato; só a
  organização certa.
- **Banco:** RLS entre duas organizações; `viewer` não escreve, `manager`
  escreve; único por `(organization_id, palavra)`.
- **Tela:** painel lista candidato com a contagem; aprovar tira da lista;
  estado vazio tem texto.
- **Ponta a ponta:** comentário com marcação que hoje cai na fila passa a ser
  respondido sozinho, e um com preço continua caindo, com o receptor local
  provando que nada público saiu no segundo caso.
