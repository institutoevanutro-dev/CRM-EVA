#!/usr/bin/env bash
# Regera os woff2 desta pasta a partir do repositório google/fonts.
# Não roda no build: o build só lê os arquivos já versionados (ver README.md).
# Requer: python com `fonttools` e `brotli` (pip install fonttools brotli).
set -euo pipefail
cd "$(dirname "$0")"
SRC="${SRC:-$(mktemp -d)}"
BASE=https://raw.githubusercontent.com/google/fonts/main/ofl

# Faixas que o Google Fonts serve nos subsets `latin` e `latin-ext`.
LATIN="U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD"
LATIN_EXT="U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C4,U+2113,U+2C60-2C7F,U+A720-A7FF"

baixar() { # <pasta-ofl> <arquivo>
  mkdir -p "$SRC/$1"
  curl -sfL -o "$SRC/$1/$2" "$BASE/$1/$(printf %s "$2" | sed 's/\[/%5B/;s/\]/%5D/')"
  curl -sfL -o "$1.OFL.txt" "$BASE/$1/OFL.txt"
}

# <pasta-ofl> <arquivo> <saida.woff2> <unicodes> [eixos do instancer...]
# Eixos não pedidos ao Google ficam fixos no default (`eixo=drop`), como o
# Google faz ao servir; `wght=a:b` corta a faixa aos pesos declarados.
gerar() {
  local pasta=$1 arq=$2 saida=$3 uni=$4; shift 4
  baixar "$pasta" "$arq"
  local ttf="$SRC/$pasta/$arq"
  if [ $# -gt 0 ]; then
    python -m fontTools.varLib.instancer "$ttf" "$@" -o "$SRC/$pasta/inst.ttf" -q
    ttf="$SRC/$pasta/inst.ttf"
  fi
  python -m fontTools.subset "$ttf" --unicodes="$uni" --layout-features='*' \
    --flavor=woff2 --output-file="$saida"
}

# Plex tem Reserved Font Name ("Plex"): só troca de formato (TTF→WOFF2), sem
# subset nem instância, para não gerar uma "Modified Version" com o nome.
embrulhar() { # <pasta-ofl> <arquivo> <saida.woff2>
  baixar "$1" "$2"
  python -c 'import sys;from fontTools.ttLib import TTFont;t=TTFont(sys.argv[1]);t.flavor="woff2";t.save(sys.argv[2])' "$SRC/$1/$2" "$3"
}

# Layout raiz (app/layout.tsx): latin + latin-ext.
gerar inter "Inter[opsz,wght].ttf" inter.woff2 "$LATIN,$LATIN_EXT" opsz=drop
gerar cormorantgaramond "CormorantGaramond[wght].ttf" cormorant-garamond.woff2 "$LATIN,$LATIN_EXT" wght=500:700
embrulhar ibmplexmono IBMPlexMono-Regular.ttf ibm-plex-mono-400.woff2
embrulhar ibmplexmono IBMPlexMono-Medium.ttf ibm-plex-mono-500.woff2

# Vitrine /design (app/design/lib/fonts.ts): latin.
gerar bricolagegrotesque "BricolageGrotesque[opsz,wdth,wght].ttf" bricolage-grotesque.woff2 "$LATIN" opsz=drop wdth=drop
gerar plusjakartasans "PlusJakartaSans[wght].ttf" plus-jakarta-sans.woff2 "$LATIN"
gerar fraunces "Fraunces[SOFT,WONK,opsz,wght].ttf" fraunces.woff2 "$LATIN"
gerar manrope "Manrope[wght].ttf" manrope.woff2 "$LATIN"
gerar atkinsonhyperlegible AtkinsonHyperlegible-Regular.ttf atkinson-hyperlegible-400.woff2 "$LATIN"
gerar atkinsonhyperlegible AtkinsonHyperlegible-Bold.ttf atkinson-hyperlegible-700.woff2 "$LATIN"
gerar sourceserif4 "SourceSerif4[opsz,wght].ttf" source-serif-4.woff2 "$LATIN" opsz=drop
embrulhar ibmplexsans "IBMPlexSans[wdth,wght].ttf" ibm-plex-sans.woff2
gerar jetbrainsmono "JetBrainsMono[wght].ttf" jetbrains-mono.woff2 "$LATIN"
