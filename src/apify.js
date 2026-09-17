/**
 * Cliente minimo da API v2 do Apify usando fetch nativo (Node >= 18).
 *
 * O token vai sempre no header Authorization, nunca na query string, para nao
 * acabar em log de proxy, em historico de shell ou em mensagem de erro.
 */

const API = 'https://api.apify.com/v2';

export class ApifyError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'ApifyError';
    this.status = status;
    this.body = body;
  }
}

export class ApifyClient {
  constructor(token, { fetchImpl = fetch } = {}) {
    if (!token) throw new ApifyError('Token do Apify ausente.');
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  async request(path, { method = 'GET', body, query } = {}) {
    const url = new URL(`${API}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }

    const res = await this.fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }

    if (!res.ok) {
      const detail = parsed?.error?.message ?? (typeof parsed === 'string' ? parsed : res.statusText);
      throw new ApifyError(`${method} ${path} falhou (HTTP ${res.status}): ${detail}`, {
        status: res.status,
        body: parsed,
      });
    }

    // A API embrulha as respostas em { data: ... }; os datasets vem como array.
    return parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed;
  }

  /** Dados da conta: confirma que o token e valido. */
  me() {
    return this.request('/users/me');
  }

  /** Limites e consumo do mes, para conferir o credito disponivel. */
  limits() {
    return this.request('/users/me/limits');
  }

  /** Dispara uma execucao assincrona do Actor. */
  startRun(actorId, input, { memoryMbytes, timeoutSecs } = {}) {
    return this.request(`/acts/${encodeURIComponent(actorId)}/runs`, {
      method: 'POST',
      body: input,
      query: { memory: memoryMbytes, timeout: timeoutSecs },
    });
  }

  getRun(runId) {
    return this.request(`/actor-runs/${runId}`);
  }

  abortRun(runId) {
    return this.request(`/actor-runs/${runId}/abort`, { method: 'POST' });
  }

  /** Le itens do dataset, paginando em blocos de 1000. */
  async datasetItems(datasetId, { limit = 1000 } = {}) {
    const items = [];
    let offset = 0;

    while (items.length < limit) {
      const page = await this.request(`/datasets/${datasetId}/items`, {
        query: { clean: true, format: 'json', offset, limit: Math.min(1000, limit - items.length) },
      });
      if (!Array.isArray(page) || page.length === 0) break;
      items.push(...page);
      offset += page.length;
      if (page.length < 1000) break;
    }

    return items.slice(0, limit);
  }

  /**
   * Dispara o Actor e espera o fim da execucao.
   * Aborta se passar de `maxWaitSecs`, para nao ficar consumindo credito
   * indefinidamente numa execucao travada.
   */
  async runAndWait(actorId, input, { pollSecs = 10, maxWaitSecs = 900, onStatus, timeoutSecs } = {}) {
    const started = await this.startRun(actorId, input, { timeoutSecs: timeoutSecs ?? maxWaitSecs });
    const deadline = Date.now() + maxWaitSecs * 1000;
    let run = started;

    const terminal = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);
    while (!terminal.has(run.status)) {
      if (Date.now() > deadline) {
        onStatus?.({ status: 'ABORTING', runId: run.id });
        try {
          await this.abortRun(run.id);
        } catch {
          // Se o abort falhar, o timeout do proprio Actor encerra a execucao.
        }
        run = await this.getRun(run.id);
        break;
      }
      await new Promise((r) => setTimeout(r, pollSecs * 1000));
      run = await this.getRun(run.id);
      onStatus?.({ status: run.status, runId: run.id });
    }

    return run;
  }
}
