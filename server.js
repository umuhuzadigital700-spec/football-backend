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

let players = [];
let availableCards = [];
let turnIndex = 0;
let draftOrder = [];

io.on('connection', (socket) => {
    socket.on('joinLobby', (data) => {
        players.push({ id: socket.id, name: data.name });
        io.emit('playersUpdate', players);
    });

    socket.on('hostStartGame', async () => {
        try {
            // This grabs your Google Sheet players from the link you put in Render
            const response = await axios.get(process.env.SHEET_URL);
            const data = await csv().fromString(response.data);
            
            availableCards = data;
            draftOrder = [...players, ...[...players].reverse()]; 
            turnIndex = 0;

            io.emit('startDraft', { 
                cards: availableCards, 
                currentTurnId: draftOrder[0].id 
            });
        } catch (error) {
            console.error("Error loading players:", error);
        }
    });

    socket.on('pickCard', (cardId) => {
        const card = availableCards.find(c => c.id === cardId);
        if (card) {
            availableCards = availableCards.filter(c => c.id !== cardId);
            turnIndex++;
            const nextTurnId = draftOrder[turnIndex] ? draftOrder[turnIndex].id : null;
            io.emit('cardPicked', { 
                card, 
                pickerId: socket.id, 
                remainingCards: availableCards,
                nextTurnId: nextTurnId
            });
        }
    });

    socket.on('disconnect', () => {
        players = players.filter(p => p.id !== socket.id);
        io.emit('playersUpdate', players);
    });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
