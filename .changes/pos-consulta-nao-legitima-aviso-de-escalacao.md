---
impacto: nada_mudou
secao: corrigido
titulo: O pós-consulta não faz mais sair "chamei alguém da equipe" num número sem IA
---
Quando o paciente respondia ao texto fixo de um follow-up (como o pós-consulta) com uma mensagem
de tom negativo, o detector de sentimento passava a conversa para a equipe e mandava ao paciente
o aviso "chamei alguém da equipe", mesmo num número onde nenhum agente atende. O aviso só deve
sair onde a IA de fato conversou, e o texto fixo do fluxo passou a não contar como conversa da
IA. Onde um agente já falou com o paciente, o aviso continua saindo como antes.
