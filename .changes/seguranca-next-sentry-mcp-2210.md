---
impacto: nada_mudou
secao: corrigido
titulo: Correções de segurança no Next.js, no Sentry e no SDK do MCP
---

Atualiza três dependências com avisos de segurança publicados em 22/10/2026:

- Next.js 16.3.8 → 16.4.2: requisições montadas podiam esgotar a CPU com App Router e Server
  Actions (GHSA-p3m5-59mp-jv5r), e a otimização de imagem tinha execução remota com SVG
  (GHSA-2464-fhr4-w9xw; o CRM usa `images.unoptimized`, mas a versão corrigida fecha a porta).
- Sentry 10.74.0 → 10.76.2: desvio do middleware pela rota de túnel (GHSA-mchm-gjx6-7h55). O CRM
  usa a rota de túnel `/monitoring`.
- SDK do MCP 1.31.0 → 1.32.1: quatro avisos no servidor e no cliente MCP, incluindo token de
  portador emitido para outro servidor sendo aceito (GHSA-rvq5-wwqv-78pq) e requisição que
  esgotava memória (GHSA-46jr-4wx8-v453).

Nada muda na tela nem na configuração.
