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
    matchType: 11,
    maxPicks: 11,
    gameStarted: false,
    secretRefToken: "eric_ref_2024",
    youtubeLink: "https://www.youtube.com",
    qrCodes: ["", "", "", "", "", ""] 
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

    socket.on('joinWaitingRoom', async (data) => {
        const name = data.name.trim();
        const txId = data.ticketCode ? data.ticketCode.trim() : "";
        if (!txId) {
            socket.emit('error', 'Transaction ID is required.');
            return;
        }
        try {
            const sentinelUrl = `https://script.google.com/macros/s/AKfycbzvG5wJmLfTAjKwIzSINNWQwWkEM3urFYdyWXuM2zhmHcMYKOh5tQCyvdtsv0xptkeX/exec?code=${txId}&name=${name}`;
            const response = await axios.get(sentinelUrl);

            if (response.data.valid) {
                const existingViewer = gameState.allViewers.find(v => v.name === name);
                if (existingViewer) {
                    existingViewer.id = socket.id;
                } else {
                    gameState.allViewers.push({ id: socket.id, name: name, role: 'spectator', txId: txId });
                }
                io.emit('gameStateUpdate', gameState);
            } else {
                socket.emit('error', response.data.message || 'Payment not verified.');
            }
        } catch (error) {
            socket.emit('error', 'Verification system is momentarily busy.');
        }
    });

    socket.on('refUpdateYoutube', (newLink) => {
        if (socket.id !== gameState.refereeId) return;
        gameState.youtubeLink = newLink;
        io.emit('gameStateUpdate', gameState);
    });

    socket.on('refUpdateQRs', (newQRs) => {
        if (socket.id !== gameState.refereeId) return;
        gameState.qrCodes = newQRs;
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

    socket.on('refStartDraft', async () => {
        if (socket.id !== gameState.refereeId) return;
        try {
            const response = await axios.get(process.env.SHEET_URL);
            let allCards = await csv().fromString(response.data);
            gameState.availableCards = allCards.slice(0, 100); 
            gameState.gameStarted = true;
            gameState.team1Picks = [];
            gameState.team2Picks = [];
            gameState.currentTurn = "team1";
            io.emit('gameStateUpdate', gameState);
        } catch (e) { console.log("Fetch Error"); }
    });

    // Inside playerPickCard in server.js
socket.on('playerPickCard', (cardId) => {
        const user = gameState.allViewers.find(v => v.id === socket.id);
        
        // Safety Check: Is it actually this user's turn?
        if (!user || user.role !== gameState.currentTurn) return;
        
        const card = gameState.availableCards.find(c => c.id === cardId);
        if (card) {
            // 1. Check if the team is already full (stops at 11)
            if (gameState[`${user.role}Picks`].length >= 11) {
                socket.emit('error', 'Your team is already full!');
                return;
            }

            // 2. Goal Keeper check
            const isGK = card.pos === 'GK' || card.pos === 'Goal Keeper';
            const currentPicks = gameState[`${user.role}Picks`];
            if (isGK && currentPicks.some(p => p.pos === 'GK' || p.pos === 'Goal Keeper')) {
                socket.emit('error', 'Team already has a Goal Keeper!');
                return;
            }

            // 3. Process the pick
            gameState[`${user.role}Picks`].push(card);
            gameState.availableCards = gameState.availableCards.filter(c => c.id !== cardId);
            
            // 4. SMART TURN SWITCH (Prevents freezing)
            const t1Picks = gameState.team1Picks.length;
            const t2Picks = gameState.team2Picks.length;

            if (t1Picks >= 11 && t2Picks >= 11) {
                gameState.currentTurn = "FINISHED";
            } else if (user.role === "team1") {
                // Switch to team2 only if team2 still needs players
                gameState.currentTurn = (t2Picks < 11) ? "team2" : "team1";
            } else if (user.role === "team2") {
                // Switch to team1 only if team1 still needs players
                gameState.currentTurn = (t1Picks < 11) ? "team1" : "team2";
            }
            
            // 5. Force update to all screens
            io.emit('gameStateUpdate', gameState);
        }
    });

    socket.on('refReset', () => {
        if (socket.id !== gameState.refereeId) return;
        gameState.gameStarted = false;
        gameState.team1Picks = [];
        gameState.team2Picks = [];
        gameState.team1Player = null;
        gameState.team2Player = null;
        gameState.allViewers.forEach(v => v.role = 'spectator');
        io.emit('gameStateUpdate', gameState);
    });

    socket.on('refClearArena', () => {
        if (socket.id !== gameState.refereeId) return;
        gameState.allViewers = [];
        gameState.authorizedNames = [];
        gameState.gameStarted = false;
        gameState.team1Picks = [];
        gameState.team2Picks = [];
        gameState.team1Player = null;
        gameState.team2Player = null;
        io.emit('clearArenaForce'); 
        io.emit('gameStateUpdate', gameState);
    });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => { console.log(`Server is running on port ${PORT}`); });


