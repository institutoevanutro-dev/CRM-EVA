# Paciente confirma a presença respondendo ao lembrete

Pedido do André em 27/11/2026, na conversa "Memória central". Nas palavras dele: "na hora que enviar mensagem para os pacientes antes do agendamento, coloque a opção dele mesmo confirmar, e dessa forma, o paciente confirma o agendamento e o CRM apenas lê essa confirmação". Antes disso, ele escolheu o sentido de "confirmado": "o paciente confirmou que vem" (opção 1).

Este documento foi escrito à noite, enquanto o André dormia. As decisões marcadas **(a confirmar)** são recomendações minhas. As outras saem direto do que ele pediu.

## O que existe hoje (medido no código e no banco do Instituto em 27/11)

- **O lembrete já sai.**
  - Quem envia é o cron `app/api/v1/cron/agenda-reminder`, a cada 5 minutos, só para compromissos `confirmed` (na tela, "Agendado") cujo tipo tem `reminder_enabled`.
  - No Instituto, o lembrete está ligado nos 5 tipos de consulta do Dr. André, todos na véspera (1440 min), com texto próprio. Saíram 72 lembretes em 60 dias, o último em 27/11.
  - O texto atual não pede resposta nenhuma ("Estamos te esperando! Se precisar remarcar, me avise…").
- **"Confirmado" no banco quer dizer outra coisa.**
  - `status='confirmed'` é a clínica ter fechado o horário (aparece como "Agendado").
  - `pending` é "Aguardando confirmação" da clínica (sinal etc.) e expira em 24h. Esse compromisso nunca recebe lembrete.
  - **Não existe hoje nenhum registro de "o paciente disse que vem".**
- **A resposta do paciente não tem elo com o lembrete.**
  - A mensagem do lembrete não guarda o id do compromisso.
  - Toda mensagem que chega vai para o agente de IA pelo turno normal (`pos-entrada.ts` → `pedirDespachoDoAgente`).
  - O agente tem `crm_confirm_appointment`, que só serve para `pending → confirmed`.

## Decisões

| # | Tema | Decisão |
|---|------|---------|
| 1 | O que é "confirmado pelo paciente" | Marca **separada do status**: "Presença confirmada". O compromisso continua "Agendado". Não mexe na expiração dos pendentes, no funil nem no laço `appointment.confirmed`. |
| 2 | Quem recebe o pedido de confirmação | Só o lembrete que já sai (`confirmed` + tipo com lembrete ligado), e só nos tipos em que a clínica ligar a chave nova **"Pedir confirmação no lembrete"** (desligada por padrão: nada muda em clínica nenhuma até alguém ligar). |
| 3 | Texto que vai ao paciente **(a confirmar)** | Com a chave ligada, o lembrete ganha no fim a frase: **"Para confirmar sua presença, responda SIM."** O texto da clínica continua editável como hoje, e a frase é acrescentada pelo sistema para nunca faltar a palavra que o CRM sabe ler. |
| 4 | O que o CRM lê | Só resposta **inequívoca e isolada**, igual à doutrina do opt-out (`lib/opt-out/deteccao.ts`): a mensagem inteira é "sim", "1", "confirmo", "confirmado(a)", "sim, confirmo", "vou sim", "estarei aí", "👍" ou "✅", com variações de caixa, acento e pontuação. Qualquer outra coisa ("sim, mas posso chegar 10 min atrasada?", "não vou", "remarcar") **não** é lida como confirmação e segue como hoje para o agente ou a equipe. |
| 5 | A qual compromisso a resposta se refere | O lembrete passa a carimbar `messages.metadata.agenda_lembrete = {appointment_id, revision}`. Uma resposta só confirma se, na mesma conversa, o último lembrete for de um compromisso ainda `confirmed`, futuro, na mesma revisão e sem confirmação. Sem lembrete carimbado, nada é lido. |
| 6 | O CRM responde? | **Não.** "O CRM apenas lê." Não há resposta automática nova. O agente de IA (ou a equipe) responde como hoje, e o bloco de compromissos que ele vê passa a dizer "presença confirmada pelo paciente", para que ele não peça confirmação de novo. |
| 7 | Remarcou? | A confirmação vale para o horário confirmado. Se `starts_at` mudar, a marca é apagada (no banco, junto da troca de horário), e o próximo lembrete pede de novo. |
| 8 | Confirmação por telefone **(a confirmar)** | O painel do paciente ganha o botão **"Paciente confirmou"** (só em "Agendado" e antes do horário), para a recepção marcar quando o paciente confirma por ligação. A origem fica gravada: mensagem ou equipe. |
| 9 | Onde aparece | **Cartão da grade:** ícone de check no canto ("Presença confirmada"), mais um item na legenda. **Painel:** etiqueta "Presença confirmada · pelo WhatsApp 26/11 14:32" ou "· pela equipe". **Timeline do lead:** atividade "Paciente confirmou presença". **Auditoria:** `agenda.paciente_confirmou`. |
| 10 | Quem não respondeu **(a confirmar)** | No cartão de quem recebeu o lembrete e não confirmou, aparece um ícone discreto "Sem confirmação". É calculado (lembrete enviado + sem confirmação), sem coluna nova. A recepção vê na véspera quem precisa de ligação. |

## Banco (uma migration, reservada: **0441**)

Colunas novas em `calendar_appointments`, todas anuláveis:
- `patient_confirmed_at timestamptz`;
- `patient_confirmed_source text`, com check em `('mensagem','equipe')`;
- `patient_confirmed_message_id uuid`, que referencia `messages(id)` com `on delete set null`;
- `patient_confirmed_user_id uuid`, que referencia `auth.users(id)` com `on delete set null`.

Coluna nova em `calendar_event_types`: `reminder_asks_confirmation boolean not null default false`.

- **Apagar ao remarcar:** no trigger de carimbo que já existe (`fn_appointment_stamp`), quando `starts_at` muda, as quatro colunas voltam a null.
- **Gravar:** RPC `fn_appointment_patient_confirm(p_appointment_id, p_revision, p_source, p_message_id, p_user_id)`, `security definer`, com piso no corpo:
  - só grava se o status for `confirmed`, `starts_at` for futuro, a revisão bater e ainda não houver confirmação;
  - é idempotente e devolve o que aconteceu.
  - Revogada de `public` e `anon` (regra 9 da doutrina) e concedida só a `service_role`.
- Apêndice idempotente no `baseline.sql` e linha no MANIFEST. Sem CHECK novo em coluna de vocabulário aberto.

## Código

1. **Leitor:** `lib/agenda/confirmacao-do-lembrete.ts`.
   - `ehConfirmacaoDePresenca(texto)` é pura e testada com as frases de controle, inclusive as que NÃO podem confirmar.
   - `lerConfirmacaoDoLembrete(mensagem)` acha o lembrete carimbado e chama o RPC.
2. **Ligação:** novo efeito em `lib/channels/pos-entrada.ts`, logo depois do opt-out.
   - É fire-and-forget e falha aberta: nunca bloqueia nem atrasa o despacho do agente.
   - A ordem dos efeitos é vigiada por `tests/unit/pos-entrada-efeitos-do-canal.test.ts`, que é atualizado.
3. **Lembrete:** o cron `agenda-reminder` passa a acrescentar a frase quando o tipo tem a chave e a carimbar o `metadata` da mensagem.
   - A frase não entra no lembrete de quem já confirmou (o degrau seguinte, por exemplo); o carimbo entra igual.
   - O `montarLembrete` ganha o parâmetro da frase.
   - O carimbo vai em todo lembrete, porque é barato e permite ligar a chave depois sem perder o elo.
4. **Equipe:** o PATCH `/api/v1/agenda/agendamentos` aceita a ação `paciente_confirmou` (papel `agent` ou acima) e chama o mesmo RPC com `source='equipe'`.
5. **Telas:**
   - `GradeDaAgenda` mostra o ícone no canto e a legenda. Cada ícone novo só entra na legenda quando algum bloco da tela o mostra: com a chave desligada, a legenda fica como era.
   - `DetalheDoCompromisso` mostra a etiqueta e o botão "Paciente confirmou".
   - A configuração do tipo, em Configurações › Agenda, ganha a chave "Pedir confirmação no lembrete", com prévia do texto final.
   - O GET de detalhe e o hook da lista passam a trazer as colunas novas.
6. **Agente:** `compromissos-do-contato.ts` inclui "presença confirmada pelo paciente em …" no bloco.

## O que não muda

- O status do compromisso, a expiração dos pendentes, o funil e o laço `appointment.confirmed`.
- A régua e o horário do lembrete, a janela de 24h e o canal.
- Nenhuma resposta automática nova ao paciente.
- Clínicas que não ligarem a chave não veem diferença, exceto o botão "Paciente confirmou" e o carimbo invisível no lembrete.

## Riscos

- **Leitura errada:** um "sim" que respondia a outra pergunta da conversa ser lido como confirmação.
  - Mitigação: só lê se o **último lembrete carimbado** da conversa for posterior a qualquer outra mensagem que a clínica enviou depois dele. Se a clínica (ou a IA) mandou outra coisa depois do lembrete, o "sim" não é lido.
- **O agente responder estranho ao "SIM":** ele vê a marca no bloco e responde curto. Isso é coberto por teste do bloco.
- **Meta oficial:** o lembrete é texto livre dentro da janela de 24h, como hoje, e não muda.

## Como provar

- Unitários:
  - o leitor, com as frases de controle positivas e negativas;
  - o RPC, por invariante com Postgres real: revisão errada, compromisso passado, pendente, já confirmado e remarcação que apaga;
  - o carimbo do lembrete e a frase acrescentada;
  - o PATCH da equipe com RBAC.
- `pnpm typecheck`, `pnpm lint`, `pnpm test:unit` inteiros e `pnpm test:db` (mexe em schema).
- e2e pela tela:
  - liga a chave no tipo;
  - o cron envia o lembrete;
  - chega um "SIM" pela ingestão do WAHA de teste;
  - o cartão mostra a marca;
  - o painel mostra "pelo WhatsApp";
  - o botão "Paciente confirmou" funciona em outro compromisso.
- Safari real, como a Agenda nova. Fragmento em `.changes/` com `capacidade_nova`.

## Perguntas para o André (uma por vez, de manhã)

1. A frase "Para confirmar sua presença, responda SIM." serve?
2. O botão "Paciente confirmou" para confirmações por telefone pode entrar?
3. O ícone "Sem confirmação" no cartão ajuda ou polui?
