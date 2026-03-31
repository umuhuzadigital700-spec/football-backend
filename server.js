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

let gameState = {
    refereeId: null,
    lobbyOpen: false,
    allViewers: [], // {id, name, role: 'spectator'|'team1'|'team2'}
    availableCards: [],
    team1Picks: [],
    team2Picks: [],
    currentTurn: "team1",
    teamSize: 5,
    gameStarted: false,
    secretRefToken: "eric_ref_2024"
};

io.on('connection', (socket) => {
    socket.emit('gameStateUpdate', gameState);

    socket.on('claimReferee', (token) => {
        if (token === gameState.secretRefToken) {
            gameState.refereeId = socket.id;
            io.emit('gameStateUpdate', gameState);
        }
    });

    socket.on('joinWaitingRoom', (data) => {
        // If lobby is closed and you aren't already in the list, you can't join
        const existingUser = gameState.allViewers.find(v => v.name === data.name);
        if (!gameState.lobbyOpen && !existingUser) return;

        if (!existingUser) {
            gameState.allViewers.push({ id: socket.id, name: data.name, role: 'spectator' });
        } else {
            existingUser.id = socket.id; // Update ID if they reloaded
        }
        io.emit('gameStateUpdate', gameState);
    });

    // REFEREE: Toggle Lobby Access
    socket.on('refToggleLobby', () => {
        if (socket.id !== gameState.refereeId) return;
        gameState.lobbyOpen = !gameState.lobbyOpen;
        io.emit('gameStateUpdate', gameState);
    });

    // REFEREE: Assign a spectator to a team
    socket.on('refAssignRole', (data) => {
        if (socket.id !== gameState.refereeId) return;
        const user = gameState.allViewers.find(v => v.id === data.userId);
        if (user) {
            user.role = data.role; // 'team1', 'team2', or 'spectator'
            io.emit('gameStateUpdate', gameState);
        }
    });

    socket.on('refStartDraft', async (config) => {
        if (socket.id !== gameState.refereeId) return;
        const response = await axios.get(process.env.SHEET_URL);
        gameState.availableCards = await csv().fromString(response.data);
        gameState.teamSize = config.teamSize;
        gameState.gameStarted = true;
        gameState.team1Picks = [];
        gameState.team2Picks = [];
        gameState.currentTurn = "team1";
        io.emit('gameStateUpdate', gameState);
    });

    // PLAYERS: Pick Card (Only if it's their turn)
    socket.on('playerPickCard', (cardId) => {
        const user = gameState.allViewers.find(v => v.id === socket.id);
        if (!user || user.role !== gameState.currentTurn) return;

        const card = gameState.availableCards.find(c => c.id === cardId);
        if (card) {
            // Position Rule: 1 GK
            if (card.pos === 'GK' && gameState[`${user.role}Picks`].some(p => p.pos === 'GK')) return;
            
            gameState[`${user.role}Picks`].push(card);
            gameState.availableCards = gameState.availableCards.filter(c => c.id !== cardId);
            
            // Turn Swap
            gameState.currentTurn = gameState.currentTurn === "team1" ? "team2" : "team1";
            
            // Check for Game Over
            if (gameState.team1Picks.length >= gameState.teamSize && gameState.team2Picks.length >= gameState.teamSize) {
                gameState.currentTurn = "finished";
            }
            io.emit('gameStateUpdate', gameState);
        }
    });

    socket.on('refReset', () => {
        if (socket.id !== gameState.refereeId) return;
        gameState.gameStarted = false;
        gameState.team1Picks = [];
        gameState.team2Picks = [];
        io.emit('gameStateUpdate', gameState);
    });
});

server.listen(process.env.PORT || 5000);
