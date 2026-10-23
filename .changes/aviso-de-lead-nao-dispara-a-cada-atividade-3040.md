---
impacto: nada_mudou
secao: corrigido
titulo: "Lead atribuído a você" só avisa quando o responsável muda de verdade
---

A notificação de negócio atribuído (e as de ganho e perdido) aparecia para quem já era o responsável a cada novidade do negócio, como uma mensagem ou uma mudança de etapa, porque o sistema não conseguia ver quem era o responsável antes da atualização. Agora o aviso sai só quando o responsável (ou o status) muda em relação ao último estado que a sua tela viu daquele negócio. Quando a sua tela ainda não tinha visto aquele negócio, o aviso sai se a própria atualização foi a atribuição a você (ou o ganho e a perda), e fica em silêncio quando ela é só uma novidade num negócio que já era seu. Nada a fazer na atualização.

Portado do projeto original (DeskcommCRM, PR #3183 de @webtecnica). No CRM da clínica, o negócio que a tela ainda não tinha visto também avisa, pelo horário da atribuição gravado no negócio; no original ele ficava sempre em silêncio.
