# Fontes locais

O build não baixa fonte nenhuma: `next/font/local` lê os `.woff2` desta pasta.
Até 10/2026 era `next/font/google`, que baixava do Google **durante o
`next build`**; quando a rede piscava, o Turbopack falhava com
`Can't resolve '@vercel/turbopack-next/internal/font/google/font'` e derrubava
`build-and-size` e `imagens-ok`.

| Arquivo | Família | Onde | Pesos / eixos | Subset |
|---|---|---|---|---|
| `inter.woff2` | Inter | `app/layout.tsx` | wght 100–900 (opsz fixo no default) | latin + latin-ext |
| `cormorant-garamond.woff2` | Cormorant Garamond | `app/layout.tsx` | wght 500–700 | latin + latin-ext |
| `ibm-plex-mono-{400,500}.woff2` | IBM Plex Mono | `app/layout.tsx` e `/design` | 400, 500 | completo (ver Plex) |
| `bricolage-grotesque.woff2` | Bricolage Grotesque | `/design` | wght 200–800 | latin |
| `plus-jakarta-sans.woff2` | Plus Jakarta Sans | `/design` | wght 200–800 | latin |
| `fraunces.woff2` | Fraunces | `/design` | wght, opsz, SOFT, WONK | latin |
| `manrope.woff2` | Manrope | `/design` | wght 200–800 | latin |
| `atkinson-hyperlegible-{400,700}.woff2` | Atkinson Hyperlegible | `/design` | 400, 700 | latin |
| `source-serif-4.woff2` | Source Serif 4 | `/design` | wght 200–900 (opsz fixo) | latin |
| `ibm-plex-sans.woff2` | IBM Plex Sans | `/design` | wght 100–700 | completo (ver Plex) |
| `jetbrains-mono.woff2` | JetBrains Mono | `/design` | wght 100–800 | latin |

## Licença

Todas são **SIL Open Font License 1.1**; o texto de cada uma, com o copyright
dos autores, está em `<família>.OFL.txt` ao lado. A OFL permite embutir e
redistribuir a fonte com o software, desde que a licença acompanhe.

**Plex** tem *Reserved Font Name* ("Plex"): uma versão modificada não pode
usar o nome. Por isso os arquivos Plex são o TTF original só trocado de
formato (WOFF2), sem subset nem instância. As demais foram recortadas aos
subsets que o Google servia, o que a OFL permite.

## Regerar

Fonte: o repositório `google/fonts` (o mesmo de onde o Google Fonts serve).

```bash
pip install fonttools brotli
bash app/fonts/gerar.sh
```
