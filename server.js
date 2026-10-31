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
let worldAccessOpenToAll = false;
const activeVehicleImpacts = new Map();
const recentImpactPairs = new Map();

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
        vehicleType: ["plane", "motorcycle"].includes(player.vehicleType) ? player.vehicleType : "car",
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


function mayPublishWorld(playerId) {
    return playerId === partyLeaderId || worldAccessOpenToAll;
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
    socket.lastImpactRequestAt = 0;
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
                vehicleType: "car",
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
                worldRevision,
                worldEditAccessOpen: worldAccessOpenToAll
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
            player.vehicleType = ["plane", "motorcycle"].includes(message.vehicleType) ? message.vehicleType : "car";
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

        if (message.type === "vehicle_impact_request") {
            const now = Date.now();
            if (now - socket.lastImpactRequestAt < 220) return;
            const otherPlayerId = String(message.otherPlayerId || "");
            const vector = message.impactVector;
            if (!players.has(otherPlayerId) || otherPlayerId === id || !validFiniteVector(vector, ["x", "y", "z"])) return;
            const force = Math.hypot(vector.x, vector.y, vector.z);
            const pairKey = [id, otherPlayerId].sort().join("|");
            if (force < 500 || force > 18000 || activeVehicleImpacts.has(otherPlayerId) || recentImpactPairs.has(pairKey)) return;
            const recipient = [...wss.clients].find(client => client.playerId === otherPlayerId && client.readyState === WebSocket.OPEN);
            if (!recipient) return;

            socket.lastImpactRequestAt = now;
            const pairExpiry = setTimeout(() => recentImpactPairs.delete(pairKey), 1300);
            recentImpactPairs.set(pairKey, pairExpiry);
            broadcast({ type: "vehicle_impact_started", vehicleId: otherPlayerId, causedBy: id });

            const recovery = setTimeout(() => {
                activeVehicleImpacts.delete(otherPlayerId);
                const affected = players.get(otherPlayerId);
                if (!affected) return;
                affected.position = { ...affected.spawn };
                affected.quaternion = { x: 0, y: 0, z: 0, w: 1 };
                affected.velocity = { x: 0, y: 0, z: 0 };
                broadcast({ type: "vehicle_impact_finished", vehicleId: otherPlayerId, spawn: affected.spawn });
                broadcast({ type: "player_state", player: cleanPlayer(affected) });
            }, 1000);
            activeVehicleImpacts.set(otherPlayerId, recovery);
            return;
        }

        // Kicking is a server-authoritative transaction. A request is accepted only
        // from the current leader, targets are resolved against the live socket map,
        // and the target is removed from lobby state before any response is broadcast.
        if (message.type === "kick_request") {
            const requestId = typeof message.requestId === "string" ? message.requestId.slice(0, 100) : "";
            const targetId = typeof message.targetId === "string" ? message.targetId : "";
            const reply = (success, details = {}) => send(socket, {
                type: "kick_response", requestId, targetId, success, ...details
            });

            if (id !== partyLeaderId || !players.has(id)) {
                reply(false, { message: "Only the current party leader can remove players." });
                return;
            }
            if (!targetId || targetId === id) {
                reply(false, { message: "Choose another player in the lobby." });
                return;
            }
            const targetPlayer = players.get(targetId);
            if (!targetPlayer) {
                reply(false, { message: "That player is no longer in the lobby. Refresh the player list and try again." });
                return;
            }
            const targetSocket = [...wss.clients].find(client =>
                String(client.playerId || "") === targetId && client.readyState === WebSocket.OPEN
            );
            if (!targetSocket) {
                players.delete(targetId);
                broadcast({ type: "player_left", id: targetId, name: targetPlayer.name, leaderId: partyLeaderId });
                reply(false, { message: "The player connection was already closed; their stale lobby entry was removed." });
                return;
            }

            // Tell the target first, then remove the authoritative lobby entry and
            // broadcast the departure to every remaining client (including leader).
            send(targetSocket, {
                type: "removed_from_lobby",
                reason: "The party leader removed you from the lobby."
            });
            players.delete(targetId);
            broadcast({ type: "player_left", id: targetId, name: targetPlayer.name, leaderId: partyLeaderId });
            reply(true, { name: targetPlayer.name });

            // The dedicated close code handles the case where the target misses the
            // removal event. Their later close event is harmless because state is gone.
            setTimeout(() => {
                try {
                    if (targetSocket.readyState === WebSocket.OPEN || targetSocket.readyState === WebSocket.CONNECTING) {
                        targetSocket.close(4001, "Removed from lobby by party leader");
                    }
                } catch (_) {}
            }, 100);
            console.log(`${targetPlayer.name} was removed from the lobby by ${players.get(id)?.name || "party leader"} (${targetId})`);
            return;
        }

        if (message.type === "world_access_change") {
            if (id !== partyLeaderId) {
                send(socket, { type: "error", message: "Only the party leader can change world edit access." });
                return;
            }
            const nextValue = message.openToAll === true;
            if (nextValue === worldAccessOpenToAll) return;
            worldAccessOpenToAll = nextValue;
            const leader = players.get(id);
            broadcast({
                type: "world_access_state",
                openToAll: worldAccessOpenToAll,
                actorId: id,
                actorName: leader ? leader.name : "The party leader",
                leaderId: partyLeaderId
            });
            console.log(`World editing access is now ${worldAccessOpenToAll ? "open to all players" : "leader only"} (${leader ? leader.name : id}).`);
            return;
        }

        if (message.type === "world_commit") {
            if (!mayPublishWorld(id)) {
                send(socket, { type: "error", message: "World editing is currently limited to the party leader." });
                return;
            }
            const sanitized = sanitizeWorld(message.world);
            if (!sanitized) {
                send(socket, { type: "error", message: "Arena update rejected: invalid object data, duplicate IDs, or more than 500 objects. No changes were published." });
                console.warn(`Rejected arena publish from ${players.get(id)?.name || id}.`);
                return;
            }
            // Store a server-owned snapshot and broadcast that exact snapshot to all
            // clients, including the leader. Clients replace their local arena from it.
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
            send(socket, { type: "world_commit_ack", revision: worldRevision, objectCount: worldState.length });
            console.log(`Arena revision ${worldRevision} published by ${players.get(id).name} (${worldState.length} objects); respawned ${players.size} player(s).`);
            return;
        }
    });

    socket.on("close", () => {
        const player = players.get(id);
        if (!player) return;
        players.delete(id);
        const recoveryTimer = activeVehicleImpacts.get(id);
        if (recoveryTimer) clearTimeout(recoveryTimer);
        activeVehicleImpacts.delete(id);
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
        if (players.size === 0) worldAccessOpenToAll = false;
        for (const [pair, timer] of recentImpactPairs) {
            if (pair.split("|").includes(id)) {
                clearTimeout(timer);
                recentImpactPairs.delete(pair);
            }
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
