import {
	action,
	type KeyDownEvent,
	type WillAppearEvent,
	SingletonAction,
} from "@elgato/streamdeck";
import { getWsClient } from "../ws-client";
import { previewState } from "../preview-state";
import { updateAllPreviewButtons } from "./source-preview";

@action({ UUID: "com.shiro.screenshare.preview-next" })
export class PreviewNextAction extends SingletonAction {
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

		previewState.next();
		updateAllPreviewButtons();
	}
}
