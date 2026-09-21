import streamDeck, {
	action,
	type KeyDownEvent,
	type WillAppearEvent,
	SingletonAction,
} from "@elgato/streamdeck";
import { getWsClient } from "../ws-client";
import { previewState } from "../preview-state";

function updateAllButtons(): void {
	const source = previewState.currentSource;
	streamDeck.actions.forEach((act: any) => {
		if (act.manifestId === "com.shiro.screenshare.source-preview") {
			if (source?.thumbnailUrl) {
				act.setImage(source.thumbnailUrl);
			}
			act.setTitle(source?.name?.substring(0, 12) || "");
		}
	});
}

@action({ UUID: "com.shiro.screenshare.preview-previous" })
export class PreviewPreviousAction extends SingletonAction {
	override onWillAppear(ev: WillAppearEvent): void {
		const client = getWsClient();
		client.send({ type: "get_sources" });
	}

	override onKeyDown(ev: KeyDownEvent): void | Promise<void> {
		const client = getWsClient();
		if (!client.isConnected || previewState.sources.length === 0) {
			ev.action.showAlert();
			return;
		}

		previewState.previous();
		updateAllButtons();
	}
}
