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

// World snapshots can contain many arena objects, so allow larger messages
// than the earlier chat-only server while still enforcing a 1 MB limit.
const wss = new WebSocket.Server({ server, path: "/ws", maxPayload: 1024 * 1024 });
const players = new Map();
let partyLeaderId = null;
let worldState = null;
let worldRevision = 0;

function send(socket, message) {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function broadcast(message, exceptSocket = null) {
    const data = JSON.stringify(message);
    for (const client of wss.clients) {
        if (client !== exceptSocket && client.readyState === WebSocket.OPEN) client.send(data);
    }
}

function spawnForIndex(index) {
    // Four-column grid, with enough space between cars to avoid overlap.
    const column = index % 4;
    const row = Math.floor(index / 4);
    return {
        x: (column - 1.5) * 6,
        y: 1.5,
        z: 15 + row * 7
    };
}

function nextSpawnIndex() {
    const used = new Set([...players.values()].map(player => player.spawnIndex));
    let index = 0;
    while (used.has(index)) index++;
    return index;
}

function cleanPlayer(player) {
    return {
        id: player.id,
        name: player.name,
        color: player.color,
        position: player.position,
        quaternion: player.quaternion,
        velocity: player.velocity,
        spawn: player.spawn,
        spawnIndex: player.spawnIndex
    };
}

function validFiniteVector(value, keys) {
    return !!value && keys.every(key => Number.isFinite(value[key]));
}

function sanitizeWorld(input) {
    if (!Array.isArray(input) || input.length > 500) return null;
    const ids = new Set();
    const result = [];
    for (const item of input) {
        if (!item || !Number.isInteger(item.id) || item.id <= 0 || ids.has(item.id)) return null;
        if (item.type !== "box" && item.type !== "cylinder") return null;
        if (!validFiniteVector(item.position, ["x", "y", "z"]) ||
            !validFiniteVector(item.rotation, ["x", "y", "z", "w"]) ||
            !validFiniteVector(item.scale, ["x", "y", "z"])) return null;
        if ([item.position.x, item.position.y, item.position.z].some(v => Math.abs(v) > 2000)) return null;
        if ([item.scale.x, item.scale.y, item.scale.z].some(v => v < 0.1 || v > 50)) return null;
        const color = typeof item.color === "string" && /^#[0-9a-f]{6}$/i.test(item.color)
            ? item.color.toLowerCase() : "#333b49";
        const safe = {
            id: item.id,
            name: String(item.name || `${item.type} ${item.id}`).slice(0, 80),
            type: item.type,
            position: { x: item.position.x, y: item.position.y, z: item.position.z },
            rotation: { x: item.rotation.x, y: item.rotation.y, z: item.rotation.z, w: item.rotation.w },
            scale: { x: item.scale.x, y: item.scale.y, z: item.scale.z },
            color,
            collision: item.collision !== false,
            baseHalfExtents: null,
            baseRadius: null,
            baseHeight: null
        };
        if (item.type === "box") {
            const h = item.baseHalfExtents;
            if (!validFiniteVector(h, ["x", "y", "z"]) || [h.x, h.y, h.z].some(v => v <= 0 || v > 1000)) return null;
            safe.baseHalfExtents = { x: h.x, y: h.y, z: h.z };
        } else {
            if (!Number.isFinite(item.baseRadius) || !Number.isFinite(item.baseHeight) ||
                item.baseRadius <= 0 || item.baseRadius > 1000 || item.baseHeight <= 0 || item.baseHeight > 1000) return null;
            safe.baseRadius = item.baseRadius;
            safe.baseHeight = item.baseHeight;
        }
        ids.add(item.id);
        result.push(safe);
    }
    return result;
}

function respawnEveryoneOnGrid() {
    let index = 0;
    for (const player of players.values()) {
        player.spawnIndex = index;
        player.spawn = spawnForIndex(index);
        player.position = { ...player.spawn };
        player.quaternion = { x: 0, y: 0, z: 0, w: 1 };
        player.velocity = { x: 0, y: 0, z: 0 };
        index++;
    }
}

wss.on("connection", socket => {
    const id = randomUUID();
    socket.playerId = id;
    socket.isAlive = true;
    socket.lastCollisionAt = 0;
    socket.lastChatAt = 0;
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
            if (players.size === 0) {
                partyLeaderId = id;
                // A new empty lobby starts with the default arena.
                if (worldState === null) worldRevision = 0;
            }
            const name = typeof message.name === "string" ? message.name.trim().slice(0, 20) : "";
            const color = typeof message.color === "string" && /^#[0-9a-f]{6}$/i.test(message.color)
                ? message.color.toLowerCase() : "#e82e42";
            const spawnIndex = nextSpawnIndex();
            const spawn = spawnForIndex(spawnIndex);
            const player = {
                id,
                name: name || "Player",
                color,
                position: { ...spawn },
                quaternion: { x: 0, y: 0, z: 0, w: 1 },
                velocity: { x: 0, y: 0, z: 0 },
                spawn,
                spawnIndex
            };
            players.set(id, player);
            send(socket, {
                type: "welcome",
                id,
                leaderId: partyLeaderId,
                isLeader: partyLeaderId === id,
                player: cleanPlayer(player),
                spawn,
                players: [...players.values()].filter(other => other.id !== id).map(cleanPlayer),
                world: worldState,
                worldRevision
            });
            broadcast({ type: "player_joined", player: cleanPlayer(player), leaderId: partyLeaderId }, socket);
            console.log(`${player.name} joined (${id})${partyLeaderId === id ? " as party leader" : ""}`);
            return;
        }

        if (!players.has(id)) return;

        if (message.type === "player_state") {
            const p = message.position;
            const q = message.quaternion;
            if (!validFiniteVector(p, ["x", "y", "z"]) || !validFiniteVector(q, ["x", "y", "z", "w"])) return;
            const player = players.get(id);
            player.name = typeof message.name === "string" ? message.name.trim().slice(0, 20) || "Player" : player.name;
            if (typeof message.color === "string" && /^#[0-9a-f]{6}$/i.test(message.color)) player.color = message.color.toLowerCase();
            player.position = { x: p.x, y: p.y, z: p.z };
            player.quaternion = { x: q.x, y: q.y, z: q.z, w: q.w };
            if (message.velocity && validFiniteVector(message.velocity, ["x", "y", "z"])) {
                player.velocity = {
                    x: Math.max(-150, Math.min(150, message.velocity.x)),
                    y: Math.max(-150, Math.min(150, message.velocity.y)),
                    z: Math.max(-150, Math.min(150, message.velocity.z))
                };
            }
            broadcast({ type: "player_state", player: cleanPlayer(player) }, socket);
            return;
        }

        if (message.type === "chat_message") {
            const now = Date.now();
            if (now - socket.lastChatAt < 300) return;
            const text = typeof message.text === "string" ? message.text.trim().slice(0, 200) : "";
            if (!text) return;
            socket.lastChatAt = now;
            const player = players.get(id);
            broadcast({ type: "chat_message", id, name: player.name, text, timestamp: now });
            return;
        }

        if (message.type === "collision") {
            const now = Date.now();
            if (now - socket.lastCollisionAt < 180) return;
            const targetId = String(message.targetId || "");
            const impulse = message.impulse;
            if (!players.has(targetId) || targetId === id || !validFiniteVector(impulse, ["x", "y", "z"])) return;
            const magnitude = Math.hypot(impulse.x, impulse.y, impulse.z);
            if (magnitude < 500 || magnitude > 18000) return;
            socket.lastCollisionAt = now;
            const targetSocket = [...wss.clients].find(client => client.playerId === targetId);
            if (targetSocket) send(targetSocket, { type: "collision", sourceId: id, targetId, impulse });
            return;
        }

        if (message.type === "kick_player") {
            if (id !== partyLeaderId) {
                send(socket, { type: "error", message: "Only the party leader can kick players." });
                return;
            }
            const targetId = String(message.targetId || "");
            if (!targetId || targetId === partyLeaderId || !players.has(targetId)) {
                send(socket, { type: "error", message: "That player cannot be kicked." });
                return;
            }
            const targetSocket = [...wss.clients].find(client => client.playerId === targetId);
            if (targetSocket) {
                send(targetSocket, { type: "kicked", by: id });
                setTimeout(() => {
                    try { targetSocket.close(4001, "Kicked by party leader"); } catch (_) {}
                }, 50);
            }
            return;
        }

        if (message.type === "world_commit") {
            if (id !== partyLeaderId) {
                send(socket, { type: "error", message: "Only the party leader can publish arena changes." });
                return;
            }
            const sanitized = sanitizeWorld(message.world);
            if (!sanitized) {
                send(socket, { type: "error", message: "Arena update was invalid or too large." });
                return;
            }
            worldState = sanitized;
            worldRevision++;
            respawnEveryoneOnGrid();
            const currentPlayers = [...players.values()].map(cleanPlayer);
            broadcast({
                type: "world_committed",
                revision: worldRevision,
                leaderId: partyLeaderId,
                world: worldState,
                players: currentPlayers
            });
            console.log(`Arena revision ${worldRevision} published by ${players.get(id).name}; respawned ${players.size} player(s).`);
            return;
        }
    });

    socket.on("close", () => {
        const player = players.get(id);
        if (!player) return;
        players.delete(id);
        const wasLeader = partyLeaderId === id;
        if (wasLeader) {
            partyLeaderId = players.size ? players.keys().next().value : null;
        }
        // Keep the latest published arena when the lobby becomes empty. The
        // next leader inherits that committed world; uncommitted editor changes
        // never reach this state.
        broadcast({ type: "player_left", id, name: player.name, leaderId: partyLeaderId });
        if (wasLeader && partyLeaderId) {
            broadcast({ type: "leader_changed", leaderId: partyLeaderId });
            console.log(`${players.get(partyLeaderId)?.name || "A player"} is the new party leader.`);
        }
        console.log(`${player.name} left (${id})`);
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
