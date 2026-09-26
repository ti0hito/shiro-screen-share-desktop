/**
 * poller.ts
 * Polling controlado para a API:
 *  - nunca sobrepõe execuções (a próxima só é agendada quando a atual termina)
 *  - backoff exponencial quando a tarefa falha (API fora do ar / rate limit)
 *  - intervalo maior quando a janela está oculta (bandeja / minimizada)
 */

export interface PollerOptions {
	/** Intervalo base entre execuções (ms) */
	intervalMs: number;
	/** Multiplicador aplicado ao intervalo quando a janela está oculta (padrão 4) */
	hiddenFactor?: number;
	/** Intervalo máximo durante o backoff (ms, padrão 2 min) */
	maxBackoffMs?: number;
}

/** A tarefa retorna false quando falhou (ativa o backoff) */
export type PollTask = () => Promise<boolean | void>;

export class Poller {
	private timer: ReturnType<typeof setTimeout> | null = null;
	private running = false;
	private inFlight = false;
	private failures = 0;
	private lastRunAt = 0;
	private readonly onVisibilityChange = () => {
		// Ao voltar para a janela, atualiza logo se o dado já estiver velho
		if (!document.hidden && Date.now() - this.lastRunAt >= this.opts.intervalMs) {
			this.trigger();
		}
	};

	constructor(
		private readonly task: PollTask,
		private readonly opts: PollerOptions,
	) {}

	/** Inicia o polling. Com runNow, executa imediatamente. */
	start(runNow = false): void {
		if (this.running) return;
		this.running = true;
		document.addEventListener("visibilitychange", this.onVisibilityChange);
		if (runNow) this.trigger();
		else this.schedule();
	}

	stop(): void {
		this.running = false;
		document.removeEventListener("visibilitychange", this.onVisibilityChange);
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	/** Executa agora (ignorado se já houver uma execução em andamento) */
	async trigger(): Promise<void> {
		if (!this.running || this.inFlight) return;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}

		this.inFlight = true;
		try {
			const result = await this.task();
			this.failures = result === false ? this.failures + 1 : 0;
		} catch (err) {
			console.warn("[Poller] Erro na tarefa de polling:", err);
			this.failures++;
		} finally {
			this.inFlight = false;
			this.lastRunAt = Date.now();
			this.schedule();
		}
	}

	private schedule(): void {
		if (!this.running) return;
		const maxBackoff = this.opts.maxBackoffMs ?? 120_000;
		let delay = this.opts.intervalMs;
		if (this.failures > 0) {
			delay = Math.min(delay * 2 ** this.failures, maxBackoff);
		}
		if (document.hidden) {
			delay *= this.opts.hiddenFactor ?? 4;
		}
		// Jitter de ±10% para não disparar todos os pollers no mesmo instante
		delay = Math.round(delay * (0.9 + Math.random() * 0.2));
		this.timer = setTimeout(() => this.trigger(), delay);
	}
}
