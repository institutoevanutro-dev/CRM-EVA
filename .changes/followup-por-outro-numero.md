---
impacto: capacidade_nova
secao: adicionado
titulo: Um passo de follow-up pode sair por outro número de WhatsApp
---
No editor de follow-up, o passo de envio ganhou "Enviar pelo número": o
padrão continua sendo o número da conversa; escolhendo outro, aquele passo
sai por ele. Se o contato ainda não tem conversa nesse número, ela é criada no
envio, e valem as travas e a janela de envio desse número. Num número com
risco de banimento (WhatsApp não oficial), o follow-up abre no máximo 20
conversas novas por dia com quem nunca falou com ele; acima disso o passo volta
no dia seguinte. O teto se ajusta em `FOLLOWUP_PRIMEIRO_CONTATO_TETO_DIA`
(opcional; nenhuma edição de `.env` é necessária). Fluxos já publicados não
mudam.
