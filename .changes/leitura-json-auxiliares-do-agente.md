---
impacto: nada_mudou
secao: corrigido
titulo: "Três auxiliares do agente leem o JSON do modelo mesmo com cerca de código, prosa ou repetição"
---

Os auxiliares do agente pedem JSON no prompt e leem o texto de volta. A leitura
antiga recortava do primeiro `{` ao último `}`, e quando o modelo repetia o
objeto (comum via OpenRouter) o recorte pegava as duas cópias e o parse falhava.
O novo `extrairJsonDoTexto` tenta o texto inteiro e, se não der, devolve o
primeiro objeto que parsear, respeitando strings. Passam a usá-lo o roteador de
intenções, a compactação e o flywheel de propostas.

Portado do projeto original (DeskcommCRM PR 2096 de @webtecnica).
