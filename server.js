const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    transports: ['websocket', 'polling']
});

// Game state
let games = new Map(); // gameId -> { players, drawnNumbers, active, prizePool, interval }
let players = new Map(); // socketId -> player data
let gameNumberIntervals = new Map(); // gameId -> interval

// Helper: Generate random number not already drawn
function generateNumber(drawnNumbers) {
    let available = [];
    for (let i = 1; i <= 75; i++) {
        if (!drawnNumbers.includes(i)) available.push(i);
    }
    if (available.length === 0) return null;
    return available[Math.floor(Math.random() * available.length)];
}

// Check for winner (simplified - server would need card data)
// For production, you'd store player cards server-side

io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);
    
    socket.on('join-game', (data) => {
        players.set(socket.id, {
            id: socket.id,
            name: data.name,
            phone: data.phone,
            cards: data.cards || []
        });
        
        // Broadcast updated player count
        io.emit('player-count', players.size);
        
        // If there's an active game, send current state
        for (let [gameId, game] of games.entries()) {
            if (game.active) {
                socket.emit('game-started', {
                    gameId: gameId,
                    prizePool: game.prizePool
                });
                socket.emit('game-state', {
                    drawnNumbers: game.drawnNumbers,
                    prizePool: game.prizePool
                });
                break;
            }
        }
    });
    
    socket.on('host-start-game', (data) => {
        const { gameId, prizePool } = data;
        
        if (games.has(gameId)) return;
        
        const game = {
            gameId: gameId,
            prizePool: prizePool || "5000",
            drawnNumbers: [],
            active: true,
            players: [],
            startedAt: Date.now()
        };
        
        games.set(gameId, game);
        
        // Start automatic number generation for this game
        const interval = setInterval(() => {
            const currentGame = games.get(gameId);
            if (!currentGame || !currentGame.active) {
                clearInterval(interval);
                gameNumberIntervals.delete(gameId);
                return;
            }
            
            const newNumber = generateNumber(currentGame.drawnNumbers);
            if (newNumber) {
                currentGame.drawnNumbers.push(newNumber);
                io.emit('number-drawn', { gameId: gameId, number: newNumber });
                
                // Check if game should end (all numbers drawn)
                if (currentGame.drawnNumbers.length >= 75) {
                    clearInterval(interval);
                    gameNumberIntervals.delete(gameId);
                    currentGame.active = false;
                    io.emit('game-full-ended', { gameId: gameId });
                }
            } else {
                // No numbers left
                clearInterval(interval);
                gameNumberIntervals.delete(gameId);
                currentGame.active = false;
                io.emit('game-full-ended', { gameId: gameId });
            }
        }, 4000);
        
        gameNumberIntervals.set(gameId, interval);
        
        // Broadcast game started to all clients
        io.emit('game-started', { gameId: gameId, prizePool: prizePool });
    });
    
    socket.on('claim-bingo', (data) => {
        const { gameId, user, pattern, cardNum, prize, cardFull, patternIndices } = data;
        
        const game = games.get(gameId);
        if (!game || !game.active) {
            socket.emit('error', { message: 'Game is no longer active' });
            return;
        }
        
        // Mark game as inactive (winner found)
        game.active = false;
        game.winner = {
            name: user.name,
            phone: user.phone,
            pattern: pattern,
            cardNum: cardNum,
            prize: prize,
            cardFull: cardFull,
            patternIndices: patternIndices,
            claimedAt: Date.now()
        };
        
        // Stop number generation
        const interval = gameNumberIntervals.get(gameId);
        if (interval) {
            clearInterval(interval);
            gameNumberIntervals.delete(gameId);
        }
        
        // Broadcast winner to all clients
        io.emit('winner-declared', game.winner);
        
        // Schedule game cleanup after 10 seconds
        setTimeout(() => {
            games.delete(gameId);
            console.log(`Game ${gameId} cleaned up`);
        }, 10000);
    });
    
    socket.on('number-drawn', (data) => {
        // For manual number drawing (if needed)
        const { gameId, number } = data;
        const game = games.get(gameId);
        if (game && game.active && !game.drawnNumbers.includes(number)) {
            game.drawnNumbers.push(number);
            io.emit('number-drawn', { gameId: gameId, number: number });
        }
    });
    
    socket.on('request-game-state', () => {
        for (let [gameId, game] of games.entries()) {
            if (game.active) {
                socket.emit('game-state', {
                    drawnNumbers: game.drawnNumbers,
                    prizePool: game.prizePool
                });
                break;
            }
        }
    });
    
    socket.on('disconnect', () => {
        players.delete(socket.id);
        io.emit('player-count', players.size);
        console.log('Client disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Bingo Server running on port ${PORT}`);
});