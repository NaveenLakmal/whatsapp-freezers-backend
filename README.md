# WhatsApp Chat Backend

A NestJS backend that connects to WhatsApp via the [Baileys](https://github.com/WhiskeySockets/Baileys) multi-device library and exposes a REST API + Socket.io WebSocket interface for a Flutter mobile app to send and receive messages.

---

## 🔒 Privacy-First Design

This backend is built with a strict **no-presence** policy:

- ❌ `sendPresenceUpdate()` is **never** called — your "last seen" and "online" status are never updated
- ❌ `presenceSubscribe()` is **never** called
- ❌ Read receipts are **never** sent automatically — only via an explicit opt-in endpoint
- ✅ The Baileys socket is initialized with `markOnlineOnConnect: false`
- Every place in the codebase where these calls could appear has a `// PRESENCE: intentionally not called` comment

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | NestJS 11 (TypeScript) |
| WhatsApp | `@whiskeysockets/baileys` |
| Database | Prisma 5 + SQLite (dev) / PostgreSQL (prod) |
| WebSocket | `@nestjs/websockets` + Socket.io |
| Auth | Static API Key (`x-api-key` header) |
| Validation | `class-validator` + `class-transformer` |

---

## Project Structure

```
src/
├── config/            # Typed environment configuration
├── auth/              # API key guards (REST + WebSocket)
├── whatsapp/          # Core Baileys integration (WhatsAppService)
├── chats/             # REST endpoints for chats & messages
├── connection/        # REST endpoints for connection status & QR
├── events/            # Socket.io WebSocket gateway
├── media/             # Media file serving
└── prisma/            # Prisma service (global)
prisma/
└── schema.prisma      # Chat, Message, MediaFile models
```

---

## Setup

### 1. Install Dependencies

```bash
npm install
```

> The `postinstall` script automatically regenerates the Prisma client.

### 2. Configure Environment

Copy `.env` and update values:

```bash
cp .env .env.local   # optional — .env is already pre-filled with defaults
```

Edit `.env`:

```env
PORT=3000
API_KEY=change-me-to-a-strong-random-secret   # ← CHANGE THIS
DATABASE_URL="file:./dev.db"
AUTH_STATE_DIR=./auth_state
MEDIA_UPLOAD_DIR=./uploads
NODE_ENV=development
```

> ⚠️ **Security**: Set `API_KEY` to a long random string. All REST and WebSocket endpoints require this key.

### 3. Run Database Migration

```bash
npx prisma migrate dev --name init
```

This creates `dev.db` (SQLite) with the Chat, Message, and MediaFile tables.

### 4. Start the Server

```bash
# Development (hot reload)
npm run start:dev

# Production
npm run build
npm run start:prod
```

Server starts at: `http://localhost:3000/api/v1`

### 5. Scan the QR Code (First Run)

On first launch, open in your browser or `curl`:

```
GET http://localhost:3000/api/v1/connection/qr
x-api-key: your-api-key-here
```

The response contains a base64 PNG QR code. Display it, scan with WhatsApp on your phone, and the connection becomes permanent (credentials are saved in `./auth_state/`).

**Terminal shortcut** — poll until connected:

```bash
watch -n 2 'curl -s -H "x-api-key: your-api-key" http://localhost:3000/api/v1/connection/status | python3 -m json.tool'
```

---

## REST API Reference

All endpoints require the `x-api-key: <API_KEY>` header.

Base URL: `http://localhost:3000/api/v1`

### Connection

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/connection/status` | Current WhatsApp connection state |
| `GET` | `/connection/qr` | QR code as base64 PNG (when not authenticated) |
| `DELETE` | `/connection/logout` | Log out and clear session |

**Status response:**
```json
{ "status": "open", "updatedAt": "2024-01-01T10:00:00.000Z" }
```

**Status values:** `connecting` · `open` · `close` · `qr`

### Chats

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/chats` | List all conversations |
| `GET` | `/chats/:jid/messages?limit=50&offset=0` | Paginated message history |
| `POST` | `/chats/:jid/messages` | Send a message |
| `POST` | `/chats/:jid/read` | ⚠️ Mark chat as read (sends read receipts — opt-in only) |

**Send text message:**
```json
POST /api/v1/chats/1234567890@s.whatsapp.net/messages
{ "type": "text", "text": "Hello from the API!" }
```

**Send image by URL:**
```json
POST /api/v1/chats/1234567890@s.whatsapp.net/messages
{
  "type": "image",
  "mediaUrl": "https://example.com/photo.jpg",
  "text": "Optional caption"
}
```

**Send document:**
```json
{
  "type": "document",
  "mediaUrl": "https://example.com/report.pdf",
  "fileName": "report.pdf",
  "mimetype": "application/pdf"
}
```

### Media

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/media/:filename` | Stream a stored media file |
| `GET` | `/media?limit=50&offset=0` | List stored media metadata |

---

## WebSocket (Socket.io)

Connect from Flutter:

```dart
// Option A — auth object (recommended)
final socket = io('http://localhost:3000', OptionBuilder()
  .setAuth({'apiKey': 'your-api-key'})
  .build());

// Option B — query param
final socket = io('http://localhost:3000?apiKey=your-api-key', ...);
```

### Events Emitted by Server

| Event | Description | Payload |
|-------|-------------|---------|
| `message.new` | New incoming or outgoing message | `{ id, baileysId, chatId, remoteJid, fromMe, messageType, body, mediaUrl, mediaLocalPath, mimetype, fileName, timestamp, status }` |
| `connection.status` | WhatsApp connection state changed | `{ status: 'open'\|'close'\|'connecting'\|'qr', qr?, updatedAt }` |
| `message.status` | Delivery/read status update | `{ baileysId, status: 'DELIVERED'\|'READ'\|'FAILED' }` |

---

## Switching to PostgreSQL

1. Update `DATABASE_URL` in `.env`:
   ```
   DATABASE_URL="postgresql://user:password@localhost:5432/whatsapp_db"
   ```
2. Change `provider` in `prisma/schema.prisma`:
   ```
   provider = "postgresql"
   ```
3. Re-run migration:
   ```bash
   npx prisma migrate dev --name init
   ```

No other code changes needed.

---

## Useful Commands

```bash
npm run start:dev        # Start with hot reload
npm run build            # Compile TypeScript
npm run prisma:migrate   # Run pending migrations
npm run prisma:studio    # Open Prisma Studio (DB browser)
npx prisma migrate reset # Reset & reseed DB (dev only)
```

---

## Security Notes

- Never commit `.env` to version control (it's in `.gitignore`)
- Never commit `auth_state/` — it contains your WhatsApp session credentials
- Set `CORS origin` in `src/main.ts` to your Flutter app's specific origin in production
- Rotate `API_KEY` if you suspect it has been compromised — all sessions using it will be invalid
