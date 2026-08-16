# WhatsApp Chat Backend

A production-ready NestJS backend that connects to WhatsApp via the [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys) multi-device library. It exposes a REST API and a Socket.io WebSocket interface designed to be consumed by Flutter mobile/desktop applications.

---

## 🔒 Privacy-First Design

This backend enforces a strict **no-presence** policy:

* ❌ `sendPresenceUpdate()` is **never** called — your "last seen" and "online" statuses are not intentionally broadcast.
* ❌ `presenceSubscribe()` is **never** called.
* ❌ Read receipts are **never** sent automatically upon receiving messages.
* ⚠️ `POST /chats/:jid/read` is the only read-receipt trigger and is purely opt-in.
* ✅ The Baileys socket is initialized with `markOnlineOnConnect: false`.

> **Note:** The backend avoids sending intentional presence updates; server-side behavior is managed strictly according to Baileys and WhatsApp protocol defaults.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | NestJS 11 (TypeScript) |
| WhatsApp Engine | `@whiskeysockets/baileys` |
| ORM & Database | Prisma 5 with SQLite (dev/container) or PostgreSQL |
| Real-Time Communication | `@nestjs/websockets` + Socket.io |
| Authentication | Static API Key (`x-api-key` header & WS handshake) |
| Validation | `class-validator` + `class-transformer` |
| Containerization | Docker (Node 22 LTS Alpine) |

---

## Project Structure

```
├── Dockerfile                 # Production multi-step Alpine Dockerfile
├── .dockerignore              # Docker build exclusions
├── .env.example               # Template for environment variables
├── .gitignore                 # Git ignore (auth credentials, DBs, logs)
├── prisma/
│   └── schema.prisma          # Prisma models (Chat, Message, MediaFile)
├── src/
│   ├── app.controller.ts      # Health check and root endpoints
│   ├── app.module.ts          # Core application module
│   ├── auth/                  # REST and WebSocket API key guards
│   ├── chats/                 # REST endpoints for chats and messages
│   ├── config/                # Typed configuration schema
│   ├── connection/            # WhatsApp connection & QR management
│   ├── events/                # Socket.io gateway for real-time events
│   ├── main.ts                # Bootstrap, CORS, graceful shutdown hooks
│   ├── media/                 # Local media file storage & streaming
│   ├── prisma/                # Prisma client service
│   └── whatsapp/              # Baileys WhatsApp service & auth store
└── uploads/                   # Stored media files (ignored in git)
```

---

## Local Development

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Copy `.env.example` to `.env` and fill in your settings:

```bash
cp .env.example .env
```

Example `.env`:
```env
PORT=3000
NODE_ENV=development
API_KEY=change-me-to-a-strong-random-secret
DATABASE_URL="file:./dev.db"
BAILEYS_AUTH_DIR=./auth_state
MEDIA_UPLOAD_DIR=./uploads
```

### 3. Generate Prisma Client & Migrate

```bash
npx prisma generate
npx prisma migrate dev --name init
```

### 4. Run the Dev Server

```bash
npm run start:dev
```

The server listens on `http://localhost:3000/api/v1` and WebSocket at `ws://localhost:3000`.

---

## Production Build & Run

```bash
# Build TypeScript bundle
npm run build

# Start production server
npm run start:prod
```

---

## Docker

### Build Docker Image

```bash
docker build -t whatsapp-freezers-backend .
```

### Run Docker Container Locally

```bash
docker run -d \
  -p 3000:3000 \
  --name whatsapp-backend \
  -e PORT=3000 \
  -e NODE_ENV=production \
  -e API_KEY=your-strong-api-key \
  -e DATABASE_URL="file:./dev.db" \
  -e BAILEYS_AUTH_DIR=/app/auth_state \
  -e MEDIA_UPLOAD_DIR=/app/uploads \
  whatsapp-freezers-backend
```

---

## 🚀 Deploying to Koyeb

Follow these steps to deploy on [Koyeb](https://www.koyeb.com):

1. **Push your repository to GitHub** (make sure `.env` and any auth folders are NOT committed).
2. Go to the **Koyeb Control Panel** and click **Create App** or **Create Service**.
3. Select **GitHub** as the deployment source and pick your repository.
4. Set the **Builder** to `Dockerfile`.
5. Under **Environment Variables**, configure:
   * `NODE_ENV`: `production`
   * `PORT`: `3000` (or leave default if Koyeb injects `PORT`)
   * `API_KEY`: `<Your-Strong-Secret-Key>`
   * `DATABASE_URL`: `file:./dev.db` (or your PostgreSQL connection string)
   * `BAILEYS_AUTH_DIR`: `./auth_state`
   * `MEDIA_UPLOAD_DIR`: `./uploads`
6. Under **Ports / Expose**:
   * Port: `3000` (or the configured `PORT`)
   * Protocol: `HTTP`
   * Public: Enabled (Path: `/`)
7. Under **Health Checks**:
   * Type: `HTTP`
   * Path: `/health`
8. Click **Deploy**.
9. Verify health status:
   ```bash
   curl https://<your-koyeb-app-name>.koyeb.app/health
   ```
   Expected response: `{"status":"ok"}`
10. Check WhatsApp connection status & scan QR:
    * Check status:
      ```bash
      curl -H "x-api-key: <your-api-key>" https://<your-koyeb-app-name>.koyeb.app/api/v1/connection/status
      ```
    * Open browser view to link WhatsApp:
      ```
      https://<your-koyeb-app-name>.koyeb.app/api/v1/connection/qr-view?apiKey=<your-api-key>
      ```

---

## ⚠️ WhatsApp Session Persistence Notice (Koyeb & Containers)

> [!IMPORTANT]
> **Stateless Container Lifecycles:**
> Standard Koyeb containers are stateless. Any session files written to local container directories (e.g. `./auth_state` or `./auth_info_baileys`) will be lost when a container is redeployed, rebuilt, or restarted onto a new instance.
>
> **Production Recommendation for Permanent Sessions:**
> 1. Attach a **Koyeb Persistent Volume** to `/app/auth_state` and set `BAILEYS_AUTH_DIR=/app/auth_state`.
> 2. Or, use a managed database (such as PostgreSQL) for persistent data and an external storage volume for auth state.

---

## API Contract Reference

All endpoints except `/health` and `/` require the `x-api-key: <API_KEY>` header (or `?apiKey=<API_KEY>` query param).

### Public Endpoints

| Method | Path | Description | Authentication |
|---|---|---|---|
| `GET` | `/health` or `/api/v1/health` | Health check probe | Public |
| `GET` | `/` or `/api/v1` | Service info | Public |

### WhatsApp Connection

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/connection/status` | Connection status (`connecting` \| `open` \| `close` \| `qr`) |
| `GET` | `/api/v1/connection/qr` | Base64 QR code PNG payload |
| `GET` | `/api/v1/connection/qr-view` | Browser webpage with auto-refreshing QR |
| `DELETE` | `/api/v1/connection/logout` | Disconnect and clear credentials |

### Chats & Messages

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/chats` | List all conversations |
| `GET` | `/api/v1/chats/:jid/messages` | Paginated message history (`?limit=50&offset=0`) |
| `POST` | `/api/v1/chats/:jid/messages` | Send message (text, image, audio, doc) |
| `POST` | `/api/v1/chats/:jid/read` | Explicitly mark messages as read |

### Media

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/media/:filename` | Stream stored media attachment |
| `GET` | `/api/v1/media` | List media files metadata |

---

## Real-Time WebSocket (Socket.io)

Flutter apps connect to the root URL using Socket.io client:

```dart
import 'package:socket_io_client/socket_io_client.dart' as IO;

final socket = IO.io('https://<your-koyeb-app>.koyeb.app', IO.OptionBuilder()
  .setTransports(['websocket', 'polling'])
  .setAuth({'apiKey': 'your-api-key'})
  .enableAutoConnect()
  .build());

socket.onConnect((_) => print('Connected to WS'));
socket.on('connection.status', (data) => print('Status: $data'));
socket.on('message.new', (data) => print('New message: $data'));
socket.on('message.status', (data) => print('Message status update: $data'));
```
