/**
 * tutorial.ts
 * Tour guiado: destaca um elemento da tela (holofote) e mostra um balão explicando a etapa.
 *
 * - Não bloqueia cliques: o usuário interage com o app normalmente durante o tour.
 * - Etapas com `completeWhen` avançam sozinhas quando a ação é feita (ex.: entrou na sala).
 *   Se a condição já estiver cumprida ao chegar na etapa, aparece o botão "Próximo".
 * - Fica oculto enquanto algum modal do app estiver aberto (ex.: modal de criar sala).
 */

export interface TourStep {
	title: string;
	/** HTML estático escrito no código (não usar com dados de usuário) */
	text: string;
	/** Elemento destacado. Sem alvo (ou alvo invisível), o balão aparece centralizado. */
	target?: () => Element | null;
	onEnter?: () => void;
	onExit?: () => void;
	/** Avança automaticamente quando passar a retornar true */
	completeWhen?: () => boolean;
	/** Texto exibido enquanto a etapa aguarda a ação do usuário */
	waitingHint?: string;
	/** Rótulo do botão de avançar (padrão "Próximo") */
	nextLabel?: string;
}

export interface TourOptions {
	onFinish?: (completed: boolean) => void;
}

const SPOTLIGHT_PADDING = 6;
const TOOLTIP_GAP = 14;
const VIEWPORT_MARGIN = 12;

export class GuidedTour {
	private index = -1;
	private spotlight: HTMLDivElement | null = null;
	private tooltip: HTMLDivElement | null = null;
	private tickTimer: ReturnType<typeof setInterval> | null = null;
	private wasComplete = false;
	private active = false;

	private readonly onKeyDown = (e: KeyboardEvent) => {
		if (e.key === "Escape" && this.active) this.stop(false);
	};
	private readonly onResize = () => this.position();

	constructor(
		private readonly steps: TourStep[],
		private readonly options: TourOptions = {},
	) {}

	isActive(): boolean {
		return this.active;
	}

	start(): void {
		if (this.active || this.steps.length === 0) return;
		this.active = true;
		this.createDom();
		document.addEventListener("keydown", this.onKeyDown);
		window.addEventListener("resize", this.onResize);
		this.tickTimer = setInterval(() => this.tick(), 200);
		this.goTo(0);
	}

	stop(completed: boolean): void {
		if (!this.active) return;
		this.active = false;
		this.steps[this.index]?.onExit?.();
		if (this.tickTimer) clearInterval(this.tickTimer);
		this.tickTimer = null;
		document.removeEventListener("keydown", this.onKeyDown);
		window.removeEventListener("resize", this.onResize);
		this.spotlight?.remove();
		this.tooltip?.remove();
		this.spotlight = this.tooltip = null;
		this.options.onFinish?.(completed);
	}

	private createDom(): void {
		this.spotlight = document.createElement("div");
		this.spotlight.className = "tour-spotlight";

		this.tooltip = document.createElement("div");
		this.tooltip.className = "tour-tooltip";
		this.tooltip.setAttribute("role", "dialog");
		this.tooltip.setAttribute("aria-live", "polite");
		// Cliques no balão não podem chegar ao document (fecharia os popovers do app)
		this.tooltip.addEventListener("click", (e) => e.stopPropagation());
		this.tooltip.addEventListener("mousedown", (e) => e.stopPropagation());

		document.body.append(this.spotlight, this.tooltip);
	}

	private goTo(index: number): void {
		this.steps[this.index]?.onExit?.();
		if (index >= this.steps.length) {
			this.stop(true);
			return;
		}
		this.index = index;
		const step = this.steps[index];
		step.onEnter?.();
		this.wasComplete = step.completeWhen?.() ?? false;
		this.render();
		// Aguarda o layout reagir ao onEnter (abrir popover, trocar aba) antes de posicionar
		requestAnimationFrame(() => this.position());
	}

	private render(): void {
		if (!this.tooltip) return;
		const step = this.steps[this.index];
		const isLast = this.index === this.steps.length - 1;
		const waiting = !!step.completeWhen && !this.wasComplete;

		this.tooltip.innerHTML = `
			<div class="tour-tooltip-progress">Passo ${this.index + 1} de ${this.steps.length}</div>
			<div class="tour-tooltip-title">${step.title}</div>
			<div class="tour-tooltip-text">${step.text}</div>
			${waiting && step.waitingHint ? `<div class="tour-tooltip-waiting"><span class="tour-waiting-dot"></span>${step.waitingHint}</div>` : ""}
			<div class="tour-tooltip-actions">
				<button type="button" class="tour-btn tour-btn-ghost" data-tour="exit">Sair do tutorial</button>
				<div class="tour-tooltip-actions-right">
					${this.index > 0 ? `<button type="button" class="tour-btn tour-btn-ghost" data-tour="back">Voltar</button>` : ""}
					${
						waiting
							? `<button type="button" class="tour-btn tour-btn-ghost" data-tour="skip">Pular</button>`
							: `<button type="button" class="tour-btn tour-btn-primary" data-tour="next">${step.nextLabel ?? (isLast ? "Concluir" : "Próximo")}</button>`
					}
				</div>
			</div>`;

		this.tooltip.querySelector('[data-tour="exit"]')?.addEventListener("click", () => this.stop(false));
		this.tooltip.querySelector('[data-tour="back"]')?.addEventListener("click", () => this.goTo(this.index - 1));
		this.tooltip.querySelector('[data-tour="skip"]')?.addEventListener("click", () => this.goTo(this.index + 1));
		this.tooltip.querySelector('[data-tour="next"]')?.addEventListener("click", () => this.goTo(this.index + 1));
	}

	private tick(): void {
		if (!this.active) return;
		const step = this.steps[this.index];

		// Ação da etapa concluída agora: avança sozinho
		if (step.completeWhen) {
			const complete = step.completeWhen();
			if (complete && !this.wasComplete) {
				this.wasComplete = true;
				this.goTo(this.index + 1);
				return;
			}
			if (!complete && this.wasComplete) {
				// Condição deixou de valer (ex.: saiu da sala): volta a aguardar
				this.wasComplete = false;
				this.render();
			}
		}
		this.position();
	}

	private position(): void {
		if (!this.spotlight || !this.tooltip) return;

		// Com um modal do app aberto, o tour sai da frente
		const modalOpen = !!document.querySelector(".modal-overlay:not(.hidden)");
		this.spotlight.classList.toggle("tour-hidden", modalOpen);
		this.tooltip.classList.toggle("tour-hidden", modalOpen);
		if (modalOpen) return;

		const step = this.steps[this.index];
		const target = step?.target?.() ?? null;
		const rect = target?.getBoundingClientRect();
		const visible = !!rect && rect.width > 0 && rect.height > 0;

		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const tipW = this.tooltip.offsetWidth;
		const tipH = this.tooltip.offsetHeight;

		if (!visible || !rect) {
			// Sem alvo: escurece tudo e centraliza o balão
			this.spotlight.classList.add("tour-spotlight-full");
			this.tooltip.style.left = `${Math.round((vw - tipW) / 2)}px`;
			this.tooltip.style.top = `${Math.round((vh - tipH) / 2)}px`;
			return;
		}

		this.spotlight.classList.remove("tour-spotlight-full");
		const hole = {
			left: Math.max(0, rect.left - SPOTLIGHT_PADDING),
			top: Math.max(0, rect.top - SPOTLIGHT_PADDING),
			right: Math.min(vw, rect.right + SPOTLIGHT_PADDING),
			bottom: Math.min(vh, rect.bottom + SPOTLIGHT_PADDING),
		};
		Object.assign(this.spotlight.style, {
			left: `${hole.left}px`,
			top: `${hole.top}px`,
			width: `${hole.right - hole.left}px`,
			height: `${hole.bottom - hole.top}px`,
		});

		// Escolhe o lado com espaço: direita, esquerda, abaixo, acima
		const candidates = [
			{ left: hole.right + TOOLTIP_GAP, top: hole.top, fits: vw - hole.right - TOOLTIP_GAP >= tipW + VIEWPORT_MARGIN },
			{ left: hole.left - TOOLTIP_GAP - tipW, top: hole.top, fits: hole.left - TOOLTIP_GAP >= tipW + VIEWPORT_MARGIN },
			{ left: hole.left, top: hole.bottom + TOOLTIP_GAP, fits: vh - hole.bottom - TOOLTIP_GAP >= tipH + VIEWPORT_MARGIN },
			{ left: hole.left, top: hole.top - TOOLTIP_GAP - tipH, fits: hole.top - TOOLTIP_GAP >= tipH + VIEWPORT_MARGIN },
		];
		const pick = candidates.find((c) => c.fits) ?? candidates[2];
		const left = Math.min(Math.max(pick.left, VIEWPORT_MARGIN), vw - tipW - VIEWPORT_MARGIN);
		const top = Math.min(Math.max(pick.top, VIEWPORT_MARGIN), vh - tipH - VIEWPORT_MARGIN);
		this.tooltip.style.left = `${Math.round(left)}px`;
		this.tooltip.style.top = `${Math.round(top)}px`;
	}
}
