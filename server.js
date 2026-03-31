const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');

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

    socket.on('hostStartGame', () => {
        const data = JSON.parse(fs.readFileSync('./players.json', 'utf8'));
        availableCards = data;
        
        // Create the Snake Draft Order: [P1, P2, P2, P1]
        draftOrder = [...players, ...[...players].reverse()]; 
        turnIndex = 0;

        io.emit('startDraft', { 
            cards: availableCards, 
            order: draftOrder, 
            currentTurnId: draftOrder[0].id 
        });
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