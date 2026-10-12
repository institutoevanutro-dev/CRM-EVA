---
impacto: capacidade_nova
secao: adicionado
titulo: Os registros que a IA grava a cada conversa passam a ter prazo de guarda
---
Sete tabelas que a IA preenche a cada mensagem nunca eram limpas e cresciam para sempre. A limpeza diária que já existia (`data-retention`) passa a cuidar delas também, em lotes pequenos, e cada rodada que apaga alguma coisa deixa uma linha `retention.sweep_run` na auditoria com a contagem de cada tabela.

O que passa a ser apagado, com os prazos que valem sem você mexer em nada:
- custo e tokens de cada chamada à IA, métricas dos turnos, ativações de skills e decisões do roteador: depois de 400 dias (`AI_TELEMETRY_RETENTION_DAYS`, mínimo 100). Não guardam texto de conversa. As telas Uso de IA e Evolução olham no máximo 90 dias e o orçamento olha o mês corrente, então nada some delas. Na tela Execuções, a lista para de voltar no tempo em 400 dias;
- registro de horário dos envios, usado no ritmo anti-banimento: depois de 2 dias (`PACING_LEDGER_RETENTION_DAYS`, mínimo 2). O último envio de cada número nunca é apagado. Nenhuma tela mostra esse registro;
- cópias do texto das mensagens enviadas, usadas pelo bloqueio de texto repetido: depois de 30 dias (`OUTBOUND_COPIES_RETENTION_DAYS`, mínimo 7). As últimas que o bloqueio compara (20 por número, ou o que estiver configurado) nunca são apagadas. Nenhuma tela mostra essas cópias, e as mensagens da conversa não são tocadas;
- resumos de atendimento que o agente escreve ao fim de cada turno: depois de 180 dias (`LEAD_CHECKPOINT_RETENTION_DAYS`, mínimo 30), e só os resumos já substituídos por um mais novo. O resumo em vigor de cada atendimento, que é a memória que o agente lê para manter o contexto com a pessoa, nunca sai, nem o que um trabalho ainda na fila vai ler. Nenhuma tela mostra os resumos antigos; a exportação de dados de LGPD de um contato deixa de trazer os resumos substituídos com mais de 180 dias.

**Se você quer guardar mais histórico do que o padrão, ponha a variável no `.env` ANTES de atualizar:** a primeira limpeza depois da atualização já apaga pelo prazo em vigor, e o que ela apagou não volta.

Para mudar um prazo, ponha a variável no `.env` com o número de dias e recrie o app. Um valor abaixo do mínimo vira o mínimo, com aviso no log; um valor que não é número vira o padrão. Os mínimos moram dentro das funções de limpeza do banco, então nem chamando a limpeza à mão dá para apagar menos dias do que o mínimo. O mínimo vale para a limpeza: um `DELETE` digitado direto no banco não passa por ele.

A primeira rodada depois da atualização pode ter bastante a apagar numa instalação antiga. Ela anda em lotes de 1.000 linhas, com teto de 20 lotes por tabela por noite, e termina ao longo de alguns dias sem travar o sistema. O espaço liberado volta a ser usado pelo banco, mas o tamanho do arquivo no disco só diminui com um `VACUUM FULL`, que o runbook `docs/runbooks/custo-e-cota-do-supabase.md` explica.

Continuam sem limpeza, de propósito: a fila de gatilhos de tempo (`event_log`), que é o que impede o mesmo WhatsApp de ser enviado duas vezes, e as mensagens, notas e memórias do contato.

Portado do DeskcommCRM (melgarafael/DeskcommCRM#2140, de @melgarafael).
