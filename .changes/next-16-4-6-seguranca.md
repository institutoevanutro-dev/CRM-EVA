---
impacto: nada_mudou
secao: corrigido
titulo: Next.js atualizado para 16.4.6 (correção de segurança)
---

O Next.js passou da 16.4.2 para a 16.4.6. A 16.4.2 tinha uma falha conhecida (GHSA-mfr8-8qww-v76h / CVE-2026-119790) que podia vazar dados guardados em cache entre parâmetros de rota, e o `next build` já recusava compilar com ela. Nada muda na tela nem no `.env`.
