import streamDeck, {
	action,
	type KeyDownEvent,
	type KeyUpEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
	SingletonAction,
} from "@elgato/streamdeck";
import { getWsClient, type WsMessage } from "../ws-client";
import { previewState } from "../preview-state";

const LONG_PRESS_MS = 500;

export function createBorderedImage(thumbnailUrl: string, isSelected: boolean): string {
	if (!thumbnailUrl) return "";
	if (!isSelected) return thumbnailUrl;

	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><image href="${thumbnailUrl}" x="6" y="6" width="132" height="132" preserveAspectRatio="xMidYMid slice"/><rect x="3" y="3" width="138" height="138" rx="10" ry="10" fill="none" stroke="#10b981" stroke-width="6"/></svg>`;
	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function updateAllPreviewButtons(): void {
	const source = previewState.currentSource;
	const isSelected = previewState.isSelected;
	for (const act of (streamDeck.actions as any)) {
		if (act.manifestId === "com.shiro.screenshare.source-preview") {
			if (source?.thumbnailUrl) {
				const img = createBorderedImage(source.thumbnailUrl, isSelected);
				act.setImage(img);
			} else {
				act.setImage(undefined);
			}
			act.setTitle(source?.name?.substring(0, 12) || "");
		}
	}
}

@action({ UUID: "com.shiro.screenshare.source-preview" })
export class SourcePreviewAction extends SingletonAction {
	private pressStart = new Map<string, number>();

	constructor() {
		super();
		const client = getWsClient();
		client.onMessage((msg: WsMessage) => {
			if (msg.type === "sources_updated") {
				previewState.sources = msg.payload.sources;
				previewState.selectedIndex = msg.payload.selectedIndex;
				updateAllPreviewButtons();
			}
		});
	}

	override onWillAppear(ev: WillAppearEvent): void {
		const client = getWsClient();
		client.send({ type: "get_sources" });
		const source = previewState.currentSource;
		const isSelected = previewState.isSelected;
		if (source?.thumbnailUrl) {
			const img = createBorderedImage(source.thumbnailUrl, isSelected);
			ev.action.setImage(img);
		} else {
			ev.action.setImage(undefined);
		}
		ev.action.setTitle(source?.name?.substring(0, 12) || "");
	}

	override onWillDisappear(ev: WillDisappearEvent): void {
		this.pressStart.delete(ev.action.id);
	}

	override onKeyDown(ev: KeyDownEvent): void | Promise<void> {
		this.pressStart.set(ev.action.id, Date.now());
	}

	override onKeyUp(ev: KeyUpEvent): void | Promise<void> {
		const client = getWsClient();
		const held = Date.now() - (this.pressStart.get(ev.action.id) ?? Date.now());
		this.pressStart.delete(ev.action.id);

		if (!client.isConnected || previewState.sources.length === 0) {
			ev.action.showAlert();
			return;
		}

		if (held >= LONG_PRESS_MS) {
			previewState.next();
			updateAllPreviewButtons();
		} else {
			const source = previewState.currentSource;
			if (!source) {
				ev.action.showAlert();
				return;
			}
		}

		client.send({ type: "select_source", payload: { index: previewState.currentIndex } });
		previewState.selectedIndex = previewState.currentIndex;
		updateAllPreviewButtons();
	}
}
