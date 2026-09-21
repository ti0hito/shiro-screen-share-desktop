# Shiro Screen Share — Stream Deck Plugin

Control [Shiro Screen Share](https://github.com/anomalyco/shiro-screen-share-desktop) directly from your Elgato Stream Deck. Toggle sharing, switch windows, change audio modes, and see live source previews — all without leaving your stream.

## Features

- **Toggle Screen Share** — Start/stop sharing with one press
- **Audio Mode** — Cycle between App Audio / System Audio / Muted
- **Launch Activity** — Open the Discord Activity directly in the Discord desktop app
- **Source Preview** — Live thumbnail of the current source on a Stream Deck key
  - **Short press** → Select the previewed source
  - **Long press (hold 500ms)** → Cycle to next source
- **Preview Previous / Next** — Dedicated navigation buttons for source cycling
- **Green border** indicator when the previewed source is the one actively being shared

## Technologies

| Technology | Purpose |
|------------|---------|
| **TypeScript** | Type-safe source code |
| **@elgato/streamdeck SDK v2** | Stream Deck plugin API |
| **Rollup** | Bundles TypeScript → single `plugin.js` |
| **Sharp** | Image processing for thumbnail borders |
| **WebSocket (ws)** | Real-time IPC with the Shiro desktop app |
| **Node.js 24** | Runtime (required by Stream Deck) |

## Architecture

```
┌─────────────────┐    WebSocket (ws://127.0.0.1:51234)    ┌──────────────────┐
│  Stream Deck    │ ◄──────────────────────────────────────►│  Shiro Screen    │
│  Plugin         │    JSON messages over localhost         │  Share App       │
│  (Node.js)      │                                         │  (Electron)      │
└─────────────────┘                                         └──────────────────┘
```

The plugin connects to the Shiro app's local WebSocket server on port `51234`. All communication uses JSON-serialized messages. The connection auto-reconnects every 3 seconds if dropped.

### WebSocket Message Reference

**Plugin → App (Commands):**

| Message | Payload | Description |
|---------|---------|-------------|
| `toggle` | — | Toggle screen sharing |
| `get_sources` | — | Request available sources |
| `select_source` | `{ index: number }` | Select a source by index |
| `get_audio_mode` | — | Request current audio mode |
| `cycle_audio_mode` | — | Cycle to next audio mode |
| `cycle_source` | — | Cycle to next source |

**App → Plugin (Events):**

| Message | Payload | Description |
|---------|---------|-------------|
| `state_changed` | `{ isSharing: boolean }` | Sharing state changed |
| `sources_updated` | `{ sources: SourceInfo[], selectedIndex: number }` | Source list updated |
| `audio_mode_changed` | `{ mode: AudioMode }` | Audio mode changed |

**Data Types:**

```typescript
type AudioMode = "process" | "system" | "disabled";

type SourceInfo = {
  id: string;
  name: string;
  processName: string;
  sourceType: "window" | "screen";
  thumbnailUrl: string; // base64 data URI
};
```

## Actions

| UUID | Name | Description |
|------|------|-------------|
| `com.shiro.screenshare.toggle` | Toggle Screen Share | Start/stop sharing |
| `com.shiro.screenshare.audio-mode` | Audio Mode | Cycle audio mode |
| `com.shiro.screenshare.launch-activity` | Launch Activity | Open Discord Activity in Discord app |
| `com.shiro.screenshare.source-preview` | Source Preview | Live thumbnail with select/cycle |
| `com.shiro.screenshare.preview-previous` | Preview Previous | Navigate to previous source |
| `com.shiro.screenshare.preview-next` | Preview Next | Navigate to next source |

## Prerequisites

- **Node.js** 24 or later
- **Stream Deck Software** 6.6 or later ([download](https://www.elgato.com/stream-deck))
- **Shiro Screen Share** app running with WebSocket server active on port 51234
- **Discord** desktop app installed (for Launch Activity button)

## Setup & Development

### 1. Clone and install

```bash
git clone https://github.com/anomalyco/shiro-screen-share-desktop.git
cd shiro-screen-share-desktop/streamdeck-plugin
npm install
```

### 2. Build

```bash
npm run build
```

Output: `com.shiro.screenshare.sdPlugin/bin/plugin.js`

### 3. Watch mode (auto-rebuild)

```bash
npm run watch
```

### 4. Link for development

```bash
npm install -g @elgato/cli@latest
streamdeck link com.shiro.screenshare.sdPlugin
```

This creates a symlink in the Stream Deck plugins directory so changes are reflected immediately after a restart.

### 5. Restart the plugin

```bash
streamdeck restart com.shiro.screenshare
```

Or restart the Stream Deck app manually.

## Installation

### For End Users (Recommended)

1. Download `com.shiro.screenshare.streamDeckPlugin` from [Releases](https://github.com/anomalyco/shiro-screen-share-desktop/releases)
2. Double-click the file — Stream Deck will install it automatically
3. Make sure the Shiro Screen Share app is running

### Manual Installation

1. Copy `com.shiro.screenshare.sdPlugin/` to:
   - **Windows:** `%APPDATA%\Elgato\StreamDeck\Plugins\`
   - **macOS:** `~/Library/Application Support/com.elgato.StreamDeck/Plugins/`
2. Restart Stream Deck

## Creating a Release Installer

### Using the Elgato CLI

The official way to package a Stream Deck plugin:

```bash
# Install the CLI globally (one-time)
npm install -g @elgato/cli@latest

# Build the plugin
cd streamdeck-plugin
npm run build

# Package into .streamDeckPlugin file
streamdeck pack com.shiro.screenshare.sdPlugin --output dist/
```

This produces `dist/com.shiro.screenshare.streamDeckPlugin` — a single file users can double-click to install.

### Creating a Release Manually (Without CI)

```bash
# 1. Build
cd streamdeck-plugin
npm run build

# 2. Install runtime deps
cd com.shiro.screenshare.sdPlugin
npm install
cd ../..

# 3. Package
streamdeck pack com.shiro.screenshare.sdPlugin --output dist/

# 4. Go to https://github.com/anomalyco/shiro-screen-share-desktop/releases/new
# 5. Create a new tag (e.g. v1.1.0)
# 6. Upload dist/com.shiro.screenshare.streamDeckPlugin as a release asset
```

## Project Structure

```
streamdeck-plugin/
├── package.json                         # Build-time dependencies
├── rollup.config.mjs                    # Rollup bundler config
├── tsconfig.json                        # TypeScript config
├── README.md                            # This file
├── .sdignore                            # Files excluded from packaging
├── src/
│   ├── plugin.ts                        # Entry point — registers all actions
│   ├── ws-client.ts                     # WebSocket client singleton
│   ├── preview-state.ts                 # Shared source preview state
│   └── actions/
│       ├── toggle-screen-share.ts       # Toggle sharing on/off
│       ├── audio-mode.ts               # Cycle audio mode
│       ├── launch-activity.ts           # Open Discord Activity
│       ├── source-preview.ts            # Live thumbnail preview
│       ├── preview-previous.ts          # Navigate to previous source
│       └── preview-next.ts              # Navigate to next source
└── com.shiro.screenshare.sdPlugin/      # Distributable plugin bundle
    ├── manifest.json                    # Plugin metadata
    ├── package.json                     # Runtime dependencies
    ├── bin/plugin.js                    # Compiled output
    ├── imgs/                            # Icons (Lucide, dark theme)
    │   ├── actions/
    │   └── states/
    └── node_modules/                    # Runtime deps (sharp, ws)
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Plugin not connecting | Make sure Shiro Screen Share app is running |
| "Alert" icon on button | WebSocket connection failed — check if the app is running on port 51234 |
| Preview shows no thumbnail | Ensure the app is capturing a source (start sharing first) |
| Launch Activity opens browser | Discord desktop app must be installed and set as default for `discord://` protocol |

## License

MIT
