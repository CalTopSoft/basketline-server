import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { MongoClient } from 'mongodb';

const server = createServer();
const wss = new WebSocketServer({ server });

const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) {
    console.error('Error: La variable de entorno MONGODB_URI no está establecida');
    throw new Error('Se requiere la variable de entorno MONGODB_URI');
}
const client = new MongoClient(mongoUri);

// ============ OPTIMIZACIONES ============
const DEVICE_REFRESH_RATES = {
    60: 16.67,   // ~60fps
    90: 11.11,   // ~90fps
    120: 8.33    // ~120fps
};

const PHYSICS_QUALITY = {
    high: 1.0,    // PC/Tablet potente
    medium: 0.75, // Móvil medio
    low: 0.5      // Móvil gama baja
};

function createRoom() {
    return {
        players: [],
        scores: [0, 0],
        round: 1,
        attempts: [0, 0],
        totalAttempts: [0, 0],
        turn: 0,
        afk: [0, 0],
        ball: { x: 300, y: 405, vx: 0, vy: 0, thrown: false, rotation: 0 },
        timer: 8,
        lastTimerUpdate: Date.now(),
        hoopX: 300,
        hoopDirection: 1,
        bounceCount: 0,
        gameStarted: false,
        gameEnded: false,
        shotInProgress: false,
        lastBounceTime: 0,
        playerIcons: ['img/iconos/memes/meme1.png', 'img/iconos/memes/meme1.png'],
        chatMessages: [],
        lastUpdateTime: Date.now(),
        physicsQuality: 'medium',
        clientRefreshRates: [60, 60], // Detectado por cliente
        dirtyFlags: { ball: false, scores: false, timer: false, hoop: false }
    };
}

const rooms = {
    room1: createRoom(),
    room2: createRoom(),
    room3: createRoom()
};

let rankings = [];

const loadRankings = async () => {
    try {
        await client.connect();
        const db = client.db('basketline');
        const collection = db.collection('rankings');
        rankings = await collection.find({}).toArray();
        console.log('Rankings cargados desde MongoDB:', rankings.length);
    } catch (error) {
        console.error('Error al cargar rankings:', error);
        rankings = [];
    }
};

const saveRankings = async () => {
    try {
        await client.connect();
        const db = client.db('basketline');
        const collection = db.collection('rankings');
        await collection.deleteMany({});
        await collection.insertMany(rankings);
    } catch (error) {
        console.error('Error al guardar rankings:', error);
    }
};

loadRankings();

// ============ OPTIMIZACIÓN: Delta Time ============
let lastFrameTime = Date.now();

const updateGameState = () => {
    const now = Date.now();
    const deltaTime = (now - lastFrameTime) / 1000; // segundos
    lastFrameTime = now;

    for (const roomName in rooms) {
        const room = rooms[roomName];
        if (!room.gameStarted || room.gameEnded || room.players.length === 0) continue;

        // ============ TIMER UPDATE ============
        if (now - room.lastTimerUpdate >= 1000 && !room.shotInProgress) {
            room.timer -= 1;
            room.lastTimerUpdate = now;
            room.dirtyFlags.timer = true;
            
            if (room.timer <= 0) {
                passTurn(room, roomName);
                continue;
            }
        }

        // ============ HOOP MOVEMENT (optimizado) ============
        if (room.round >= 2) {
            const hoopSpeed = room.round === 3 ? 2.0 : 1.2;
            const movement = hoopSpeed * deltaTime * 300; // Basado en delta
            room.hoopX += room.hoopDirection * movement;
            
            if (room.hoopX >= 450 || room.hoopX <= 150) {
                room.hoopDirection *= -1;
            }
            room.dirtyFlags.hoop = true;
        }

        // ============ FÍSICA DE PELOTA (optimizada) ============
        if (room.ball.thrown) {
            const physicsMultiplier = PHYSICS_QUALITY[room.physicsQuality] || 1.0;
            
            // Integración de velocidad (frame-independent)
            room.ball.x += room.ball.vx * deltaTime * 300;
            room.ball.y += room.ball.vy * deltaTime * 300;
            
            // Gravedad reducida en móviles bajos
            room.ball.vy += 0.2 * physicsMultiplier;
            room.ball.vx *= 0.996;
            room.ball.vy *= 0.988;

            const totalSpeed = Math.sqrt(room.ball.vx * room.ball.vx + room.ball.vy * room.ball.vy);
            room.ball.rotation += totalSpeed * 0.05;

            // Colisiones con paredes
            if (room.ball.x - 30 <= 0 || room.ball.x + 30 >= 600) {
                room.ball.x = room.ball.x - 30 <= 0 ? 30 : 570;
                room.ball.vx *= -0.8;
                room.ball.vy += (Math.random() - 0.5) * 1;
            }

            // Colisiones con suelo
            if (room.ball.y + 30 >= 370 && room.bounceCount < 3) {
                if (now - room.lastBounceTime > 200) {
                    room.ball.y = 340;
                    room.bounceCount++;
                    
                    if (room.bounceCount < 3) {
                        room.ball.vy = -Math.abs(room.ball.vy) * 0.8;
                        if (Math.abs(room.ball.vx) > 0.1) {
                            room.ball.vx *= 0.9;
                        } else {
                            room.ball.vx += (Math.random() - 0.5) * 3;
                        }
                        room.ball.vx += (room.ball.x - 300) * 0.03;
                    } else {
                        room.ball.vy = 0;
                        room.ball.vx = 0;
                        room.ball.thrown = false;
                        finalizarTiro(room, roomName, false);
                    }
                    
                    room.lastBounceTime = now;
                    room.dirtyFlags.ball = true;
                    
                    // Enviar bounce solo al mínimo
                    if (room.bounceCount < 3) {
                        broadcastToRoom(room, { type: 'bounce' });
                    }
                }
            }

            // ============ DETECCIÓN DE ENCESTE ============
            const hoopLeft = room.hoopX - 37.5;
            const hoopRight = room.hoopX + 37.5;
            const hoopTop = 113;
            const hoopBottom = hoopTop + 20;
            const hoopCenterX = room.hoopX;
            const hoopCenterY = hoopTop + 10;

            const ballInHoopArea = (
                room.ball.x + 30 >= hoopLeft &&
                room.ball.x - 30 <= hoopRight &&
                room.ball.y + 30 >= (hoopTop - 2) &&
                room.ball.y - 30 <= hoopBottom &&
                room.ball.vy > 0
            );

            if (ballInHoopArea) {
                const centerZoneWidth = 50;
                const centerZoneHeight = 20;
                const isInCenter = (
                    Math.abs(room.ball.x - hoopCenterX) < centerZoneWidth / 2 &&
                    Math.abs(room.ball.y - hoopCenterY) < centerZoneHeight / 2
                );

                if (isInCenter) {
                    const previousScore = room.scores[room.turn];
                    room.scores[room.turn] += 2;
                    room.afk[room.turn] = 0;
                    room.dirtyFlags.scores = true;
                
                    // Enviar en un solo mensaje
                    broadcastToRoom(room, {
                        type: 'score',
                        player: room.turn,
                        newScore: room.scores[room.turn],
                        all: room.scores
                    });
                    
                    broadcastToRoom(room, { type: 'confetti', player: room.turn });
                    
                    finalizarTiro(room, roomName, true);
                } else {
                    const hitLeftCorner = Math.abs(room.ball.x - hoopLeft) < 15 && Math.abs(room.ball.y - hoopTop) < 15;
                    const hitRightCorner = Math.abs(room.ball.x - hoopRight) < 15 && Math.abs(room.ball.y - hoopTop) < 15;
                    
                    if (hitLeftCorner || hitRightCorner) {
                        const bounceDirection = hitLeftCorner ? -1 : 1;
                        room.ball.vx = bounceDirection * Math.abs(room.ball.vx) * 1.3 + bounceDirection * 3;
                        room.ball.vy *= -0.7;
                        if (room.ball.vy > -2) room.ball.vy = 2;
                        
                        broadcastToRoom(room, { type: 'hoopHit' });
                    }
                }
            }
            
            room.dirtyFlags.ball = true;
        }

        // ============ ENVÍO OPTIMIZADO (solo cambios) ============
        const updatePayload = { type: 'update' };
        
        if (room.dirtyFlags.ball) updatePayload.ball = room.ball;
        if (room.dirtyFlags.scores) updatePayload.scores = room.scores;
        if (room.dirtyFlags.timer) updatePayload.timer = room.timer;
        if (room.dirtyFlags.hoop) updatePayload.hoopX = room.hoopX;
        
        // Siempre enviar datos críticos
        if (room.dirtyFlags.ball || room.dirtyFlags.scores || room.dirtyFlags.timer || room.dirtyFlags.hoop) {
            updatePayload.turn = room.turn;
            updatePayload.round = room.round;
            updatePayload.attempts = room.attempts;
            
            broadcastToRoom(room, updatePayload);
            
            // Limpiar flags
            Object.keys(room.dirtyFlags).forEach(key => room.dirtyFlags[key] = false);
        }
    }
};

const broadcastToRoom = (room, data) => {
    const json = JSON.stringify(data);
    room.players.forEach(p => {
        if (p.ws && p.ws.readyState === 1) {
            p.ws.send(json);
        }
    });
};

const broadcastToAll = (data) => {
    const json = JSON.stringify(data);
    wss.clients.forEach(client => {
        if (client.readyState === 1) {
            client.send(json);
        }
    });
};

const finalizarTiro = (room, roomName, wasSuccessful) => {
    room.ball = { x: 300, y: 405, vx: 0, vy: 0, thrown: false, rotation: 0 };
    room.bounceCount = 0;
    room.shotInProgress = false;
    room.timer = 8;
    room.lastTimerUpdate = Date.now();
    room.afk[room.turn] = 0;
    room.attempts[room.turn]++;
    room.totalAttempts[room.turn]++;
    room.dirtyFlags.ball = true;
    passTurn(room, roomName);
};

const passTurn = async (room, roomName) => {
    if (room.timer <= 0) {
        room.afk[room.turn]++;
        if (room.afk[room.turn] >= 2) {
            const winner = (room.turn + 1) % 2;
            
            if (room.players[winner]) {
                broadcastToRoom(room, { 
                    type: 'end', 
                    winner: room.players[winner].name 
                });
                
                const winnerName = room.players[winner].name;
                const winnerScore = room.scores[winner];
                const existingEntry = rankings.find(e => e.name === winnerName);
                
                if (existingEntry && winnerScore > existingEntry.score) {
                    existingEntry.score = winnerScore;
                } else if (!existingEntry) {
                    rankings.push({ name: winnerName, score: winnerScore });
                }
                
                rankings.sort((a, b) => b.score - a.score);
                rankings = rankings.slice(0, 7);
                await saveRankings();
                
                broadcastToAll({ type: 'rankings', rankings });
            }
            
            resetRoom(room);
            broadcastRoomCounts();
            return;
        }
    }

    if (room.attempts[room.turn] < 5) {
        room.timer = 8;
        room.lastTimerUpdate = Date.now();
        broadcastToRoom(room, {
            type: 'turnUpdate',
            turn: room.turn,
            timer: room.timer,
            attempts: room.attempts
        });
        return;
    }

    const otherPlayer = (room.turn + 1) % 2;
    if (room.attempts[otherPlayer] >= 5) {
        if (room.round >= 3) {
            await endGame(room, roomName);
        } else {
            room.round++;
            room.attempts = [0, 0];
            room.afk = [0, 0];
            room.turn = 0;
            room.timer = 8;
            room.lastTimerUpdate = Date.now();
            
            broadcastToRoom(room, {
                type: 'newRound',
                round: room.round,
                turn: room.turn
            });
        }
    } else {
        room.turn = otherPlayer;
        room.timer = 8;
        room.lastTimerUpdate = Date.now();
        
        broadcastToRoom(room, {
            type: 'turnUpdate',
            turn: room.turn,
            timer: room.timer
        });
    }
};

const endGame = async (room, roomName) => {
    room.gameEnded = true;
    const winner = room.scores[0] > room.scores[1] ? 0 : room.scores[1] > room.scores[0] ? 1 : -1;
    
    const winnerMsg = winner === -1 ? 'tie' : (room.players[winner]?.name || 'Desconectado');
    broadcastToRoom(room, { type: 'end', winner: winnerMsg });
    
    // Actualizar rankings
    if (winner === -1) {
        [0, 1].forEach(i => {
            if (room.players[i]) {
                const entry = rankings.find(e => e.name === room.players[i].name);
                if (entry && room.scores[i] > entry.score) entry.score = room.scores[i];
                else if (!entry) rankings.push({ name: room.players[i].name, score: room.scores[i] });
            }
        });
    } else if (room.players[winner]) {
        const entry = rankings.find(e => e.name === room.players[winner].name);
        if (entry && room.scores[winner] > entry.score) entry.score = room.scores[winner];
        else if (!entry) rankings.push({ name: room.players[winner].name, score: room.scores[winner] });
    }
    
    rankings.sort((a, b) => b.score - a.score);
    rankings = rankings.slice(0, 7);
    await saveRankings();
    
    broadcastToAll({ type: 'rankings', rankings });
    resetRoom(room);
    broadcastRoomCounts();
};

const resetRoom = (room) => {
    room.players = [];
    room.scores = [0, 0];
    room.round = 1;
    room.attempts = [0, 0];
    room.totalAttempts = [0, 0];
    room.turn = 0;
    room.afk = [0, 0];
    room.ball = { x: 300, y: 405, vx: 0, vy: 0, thrown: false, rotation: 0 };
    room.timer = 0;
    room.lastTimerUpdate = Date.now();
    room.hoopX = 300;
    room.hoopDirection = 1;
    room.bounceCount = 0;
    room.gameStarted = false;
    room.gameEnded = false;
    room.shotInProgress = false;
    room.lastBounceTime = 0;
    room.playerIcons = ['img/iconos/memes/meme1.png', 'img/iconos/memes/meme1.png'];
    room.chatMessages = [];
    room.clientRefreshRates = [60, 60];
    room.physicsQuality = 'medium';
    Object.keys(room.dirtyFlags).forEach(key => room.dirtyFlags[key] = false);
};

const broadcastRoomCounts = () => {
    broadcastToAll({
        type: 'rooms',
        rooms: {
            room1: { players: rooms.room1.players.length },
            room2: { players: rooms.room2.players.length },
            room3: { players: rooms.room3.players.length }
        }
    });
};

// ============ WEBSOCKET HANDLERS ============
wss.on('connection', (ws) => {
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);

            // Detectar refresh rate del cliente
            if (data.type === 'deviceInfo') {
                const room = rooms[data.room];
                if (room && data.playerIndex !== undefined) {
                    const player = room.players[data.playerIndex];
                    if (player) {
                        room.clientRefreshRates[data.playerIndex] = data.refreshRate || 60;
                        // Ajustar calidad de física
                        const minRefresh = Math.min(...room.clientRefreshRates.filter(r => r > 0));
                        room.physicsQuality = minRefresh >= 90 ? 'high' : minRefresh >= 60 ? 'medium' : 'low';
                    }
                }
                return;
            }

            if (data.type === 'join') {
                const room = rooms[data.room];
                if (!room || room.players.length >= 2) {
                    ws.send(JSON.stringify({ type: 'full' }));
                    return;
                }

                const playerIndex = room.players.length;
                room.players.push({ ws, name: data.name, index: playerIndex, icon: data.icon });
                room.playerIcons[playerIndex] = data.icon || 'img/iconos/memes/meme1.png';
                room.clientRefreshRates[playerIndex] = data.refreshRate || 60;

                ws.send(JSON.stringify({
                    type: 'joined',
                    room: data.room,
                    players: room.players.map(p => p.name),
                    playerIndex: playerIndex,
                    playerIcons: room.playerIcons,
                    chatMessages: room.chatMessages
                }));

                if (room.players.length === 2) {
                    room.gameStarted = true;
                    room.gameEnded = false;
                    room.turn = 0;
                    room.attempts = [0, 0];
                    room.totalAttempts = [0, 0];
                    room.afk = [0, 0];
                    room.scores = [0, 0];
                    room.round = 1;
                    room.timer = 8;
                    room.lastTimerUpdate = Date.now();

                    broadcastToRoom(room, {
                        type: 'start',
                        turn: room.turn,
                        scores: room.scores,
                        round: room.round,
                        attempts: room.attempts,
                        players: room.players.map(p => p.name),
                        playerIcons: room.playerIcons
                    });
                }

                broadcastRoomCounts();
            }

            if (data.type === 'shot') {
                const room = rooms[data.room];
                if (!room || room.turn !== data.playerIndex || !room.gameStarted || 
                    room.gameEnded || room.ball.thrown || room.shotInProgress || 
                    room.attempts[room.turn] >= 5) {
                    return;
                }
                
                room.ball.vx = data.ballVX;
                room.ball.vy = data.ballVY;
                room.ball.thrown = true;
                room.ball.rotation = 0;
                room.bounceCount = 0;
                room.shotInProgress = true;
                room.lastBounceTime = 0;
                room.dirtyFlags.ball = true;
            }

            if (data.type === 'chat') {
                const room = rooms[data.room];
                if (!room) return;
                
                const msg = {
                    username: data.username,
                    message: data.message.slice(0, 100),
                    timestamp: Date.now()
                };
                
                room.chatMessages.push(msg);
                if (room.chatMessages.length > 50) room.chatMessages.shift();
                
                broadcastToRoom(room, {
                    type: 'chat',
                    username: msg.username,
                    message: msg.message
                });
            }

            if (data.type === 'getRankings') {
                ws.send(JSON.stringify({ type: 'rankings', rankings }));
            }

            if (data.type === 'getRooms') {
                broadcastRoomCounts();
            }
        } catch (e) {
            console.error('Error parsing message:', e);
        }
    });

    ws.on('close', () => {
        for (const roomName in rooms) {
            const room = rooms[roomName];
            const index = room.players.findIndex(p => p.ws === ws);
            
            if (index !== -1) {
                room.players.splice(index, 1);
                
                if (room.gameStarted && room.players.length < 2) {
                    if (room.players.length === 1) {
                        broadcastToRoom(room, { type: 'end', winner: 'Desconectado' });
                    }
                    resetRoom(room);
                }
                
                broadcastRoomCounts();
            }
        }
    });
});

// ============ GAME LOOP OPTIMIZADO ============
setInterval(updateGameState, 16); // 60fps base

server.listen(process.env.PORT || 8080, () => {
    console.log(`🎮 Basketline server running on port ${process.env.PORT || 8080}`);
    console.log('📊 Physics optimization enabled for mobile devices');
});
