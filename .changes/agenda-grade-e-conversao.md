---
impacto: capacidade_nova
secao: alterado
titulo: Agenda mais limpa, com cor por profissional, e o agendamento diz quem converteu e a origem do lead
---
A grade da Agenda desenha só as horas das jornadas de atendimento (sem a
madrugada), com uma linha na meia hora e o horário dentro de cada vaga. O
bloqueio aparece uma vez só, como faixa "Bloqueado" com cadeado, os nomes e o
motivo; um feriado de vários profissionais vira uma faixa única. Cada consulta
tem a cor do profissional, mais forte, e a legenda diz de quem é cada cor.

No "Novo agendamento": só aparece quem tem procedimento cadastrado; "Marcada
por" já vem em Mensagem; a janela ficou mais larga; escolhido o paciente, a
busca some e um X desfaz a escolha. Dois campos novos: "Quem converteu" (alguém
da equipe ou a IA do atendimento; padrão: quem marca), gravado no agendamento e
mostrado no detalhe, e "Origem do lead", lida pela mesma regra do funil do
Marketing — mudar ali grava o "Como chegou" da ficha. Migration 0422 (colunas
novas em `calendar_appointments`); o `update.sh` reaplica o baseline.
