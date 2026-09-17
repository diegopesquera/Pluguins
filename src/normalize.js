/**
 * Traduz a saida de cada Actor para um registro comum, para que as fontes
 * possam ser lidas e contadas juntas.
 *
 * Formato comum:
 *   { id, source, kind, url, author, publishedAt, text, engagement, extra }
 */

const firstOf = (obj, keys) => {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
};

const toIso = (value) => {
  if (!value) return undefined;
  // Actors devolvem ISO string ou timestamp unix (segundos).
  const d = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export const normalizers = {
  instagramPost(item, source) {
    const likes = num(firstOf(item, ['likesCount', 'likes']));
    const comments = num(firstOf(item, ['commentsCount', 'comments']));
    return {
      id: firstOf(item, ['id', 'shortCode', 'shortcode', 'url']),
      source: source.key,
      kind: 'instagram_post',
      url: firstOf(item, ['url', 'displayUrl']),
      author: firstOf(item, ['ownerUsername', 'username', 'ownerFullName']),
      publishedAt: toIso(firstOf(item, ['timestamp', 'takenAtTimestamp'])),
      text: firstOf(item, ['caption', 'text']) ?? '',
      engagement: {
        likes,
        comments,
        videoViews: num(firstOf(item, ['videoViewCount', 'videoPlayCount'])),
        total: (likes ?? 0) + (comments ?? 0),
      },
      extra: {
        type: firstOf(item, ['type', 'productType']),
        hashtags: item?.hashtags,
        mentions: item?.mentions,
        locationName: item?.locationName,
      },
    };
  },

  webPage(item, source) {
    const text = firstOf(item, ['markdown', 'text']) ?? '';
    return {
      id: firstOf(item, ['url', 'loadedUrl']),
      source: source.key,
      kind: 'web_page',
      url: firstOf(item, ['url', 'loadedUrl']),
      author: undefined,
      publishedAt: toIso(item?.metadata?.publishedAt ?? item?.crawl?.loadedTime),
      text,
      engagement: {},
      extra: {
        title: firstOf(item, ['title']) ?? item?.metadata?.title,
        description: item?.metadata?.description,
        chars: text.length,
      },
    };
  },

  searchResult(item, source) {
    // O google-search-scraper devolve uma linha por pagina de busca,
    // com os resultados em organicResults. Achatamos para um registro por link.
    const rows = Array.isArray(item?.organicResults) ? item.organicResults : [item];
    return rows.map((r) => ({
      id: firstOf(r, ['url', 'link']),
      source: source.key,
      kind: 'news_mention',
      url: firstOf(r, ['url', 'link']),
      author: firstOf(r, ['displayedUrl', 'domain']),
      publishedAt: toIso(firstOf(r, ['date'])),
      text: firstOf(r, ['description', 'snippet']) ?? '',
      engagement: {},
      extra: {
        title: firstOf(r, ['title']),
        position: num(r?.position),
        query: item?.searchQuery?.term,
      },
    }));
  },

  placeReview(item, source) {
    // Cada place traz reviews aninhadas; viram um registro por review.
    const reviews = Array.isArray(item?.reviews) ? item.reviews : [];
    if (reviews.length === 0) {
      return [{
        id: firstOf(item, ['placeId', 'url']),
        source: source.key,
        kind: 'place',
        url: firstOf(item, ['url']),
        author: undefined,
        publishedAt: undefined,
        text: firstOf(item, ['description']) ?? '',
        engagement: { rating: num(item?.totalScore), reviewCount: num(item?.reviewsCount) },
        extra: { title: item?.title, address: item?.address },
      }];
    }
    return reviews.map((r) => ({
      id: firstOf(r, ['reviewId', 'reviewUrl']),
      source: source.key,
      kind: 'place_review',
      url: firstOf(r, ['reviewUrl']) ?? item?.url,
      author: firstOf(r, ['name', 'reviewerName']),
      publishedAt: toIso(firstOf(r, ['publishedAtDate', 'publishAt'])),
      text: firstOf(r, ['text']) ?? '',
      engagement: { rating: num(r?.stars), likes: num(r?.likesCount) },
      extra: { placeTitle: item?.title },
    }));
  },
};

/** Aplica o normalizador da fonte e devolve sempre um array achatado. */
export function normalizeItems(items, source) {
  const fn = normalizers[source.normalizer];
  if (!fn) throw new Error(`Normalizador desconhecido: ${source.normalizer} (fonte ${source.key})`);
  return items.flatMap((item) => {
    const out = fn(item, source);
    return Array.isArray(out) ? out : [out];
  });
}

/** Remove registros repetidos entre fontes, mantendo o de maior engajamento. */
export function dedupe(records) {
  const byId = new Map();
  for (const rec of records) {
    const key = rec.url ?? rec.id;
    if (!key) continue;
    const prev = byId.get(key);
    if (!prev || (rec.engagement?.total ?? 0) > (prev.engagement?.total ?? 0)) {
      byId.set(key, rec);
    }
  }
  return [...byId.values()];
}
