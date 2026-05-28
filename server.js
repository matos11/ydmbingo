const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ['websocket', 'polling']
});

// Game state storage
let games = new Map();             // gameId -> { active, drawnNumbers, prizePool, winPatterns }
let players = new Map();           // socketId -> { id, name, phone, cards: [][], room }
let lobbyTimer = null;
let lobbyTimeLeft = 30;            // 30 seconds countdown
const MIN_PLAYERS_TO_START = 2;

// --- BINGO CORE ENGINE HELPERS ---

// Generates a valid 5x5 Bingo matrix adhering to B-I-N-G-O column rules
function generateBingoCard() {
    const card = [];
    const ranges = [
        { min: 1, max: 15 },   // B
        { min: 16, max: 30 },  // I
        { min: 31, max: 45 },  // N
        { min: 46, max: 60 },  // G
        { min: 61, max: 75 }   // O
    ];
    
    // Create columns
    const columns = ranges.map(range => {
        const pool = Array.from({ length: range.max - range.min + 1 }, (_, i) => range.min + i);
        const col = [];
        for (let i = 0; i < 5; i++) {
            const idx = Math.floor(Math.random() * pool.length);
            col.push(pool.splice(idx, 1)[0]);
        }
        return col.sort((a, b) => a - b);
    });

    // Transpose columns into 5 rows
    for (let r = 0; r < 5; r++) {
        const row = [];
        for (let c = 0; c < 5; c++) {
            if (r === 2 && c === 2) {
                row.push(0); // FREE SPACE marker
            } else {
                row.push(columns[c][r]);
            }
        }
        card.push(row);
    }
    return card;
}

function generateNumber(drawnNumbers) {
    let available = Array.from({ length: 75 }, (_, i) => i + 1).filter(n => !drawnNumbers.includes(n));
    if (available.length === 0) return null;
    return available[Math.floor(Math.random() * available.length)];
}

// Strictly verifies if a card actually won based on server drawn numbers
function verifyBingoClaim(card, drawnNumbers, targetIndices) {
    // Treat 0 as automatically hit (FREE SPACE)
    const hits = card.map(row => row.map(num => num === 0 || drawnNumbers.includes(num)));
    
    // Flatten the 5x5 matrix to a 1D array of 25 items matching front-end map styles
    const flatHits = hits.flat();
    
    // Check if every index specified in the pattern has been drawn
    return targetIndices.every(index => flatHits[index] === true);
}

// --- SYSTEM LOGIC CONTROLLERS ---

function manageLobbyTimer() {
    const activeCount = players.size;

    if (activeCount >= MIN_PLAYERS_TO_START) {
        if (!lobbyTimer) {
            lobbyTimeLeft = 30; // Reset
            io.emit('lobby-timer-updated', { timeLeft: lobbyTimeLeft, status: "waiting" });
            
            lobbyTimer = setInterval(() => {
                lobbyTimeLeft--;
                io.emit('lobby-timer-updated', { timeLeft: lobbyTimeLeft, status: "counting" });

                if (lobbyTimeLeft <= 0) {
                    clearInterval(lobbyTimer);
                    lobbyTimer = null;
                    autoStartNewGame();
                }
            }, 1000);
        }
    } else {
        if (lobbyTimer) {
            clearInterval(lobbyTimer);
            lobbyTimer = null;
            io.emit('lobby-timer-updated', { timeLeft: null, status: "stopped", message: "Need more players" });
        }
    }
}

function autoStartNewGame() {
    const gameId = "GAME_" + Date.now();
    const game = {
        gameId: gameId,
        prizePool: (players.size * 100).toString(), // Dynamic calculations based on player entries
        drawnNumbers: [],
        active: true,
        startedAt: Date.now()
    };

    games.set(gameId, game);
    io.emit('game-started', { gameId: gameId, prizePool: game.prizePool });

    // Internal Game loop clock execution 
    const interval = setInterval(() => {
        const currentGame = games.get(gameId);
        if (!currentGame || !currentGame.active) {
            clearInterval(interval);
            return;
        }

        const newNumber = generateNumber(currentGame.drawnNumbers);
        if (newNumber) {
            currentGame.drawnNumbers.push(newNumber);
            io.emit('number-drawn', { gameId: gameId, number: newNumber });

            if (currentGame.drawnNumbers.length >= 75) {
                clearInterval(interval);
                currentGame.active = false;
                io.emit('game-full-ended', { gameId: gameId });
            }
        }
    }, 4000); // 4 Seconds draw loop smooth delivery
}

// --- SOCKET CONNECTION GATEWAY ---

io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);

    // Cartela generation requested by front-end client
    socket.on('request-cartelas', (data) => {
        const count = data.count || 1;
        const generatedCards = [];
        for(let i=0; i < count; i++) {
            generatedCards.push(generateBingoCard());
        }
        // Reply exclusively to the requester
        socket.emit('receive-cartelas', { cards: generatedCards });
    });

    socket.on('join-game', (data) => {
        players.set(socket.id, {
            id: socket.id,
            name: data.name,
            phone: data.phone,
            cards: data.cards || [] // Store generated cards safely inside map reference
        });

        io.emit('player-count', players.size);
        manageLobbyTimer();

        // Catch-up sync for mid-game joins or page reloads
        for (let [gameId, game] of games.entries()) {
            if (game.active) {
                socket.emit('game-started', { gameId: gameId, prizePool: game.prizePool });
                socket.emit('game-state', { drawnNumbers: game.drawnNumbers, prizePool: game.prizePool });
                break;
            }
        }
    });

    socket.on('claim-bingo', (data) => {
        const { gameId, patternIndices, cardIndex } = data;
        const game = games.get(gameId);
        const player = players.get(socket.id);

        if (!game || !game.active) {
            socket.emit('claim-rejected', { message: 'Game is inactive or already closed.' });
            return;
        }
        if (!player || !player.cards[cardIndex]) {
            socket.emit('claim-rejected', { message: 'Invalid player profile context or Card data reference missing.' });
            return;
        }

        // BACKEND CRITICAL VERIFICATION CHALLENGE
        const targetedCard = player.cards[cardIndex];
        const isLegitWin = verifyBingoClaim(targetedCard, game.drawnNumbers, patternIndices);

        if (isLegitWin) {
            game.active = false;
            game.winner = {
                name: player.name,
                phone: player.phone,
                cardIndex: cardIndex,
                prize: game.prizePool,
                claimedAt: Date.now()
            };

            io.emit('winner-declared', game.winner);

            setTimeout(() => {
                games.delete(gameId);
                manageLobbyTimer(); // Restart loop checks for upcoming games
            }, 15000);
        } else {
            // Anti-cheat flag logging system fallback
            console.warn(`Suspicious Claim Attempt dropped from socket instance: ${socket.id}`);
            socket.emit('claim-rejected', { message: 'Invalid claim! Numbers missing from selection history.' });
        }
    });

    socket.on('disconnect', () => {
        players.delete(socket.id);
        io.emit('player-count', players.size);
        manageLobbyTimer();
        console.log('Client disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Bingo Server processing on port ${PORT}`));