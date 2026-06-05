const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
require('dotenv').config();
const axios = require('axios');
const Game = require('./models/Game');

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());
// Content Security Policy для защиты от XSS и других атак
app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', "default-src 'self' localhost:* http://localhost:*; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' localhost:* http://localhost:* https:; img-src 'self' https: data:;");
    next();
});
// Serve static files from the root directory (for index.html and any assets)
app.use(express.static(path.join(__dirname)));

//Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
.then(() => console.log('MongoDB connected'))
.catch(err => console.log("MongoDB connection error: ", err));



//function to fetch game data from CheapShark API and save to MongoDB
async function fetchAndSaveGames() {
    try{
        console.log('Fetching game data from CheapShark API...');
        const response = await axios.get('https://www.cheapshark.com/api/1.0/deals');
        const gamesFromApi = response.data;

        for(let game of gamesFromApi) {
            //update existing game or create new one
            await Game.findOneAndUpdate(
                { GameID: game.gameID },
                {
                    title: game.title,
                    salePrice: parseFloat(game.salePrice),
                    storeID: game.storeID,
                    dealID: game.dealID,
                    storeName: game.storeName,
                    normalPrice: parseFloat(game.normalPrice),
                    saving: parseFloat(game.savings),
                    thumb: game.thumb,
                    lastUpdated: Date.now()
                },
                { upsert: true, new: true }
            );
        }
        console.log('Game data fetched and saved successfully');
        return { success: true, message: 'Game data fetched and saved successfully' };
    } catch(err) {
        console.error('Error fetching/saving game data: ', err);
        return { success: false, error: err.message };
    }
}


// Routes
app.get('/', (req,res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// API route to trigger game fetching
app.get('/api/fetch-now', async (req,res) => {
    const result = await fetchAndSaveGames();
    res.json(result);
});



// API route to get all games
app.get('/api/games', async (req,res) => {
    try {
        const games = await Game.find().sort({ saving: -1 });
        res.json(games);
    } catch(err) {
        console.error('Error fetching games from DB: ', err);
        res.status(500).json({ success: false, error: 'Failed to fetch games' });
    }
});
// Start the server
app.listen(port,() => {
    console.log(`Server is running on port: ${port}`);
});


module.exports = app;