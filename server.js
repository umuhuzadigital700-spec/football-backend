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

const SENTINEL_URL = "https://script.google.com/macros/s/AKfycby_FXyDMq0K0dW2kpRuaW0NdSTEy-9X8JrHIttJdjpadXs0cKV9Lr9Hg2EKY9pJhGdU/exec";

const CF_CONFIG = {
    accId: process.env.CLOUDFLARE_ACCOUNT_ID,
    token: process.env.CLOUDFLARE_API_TOKEN,
    uid: process.env.CLOUDFLARE_VIDEO_ID
};

let gameState = {
    refereeId: null,
    allViewers: [],      
    availableCards: [],
    team1Picks: [],
    team2Picks: [],
    team1Player: null,   
    team2Player: null,   
    currentTurn: "team1",
    gameStarted: false,
    matchLocked: false, 
    youtubeLink: "https://www.youtube.com",
    arenaBanner: "", 
    qrCodes: ["", "", "", "", "", ""],
    team1Formation: "4-4-2",
    team2Formation: "4-4-2",
    team1Tactics: {}, 
    team2Tactics: {}
};

async function getSecureStream() {
    if (!CF_CONFIG.token || !CF_CONFIG.accId || !CF_CONFIG.uid) return null;
    try {
        // SURGICAL FIX: The correct API endpoint for generating a Signed Token
        const url = `https://api.cloudflare.com/client/v4/accounts/${CF_CONFIG.accId}/stream/${CF_CONFIG.uid}/token`;
        const res = await axios.post(url, {}, { 
            headers: { 
                'Authorization': `Bearer ${CF_CONFIG.token}`,
                'Content-Type': 'application/json'
            } 
        });
        
        if (res.data && res.data.result && res.data.result.token) {
            return `https://customer-v7ps8f9e01.cloudflarestream.com/${res.data.result.token}/iframe`;
        }
        return null;
    } catch (e) { 
        console.error("CF Handshake Failed:", e.message);
        return null; 
    }
}

io.on('connection', (socket) => {
    socket.emit('gameStateUpdate', gameState);

    socket.on('claimReferee', (token) => {
        if (token === "eric_ref_2024") {
            gameState.refereeId = socket.id;
            io.emit('gameStateUpdate', gameState);
            socket.emit('refConfirm', true);
        }
    });

    socket.on('joinWaitingRoom', async (data) => {
        const name = data.name?.trim();
        const txId = data.ticketCode?.trim();
        if (!txId || !name) return;

        const alreadyActive = gameState.allViewers.find(v => v.txId === txId && v.id !== socket.id);
        if (alreadyActive) return socket.emit('error', 'Iyi code iri gukoreshwa n’undi muntu.');

        try {
            const verificationUrl = `${SENTINEL_URL}?code=${txId}&name=${encodeURIComponent(name)}`;
            const response = await axios.get(verificationUrl, { maxRedirects: 5 });
            
            if (response.data && response.data.valid) {
                const amount = Number(response.data.amount) || 0;
                let secureLink = (amount >= 2000) ? await getSecureStream() : null;
                
                let userIdx = gameState.allViewers.findIndex(v => v.txId === txId);
                
                if (userIdx !== -1) {
                    gameState.allViewers[userIdx].id = socket.id;
                    gameState.allViewers[userIdx].secureLink = secureLink;
                    gameState.allViewers[userIdx].isPremium = (amount >= 2000);
                    if (gameState.team1Player && gameState.team1Player.txId === txId) gameState.team1Player.id = socket.id;
                    if (gameState.team2Player && gameState.team2Player.txId === txId) gameState.team2Player.id = socket.id;
                } else {
                    gameState.allViewers.push({ 
                        id: socket.id, name: name, role: 'spectator', txId: txId, 
                        isPremium: (amount >= 2000), secureLink: secureLink 
                    });
                }
                io.emit('gameStateUpdate', gameState);
            } else { 
                socket.emit('error', 'Iyi code ntizwi cyangwa ntiyishyuwe.'); 
            }
        } catch (e) { socket.emit('error', 'Sentinel Error'); }
    });

    // --- EVERYTHING BELOW REMAINS 100% IDENTICAL TO YOUR WORKING VERSION ---
    socket.on('refUpdateBanner', (url) => { if (socket.id === gameState.refereeId) { gameState.arenaBanner = url; io.emit('gameStateUpdate', gameState); } });
    socket.on('refAssignRole', (data) => {
        if (socket.id !== gameState.refereeId) return;
        const user = gameState.allViewers.find(v => v.id === data.userId);
        if (user) {
            user.role = data.role;
            if (data.role === 'team1') gameState.team1Player = { id: user.id, name: user.name, txId: user.txId };
            if (data.role === 'team2') gameState.team2Player = { id: user.id, name: user.name, txId: user.txId };
            io.emit('gameStateUpdate', gameState);
        }
    });
    socket.on('refStartDraft', async () => {
        if (socket.id !== gameState.refereeId) return;
        try {
            const response = await axios.get(process.env.SHEET_URL);
            gameState.availableCards = (await csv().fromString(response.data)).slice(0, 100);
            gameState.gameStarted = true;
            gameState.matchLocked = false;
            gameState.team1Picks = [];
            gameState.team2Picks = [];
            gameState.team1Tactics = {};
            gameState.team2Tactics = {};
            gameState.currentTurn = "team1";
            io.emit('gameStateUpdate', gameState);
            io.emit('gameSyncPhase', 'DRAFT');
        } catch (e) { console.log("Draft Start Error"); }
    });
    socket.on('refReset', () => {
        if (socket.id !== gameState.refereeId) return;
        gameState.gameStarted = false;
        gameState.matchLocked = false;
        gameState.team1Picks = [];
        gameState.team2Picks = [];
        gameState.team1Tactics = {};
        gameState.team2Tactics = {};
        gameState.team1Player = null;
        gameState.team2Player = null;
        gameState.allViewers.forEach(v => v.role = 'spectator');
        io.emit('gameStateUpdate', gameState);
        io.emit('gameSyncPhase', 'LOBBY');
    });
    socket.on('refClearArena', () => {
        if (socket.id !== gameState.refereeId) return;
        gameState.allViewers = [];
        gameState.gameStarted = false;
        gameState.qrCodes = ["", "", "", "", "", ""];
        gameState.youtubeLink = "https://www.youtube.com";
        gameState.arenaBanner = "";
        io.emit('clearArenaForce'); 
        io.emit('gameStateUpdate', gameState);
    });
    socket.on('refUpdateYoutube', (link) => { if (socket.id === gameState.refereeId) { gameState.youtubeLink = link; io.emit('gameStateUpdate', gameState); } });
    socket.on('refUpdateQRs', (qrs) => { if (socket.id === gameState.refereeId) { gameState.qrCodes = qrs; io.emit('gameStateUpdate', gameState); } });
    socket.on('refLockMatch', () => { if (socket.id === gameState.refereeId) { gameState.matchLocked = true; io.emit('gameStateUpdate', gameState); } });
    socket.on('playerPickCard', (cardId) => {
        const user = gameState.allViewers.find(v => v.id === socket.id);
        if (!user || user.role !== gameState.currentTurn) return;
        const card = gameState.availableCards.find(c => c.id === cardId);
        if (card) {
            const myTeam = user.role === 'team1' ? gameState.team1Picks : gameState.team2Picks;
            if (myTeam.length >= 11) return;
            myTeam.push(card);
            gameState.availableCards = gameState.availableCards.filter(c => c.id !== cardId);
            const otherTeam = user.role === 'team1' ? 'team2' : 'team1';
            const otherPicks = user.role === 'team1' ? gameState.team2Picks : gameState.team1Picks;
            if (gameState.team1Picks.length >= 11 && gameState.team2Picks.length >= 11) { gameState.currentTurn = "FINISHED"; } 
            else { gameState.currentTurn = (otherPicks.length < 11) ? otherTeam : user.role; }
            io.emit('gameStateUpdate', gameState);
        }
    });
    socket.on('playerSetPosition', (data) => {
        if (gameState.matchLocked) return;
        const user = gameState.allViewers.find(v => v.id === socket.id);
        if (!user || !user.role.startsWith('team')) return;
        const tactics = gameState[`${user.role}Tactics`];
        const picks = gameState[`${user.role}Picks`];
        const card = picks.find(p => p.id === data.cardId);
        if (card) {
            Object.keys(tactics).forEach(k => { if (tactics[k].id === data.cardId) delete tactics[k]; });
            tactics[data.slotIndex] = card;
            io.emit('gameStateUpdate', gameState);
        }
    });
    socket.on('playerSetFormation', (formation) => {
        if (gameState.matchLocked) return;
        const user = gameState.allViewers.find(v => v.id === socket.id);
        if (!user || !user.role.startsWith('team')) return;
        gameState[`${user.role}Formation`] = formation;
        gameState[`${user.role}Tactics`] = {}; 
        io.emit('gameStateUpdate', gameState);
    });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => { console.log(`Arena Backend Masterpiece Online`); });
