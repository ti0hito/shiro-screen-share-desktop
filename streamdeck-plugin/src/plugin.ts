import streamDeck from "@elgato/streamdeck";
import { ToggleScreenShareAction } from "./actions/toggle-screen-share";
import { AudioModeAction } from "./actions/audio-mode";
import { LaunchActivityAction } from "./actions/launch-activity";
import { SourcePreviewAction } from "./actions/source-preview";
import { PreviewNextAction } from "./actions/preview-next";
import { PreviewPreviousAction } from "./actions/preview-previous";

streamDeck.actions.registerAction(new ToggleScreenShareAction());
streamDeck.actions.registerAction(new AudioModeAction());
streamDeck.actions.registerAction(new LaunchActivityAction());
streamDeck.actions.registerAction(new SourcePreviewAction());
streamDeck.actions.registerAction(new PreviewNextAction());
streamDeck.actions.registerAction(new PreviewPreviousAction());
streamDeck.connect();
