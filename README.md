<div align="center">

<img src="icon.ico" width="96" height="96" alt="Shiro Screen Share">

# Shiro Screen Share

**App Desktop de Alta Performance para Compartilhamento de Tela P2P e Transmissões em Tempo Real**

[![License: MIT](https://img.shields.io/badge/License-MIT-violet.svg)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron)](https://www.electronjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![WebRTC](https://img.shields.io/badge/WebRTC-P2P-333333?logo=webrtc)](https://webrtc.org/)
[![Vercel API](https://img.shields.io/badge/Vercel-API-000000?logo=vercel)](https://vercel.com/)
[![MongoDB](https://img.shields.io/badge/MongoDB-Atlas-47A248?logo=mongodb)](https://www.mongodb.com/)
[![Platform](https://img.shields.io/badge/Platform-Windows-0078D6?logo=windows)](https://www.microsoft.com/windows)
[![Platform](https://img.shields.io/badge/Platform-Linux-FCC624?logo=linux&logoColor=black)](#-linux)

</div>

---

## ✨ Visão Geral

O **Shiro Screen Share** é um aplicativo desktop moderno construído em Electron e TypeScript, projetado para transmissões de tela diretas e de altíssima performance usando **conexões Peer-to-Peer (P2P) puras via WebRTC**. 

Livre de intermediários pesados ou servidores de streaming pagos, o app se conecta a uma **API Vercel + MongoDB** ultrarrápida para autenticação segura e sinalização em tempo real.

### 🌟 Destaques da Nova Versão (v2.1)

- 🔒 **Sistema de Autenticação Seguro**: Tela inicial de Login e Registro com senhas criptografadas em `bcrypt` (12 rounds) e tokens JWT.
- 📡 **Conexão Direta Peer-to-Peer (P2P)**: Transmissão de vídeo e áudio via `RTCPeerConnection` nativo com sinalização real-time por Server-Sent Events (SSE).
- 🎙️ **Isolamento de Áudio por Processo**: Captura nativa via WASAPI (Windows) — transmita apenas o áudio do seu jogo ou programa sem capturar sons do sistema.
- 🏰 **Salas de Transmissão (Canais)**:
  - Crie salas públicas ou privadas.
  - **IDs de Sala**: Personalizados (ex: `MINHASALA`) ou gerados automaticamente (ex: `SHIRO-9F2A`).
  - **Proteção por Senha de 8 Dígitos**: Crie salas privadas protegidas por senha numérica de 8 dígitos ou use o botão **⚡ Gerar Senha**.
- 📺 **Grid Multi-Transmissão (Live Grid)**:
  - Visualize todas as transmissões ao vivo da sala simultaneamente em um grid no estilo Discord.
  - **Maximizar ao Clicar**: Clique em qualquer card de transmissão para expandir em tela cheia com barra de atalho ou tecla `Esc` para retornar.
- 🛡️ **Segurança de Chaves e IPC Bridge**: A `SHIRO_API_KEY` reside exclusivamente no processo principal do Electron e nunca é exposta no renderer.

---

## 🏗️ Arquitetura do Sistema

```
┌───────────────────────────────────────────────────────────────────────┐
│                        Electron Main Process (Node)                   │
│                                                                       │
│  ┌─────────────────┐  ┌──────────────────┐  ┌──────────────────────┐  │
│  │   AudioEngine   │  │   IpcHandlers    │  │    WindowScanner     │  │
│  │ (WASAPI capture)│  │ (Safe IPC + SSE) │  │  (Win32 enumeration) │  │
│  └────────┬────────┘  └────────┬─────────┘  └──────────┬───────────┘  │
│           │ PCM stream         │ Security & Headers    │ Sources      │
└───────────┼────────────────────┼───────────────────────┼──────────────┘
            │                    │                       │
┌───────────▼────────────────────▼───────────────────────▼──────────────┐
│                        Electron Renderer (UI)                         │
│                                                                       │
│  ┌─────────────────┐  ┌──────────────────┐  ┌──────────────────────┐  │
│  │  Auth & Rooms   │  │    P2PManager    │  │  Multi-Stream Grid   │  │
│  │ (JWT Session)   │  │ (Native WebRTC)  │  │ (Focus / Maximized)  │  │
│  └─────────────────┘  └────────┬─────────┘  └──────────────────────┘  │
└────────────────────────────────┼──────────────────────────────────────┘
                                 │ SDP & ICE Signals
┌────────────────────────────────▼──────────────────────────────────────┐
│                    API Vercel + MongoDB Backend                       │
│                                                                       │
│   • POST /api/auth/login & /register                                  │
│   • POST /api/rooms/create, /join, /leave, /stream                    │
│   • GET  /api/signal/sse (Real-Time SSE EventStream)                  │
└───────────────────────────────────────────────────────────────────────┘
```

---

## 📁 Estrutura do Repositório

| Módulo | Tipo | Responsabilidade |
|--------|------|------------------|
| `src/main/main.ts` | Main | Ciclo de vida da aplicação Electron, protocolo customizado e tray |
| `src/main/audioEngine.ts` | Main | Captura de áudio nativa via `loopback-capture` (WASAPI no Windows, PipeWire no Linux) |
| `src/main/ipcHandlers.ts` | Main | Ponte IPC segura (injetor da `X-API-Key` e túnel SSE) |
| `src/main/windowScanner.ts` | Main | Enumeração de janelas e telas (Win32 no Windows, `/proc` + `xprop` no Linux) |
| `src/renderer/src/app.ts` | Renderer | Gerenciador da interface, controle de salas, grid e estado |
| `src/renderer/src/p2pManager.ts` | Renderer | Conexões WebRTC P2P multi-peer e sinalização |
| `src/renderer/src/authManager.ts` | Renderer | Comunicação de autenticação, JWT e API de salas |
| `src/renderer/src/sourcePicker.ts` | Renderer | Picker de janelas e telas em tempo real |
| `src/renderer/index.html` | UI | Estrutura da interface com visual Wireframe e Modais |
| `src/renderer/index.css` | Styling | Design visual responsivo, dark mode e estilos do grid |

---

## 🚀 Como Executar

### Pré-requisitos

- **Windows 10 ou 11** (captura de áudio por processo via WASAPI) **ou Linux x64** (áudio via PipeWire — veja a seção [🐧 Linux](#-linux))
- **Node.js 18+** e **npm**
- **Repositório de API Vercel**: `shiro-screenshare-desktop-api` hospedado na Vercel com MongoDB Atlas.

### 1. Clonar o repositório

```bash
git clone https://github.com/ti0hito/shiro-screen-share-desktop.git
cd shiro-screen-share-desktop
```

### 2. Instalar as dependências

```bash
npm install
```

### 3. Configurar as variáveis de ambiente

Copie o `.env.example` para `.env` na raiz do projeto e preencha a chave da API:

```bash
cp .env.example .env
```

```env
# URL da API (opcional — padrão https://share.shirobot.xyz)
SHIRO_API_URL=https://share.shirobot.xyz

# Chave da API (header X-API-Key) — obrigatória para compilar
SHIRO_API_KEY=cole-a-chave-aqui

# Servidor STUN para P2P (padrão Google)
STUN_URL=stun:stun.l.google.com:19302
```

> 🔑 **A chave da API não fica no código** (o repositório é público). Ela é lida do `.env` e
> embutida no app durante o build (`scripts/build-main.mjs`). Sem ela, o build para com uma
> mensagem explicando o que fazer. Peça a chave a quem administra a API e **nunca faça commit do `.env`**.
>
> No **GitHub Actions**, a chave vem do secret `SHIRO_API_KEY`
> (Settings → Secrets and variables → Actions).

### 4. Executar em modo de desenvolvimento

```bash
npm run dev
```

### 5. Compilar para produção

| Comando | Onde rodar | Gera (em `release/`) |
|---------|------------|----------------------|
| `npm run build` | Windows | Instalador `.exe` (setup), versão portátil `.exe` e `latest.yml` |
| `npm run build:linux` | Linux | `.AppImage`, `.deb` e `latest-linux.yml` |

Os pacotes Linux precisam ser gerados em um Linux (veja [Gerar os pacotes Linux](#gerar-os-pacotes-linux)).

---

## 🐧 Linux

O app roda em **Linux x64**, tanto em sessões **X11** quanto **Wayland**.

### Instalar (usuários)

Baixe o pacote na página de [Releases](https://github.com/ti0hito/shiro-screen-share-desktop/releases):

**AppImage** — funciona em qualquer distribuição e atualiza sozinho:

```bash
chmod +x "Shiro Screen Share-"*.AppImage
./"Shiro Screen Share-"*.AppImage
```

**.deb** — Debian, Ubuntu, Linux Mint, Pop!_OS e derivados:

```bash
sudo apt install ./shiro-screen-share_*_amd64.deb
```

### Dependências do sistema

| Pacote | Para quê | Obrigatório? |
|--------|----------|--------------|
| **PipeWire** | Captura de áudio (sistema e por aplicativo) | Sim, para transmitir áudio |
| **xdg-desktop-portal** + backend do seu ambiente (GNOME, KDE…) | Seletor de tela/janela no **Wayland** | Sim, no Wayland |
| **xprop** (`x11-utils`) | Áudio de um aplicativo específico no **X11** | Opcional |

A maioria das distribuições atuais (Ubuntu 22.10+, Fedora, Arch, Pop!_OS…) já vem com PipeWire e o portal instalados. Se precisar instalar:

```bash
# Debian / Ubuntu
sudo apt install pipewire xdg-desktop-portal xdg-desktop-portal-gtk x11-utils

# Fedora
sudo dnf install pipewire xdg-desktop-portal xdg-desktop-portal-gtk xprop

# Arch Linux
sudo pacman -S pipewire xdg-desktop-portal xdg-desktop-portal-gtk xorg-xprop
```

> Em KDE Plasma, use `xdg-desktop-portal-kde` no lugar de `xdg-desktop-portal-gtk`.

### Executar a partir do código-fonte

```bash
git clone https://github.com/ti0hito/shiro-screen-share-desktop.git
cd shiro-screen-share-desktop
npm install
npm run dev
```

Não é preciso compilar nada nativo: o `loopback-capture` (áudio) e o `koffi` já incluem os binários para Linux x64.

### Gerar os pacotes Linux

- **Em um Linux:** `npm run build:linux` → gera `.AppImage`, `.deb` e `latest-linux.yml` em `release/`.
- **Pelo GitHub Actions:** aba **Actions → Build Linux → Run workflow**; os pacotes ficam em *Artifacts* ao final da execução.
- **No Windows:** apenas o AppImage, com `npm run build:linux:appimage` — requer o *Modo de Desenvolvedor* ativado (Configurações → Sistema → Para desenvolvedores) ou terminal como administrador. O `.deb` não pode ser gerado no Windows.

Para o **auto-update** funcionar no Linux, publique na release o `.AppImage` junto com o `latest-linux.yml`.

### Diferenças no Linux

- **Seleção de tela no Wayland:** o sistema não permite que apps listem janelas. Clique em **"Escolher tela ou janela"** (ou em **Iniciar transmissão**) e escolha no seletor do sistema entre a tela inteira ou uma janela específica.
- **Áudio por aplicativo:** funciona no **X11** (requer `xprop`). No **Wayland** não é possível identificar o processo da janela, então o app usa o áudio do sistema automaticamente.
- **Fechar a janela encerra o app** (no Windows ela vai para a bandeja). Antes de fechar, o app sai da sala e encerra sua transmissão.

### Solução de problemas

**O app não abre e aparece um erro de *sandbox*** (comum no Ubuntu 23.10+ por causa do AppArmor):

```bash
# AppImage
./"Shiro Screen Share-"*.AppImage --no-sandbox

# Código-fonte (npm run dev): configure o sandbox do Electron uma vez
sudo chown root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

**O seletor de tela não aparece no Wayland:** verifique se o `xdg-desktop-portal` e o backend do seu ambiente estão instalados e reinicie a sessão.

**Sem áudio na transmissão:** confirme que o sistema usa PipeWire (`pactl info | grep "Server Name"` deve mostrar *PipeWire*).

---

## 🔐 Segurança

- **Chave de API Oculta**: O processo renderer executa com `contextIsolation: true`. A chave `SHIRO_API_KEY` fica armazenada exclusivamente no ambiente Node do processo principal.
- **Criptografia de Senhas**: Todas as senhas de usuários e senhas de salas privadas são salvas no banco de dados MongoDB utilizando hash `bcrypt` de 12 rounds.
- **Sessões JWT**: Tokens autenticados possuem expiração e são renovados com a sessão do usuário.

---

## 📄 Licença

Distribuído sob a licença MIT. Veja `LICENSE` para mais informações.
