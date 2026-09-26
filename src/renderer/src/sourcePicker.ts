import type { SourceType, WindowSource } from "../../types/capture";

export class SourcePicker {
	private sources: WindowSource[] = [];
	private selectedSource: WindowSource | null = null;
	private currentFilter: SourceType = "window";
	private containerElement: HTMLElement;
	private onSelectCallback: (source: WindowSource) => void;

	constructor(
		containerElement: HTMLElement,
		onSelectCallback: (source: WindowSource) => void,
	) {
		this.containerElement = containerElement;
		this.onSelectCallback = onSelectCallback;
	}

	public setSources(sources: WindowSource[]): void {
		this.sources = sources;
		this.render();
	}

	public setFilter(filter: SourceType): void {
		this.currentFilter = filter;
		this.render();
	}

	public getSelectedSource(): WindowSource | null {
		return this.selectedSource;
	}

	public setSelectedSource(source: WindowSource | null): void {
		this.selectedSource = source;
		this.render();
	}

	public setSelectedSourceById(id: string): void {
		const found = this.sources.find((s) => s.id === id);
		if (found) {
			this.selectedSource = found;
			this.render();
		}
	}

	public render(): void {
		const filtered = this.sources.filter(
			(s) => s.sourceType === this.currentFilter,
		);

		// Mesmas fontes na mesma ordem: atualiza os cards no lugar em vez de recriá-los.
		// Recriar o DOM a cada atualização (15s) fazia cliques em andamento se perderem.
		const renderedIds = Array.from(
			this.containerElement.querySelectorAll<HTMLElement>(".source-card"),
		).map((c) => c.dataset.sourceId);
		if (
			filtered.length > 0 &&
			renderedIds.length === filtered.length &&
			filtered.every((s, i) => s.id === renderedIds[i])
		) {
			this.updateCardsInPlace(filtered);
			return;
		}

		this.containerElement.innerHTML = "";

		if (filtered.length === 0) {
			const emptyState = document.createElement("div");
			emptyState.className = "empty-sources-state";
			emptyState.innerHTML = `<p style="padding: 20px; text-align: center; color: var(--text-muted); grid-column: span 2;">Nenhuma ${this.currentFilter === "window" ? "janela" : "tela"} encontrada.</p>`;
			this.containerElement.appendChild(emptyState);
			return;
		}

		for (const src of filtered) {
			const isSelected = this.selectedSource?.id === src.id;

			const card = document.createElement("div");
			card.className = `source-card ${isSelected ? "selected" : ""}`;
			card.dataset.sourceId = src.id;

			const thumbWrapper = document.createElement("div");
			thumbWrapper.className = "thumbnail-wrapper";

			const img = document.createElement("img");
			img.className = "source-thumbnail";
			img.src = src.thumbnailUrl;
			img.alt = src.name;
			thumbWrapper.appendChild(img);

			const infoDiv = document.createElement("div");
			infoDiv.className = "source-info";

			const titleSpan = document.createElement("span");
			titleSpan.className = "source-title";
			titleSpan.innerText = src.name;
			titleSpan.title = `${src.name} (${src.processName || "N/A"})`;

			infoDiv.appendChild(titleSpan);

			card.appendChild(thumbWrapper);
			card.appendChild(infoDiv);

			card.addEventListener("click", () => {
				// Busca a versão atual da fonte (os dados são atualizados no lugar a cada varredura)
				const current = this.sources.find((s) => s.id === card.dataset.sourceId) ?? src;
				this.selectedSource = current;
				this.render();
				this.onSelectCallback(current);
			});

			this.containerElement.appendChild(card);
		}
	}

	private updateCardsInPlace(filtered: WindowSource[]): void {
		const cards = this.containerElement.querySelectorAll<HTMLElement>(".source-card");
		filtered.forEach((src, i) => {
			const card = cards[i];
			card.classList.toggle("selected", this.selectedSource?.id === src.id);

			const img = card.querySelector<HTMLImageElement>(".source-thumbnail");
			if (img && img.src !== src.thumbnailUrl) img.src = src.thumbnailUrl;

			const title = card.querySelector<HTMLElement>(".source-title");
			if (title && title.innerText !== src.name) {
				title.innerText = src.name;
				title.title = `${src.name} (${src.processName || "N/A"})`;
			}
		});
	}
}
