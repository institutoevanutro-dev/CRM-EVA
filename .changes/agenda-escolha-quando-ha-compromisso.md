---
impacto: capacidade_nova
secao: adicionado
titulo: Regra de automação e follow-up escolhem o que fazer quando o contato tem horário marcado
---

Até aqui, todo envio automático para quem tinha um compromisso pendente ou confirmado na
agenda ficava adiado até o horário, mesmo que o compromisso fosse daqui a meses. Agora as
ações de enviar mensagem (texto e IA) de uma regra e a configuração de follow-up do agente
aceitam `quando_ha_compromisso`: `adiar` (o padrão, igual a antes), `enviar` (a agenda não
segura este envio) ou `nao_enviar` (o envio é pulado e registrado com o motivo
`compromisso_na_agenda`).

O pulo vale nos três caminhos de envio: regra de automação, texto fixo do follow-up e o
worker do follow-up. Numa regra, a aba Atividade mostra o motivo; no follow-up, a inscrição
é encerrada com esse motivo. Se o pulo acontecer com a mensagem já criada, ela aparece no
Inbox com o selo "Pulada pela agenda", sem o botão "Tentar de novo", porque reenviar
furaria a escolha.

Opt-out, janela do número e limite diário continuam valendo sempre. A escolha ainda não tem
controle na tela: por enquanto ela é gravada pela API da regra e pela configuração do
agente. Quem não configura nada não vê diferença.

Portado do projeto original (DeskcommCRM, PR #3818, #3840, #3850 de @webtecnica).
