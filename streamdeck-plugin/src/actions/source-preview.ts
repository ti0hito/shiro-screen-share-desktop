import streamDeck, {
	action,
	type KeyDownEvent,
	type KeyUpEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
	SingletonAction,
} from "@elgato/streamdeck";
import sharp from "sharp";
import { getWsClient, type WsMessage } from "../ws-client";
import { previewState } from "../preview-state";

const LONG_PRESS_MS = 500;
const BORDER_COLOR_SELECTED = "#10b981";
const IMG_SIZE = 144;
const BORDER_WIDTH = 6;

async function createBorderedImage(thumbnailUrl: string, isSelected: boolean): Promise<string> {
	if (!isSelected) return thumbnailUrl;

	const base64Data = thumbnailUrl.replace(/^data:image\/\w+;base64,/, "");
	const imgBuffer = Buffer.from(base64Data, "base64");
	const innerSize = IMG_SIZE - BORDER_WIDTH * 2;

	const resizedThumbnail = await sharp(imgBuffer)
		.resize(innerSize, innerSize, { fit: "cover" })
		.png()
		.toBuffer();

	const bordered = await sharp({
		create: {
			width: IMG_SIZE,
			height: IMG_SIZE,
			channels: 4,
			background: { r: 16, g: 185, b: 129, alpha: 1 },
		},
	})
		.composite([
			{
				input: resizedThumbnail,
				top: BORDER_WIDTH,
				left: BORDER_WIDTH,
			},
		])
		.png()
		.toBuffer();

	return `data:image/png;base64,${bordered.toString("base64")}`;
}

function updateAllButtons(): void {
	const source = previewState.currentSource;
	const isSelected = previewState.isSelected;
	streamDeck.actions.forEach((act: any) => {
		if (act.manifestId === "com.shiro.screenshare.source-preview") {
			if (source?.thumbnailUrl) {
				createBorderedImage(source.thumbnailUrl, isSelected).then((img) => {
					act.setImage(img);
				});
			}
			act.setTitle(source?.name?.substring(0, 12) || "");
		}
	});
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
				updateAllButtons();
			}
		});
	}

	override async onWillAppear(ev: WillAppearEvent): Promise<void> {
		const client = getWsClient();
		client.send({ type: "get_sources" });
		const source = previewState.currentSource;
		const isSelected = previewState.isSelected;
		if (source?.thumbnailUrl) {
			const img = await createBorderedImage(source.thumbnailUrl, isSelected);
			ev.action.setImage(img);
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
			updateAllButtons();
		} else {
			const source = previewState.currentSource;
			if (!source) {
				ev.action.showAlert();
				return;
			}
		}

		client.send({ type: "select_source", payload: { index: previewState.currentIndex } });
		previewState.selectedIndex = previewState.currentIndex;
		updateAllButtons();
	}
}
