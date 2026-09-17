/**
 * Testes do pipeline sem tocar na API real: o fetch e substituido por um mock.
 *   node --test test/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApifyClient, ApifyError } from '../src/apify.js';
import { normalizeItems, dedupe } from '../src/normalize.js';
import { buildReport } from '../src/run.js';
import { sources, event } from '../src/config.js';

const src = (key) => sources.find((s) => s.key === key);

const jsonRes = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('config: todas as fontes tem actor, teto e normalizador validos', () => {
  for (const s of sources) {
    assert.match(s.actor, /^[\w.-]+~[\w.-]+$/, `actor invalido em ${s.key}`);
    assert.ok(s.maxItems > 0, `maxItems invalido em ${s.key}`);
    assert.ok(s.input && typeof s.input === 'object', `input invalido em ${s.key}`);
    assert.doesNotThrow(() => normalizeItems([], s), `normalizador invalido em ${s.key}`);
  }
  const keys = sources.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length, 'chaves de fonte duplicadas');
});

test('cliente: manda o token no header e nunca na query string', async () => {
  let seen;
  const client = new ApifyClient('apify_api_segredo', {
    fetchImpl: async (url, opts) => {
      seen = { url: url.toString(), headers: opts.headers };
      return jsonRes({ data: { username: 'diego' } });
    },
  });

  const me = await client.me();
  assert.equal(me.username, 'diego');
  assert.equal(seen.headers.Authorization, 'Bearer apify_api_segredo');
  assert.ok(!seen.url.includes('apify_api_segredo'), 'token apareceu na URL');
});

test('cliente: authMode proxy nao manda header Authorization', async () => {
  let seen;
  const client = new ApifyClient(null, {
    authMode: 'proxy',
    fetchImpl: async (url, opts) => {
      seen = { url: url.toString(), headers: opts.headers };
      return jsonRes({ data: { username: 'diego' } });
    },
  });

  const me = await client.me();
  assert.equal(me.username, 'diego');
  assert.equal(seen.headers.Authorization, undefined, 'o proxy injeta o header, o cliente nao deve mandar');
  assert.ok(!seen.url.includes('token'), 'nada de token na URL');
});

test('cliente: authMode proxy dispensa token, bearer exige', () => {
  assert.doesNotThrow(() => new ApifyClient(null, { authMode: 'proxy' }));
  assert.throws(() => new ApifyClient(null), /Token do Apify ausente/);
  assert.throws(() => new ApifyClient(undefined, { authMode: 'bearer' }), /Token do Apify ausente/);
});

test('cliente: erro HTTP virou ApifyError com status e mensagem da API', async () => {
  const client = new ApifyClient('t', {
    fetchImpl: async () => jsonRes({ error: { message: 'Monthly usage hard limit exceeded' } }, 403),
  });

  await assert.rejects(
    () => client.me(),
    (err) => {
      assert.ok(err instanceof ApifyError);
      assert.equal(err.status, 403);
      assert.match(err.message, /Monthly usage hard limit exceeded/);
      return true;
    },
  );
});

test('cliente: datasetItems pagina e respeita o limite pedido', async () => {
  const total = 2500;
  let calls = 0;
  const client = new ApifyClient('t', {
    fetchImpl: async (url) => {
      calls += 1;
      const offset = Number(new URL(url).searchParams.get('offset'));
      const limit = Number(new URL(url).searchParams.get('limit'));
      const page = Array.from({ length: Math.min(limit, Math.max(0, total - offset)) }, (_, i) => ({
        id: offset + i,
      }));
      return jsonRes(page);
    },
  });

  const items = await client.datasetItems('ds1', { limit: 1200 });
  assert.equal(items.length, 1200);
  assert.equal(items[0].id, 0);
  assert.equal(items.at(-1).id, 1199);
  assert.equal(calls, 2, 'deveria paginar em dois pedidos');
});

test('cliente: runAndWait espera o estado terminal e devolve o dataset', async () => {
  const statuses = ['RUNNING', 'RUNNING', 'SUCCEEDED'];
  let polls = 0;
  const client = new ApifyClient('t', {
    fetchImpl: async (url, opts) => {
      if (opts.method === 'POST') return jsonRes({ data: { id: 'run1', status: 'READY' } });
      polls += 1;
      return jsonRes({ data: { id: 'run1', status: statuses[polls - 1] ?? 'SUCCEEDED', defaultDatasetId: 'ds1' } });
    },
  });

  const run = await client.runAndWait('apify~x', {}, { pollSecs: 0, maxWaitSecs: 30 });
  assert.equal(run.status, 'SUCCEEDED');
  assert.equal(run.defaultDatasetId, 'ds1');
});

test('cliente: runAndWait aborta quando passa da espera maxima', async () => {
  let aborted = false;
  const client = new ApifyClient('t', {
    fetchImpl: async (url, opts) => {
      const u = url.toString();
      if (opts.method === 'POST' && u.endsWith('/abort')) {
        aborted = true;
        return jsonRes({ data: { id: 'run1', status: 'ABORTED' } });
      }
      if (opts.method === 'POST') return jsonRes({ data: { id: 'run1', status: 'RUNNING' } });
      return jsonRes({ data: { id: 'run1', status: aborted ? 'ABORTED' : 'RUNNING' } });
    },
  });

  const run = await client.runAndWait('apify~x', {}, { pollSecs: 0, maxWaitSecs: -1 });
  assert.ok(aborted, 'a execucao travada deveria ter sido abortada');
  assert.equal(run.status, 'ABORTED');
});

test('normalize: post do Instagram vira registro comum com engajamento somado', () => {
  const [rec] = normalizeItems(
    [{
      id: '1',
      shortCode: 'abc',
      url: 'https://www.instagram.com/p/abc/',
      ownerUsername: 'festivalcostumegourmet',
      timestamp: '2026-09-18T14:00:00.000Z',
      caption: 'Abertura do Costume Gourmet',
      likesCount: 100,
      commentsCount: 20,
      type: 'Image',
      hashtags: ['costumegourmet'],
    }],
    src('instagram-perfis'),
  );

  assert.equal(rec.kind, 'instagram_post');
  assert.equal(rec.author, 'festivalcostumegourmet');
  assert.equal(rec.publishedAt, '2026-09-18T14:00:00.000Z');
  assert.equal(rec.engagement.total, 120);
  assert.deepEqual(rec.extra.hashtags, ['costumegourmet']);
});

test('normalize: timestamp unix em segundos e convertido', () => {
  const [rec] = normalizeItems(
    [{ id: '2', takenAtTimestamp: 1789732800, caption: 'x' }],
    src('instagram-perfis'),
  );
  assert.equal(rec.publishedAt, new Date(1789732800 * 1000).toISOString());
});

test('normalize: data invalida nao quebra e fica indefinida', () => {
  const [rec] = normalizeItems([{ id: '3', timestamp: 'nao-e-data', caption: 'x' }], src('instagram-perfis'));
  assert.equal(rec.publishedAt, undefined);
});

test('normalize: uma pagina de busca e achatada em um registro por link', () => {
  const recs = normalizeItems(
    [{
      searchQuery: { term: '"Costume Gourmet" 2026' },
      organicResults: [
        { title: 'Claude Troisgros no festival', url: 'https://exemplo.com/a', description: 'chef', position: 1 },
        { title: 'Programacao completa', url: 'https://exemplo.com/b', description: 'agenda', position: 2 },
      ],
    }],
    src('noticias'),
  );

  assert.equal(recs.length, 2);
  assert.equal(recs[0].kind, 'news_mention');
  assert.equal(recs[0].extra.query, '"Costume Gourmet" 2026');
  assert.equal(recs[1].url, 'https://exemplo.com/b');
});

test('normalize: avaliacoes do local viram um registro por review', () => {
  const recs = normalizeItems(
    [{
      placeId: 'p1',
      title: 'La Maison',
      url: 'https://maps.google.com/p1',
      reviews: [
        { reviewId: 'r1', name: 'Ana', stars: 5, text: 'otimo', publishedAtDate: '2026-09-19T10:00:00Z' },
        { reviewId: 'r2', name: 'Bruno', stars: 4, text: 'bom' },
      ],
    }],
    src('local-avaliacoes'),
  );

  assert.equal(recs.length, 2);
  assert.equal(recs[0].kind, 'place_review');
  assert.equal(recs[0].engagement.rating, 5);
  assert.equal(recs[1].author, 'Bruno');
});

test('normalize: place sem reviews ainda gera a ficha do local', () => {
  const recs = normalizeItems(
    [{ placeId: 'p1', title: 'La Maison', totalScore: 4.6, reviewsCount: 900, reviews: [] }],
    src('local-avaliacoes'),
  );
  assert.equal(recs.length, 1);
  assert.equal(recs[0].kind, 'place');
  assert.equal(recs[0].engagement.rating, 4.6);
});

test('dedupe: mantem a versao com maior engajamento e descarta sem url/id', () => {
  const out = dedupe([
    { id: 'a', url: 'https://x/1', engagement: { total: 10 }, text: 'antigo' },
    { id: 'a', url: 'https://x/1', engagement: { total: 99 }, text: 'novo' },
    { id: 'b', url: 'https://x/2', engagement: { total: 1 }, text: 'outro' },
    { engagement: {}, text: 'sem identificador' },
  ]);

  assert.equal(out.length, 2);
  assert.equal(out.find((r) => r.url === 'https://x/1').text, 'novo');
});

test('report: conta registros na janela do evento e ordena por engajamento', () => {
  const records = [
    {
      kind: 'instagram_post', url: 'https://x/1', author: 'festivalcostumegourmet',
      publishedAt: '2026-09-19T12:00:00.000Z', text: 'dia 2 do festival',
      engagement: { total: 500, likes: 450, comments: 50 },
    },
    {
      kind: 'instagram_post', url: 'https://x/2', author: 'mercadinhossaoluiz',
      publishedAt: '2026-08-01T12:00:00.000Z', text: 'pre-evento',
      engagement: { total: 900, likes: 800, comments: 100 },
    },
    {
      kind: 'news_mention', url: 'https://jornal/a', author: 'jornal.com',
      text: 'materia', engagement: {}, extra: { title: 'Festival reune 30 chefs' },
    },
  ];

  const md = buildReport(
    {
      event,
      collectedAt: '2026-09-20T23:00:00.000Z',
      sources: [{ key: 'instagram-perfis', status: 'SUCCEEDED', rawItems: 2, records: 2, elapsedSecs: 12 }],
      totals: { records: 3, uniqueRecords: 3, computeUnits: 0.42 },
    },
    records,
  );

  assert.match(md, /# Coleta - Festival Costume Gourmet 2026/);
  assert.match(md, /Registros publicados durante o evento: 1/);
  assert.match(md, /Festival reune 30 chefs/);
  // O post de maior engajamento aparece antes do outro.
  assert.ok(md.indexOf('pre-evento') < md.indexOf('dia 2 do festival'));
});

test('report: nao quebra quando a coleta volta vazia', () => {
  const md = buildReport(
    { event, collectedAt: 'agora', sources: [], totals: { records: 0, uniqueRecords: 0 } },
    [],
  );
  assert.match(md, /Registros unicos: 0/);
});
