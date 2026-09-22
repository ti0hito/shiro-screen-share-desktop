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
┌────────────────────────────────────────────────────────────────────────┐
│                        Electron Main Process (Node)                    │
│                                                                        │
│  ┌─────────────────┐  ┌──────────────────┐  ┌──────────────────────┐  │
│  │   AudioEngine   │  │   IpcHandlers    │  │    WindowScanner     │  │
│  │ (WASAPI capture)│  │ (Safe IPC + SSE) │  │  (Win32 enumeration) │  │
│  └────────┬────────┘  └────────┬─────────┘  └──────────┬───────────┘  │
│           │ PCM stream         │ Security & Headers    │ Sources      │
└───────────┼────────────────────┼───────────────────────┼──────────────┘
            │                    │                       │
┌───────────▼────────────────────▼───────────────────────▼──────────────┐
│                        Electron Renderer (UI)                          │
│                                                                        │
│  ┌─────────────────┐  ┌──────────────────┐  ┌──────────────────────┐  │
│  │  Auth & Rooms   │  │    P2PManager    │  │  Multi-Stream Grid   │  │
│  │ (JWT Session)   │  │ (Native WebRTC)  │  │ (Focus / Maximized)  │  │
│  └─────────────────┘  └────────┬─────────┘  └──────────────────────┘  │
└────────────────────────────────┼──────────────────────────────────────┘
                                 │ SDP & ICE Signals
┌────────────────────────────────▼──────────────────────────────────────┐
│                    API Vercel + MongoDB Backend                        │
│                                                                        │
│   • POST /api/auth/login & /register                                  │
│   • POST /api/rooms/create, /join, /leave, /stream                     │
│   • GET  /api/signal/sse (Real-Time SSE EventStream)                   │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 📁 Estrutura do Repositório

| Módulo | Tipo | Responsabilidade |
|--------|------|------------------|
| `src/main/main.ts` | Main | Ciclo de vida da aplicação Electron, protocolo customizado e tray |
| `src/main/audioEngine.ts` | Main | Captura WASAPI de áudio nativo via `loopback-capture` |
| `src/main/ipcHandlers.ts` | Main | Ponte IPC segura (injetor da `X-API-Key` e túnel SSE) |
| `src/main/windowScanner.ts` | Main | Enumeração de janelas e telas do Windows |
| `src/renderer/src/app.ts` | Renderer | Gerenciador da interface, controle de salas, grid e estado |
| `src/renderer/src/p2pManager.ts` | Renderer | Conexões WebRTC P2P multi-peer e sinalização |
| `src/renderer/src/authManager.ts` | Renderer | Comunicação de autenticação, JWT e API de salas |
| `src/renderer/src/sourcePicker.ts` | Renderer | Picker de janelas e telas em tempo real |
| `src/renderer/index.html` | UI | Estrutura da interface com visual Wireframe e Modais |
| `src/renderer/index.css` | Styling | Design visual responsivo, dark mode e estilos do grid |

---

## 🚀 Como Executar

### Pré-requisitos

- **Windows 10 ou 11** (necessário para a API WASAPI de captura de áudio por processo)
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

Crie um arquivo `.env` na raiz do projeto com as credenciais do seu ambiente:

```env
# URL da API Shiro hospedada na Vercel
SHIRO_API_URL=https://sua-api.vercel.app

# Chave de segurança para validar chamadas na API (Header X-API-Key)
SHIRO_API_KEY=sua-chave-secreta-compartilhada-aqui

# Servidor STUN para P2P (padrão Google)
STUN_URL=stun:stun.l.google.com:19302
```

### 4. Executar em modo de desenvolvimento

```bash
npm run dev
```

### 5. Compilar para produção

```bash
npm run build
```

Os executáveis instaláveis (`.exe`) e portáteis serão gerados na pasta `release/`.

---

## 🔐 Segurança

- **Chave de API Oculta**: O processo renderer executa com `contextIsolation: true`. A chave `SHIRO_API_KEY` fica armazenada exclusivamente no ambiente Node do processo principal.
- **Criptografia de Senhas**: Todas as senhas de usuários e senhas de salas privadas são salvas no banco de dados MongoDB utilizando hash `bcrypt` de 12 rounds.
- **Sessões JWT**: Tokens autenticados possuem expiração e são renovados com a sessão do usuário.

---

## 📄 Licença

Distribuído sob a licença MIT. Veja `LICENSE` para mais informações.
