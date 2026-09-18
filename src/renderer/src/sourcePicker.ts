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

	public render(): void {
		this.containerElement.innerHTML = "";

		const filtered = this.sources.filter(
			(s) => s.sourceType === this.currentFilter,
		);

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
				this.selectedSource = src;
				this.render();
				this.onSelectCallback(src);
			});

			this.containerElement.appendChild(card);
		}
	}
}
