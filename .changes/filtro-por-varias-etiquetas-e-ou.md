---
impacto: capacidade_nova
secao: adicionado
titulo: Filtre a lista por várias etiquetas de uma vez — todas (E) ou qualquer uma (OU)
---

O filtro de etiqueta passa a aceitar mais de uma escolha nas três listas: Inbox, Funil e Contatos. Você marca quantas quiser no menu (o menu não fecha mais a cada clique) e escolhe o sentido:

- **Todas (E)** — a lista mostra só quem tem todas as etiquetas escolhidas, juntas na mesma caixa (na conversa ou no contato), que era o sentido de filtrar por duas e comparar na cabeça.
- **Qualquer uma (OU)** — a lista mostra quem tem pelo menos uma delas, em qualquer caixa.

O modo aparece no menu só quando há duas ou mais etiquetas, porque com uma ele não muda nada. O gatilho do filtro resume a escolha ("vip +1") e "Limpar filtros" continua limpando tudo. Os filtros continuam nos endereços: `?tag=vip&tag=orçamento` com `&modo=ou`, e qualquer link salvo ou chamada de API com uma etiqueta só segue funcionando igual, sem mudança.

Uma combinação ainda não é possível: "vip na conversa **e** orçamento no contato", misturando as caixas. Ela fica registrada como decisão de produto pendente — as duas caixas de hoje não a expressam, e o filtro não finge que expressa.

Portado do projeto original (DeskcommCRM PR 1886 de @webtecnica).
