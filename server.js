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
    authorizedNames: [], // Permanent list of who "made it in" before the door closed
    allViewers: [],      // Active connections {id, name, role}
    availableCards: [],
    team1Picks: [],
    team2Picks: [],
    team1Player: null,   // The specific person assigned to T1 {id, name}
    team2Player: null,   // The specific person assigned to T2 {id, name}
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
            socket.emit('refConfirm', true);
        }
    });

    socket.on('joinWaitingRoom', (data) => {
        const name = data.name.trim();
        const isAlreadyAuthorized = gameState.authorizedNames.includes(name);

        // LOCKOUT LOGIC: If lobby is closed and you weren't already in, you stay out.
        if (!gameState.lobbyOpen && !isAlreadyAuthorized) {
            socket.emit('error', 'Lobby is closed. You are not on the authorized spectator list.');
            return;
        }

        // AUTHORIZE: Add to the permanent list if lobby is open
        if (gameState.lobbyOpen && !isAlreadyAuthorized) {
            gameState.authorizedNames.push(name);
        }

        // ACTIVE CONNECTION: Update or add to active viewers
        const existingViewer = gameState.allViewers.find(v => v.name === name);
        if (existingViewer) {
            existingViewer.id = socket.id; // Update socket ID on refresh
        } else {
            gameState.allViewers.push({ id: socket.id, name: name, role: 'spectator' });
        }
        
        io.emit('gameStateUpdate', gameState);
    });

    socket.on('refToggleLobby', () => {
        if (socket.id !== gameState.refereeId) return;
        gameState.lobbyOpen = !gameState.lobbyOpen;
        io.emit('gameStateUpdate', gameState);
    });

    socket.on('refAssignRole', (data) => {
        if (socket.id !== gameState.refereeId) return;
        const user = gameState.allViewers.find(v => v.id === data.userId);
        if (user) {
            user.role = data.role;
            if (data.role === 'team1') gameState.team1Player = { id: user.id, name: user.name };
            if (data.role === 'team2') gameState.team2Player = { id: user.id, name: user.name };
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

    socket.on('playerPickCard', (cardId) => {
        const user = gameState.allViewers.find(v => v.id === socket.id);
        // ONLY the assigned Team 1 or Team 2 player can pick
        if (!user || user.role !== gameState.currentTurn) return;

        const card = gameState.availableCards.find(c => c.id === cardId);
        if (card) {
            if (card.pos === 'GK' && gameState[`${user.role}Picks`].some(p => p.pos === 'GK')) return;
            gameState[`${user.role}Picks`].push(card);
            gameState.availableCards = gameState.availableCards.filter(c => c.id !== cardId);
            gameState.currentTurn = gameState.currentTurn === "team1" ? "team2" : "team1";
            
            if (gameState.team1Picks.length >= gameState.teamSize && gameState.team2Picks.length >= gameState.teamSize) {
                gameState.currentTurn = "FINISHED";
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
