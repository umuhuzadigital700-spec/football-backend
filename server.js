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
    authorizedNames: [], 
    allViewers: [],      
    availableCards: [],
    team1Picks: [],
    team2Picks: [],
    team1Player: null,   
    team2Player: null,   
    currentTurn: "team1",
    matchType: 1,        // Added back (1v1, 2v2, etc.)
    maxPicks: 11,        // Hardcoded to 11 per team
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
        if (!gameState.lobbyOpen && !isAlreadyAuthorized) {
            socket.emit('error', 'Lobby is closed.');
            return;
        }
        if (gameState.lobbyOpen && !isAlreadyAuthorized) {
            gameState.authorizedNames.push(name);
        }
        const existingViewer = gameState.allViewers.find(v => v.name === name);
        if (existingViewer) {
            existingViewer.id = socket.id;
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
        try {
            const response = await axios.get(process.env.SHEET_URL);
            let allCards = await csv().fromString(response.data);
            
            // Limit to exactly 100 cards as requested
            gameState.availableCards = allCards.slice(0, 100); 
            
            // Set the Match Type (1v1, 5v5 etc) but still pick 11 each
            gameState.matchType = config.teamSize || 1;
            
            gameState.gameStarted = true;
            gameState.team1Picks = [];
            gameState.team2Picks = [];
            gameState.currentTurn = "team1";
            io.emit('gameStateUpdate', gameState);
        } catch (e) { console.log("Fetch Error"); }
    });

    socket.on('playerPickCard', (cardId) => {
        const user = gameState.allViewers.find(v => v.id === socket.id);
        if (!user || user.role !== gameState.currentTurn) return;

        const card = gameState.availableCards.find(c => c.id === cardId);
        if (card) {
            // Position Rule: Max 1 Goal Keeper
            const isGK = card.pos === 'GK' || card.pos === 'Goal Keeper';
            if (isGK && gameState[`${user.role}Picks`].some(p => p.pos === 'GK' || p.pos === 'Goal Keeper')) {
                socket.emit('error', 'You already have a Goal Keeper!');
                return;
            }
            
            gameState[`${user.role}Picks`].push(card);
            gameState.availableCards = gameState.availableCards.filter(c => c.id !== cardId);
            
            // Swap turns
            gameState.currentTurn = gameState.currentTurn === "team1" ? "team2" : "team1";
            
            // Draft ends when BOTH teams have 11 players
            if (gameState.team1Picks.length >= 11 && gameState.team2Picks.length >= 11) {
                gameState.currentTurn = "FINISHED";
            }
            io.emit('gameStateUpdate', gameState);
        }
    });

    socket.on('refCloseGame', () => {
        if (socket.id !== gameState.refereeId) return;
        gameState.currentTurn = "CLOSED BY REFEREE";
        io.emit('gameStateUpdate', gameState);
    });

    socket.on('refReset', () => {
        if (socket.id !== gameState.refereeId) return;
        gameState.gameStarted = false;
        gameState.team1Picks = [];
        gameState.team2Picks = [];
        io.emit('gameStateUpdate', gameState);
    });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
