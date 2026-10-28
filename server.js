const http = require("http");
const WebSocket = require("ws");
const { randomUUID } = require("crypto");

const PORT = process.env.PORT || 10000;
const server = http.createServer((req, res) => {
    if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        return res.end("Ramp Rush 3D server is running!");
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Ramp Rush 3D WebSocket server");
});

const wss = new WebSocket.Server({ server, path: "/ws", maxPayload: 8192 });
const players = new Map();

function send(socket, message) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function broadcast(message, exceptSocket = null) {
    const data = JSON.stringify(message);
    for (const client of wss.clients) {
        if (client !== exceptSocket && client.readyState === WebSocket.OPEN) client.send(data);
    }
}

wss.on("connection", socket => {
    const id = randomUUID();
    socket.playerId = id;
    socket.isAlive = true;
    socket.lastCollisionAt = 0;
    socket.on("pong", () => { socket.isAlive = true; });

    socket.on("message", rawMessage => {
        let message;
        try { message = JSON.parse(rawMessage.toString()); }
        catch {
            send(socket, { type: "error", message: "Invalid JSON message." });
            return;
        }
        if (!message || typeof message.type !== "string") return;

        if (message.type === "join") {
            if (players.has(id)) return;
            const name = typeof message.name === "string" ? message.name.trim().slice(0, 20) : "";
            const player = {
                id,
                name: name || "Player",
                position: { x: 0, y: 2, z: 0 },
                quaternion: { x: 0, y: 0, z: 0, w: 1 },
                velocity: { x: 0, y: 0, z: 0 }
            };
            players.set(id, player);
            send(socket, { type: "welcome", id, players: [...players.values()].filter(other => other.id !== id) });
            broadcast({ type: "player_joined", player }, socket);
            console.log(`${player.name} joined (${id})`);
            return;
        }

        if (!players.has(id)) return;

        if (message.type === "player_state") {
            const p = message.position;
            const q = message.quaternion;
            if (!p || !q || ![p.x, p.y, p.z].every(Number.isFinite) || ![q.x, q.y, q.z, q.w].every(Number.isFinite)) return;
            const player = players.get(id);
            player.name = typeof message.name === "string" ? message.name.trim().slice(0, 20) || "Player" : player.name;
            player.position = { x: p.x, y: p.y, z: p.z };
            player.quaternion = { x: q.x, y: q.y, z: q.z, w: q.w };
            if (message.velocity && [message.velocity.x, message.velocity.y, message.velocity.z].every(Number.isFinite)) {
                player.velocity = {
                    x: Math.max(-150, Math.min(150, message.velocity.x)),
                    y: Math.max(-150, Math.min(150, message.velocity.y)),
                    z: Math.max(-150, Math.min(150, message.velocity.z))
                };
            }
            broadcast({ type: "player_state", player }, socket);
            return;
        }

        // Relay collision impulses to the target player's client. This lets the
        // target's authoritative car body receive the impact too.
        if (message.type === "collision") {
            const now = Date.now();
            if (now - socket.lastCollisionAt < 180) return;
            const targetId = String(message.targetId || "");
            const impulse = message.impulse;
            if (!players.has(targetId) || targetId === id || !impulse ||
                ![impulse.x, impulse.y, impulse.z].every(Number.isFinite)) return;
            const magnitude = Math.hypot(impulse.x, impulse.y, impulse.z);
            if (magnitude < 500 || magnitude > 18000) return;
            socket.lastCollisionAt = now;
            const targetSocket = [...wss.clients].find(client => client.playerId === targetId);
            if (targetSocket && targetSocket.readyState === WebSocket.OPEN) {
                send(targetSocket, {
                    type: "collision",
                    sourceId: id,
                    targetId,
                    impulse: { x: impulse.x, y: impulse.y, z: impulse.z }
                });
            }
        }
    });

    socket.on("close", () => {
        const player = players.get(id);
        if (player) {
            players.delete(id);
            broadcast({ type: "player_left", id });
            console.log(`${player.name} left (${id})`);
        }
    });
    socket.on("error", error => console.error("WebSocket error:", error.message));
});

const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
        if (!socket.isAlive) { socket.terminate(); continue; }
        socket.isAlive = false;
        socket.ping();
    }
}, 30000);
server.on("close", () => clearInterval(heartbeat));
server.listen(PORT, "0.0.0.0", () => console.log(`Ramp Rush 3D server listening on port ${PORT}`));
