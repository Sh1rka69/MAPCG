# MAPCG Multiplayer Server

Central Socket.IO backend for MAPCG collaborative editing.

## Local run

```bash
npm install
npm start
```

Server starts on `http://localhost:3000`.

## Deploy

Use any Node.js host that supports long-running WebSocket processes: Railway, Render, Fly.io, or VPS.

Environment variables:

- `PORT` — provided by most hosts automatically.
- `MAX_ROOMS` — optional, default `200`.
- `MAX_PLAYERS_PER_ROOM` — optional, default `16`.

The server keeps room map states in memory only. When host/admin leaves, room is destroyed and no map is saved to disk.
