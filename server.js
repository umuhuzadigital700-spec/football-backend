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
            gameState.currentTurn = "team1";
            io.emit('gameStateUpdate', gameState);
        } catch (e) { console.log("Sheet Error"); }
    });

    socket.on('playerPickCard', (cardId) => {
        const user = gameState.allViewers.find(v => v.id === socket.id);
        
        // RE-VERIFY: Only the person whose turn it actually is can proceed
        if (!user || user.role !== gameState.currentTurn) {
            socket.emit('error', "Wait for your turn!");
            return;
        }
        
        const card = gameState.availableCards.find(c => c.id === cardId);
        if (card) {
            const myTeamPicks = gameState[`${user.role}Picks`];
            
            // Limit check
            if (myTeamPicks.length >= 11) return;

            // Goal Keeper check
            const isGK = card.pos?.toUpperCase().includes("GK");
            if (isGK && myTeamPicks.some(p => p.pos?.toUpperCase().includes("GK"))) {
                socket.emit('error', 'Team already has a Goal Keeper!');
                return;
            }

            // PERFORM THE PICK
            gameState[`${user.role}Picks`].push(card);
            gameState.availableCards = gameState.availableCards.filter(c => c.id !== cardId);
            
            // CALCULATE NEXT TURN
            const t1Count = gameState.team1Picks.length;
            const t2Count = gameState.team2Picks.length;

            if (t1Count >= 11 && t2Count >= 11) {
                gameState.currentTurn = "FINISHED";
            } else if (user.role === "team1") {
                // If Team 2 is not full, it's their turn. Otherwise, stay with Team 1.
                gameState.currentTurn = (t2Count < 11) ? "team2" : "team1";
            } else {
                // If Team 1 is not full, it's their turn. Otherwise, stay with Team 2.
                gameState.currentTurn = (t1Count < 11) ? "team1" : "team2";
            }
            
            // BROADCAST TO ALL: This forces every phone to unfreeze
            io.emit('gameStateUpdate', gameState);
        }
    });

    socket.on('refReset', () => {
        if (socket.id !== gameState.refereeId) return;
        gameState.gameStarted = false;
        gameState.team1Picks = [];
        gameState.team2Picks = [];
        gameState.currentTurn = "team1";
        gameState.allViewers.forEach(v => v.role = 'spectator');
        io.emit('gameStateUpdate', gameState);
    });

    socket.on('refClearArena', () => {
        if (socket.id !== gameState.refereeId) return;
        gameState.allViewers = [];
        gameState.gameStarted = false;
        io.emit('clearArenaForce');
        io.emit('gameStateUpdate', gameState);
    });
});

server.listen(process.env.PORT || 5000);
