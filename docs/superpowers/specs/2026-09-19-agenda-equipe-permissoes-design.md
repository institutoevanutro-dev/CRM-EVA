# Agenda por profissional e permissões da equipe

## Objetivo

Usar o CRM como agenda principal do Instituto Eva. Cada profissional terá agenda,
pacientes, serviços, unidade e disponibilidade próprios. O CRM poderá sincronizar os
agendamentos com um calendário Google individual, sem depender dele para funcionar.

## Papéis humanos

| Papel | Acesso |
| --- | --- |
| Administrador | Acesso total, incluindo configurações, integrações e permissões. |
| Gerente | Equipe, pacientes, agendas, leads, funis e pendências. |
| Colaborador | Todos os pacientes e agendas; cria e altera atendimentos e aplicações; não administra o sistema. |
| Prestador de serviço | Somente sua agenda e seus pacientes; registra os próprios atendimentos. |

Distribuição inicial confirmada:

- André: administrador.
- Erick Augusto: gerente.
- Isadora Carvalho de Figueiredo: colaboradora.
- Geovana Carvalho: administradora.
- Cintia humana: colaboradora após aceitar o convite.

Pessoas e agentes de IA são identidades diferentes, mesmo quando têm o mesmo nome.
Toda ação guarda autor, data, origem e motivo.

## Permissões dos agentes de IA

- Cintia IA consulta horários, agenda, remarca e cancela quando o paciente pede claramente.
- Isadora IA organiza aplicações, calorimetria e bioimpedância; também agenda, remarca e cancela.
- Erick IA supervisiona conversas, leads, funis e pendências.
- Nenhuma IA exclui histórico.
- Exceções financeiras, clínicas ou operacionais são enviadas para revisão humana.

Cancelamento por IA libera o horário somente após pedido claro do paciente. O CRM
registra o motivo, mas a IA não promete devolução do sinal. O sinal fica em revisão
humana. Remarcações com 24 horas ou mais preservam o sinal; abaixo desse prazo ficam
em revisão humana. O novo horário só é confirmado após verificar profissional e sala.

## Recursos da agenda

Cada agendamento reserva simultaneamente:

1. profissional;
2. unidade;
3. sala;
4. serviço e sua duração.

O CRM escolhe automaticamente uma sala compatível e livre. Funcionários autorizados
podem trocar a sala manualmente. A agenda usa uma grade de cinco minutos.

Capacidade física:

- Vitória: três consultórios e duas salas de aplicação.
- Serra: uma sala de atendimento.

Uma sala não recebe dois pacientes no mesmo período. Um profissional não atende dois
pacientes simultaneamente, salvo a exceção de aplicações da Isadora descrita abaixo.

## Aplicações da Isadora

- Intramuscular: sete minutos totais.
- Intravenosa: trinta minutos totais.
- Não há intervalo adicional; as durações já incluem o tempo operacional.
- Isadora pode acompanhar duas aplicações simultâneas somente quando uma for
  intravenosa e a outra intramuscular, cada uma em uma sala de aplicação diferente.
- Duas intravenosas ou duas intramusculares simultâneas são bloqueadas.

## Horário e distribuição semanal

As duas unidades funcionam de segunda a sexta, das 09h às 12h e das 14h às 19h.

- Dr. André: segunda e quinta na Serra; terça, quarta e sexta em Vitória.
- Dra. Ana: quarta à tarde em Vitória.
- Juliana: segunda à tarde em Vitória.
- Leonardo: quarta e sexta à tarde em Vitória.
- Paulo: terça e quinta à tarde em Vitória.
- Isadora: segunda e quinta o dia todo na Serra; terça, quarta e sexta o dia todo em Vitória.

Todos terão agenda própria no CRM. A disponibilidade real continua sujeita a bloqueios,
folgas, férias e compromissos já existentes.

## Estados do agendamento

1. Reservado.
2. Aguardando sinal.
3. Confirmado.
4. Em atendimento.
5. Concluído.
6. Cancelado.
7. Faltou.
8. Remarcado.

O histórico registra toda mudança de estado. Remarcação liga o horário anterior ao novo,
sem apagar o registro original.

## Fluxo de agendamento

1. Usuário ou IA escolhe paciente, serviço e profissional.
2. CRM calcula a duração e verifica profissional, unidade e sala.
3. CRM reserva uma sala compatível automaticamente.
4. CRM grava o agendamento e seu status.
5. Se houver calendário Google conectado, cria ou atualiza o evento correspondente.
6. Alterações feitas por IA ou pessoa atualizam o CRM e tentam atualizar o Google.
7. Se a sincronização falhar, o CRM mantém o agendamento e cria uma pendência para o gerente.

O CRM é a fonte da verdade. Um erro no Google não apaga nem desfaz o agendamento interno.

## Controles de conflito

A criação, remarcação ou cancelamento deve ser transacional. Antes de confirmar, o CRM
repete a verificação de disponibilidade para impedir duas reservas concorrentes. Conflitos
mostram opções livres próximas sem substituir silenciosamente a escolha do usuário.

Bloqueios de almoço, indisponibilidade do profissional, sala incompatível, duração fora do
expediente e sobreposição impedem a confirmação. Silêncio do paciente não cancela nem libera
horário automaticamente.

## Entregas sugeridas

1. Papéis, permissões e separação entre usuário humano e agente de IA.
2. Cadastro de profissionais, unidades, salas, serviços e disponibilidades.
3. Motor de disponibilidade e conflitos, incluindo a exceção da Isadora.
4. Criação, remarcação, cancelamento, estados e auditoria.
5. Sincronização individual com Google Agenda e fila de pendências.
6. Ferramentas seguras para Cintia IA e Isadora IA.
7. Testes de permissões, concorrência, salas, sinal e sincronização.

## Critérios de aceite

- Prestador não consegue ver agenda ou pacientes de outro profissional.
- Colaborador, gerente e administrador acessam todas as agendas conforme suas permissões.
- Não ocorre dupla reserva de profissional ou sala.
- A exceção da Isadora aceita apenas uma intravenosa com uma intramuscular simultâneas.
- IAs cancelam somente após pedido claro e nunca prometem devolução do sinal.
- Toda alteração fica auditável.
- Falha no Google gera pendência e preserva o agendamento no CRM.
