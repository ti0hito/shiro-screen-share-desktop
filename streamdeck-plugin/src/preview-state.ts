import type { SourceInfo } from "./ws-client";

class PreviewState {
	private _sources: SourceInfo[] = [];
	private _currentIndex = 0;
	private _selectedIndex = -1;

	get sources(): SourceInfo[] {
		return this._sources;
	}

	set sources(val: SourceInfo[]) {
		this._sources = val;
		if (this._currentIndex >= val.length) {
			this._currentIndex = 0;
		}
	}

	get currentIndex(): number {
		return this._currentIndex;
	}

	get selectedIndex(): number {
		return this._selectedIndex;
	}

	set selectedIndex(val: number) {
		this._selectedIndex = val;
	}

	get currentSource(): SourceInfo | undefined {
		return this._sources[this._currentIndex];
	}

	get isSelected(): boolean {
		return this._currentIndex === this._selectedIndex && this._selectedIndex >= 0;
	}

	next(): SourceInfo | undefined {
		if (this._sources.length === 0) return undefined;
		this._currentIndex = (this._currentIndex + 1) % this._sources.length;
		return this.currentSource;
	}

	previous(): SourceInfo | undefined {
		if (this._sources.length === 0) return undefined;
		this._currentIndex = (this._currentIndex - 1 + this._sources.length) % this._sources.length;
		return this.currentSource;
	}

	select(index: number): SourceInfo | undefined {
		if (index < 0 || index >= this._sources.length) return undefined;
		this._currentIndex = index;
		return this.currentSource;
	}
}

export const previewState = new PreviewState();
