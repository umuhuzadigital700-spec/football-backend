const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const axios = require('axios');
const csv = require('csvtojson');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// --- GAME STATE ---
let gameState = {
    refereeId: null,      // The socket.id of the current referee
    lobbyOpen: false,     // Waiting room status
    allViewers: [],       // Array of all connected sockets {id, name, type}
    availableCards: [],    // The ~100+ cards from Google Sheet
    team1: [],            // The cards picked for Team 1
    team2: [],            // The cards picked for Team 2
    currentTurn: "team1",  // Who is currently picking: "team1" or "team2"
    teamSize: 11,         // Match type (e.g., 5v5)
    gameStarted: false,   // If the draft board is active
    secretRefToken: "eric_ref_2024" // Your secret token to claim authority
};

// SNAKE DRAFT TURN LOGIC (T1, T2, T2, T1...)
const getNextTurn = (current, pickedCount) => {
    // Basic snake: T1, T2, T2, T1, T1, T2, T2, T1...
    const turnBlock = Math.floor(pickedCount / 2);
    return turnBlock % 2 === 0 ? "team1" : "team2"; 
};

io.on('connection', (socket) => {
    console.log('New User Connected:', socket.id);

    // Give new user the current complete state of the game (Real-Time Synch)
    socket.emit('gameStateUpdate', gameState);

    // 1. ANONYMOUS JOIN (Waiting Room/Spectator)
    socket.on('joinWaitingRoom', (data) => {
        if (!gameState.lobbyOpen && !data.isRefereeClaim) {
            socket.emit('error', 'The lobby is currently closed by the Referee.');
            return;
        }
        
        const isAlreadyRef = gameState.refereeId === socket.id;
        gameState.allViewers.push({ 
            id: socket.id, 
            name: data.name || "Spectator", 
            type: isAlreadyRef ? "referee" : "spectator" 
        });
        io.emit('gameStateUpdate', gameState);
    });

    // 2. REFEREE AUTHORITY: CLAIM CONTROL
    socket.on('claimReferee', (token) => {
        if (token === gameState.secretRefToken) {
            console.log("Referee Authority Claimed by:", socket.id);
            gameState.refereeId = socket.id;
            
            // Mark the referee in the viewer list
            gameState.allViewers = gameState.allViewers.map(v => 
                v.id === socket.id ? { ...v, type: "referee" } : v
            );
            
            socket.emit('refereeConfirmed', true);
            io.emit('gameStateUpdate', gameState);
        } else {
            socket.emit('error', 'Invalid Referee Token.');
        }
    });

    // 3. REFEREE AUTHORITY: TOGGLE LOBBY (Open/Close)
    socket.on('refToggleLobby', () => {
        if (socket.id !== gameState.refereeId) return;
        gameState.lobbyOpen = !gameState.lobbyOpen;
        io.emit('gameStateUpdate', gameState);
    });

    // 4. REFEREE AUTHORITY: SET MATCH TYPE AND START
    socket.on('refStartDraft', async (config) => {
        if (socket.id !== gameState.refereeId) return;
        
        try {
            const response = await axios.get(process.env.SHEET_URL);
            const allCards = await csv().fromString(response.data);
            
            // Reset Game State for New Match
            gameState.availableCards = allCards; // The full ~100 cards
            gameState.team1 = [];
            gameState.team2 = [];
            gameState.teamSize = config.teamSize || 11;
            gameState.currentTurn = "team1";
            gameState.gameStarted = true;
            
            io.emit('gameStateUpdate', gameState);
            
        } catch (error) {
            console.error("Error starting draft:", error);
            socket.emit('error', 'Failed to load players from Google Sheet.');
        }
    });

    // 5. REFEREE AUTHORITY: PICK A CARD (For either team)
    socket.on('refPickCard', (data) => {
        // Only the referee can trigger this action
        if (socket.id !== gameState.refereeId) return;
        if (!gameState.gameStarted) return;
        
        const cardId = data.cardId;
        const targetTeam = data.targetTeam; // "team1" or "team2"

        if (gameState.currentTurn !== targetTeam) {
            socket.emit('error', `It is currently ${gameState.currentTurn}'s turn.`);
            return;
        }

        const card = gameState.availableCards.find(c => c.id === cardId);
        if (!card) return;

        const currentTeamList = gameState[targetTeam];

        // --- POSITION RULE: Max 1 GK per team ---
        if (card.pos === 'GK' || card.pos === 'Goal Keeper') {
            const hasGK = currentTeamList.some(p => p.pos === 'GK' || p.pos === 'Goal Keeper');
            if (hasGK) {
                socket.emit('error', `${targetTeam} already has a Goal Keeper.`);
                return;
            }
        }

        // --- SIZE RULE: Can't exceed teamSize ---
        if (currentTeamList.length >= gameState.teamSize) {
            socket.emit('error', `${targetTeam} is already full (${gameState.teamSize} players).`);
            return;
        }

        // Execute the Pick
        gameState[targetTeam].push(card);
        gameState.availableCards = gameState.availableCards.filter(c => c.id !== cardId);

        // Update turn using snake logic based on total picks
        const totalPicks = gameState.team1.length + gameState.team2.length;
        gameState.currentTurn = getNextTurn(gameState.currentTurn, totalPicks);

        // Check if draft is complete
        if (gameState.team1.length === gameState.teamSize && gameState.team2.length === gameState.teamSize) {
            gameState.currentTurn = "complete";
        }

        io.emit('gameStateUpdate', gameState);
    });

    // 6. REFEREE AUTHORITY: RESET FROM ZERO
    socket.on('refResetGame', () => {
        if (socket.id !== gameState.refereeId) return;
        
        // Wipe everything back to the pure lobby state
        gameState.availableCards = [];
        gameState.team1 = [];
        gameState.team2 = [];
        gameState.currentTurn = "team1";
        gameState.gameStarted = false;
        
        console.log("Game Reset by Referee.");
        io.emit('gameStateUpdate', gameState);
    });

    socket.on('disconnect', () => {
        // If referee disconnects, they are removed from viewers, 
        // but gameState.refereeId remains so they can reclaim.
        gameState.allViewers = gameState.allViewers.filter(v => v.id !== socket.id);
        
        // You may optionally add logic here to inform viewers the ref left.
        io.emit('gameStateUpdate', gameState);
    });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`Arena Backend Running on Port ${PORT}`);
});
