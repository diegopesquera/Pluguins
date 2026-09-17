# Coleta — Festival Costume Gourmet

Coleta de dados públicos sobre o **Festival Costume Gourmet 2026** (Fortaleza,
La Maison, 18 a 20 de setembro de 2026) usando Actors da [Apify](https://apify.com).

Sem dependências: usa o `fetch` nativo do Node (>= 18). Não precisa de
`npm install`.

## Configurar a credencial

A coleta precisa de um token da API do Apify: **Apify Console → Settings →
API & Integrations → Personal API token**. Há dois caminhos.

### Opção 1 — API credential do ambiente (recomendada em sessão na nuvem)

O token fica guardado no ambiente e o agent proxy injeta o header
`Authorization` **depois** que o pedido sai da VM: o token nunca entra na
sessão, não aparece em variável de ambiente nem em arquivo. Também dispensa
liberar o domínio na allowlist de rede, porque os hosts da credencial não
passam por ela.

Em [claude.ai/code](https://claude.ai/code), no ambiente → **API credentials**
→ **Add credential**:

- **Credential type**: `Bearer`
- **Allowed websites**: `api.apify.com`
- **Custom headers**: nome `Authorization`, prefixo `Bearer`, valor = o token

Depois defina em **Environment variables**:

```text
COLETA_AUTH_MODE=proxy
```

Disponível nos planos Pro e Max, e exige papel de admin da organização.

### Opção 2 — token como variável de ambiente

```bash
cp .env.example .env
# edite .env e preencha APIFY_TOKEN=apify_api_...
```

O `.env` está no `.gitignore` e não deve ser versionado. O token vai sempre no
header `Authorization`, nunca na query string, para não vazar em log de proxy
nem no histórico do shell.

Numa sessão na nuvem, esse caminho tem duas pegadinhas:

1. Quem usa o ambiente consegue ler o valor da variável.
2. `api.apify.com` **não** está entre os domínios liberados no nível
   **Trusted**. É preciso mudar **Network access** para **Custom**, listar
   `api.apify.com` em **Allowed domains** e marcar *Also include default list
   of common package managers*. Sem isso a coleta falha na rede, mesmo com o
   token correto.

Sem nenhuma das duas opções configuradas, o comando explica o que falta e não
consome crédito.

## Usar

```bash
# 1. Confere se o token é válido e quanto crédito ainda há no mês.
#    Não dispara nenhum Actor, não consome crédito.
node --env-file=.env src/run.js preflight

# 2. Mostra exatamente quais Actors seriam chamados, com qual input e
#    qual teto de itens. Também não consome crédito.
node --env-file=.env src/run.js collect --dry-run

# 3. Executa a coleta.
node --env-file=.env src/run.js collect

# 4. Regera o relatório de uma coleta já salva (usa a mais recente se omitir o diretório).
node src/run.js report [data/runs/<timestamp>]
```

Se preferir, use `npm run preflight`, `npm run plan`, `npm run collect`,
`npm run report` — mas aí exporte `APIFY_TOKEN` no ambiente, porque os scripts
do npm não carregam o `.env`.

### Flags do `collect`

| Flag | Efeito |
| --- | --- |
| `--dry-run` | Imprime o plano e sai, sem chamar a API. |
| `--only a,b` | Roda só essas fontes, ignorando o `enabled` do config. |
| `--max-items N` | Teto de itens por fonte, sobrepõe o config (também via `COLETA_MAX_ITEMS`). |
| `--wait-secs N` | Espera máxima por Actor, em segundos (padrão 900). Passando disso a execução é abortada. |
| `--out DIR` | Diretório de saída (padrão `data/runs/<timestamp>`). |

## Fontes coletadas

Definidas em [`src/config.js`](src/config.js). Cada fonte tem um teto explícito
de itens, para que uma execução não consuma crédito de forma imprevisível.

| Fonte | Actor | Teto | Padrão |
| --- | --- | --- | --- |
| `instagram-perfis` | `apify/instagram-scraper` | 120 | ligada |
| `instagram-hashtags` | `apify/instagram-hashtag-scraper` | 300 | ligada |
| `site-oficial` | `apify/website-content-crawler` | 60 | ligada |
| `noticias` | `apify/google-search-scraper` | 120 | ligada |
| `local-avaliacoes` | `compass/crawler-google-places` | 200 | **desligada** |

`local-avaliacoes` vem desligada porque as avaliações são do espaço (La Maison)
e não do festival, e é a fonte mais caro por item. Para incluir:
`node --env-file=.env src/run.js collect --only local-avaliacoes`.

Para ajustar perfis, hashtags ou termos de busca, edite `instagramProfiles`,
`hashtags` e `searchQueries` em `src/config.js`.

> Os schemas dos Actors da Apify Store mudam de tempo em tempo. Se uma fonte
> falhar com erro de input inválido, confira os campos na página do Actor no
> Console. Uma fonte que falha não derruba as outras: a execução segue e o
> erro aparece no `summary.json` e no `report.md`.

## Saída

Cada execução escreve em `data/runs/<timestamp>/` (fora do versionamento):

```
raw/<fonte>.json    resposta bruta de cada Actor, como veio do dataset
normalized.jsonl    um registro por linha, formato comum a todas as fontes
summary.json        status, contagens, compute units e erros por fonte
report.md           relatório legível: totais, posts com mais engajamento, imprensa
```

O registro normalizado tem sempre o mesmo formato, o que permite ler as fontes
juntas:

```json
{
  "id": "...",
  "source": "instagram-hashtags",
  "kind": "instagram_post",
  "url": "https://www.instagram.com/p/...",
  "author": "festivalcostumegourmet",
  "publishedAt": "2026-09-19T12:00:00.000Z",
  "text": "...",
  "engagement": { "likes": 450, "comments": 50, "total": 500 },
  "extra": { "hashtags": ["costumegourmet"] }
}
```

## Testes

```bash
npm test
```

Os testes substituem o `fetch` por um mock, então rodam sem token e sem
consumir crédito. Cobrem o cliente da API (header do token, paginação de
dataset, erro HTTP, abort por timeout), os normalizadores de cada fonte e a
geração do relatório.

## Custo

O custo fica em duas partes: as compute units do Actor e, nos Actors de
Instagram, a cobrança por resultado. Os tetos do `config.js` existem para
limitar isso. Confira o consumo do mês antes e depois com
`src/run.js preflight`, e revise o plano com `--dry-run` antes de qualquer
execução real.

Colete apenas dados públicos e respeite os termos de uso de cada plataforma.
