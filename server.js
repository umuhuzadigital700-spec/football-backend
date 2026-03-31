// ... existing imports and setup ...

    socket.on('refStartDraft', async (config) => {
        if (socket.id !== gameState.refereeId) return;
        try {
            const response = await axios.get(process.env.SHEET_URL);
            let allCards = await csv().fromString(response.data);
            
            // Limit to exactly 100 cards
            gameState.availableCards = allCards.slice(0, 100); 
            
            // Set the match type (1v1, 2v2, etc.)
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
            // Position Rule: 1 GK
            if ((card.pos === 'GK' || card.pos === 'Goal Keeper') && 
                gameState[`${user.role}Picks`].some(p => p.pos === 'GK' || p.pos === 'Goal Keeper')) {
                socket.emit('error', 'You already have a Goal Keeper!');
                return;
            }
            
            gameState[`${user.role}Picks`].push(card);
            gameState.availableCards = gameState.availableCards.filter(c => c.id !== cardId);
            
            // Snake/Turn Swap
            gameState.currentTurn = gameState.currentTurn === "team1" ? "team2" : "team1";
            
            // ALWAYS Draft until 11 picks per team are reached
            if (gameState.team1Picks.length >= 11 && gameState.team2Picks.length >= 11) {
                gameState.currentTurn = "FINISHED";
            }
            io.emit('gameStateUpdate', gameState);
        }
    });

// ... rest of the file stays the same ...
