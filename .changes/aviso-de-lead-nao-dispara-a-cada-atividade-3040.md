---
impacto: nada_mudou
secao: corrigido
titulo: "Lead atribuído a você" só avisa quando o responsável muda de verdade
---

A notificação de negócio atribuído (e as de ganho e perdido) aparecia para quem já era o responsável a cada novidade do negócio, como uma mensagem ou uma mudança de etapa, porque o sistema não conseguia ver quem era o responsável antes da atualização. Agora o aviso sai só quando o responsável (ou o status) muda em relação ao último estado que a sua tela viu daquele negócio. Se a sua tela ainda não tinha visto nenhuma atualização daquele negócio desde que foi aberta, o aviso não sai: o sistema prefere ficar em silêncio a avisar por engano. Nada a fazer na atualização.

Portado do projeto original (DeskcommCRM, PR #3183 de @webtecnica).
