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

    socket.on('hostStartGame', async (data) => {
        try {
            const response = await axios.get(process.env.SHEET_URL);
            const allCards = await csv().fromString(response.data);
            
            const teamSize = data.teamSize || 5; 
            availableCards = allCards;
            
            // SNAKE DRAFT LOGIC: P1, P2, P2, P1, P1, P2...
            draftOrder = [];
            let p1 = players[0];
            let p2 = players[1];
            
            for (let i = 0; i < teamSize; i++) {
                if (i % 2 === 0) {
                    draftOrder.push(p1, p2);
                } else {
                    draftOrder.push(p2, p1);
                }
            }
            
            turnIndex = 0;
            io.emit('startDraft', { 
                cards: availableCards, 
                currentTurnId: draftOrder[0].id,
                teamSize: teamSize
            });
        } catch (error) {
            console.error("Draft Start Error:", error);
        }
    });

    socket.on('pickCard', (cardId) => {
        if (turnIndex >= draftOrder.length) return;
        const currentPicker = draftOrder[turnIndex];
        
        if (socket.id !== currentPicker.id) return;

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
