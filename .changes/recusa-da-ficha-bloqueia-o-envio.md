---
impacto: nada_mudou
secao: corrigido
titulo: Uma recusa de marketing registrada pela ficha do contato passa a bloquear os envios
---

Quando o consentimento de marketing de um contato era retirado pela ficha dele (`PATCH /api/v1/contacts/{id}`, no formato `{ "granted": false }`), essa recusa não era lida na hora de enviar: as automações (WhatsApp, mensagem escrita pela IA, e-mail) e as campanhas continuavam escrevendo para ele. Só a recusa recebida por um formulário era levada em conta. Agora a recusa é lida nos dois formatos e bloqueia esses envios. Lembretes de compromisso, que são transacionais, continuam saindo. Não há nada a fazer.

Portado do projeto original (DeskcommCRM, PR #4307 de @FabioMundoDigital).
