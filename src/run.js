#!/usr/bin/env node
/**
 * Coleta de dados publicos sobre o Festival Costume Gourmet via Apify.
 *
 *   node src/run.js preflight              confere token e credito, sem gastar
 *   node src/run.js collect --dry-run      mostra o que seria executado
 *   node src/run.js collect                executa a coleta
 *   node src/run.js report <dir-da-run>    regera o relatorio de uma coleta
 *
 * Flags de collect:
 *   --only a,b        roda apenas essas fontes (ignora o enabled do config)
 *   --max-items N     teto de itens por fonte, sobrepoe o config
 *   --wait-secs N     espera maxima por Actor (padrao 900)
 *   --out DIR         diretorio de saida (padrao data/runs/<timestamp>)
 */

import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { ApifyClient, ApifyError } from './apify.js';
import { event, sources as allSources } from './config.js';
import { normalizeItems, dedupe } from './normalize.js';

const ROOT = path.resolve(import.meta.dirname, '..');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      args._.push(a);
      continue;
    }
    const key = a.slice(2);
    if (key === 'dry-run') args.dryRun = true;
    else args[key] = argv[++i];
  }
  return args;
}

/**
 * Decide como autenticar.
 *
 * COLETA_AUTH_MODE=proxy: nao usa token nenhum aqui. O agent proxy do Claude
 * Code injeta a credencial cadastrada no ambiente depois que o pedido sai da
 * VM, entao o token nunca entra na sessao. Use quando o token estiver como
 * API credential do ambiente, com host api.apify.com.
 *
 * Caso contrario, espera APIFY_TOKEN no ambiente.
 */
function loadAuth() {
  if (process.env.COLETA_AUTH_MODE?.trim().toLowerCase() === 'proxy') {
    return { token: null, authMode: 'proxy' };
  }

  const token = process.env.APIFY_TOKEN?.trim();
  if (token) return { token, authMode: 'bearer' };

  throw new Error(
    'Nenhuma credencial do Apify configurada.\n\n' +
      'Opcao 1 - token no ambiente:\n' +
      '  export APIFY_TOKEN=apify_api_...\n' +
      '  ou copie .env.example para .env e rode com --env-file=.env\n\n' +
      'Opcao 2 - API credential do ambiente (o token nao entra na sessao):\n' +
      '  cadastre a credencial para o host api.apify.com e defina\n' +
      '  COLETA_AUTH_MODE=proxy',
  );
}

const fmt = (n) => new Intl.NumberFormat('pt-BR').format(n);

/** Confere que o token funciona e mostra o credito disponivel. */
async function preflight() {
  const { token, authMode } = loadAuth();
  const client = new ApifyClient(token, { authMode });
  if (authMode === 'proxy') {
    console.log('Autenticacao: API credential do ambiente (injetada pelo proxy).');
  }
  const me = await client.me();
  console.log(`Conta Apify: ${me.username}${me.email ? ` <${me.email}>` : ''}`);
  console.log(`Plano: ${me.plan?.id ?? me.plan?.description ?? 'desconhecido'}`);

  try {
    const limits = await client.limits();
    const used = limits.current?.monthlyUsageUsd;
    const max = limits.limits?.maxMonthlyUsageUsd;
    if (used !== undefined && max !== undefined) {
      console.log(`Consumo do mes: US$ ${used.toFixed(2)} de US$ ${max.toFixed(2)}`);
      const left = max - used;
      console.log(
        left > 0
          ? `Credito restante: US$ ${left.toFixed(2)}`
          : 'ATENCAO: o limite mensal ja foi atingido; as execucoes vao falhar.',
      );
    }
    const actorMemory = limits.limits?.maxActorMemoryGbytes;
    if (actorMemory) console.log(`Memoria maxima por Actor: ${actorMemory} GB`);
  } catch (err) {
    console.log(`Nao foi possivel ler os limites da conta: ${err.message}`);
  }

  console.log('\nToken valido. Rode `node src/run.js collect --dry-run` para revisar o plano.');
}

function selectSources(args) {
  const only = args.only?.split(',').map((s) => s.trim()).filter(Boolean);
  const chosen = only
    ? allSources.filter((s) => only.includes(s.key))
    : allSources.filter((s) => s.enabled);

  if (only) {
    const unknown = only.filter((k) => !allSources.some((s) => s.key === k));
    if (unknown.length) throw new Error(`Fonte desconhecida em --only: ${unknown.join(', ')}`);
  }
  if (chosen.length === 0) throw new Error('Nenhuma fonte selecionada.');

  const cap = Number(args['max-items'] ?? process.env.COLETA_MAX_ITEMS);
  if (Number.isFinite(cap) && cap > 0) {
    return chosen.map((s) => ({ ...s, maxItems: Math.min(s.maxItems, cap) }));
  }
  return chosen;
}

function printPlan(selected) {
  console.log(`Evento: ${event.name} - ${event.city}`);
  console.log(`Periodo: ${event.startDate} a ${event.endDate}\n`);
  console.log(`Fontes selecionadas (${selected.length}):`);
  for (const s of selected) {
    console.log(`\n  [${s.key}] ${s.label}`);
    console.log(`    actor    : ${s.actor}`);
    console.log(`    maxItems : ${s.maxItems}`);
    console.log(`    input    : ${JSON.stringify(s.input, null, 2).split('\n').join('\n               ')}`);
  }
  const total = selected.reduce((sum, s) => sum + s.maxItems, 0);
  console.log(`\nTeto total de itens nesta coleta: ${fmt(total)}`);
}

async function collect(args) {
  const selected = selectSources(args);
  // Confere a credencial antes de imprimir o plano, para falhar rapido.
  const auth = args.dryRun ? null : loadAuth();

  printPlan(selected);

  if (args.dryRun) {
    console.log('\n--dry-run: nada foi executado e nenhum credito foi consumido.');
    return;
  }

  const client = new ApifyClient(auth.token, { authMode: auth.authMode });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = args.out ? path.resolve(args.out) : path.join(ROOT, 'data', 'runs', stamp);
  const rawDir = path.join(outDir, 'raw');
  await mkdir(rawDir, { recursive: true });

  const maxWaitSecs = Number(args['wait-secs'] ?? 900);
  const results = [];
  let allRecords = [];

  console.log(`\nSaida: ${path.relative(ROOT, outDir)}\n`);

  for (const source of selected) {
    const started = Date.now();
    process.stdout.write(`> ${source.key}: iniciando ${source.actor}\n`);
    try {
      const run = await client.runAndWait(source.actor, source.input, {
        maxWaitSecs,
        onStatus: ({ status }) => process.stdout.write(`  ${source.key}: ${status}\n`),
      });

      const items = run.defaultDatasetId
        ? await client.datasetItems(run.defaultDatasetId, { limit: source.maxItems })
        : [];

      await writeFile(path.join(rawDir, `${source.key}.json`), JSON.stringify(items, null, 2));
      const records = normalizeItems(items, source);
      allRecords = allRecords.concat(records);

      const entry = {
        key: source.key,
        label: source.label,
        actor: source.actor,
        runId: run.id,
        status: run.status,
        rawItems: items.length,
        records: records.length,
        computeUnits: run.stats?.computeUnits,
        elapsedSecs: Math.round((Date.now() - started) / 1000),
      };
      results.push(entry);
      console.log(
        `  ${source.key}: ${run.status} - ${fmt(items.length)} itens, ` +
          `${fmt(records.length)} registros, ${entry.elapsedSecs}s` +
          (entry.computeUnits ? `, ${entry.computeUnits.toFixed(3)} CU` : ''),
      );
    } catch (err) {
      // Uma fonte que falha nao derruba as outras.
      const entry = {
        key: source.key,
        label: source.label,
        actor: source.actor,
        status: 'ERROR',
        error: err instanceof ApifyError ? `${err.message}` : String(err.message ?? err),
        elapsedSecs: Math.round((Date.now() - started) / 1000),
      };
      results.push(entry);
      console.error(`  ${source.key}: ERRO - ${entry.error}`);
    }
  }

  const deduped = dedupe(allRecords);
  await writeFile(
    path.join(outDir, 'normalized.jsonl'),
    deduped.map((r) => JSON.stringify(r)).join('\n') + (deduped.length ? '\n' : ''),
  );

  const summary = {
    event,
    collectedAt: new Date().toISOString(),
    sources: results,
    totals: {
      records: allRecords.length,
      uniqueRecords: deduped.length,
      computeUnits: results.reduce((s, r) => s + (r.computeUnits ?? 0), 0),
    },
  };
  await writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  await writeFile(path.join(outDir, 'report.md'), buildReport(summary, deduped));

  console.log(`\nColeta concluida: ${fmt(deduped.length)} registros unicos.`);
  console.log(`Relatorio: ${path.relative(ROOT, path.join(outDir, 'report.md'))}`);

  const failed = results.filter((r) => r.status !== 'SUCCEEDED');
  if (failed.length) {
    console.log(`\nFontes com problema: ${failed.map((f) => f.key).join(', ')}`);
    process.exitCode = 1;
  }
}

export function buildReport(summary, records) {
  const lines = [];
  const withDates = records.filter((r) => r.publishedAt);
  const inWindow = withDates.filter(
    (r) => r.publishedAt >= summary.event.startDate && r.publishedAt <= `${summary.event.endDate}T23:59:59Z`,
  );

  lines.push(`# Coleta - ${summary.event.name}`);
  lines.push('');
  lines.push(`Executada em ${summary.collectedAt}`);
  lines.push('');
  lines.push(`- Local: ${summary.event.venue}, ${summary.event.city}`);
  lines.push(`- Periodo do evento: ${summary.event.startDate} a ${summary.event.endDate}`);
  lines.push(`- Registros unicos: ${fmt(summary.totals.uniqueRecords)}`);
  lines.push(`- Registros publicados durante o evento: ${fmt(inWindow.length)}`);
  if (summary.totals.computeUnits) {
    lines.push(`- Compute units consumidas: ${summary.totals.computeUnits.toFixed(3)}`);
  }
  lines.push('');

  lines.push('## Fontes');
  lines.push('');
  lines.push('| Fonte | Status | Itens | Registros | Tempo |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const s of summary.sources) {
    lines.push(
      `| ${s.key} | ${s.status}${s.error ? ` (${s.error.slice(0, 60)})` : ''} | ` +
        `${s.rawItems ?? 0} | ${s.records ?? 0} | ${s.elapsedSecs}s |`,
    );
  }
  lines.push('');

  const byKind = records.reduce((acc, r) => {
    acc[r.kind] = (acc[r.kind] ?? 0) + 1;
    return acc;
  }, {});
  lines.push('## Registros por tipo');
  lines.push('');
  for (const [kind, count] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${kind}: ${fmt(count)}`);
  }
  lines.push('');

  const social = records
    .filter((r) => (r.engagement?.total ?? 0) > 0)
    .sort((a, b) => (b.engagement.total ?? 0) - (a.engagement.total ?? 0))
    .slice(0, 15);
  if (social.length) {
    lines.push('## Publicacoes com maior engajamento');
    lines.push('');
    for (const r of social) {
      const when = r.publishedAt?.slice(0, 10) ?? 's/data';
      const snippet = r.text.replace(/\s+/g, ' ').slice(0, 110);
      lines.push(
        `- **${fmt(r.engagement.total)}** (${fmt(r.engagement.likes ?? 0)} likes, ` +
          `${fmt(r.engagement.comments ?? 0)} coment.) - @${r.author ?? '?'} - ${when} - ${snippet}` +
          (r.url ? ` - [link](${r.url})` : ''),
      );
    }
    lines.push('');
  }

  const news = records.filter((r) => r.kind === 'news_mention').slice(0, 25);
  if (news.length) {
    lines.push('## Mencoes na imprensa');
    lines.push('');
    for (const r of news) {
      lines.push(`- ${r.extra?.title ?? r.url} - ${r.author ?? ''} ${r.url ? `[link](${r.url})` : ''}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/** Regera o relatorio a partir de uma coleta ja salva. */
async function report(args) {
  let dir = args._[1];
  if (!dir) {
    const runsDir = path.join(ROOT, 'data', 'runs');
    const entries = (await readdir(runsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    if (!entries.length) throw new Error(`Nenhuma coleta encontrada em ${runsDir}`);
    dir = path.join(runsDir, entries.at(-1));
    console.log(`Usando a coleta mais recente: ${path.relative(ROOT, dir)}`);
  }

  const summary = JSON.parse(await readFile(path.join(dir, 'summary.json'), 'utf8'));
  const jsonl = await readFile(path.join(dir, 'normalized.jsonl'), 'utf8');
  const records = jsonl.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const out = path.join(dir, 'report.md');
  await writeFile(out, buildReport(summary, records));
  console.log(`Relatorio regerado: ${path.relative(ROOT, out)}`);
}

const commands = { preflight, collect, report };

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] ?? 'collect';
  const fn = commands[cmd];
  if (!fn) {
    console.error(`Comando desconhecido: ${cmd}. Use: ${Object.keys(commands).join(', ')}`);
    process.exit(2);
  }
  await fn(args);
}

// Roda so quando chamado direto, para que os testes possam importar o modulo.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((err) => {
    console.error(`\nFalhou: ${err.message}`);
    process.exit(1);
  });
}
