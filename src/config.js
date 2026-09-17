/**
 * Definicao do evento e das fontes de coleta.
 *
 * Cada fonte aponta para um Actor da Apify Store e carrega um teto explicito
 * de itens, para que uma execucao nao consuma credito de forma imprevisivel.
 * Confira os IDs e os campos de input no Console do Apify antes de rodar:
 * os schemas dos Actors mudam de tempo em tempo.
 */

export const event = {
  slug: 'costume-gourmet-2026',
  name: 'Festival Costume Gourmet 2026',
  edition: '2026',
  theme: 'Sabores de uma bela historia',
  city: 'Fortaleza, CE',
  venue: 'La Maison (Coliseu)',
  // Datas divulgadas pela imprensa para a edicao 2026.
  startDate: '2026-09-18',
  endDate: '2026-09-20',
  organizer: 'Mercadinhos Sao Luiz / Grupo MSLZ',
  website: 'https://costumegourmet.com.br',
  instagram: 'festivalcostumegourmet',
};

/** Perfis do Instagram ligados ao evento e ao organizador. */
export const instagramProfiles = [
  'festivalcostumegourmet',
  'mercadinhossaoluiz',
];

/** Hashtags monitoradas (sem o `#`). */
export const hashtags = [
  'costumegourmet',
  'festivalcostumegourmet',
  'costumegourmet2026',
];

/** Termos usados na coleta de noticias e mencoes na web. */
export const searchQueries = [
  '"Festival Costume Gourmet" 2026',
  '"Costume Gourmet" Fortaleza programacao',
  '"Costume Gourmet" chefs La Maison',
];

/**
 * Fontes de coleta.
 *
 * key       identificador curto, usado em --only e nos arquivos de saida
 * actor     ID do Actor no formato `owner~nome`
 * maxItems  teto de itens lidos do dataset da execucao
 * input     input enviado ao Actor
 */
export const sources = [
  {
    key: 'instagram-perfis',
    label: 'Posts dos perfis oficiais no Instagram',
    actor: 'apify~instagram-scraper',
    enabled: true,
    maxItems: 120,
    normalizer: 'instagramPost',
    input: {
      directUrls: instagramProfiles.map((p) => `https://www.instagram.com/${p}/`),
      resultsType: 'posts',
      resultsLimit: 60,
      addParentData: true,
    },
  },
  {
    key: 'instagram-hashtags',
    label: 'Publicacoes por hashtag no Instagram',
    actor: 'apify~instagram-hashtag-scraper',
    enabled: true,
    maxItems: 300,
    normalizer: 'instagramPost',
    input: {
      hashtags,
      resultsLimit: 100,
    },
  },
  {
    key: 'site-oficial',
    label: 'Conteudo do site oficial (programacao, chefs, ingressos)',
    actor: 'apify~website-content-crawler',
    enabled: true,
    maxItems: 60,
    normalizer: 'webPage',
    input: {
      startUrls: [{ url: event.website }],
      crawlerType: 'playwright:adaptive',
      maxCrawlPages: 40,
      maxCrawlDepth: 3,
      saveMarkdown: true,
      saveHtml: false,
    },
  },
  {
    key: 'noticias',
    label: 'Mencoes do evento na imprensa (Google Search)',
    actor: 'apify~google-search-scraper',
    enabled: true,
    maxItems: 120,
    normalizer: 'searchResult',
    input: {
      queries: searchQueries.join('\n'),
      resultsPerPage: 20,
      maxPagesPerQuery: 2,
      countryCode: 'br',
      languageCode: 'pt-BR',
    },
  },
  {
    key: 'local-avaliacoes',
    label: 'Ficha e avaliacoes do local no Google Maps',
    actor: 'compass~crawler-google-places',
    // Desligada por padrao: as avaliacoes sao do espaco (La Maison), nao do
    // festival, e e a fonte mais caro por item. Ligue com --only se quiser.
    enabled: false,
    maxItems: 200,
    normalizer: 'placeReview',
    input: {
      searchStringsArray: ['La Maison Fortaleza'],
      maxCrawledPlacesPerSearch: 2,
      maxReviews: 100,
      language: 'pt-BR',
      reviewsSort: 'newest',
    },
  },
];
