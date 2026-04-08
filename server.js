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
    allViewers: [],      
    availableCards: [],
    team1Picks: [],
    team2Picks: [],
    team1Player: null,   
    team2Player: null,   
    currentTurn: "team1",
    matchType: 11,
    gameStarted: false,
    secretRefToken: "eric_ref_2024",
    youtubeLink: "https://www.youtube.com",
    qrCodes: ["", "", "", "", "", ""],
    // New Tactical Data
    team1Formation: "4-4-2",
    team2Formation: "4-4-2",
    team1Tactics: {}, 
    team2Tactics: {}
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
        if (!txId || !name) return;
        try {
            const sentinelUrl = `https://script.google.com/macros/s/AKfycbzvG5wJmLfTAjKwIzSINNWQwWkEM3urFYdyWXuM2zhmHcMYKOh5tQCyvdtsv0xptkeX/exec?code=${txId}&name=${name}`;
            const response = await axios.get(sentinelUrl);
            if (response.data.valid) {
                const existing = gameState.allViewers.find(v => v.name === name);
                if (existing) { existing.id = socket.id; } 
                else { gameState.allViewers.push({ id: socket.id, name: name, role: 'spectator', txId: txId }); }
                io.emit('gameStateUpdate', gameState);
            } else { socket.emit('error', 'Payment not verified.'); }
        } catch (e) { socket.emit('error', 'System Busy'); }
    });

    socket.on('refUpdateYoutube', (link) => {
        if (socket.id !== gameState.refereeId) return;
        gameState.youtubeLink = link;
        io.emit('gameStateUpdate', gameState);
    });

    socket.on('refUpdateQRs', (qrs) => {
        if (socket.id !== gameState.refereeId) return;
        gameState.qrCodes = qrs;
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
            gameState.availableCards = (await csv().fromString(response.data)).slice(0, 100);
            gameState.gameStarted = true;
            gameState.team1Picks = [];
            gameState.team2Picks = [];
            gameState.team1Tactics = {};
            gameState.team2Tactics = {};
            gameState.currentTurn = "team1";
            io.emit('gameStateUpdate', gameState);
        } catch (e) { console.log("Sheet Error"); }
    });

    socket.on('playerPickCard', (cardId) => {
        const user = gameState.allViewers.find(v => v.id === socket.id);
        if (!user || user.role !== gameState.currentTurn) return;
        const card = gameState.availableCards.find(c => c.id === cardId);
        if (card) {
            const myTeam = user.role === 'team1' ? gameState.team1Picks : gameState.team2Picks;
            if (myTeam.length >= 11) return;
            const isGK = card.pos?.toUpperCase().includes("GK");
            if (isGK && myTeam.some(p => p.pos?.toUpperCase().includes("GK"))) {
                socket.emit('error', 'Only 1 GK allowed!');
                return;
            }
            myTeam.push(card);
            gameState.availableCards = gameState.availableCards.filter(c => c.id !== cardId);
            const otherTeam = user.role === 'team1' ? 'team2' : 'team1';
            const otherPicks = user.role === 'team1' ? gameState.team2Picks : gameState.team1Picks;
            if (gameState.team1Picks.length >= 11 && gameState.team2Picks.length >= 11) {
                gameState.currentTurn = "FINISHED";
            } else {
                gameState.currentTurn = (otherPicks.length < 11) ? otherTeam : user.role;
            }
            io.emit('gameStateUpdate', gameState);
        }
    });

    // --- NEW TACTICAL LISTENERS ---
    socket.on('playerSetPosition', (data) => {
        const user = gameState.allViewers.find(v => v.id === socket.id);
        if (!user || !user.role.startsWith('team')) return;
        const teamKey = user.role;
        const picks = gameState[`${teamKey}Picks`];
        const tactics = gameState[`${teamKey}Tactics`];
        const card = picks.find(p => p.id === data.cardId);
        if (card) {
            Object.keys(tactics).forEach(key => {
                if (tactics[key].id === data.cardId) delete tactics[key];
            });
            tactics[data.slotIndex] = card;
            io.emit('gameStateUpdate', gameState);
        }
    });

    socket.on('playerSetFormation', (formation) => {
        const user = gameState.allViewers.find(v => v.id === socket.id);
        if (!user || !user.role.startsWith('team')) return;
        gameState[`${user.role}Formation`] = formation;
        gameState[`${user.role}Tactics`] = {}; 
        io.emit('gameStateUpdate', gameState);
    });
    // ------------------------------

    socket.on('refReset', () => {
        if (socket.id !== gameState.refereeId) return;
        gameState.gameStarted = false;
        gameState.team1Picks = [];
        gameState.team2Picks = [];
        gameState.team1Tactics = {};
        gameState.team2Tactics = {};
        gameState.currentTurn = "team1";
        gameState.team1Player = null;
        gameState.team2Player = null;
        gameState.allViewers.forEach(v => v.role = 'spectator');
        io.emit('gameStateUpdate', gameState);
    });

    socket.on('refClearArena', () => {
        if (socket.id !== gameState.refereeId) return;
        gameState.allViewers = [];
        gameState.gameStarted = false;
        gameState.team1Picks = [];
        gameState.team2Picks = [];
        gameState.team1Tactics = {};
        gameState.team2Tactics = {};
        gameState.team1Player = null;
        gameState.team2Player = null;
        io.emit('clearArenaForce');
        io.emit('gameStateUpdate', gameState);
    });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });
