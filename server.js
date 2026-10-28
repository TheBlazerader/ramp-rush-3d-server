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

const wss = new WebSocket.Server({
    server,
    path: "/ws",
    maxPayload: 8192
});

const players = new Map();

function send(socket, message) {
    if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
    }
}

function broadcast(message, exceptSocket = null) {
    const data = JSON.stringify(message);

    for (const client of wss.clients) {
        if (
            client !== exceptSocket &&
            client.readyState === WebSocket.OPEN
        ) {
            client.send(data);
        }
    }
}

wss.on("connection", (socket) => {
    const id = randomUUID();

    socket.playerId = id;
    socket.isAlive = true;

    socket.on("pong", () => {
        socket.isAlive = true;
    });

    socket.on("message", (rawMessage) => {
        let message;

        try {
            message = JSON.parse(rawMessage.toString());
        } catch {
            send(socket, {
                type: "error",
                message: "Invalid JSON message."
            });
            return;
        }

        if (!message || typeof message.type !== "string") {
            return;
        }

        // Player joins the game.
        if (message.type === "join") {
            if (players.has(id)) return;

            const name =
                typeof message.name === "string"
                    ? message.name.trim().slice(0, 20)
                    : "";

            const player = {
                id,
                name: name || "Player",
                position: { x: 0, y: 2, z: 0 },
                quaternion: { x: 0, y: 0, z: 0, w: 1 }
            };

            players.set(id, player);

            // Tell the new player their ID and who is already here.
            send(socket, {
                type: "welcome",
                id,
                players: [...players.values()]
                    .filter(other => other.id !== id)
            });

            // Tell existing players about the newcomer.
            broadcast({
                type: "player_joined",
                player
            }, socket);

            console.log(`${player.name} joined (${id})`);
            return;
        }

        // Ignore movement messages until the player has joined.
        if (message.type !== "player_state" || !players.has(id)) {
            return;
        }

        const player = players.get(id);

        // Accept only valid, finite position and rotation values.
        const p = message.position;
        const q = message.quaternion;

        if (
            !p || !q ||
            ![p.x, p.y, p.z].every(Number.isFinite) ||
            ![q.x, q.y, q.z, q.w].every(Number.isFinite)
        ) {
            return;
        }

        player.name =
            typeof message.name === "string"
                ? message.name.trim().slice(0, 20) || "Player"
                : player.name;

        player.position = { x: p.x, y: p.y, z: p.z };
        player.quaternion = {
            x: q.x,
            y: q.y,
            z: q.z,
            w: q.w
        };

        // Relay this player's latest car state to everyone else.
        broadcast({
            type: "player_state",
            player
        }, socket);
    });

    socket.on("close", () => {
        const player = players.get(id);

        if (player) {
            players.delete(id);

            broadcast({
                type: "player_left",
                id
            });

            console.log(`${player.name} left (${id})`);
        }
    });

    socket.on("error", (error) => {
        console.error("WebSocket error:", error.message);
    });
});

// Remove connections that stop responding.
const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
        if (!socket.isAlive) {
            socket.terminate();
            continue;
        }

        socket.isAlive = false;
        socket.ping();
    }
}, 30000);

server.listen(PORT, "0.0.0.0", () => {
    console.log(`Ramp Rush 3D server listening on port ${PORT}`);
});

server.on("close", () => clearInterval(heartbeat));
