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

app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', "default-src 'self' localhost:* http://localhost:*; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' localhost:* http://localhost:* https:; img-src 'self' https: data:;");
    next();
});

app.use(express.static(path.join(__dirname)));

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
.then(() => console.log('MongoDB connected'))
.catch(err => console.log("MongoDB connection error: ", err));

function roundPrice(value) {
    return Math.round(value * 100) / 100;
}

function parseMoney(value) {
    if (value === null || value === undefined || value === '') return null;

    if (typeof value === 'number') {
        return Number.isFinite(value) ? roundPrice(value) : null;
    }

    if (typeof value === 'string') {
        const normalized = value.replace(',', '.').match(/-?\d+(\.\d+)?/);
        if (!normalized) return null;

        const parsed = Number(normalized[0]);
        return Number.isFinite(parsed) ? roundPrice(parsed) : null;
    }

    return null;
}

function parseCentPrice(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = typeof value === 'number' ? value : parseInt(value, 10);
    return Number.isFinite(parsed) && !isNaN(parsed) ? roundPrice(parsed / 100) : null;
}

function calculateSaving(normalPrice, salePrice, fallbackPercent) {
    const fallback = Number(fallbackPercent);
    if (Number.isFinite(fallback) && fallback > 0) return Math.max(0, Math.round(fallback));

    if (normalPrice > 0 && Number.isFinite(salePrice)) {
        return Math.max(0, Math.round(((normalPrice - salePrice) / normalPrice) * 100));
    }

    return 0;
}

function isValidGameDeal(game) {
    return Boolean(
        game &&
        game.title &&
        game.GameID &&
        game.dealID &&
        game.storeID &&
        game.storeName &&
        game.url &&
        Number.isFinite(game.salePrice) &&
        Number.isFinite(game.normalPrice) &&
        Number.isFinite(game.saving) &&
        !isNaN(game.salePrice) &&
        !isNaN(game.normalPrice) &&
        !isNaN(game.saving)
    );
}

// Function to get deals from Steam
async function getSteamDeals() {
    try {
        const response = await axios.get('https://store.steampowered.com/api/featuredcategories/?l=english');
        const specials = response.data.specials?.items || [];

        return specials.map(item => {
            const normalPrice = parseCentPrice(item.original_price);
            const salePrice = parseCentPrice(item.final_price);
            const gameID = item.id;

            if (!item.name || !gameID || normalPrice === null || salePrice === null) return null;

            return {
                title: item.name,
                storeID: 'steam',
                storeName: 'Steam',
                salePrice,
                normalPrice,
                saving: calculateSaving(normalPrice, salePrice, item.discount_percent),
                GameID: `steam-${gameID}`,
                dealID: `steam-${gameID}`,
                thumb: item.large_capsule_image,
                url: `https://store.steampowered.com/app/${gameID}`
            };
        }).filter(Boolean);
    } catch (err) {
        console.error('Error fetching data from Steam: ', err.message);
        return [];
    }
}

// Function to get deals from GOG
async function getGogDeals() {
    try {
        const response = await axios.get('https://catalog.gog.com/v1/catalog?order=desc:discount&page=1&price=discounted');
        const products = response.data.products || [];

        return products.map(item => {
            const base = parseMoney(item.price?.basePrice);
            const final = parseMoney(item.price?.finalPrice);
            const gameID = item.id || item.slug;

            if (!item.title || !item.slug || !gameID || base === null || final === null) return null;

            return {
                title: item.title,
                storeID: 'gog',
                storeName: 'GOG',
                salePrice: final,
                normalPrice: base,
                saving: calculateSaving(base, final),
                GameID: `gog-${gameID}`,
                dealID: `gog-${gameID}`,
                thumb: item.coverHorizontal || item.coverVertical,
                url: `https://www.gog.com/game/${item.slug}`
            };
        }).filter(Boolean);
    } catch (err) {
        console.error('Error fetching data from GOG: ', err.message);
        return [];
    }
}

// Function to get deals from Epic Games Store
async function getEpicDeals(){
    try{
        const res = await axios.get('https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=en-US&country=US&allowCountries=US');
        const elements = res.data.data.Catalog.searchStore.elements || [];

        return elements
            .map(item => {
                const base = parseCentPrice(item.price?.totalPrice?.originalPrice);
                const discount = parseCentPrice(item.price?.totalPrice?.discountPrice);
                const pageSlug = item.catalogNs?.mappings?.[0]?.pageSlug || item.productSlug || item.id;

                if (!item.title || !pageSlug || base === null || discount === null || discount >= base) return null;

                const image = (item.keyImages || []).find(img => img.type === 'Thumbnail' || img.type === 'DieselStoreFrontWide')?.url || '';
                const gameID = item.productSlug || item.id || item.title;

                return {
                    title: item.title,
                    storeID: 'epic',
                    storeName: 'Epic Games',
                    salePrice: discount,
                    normalPrice: base,
                    saving: calculateSaving(base, discount),
                    GameID: `epic-${gameID}`,
                    dealID: `epic-${gameID}`,
                    thumb: image,
                    url: `https://store.epicgames.com/en-US/p/${pageSlug}`
                };
            })
            .filter(Boolean);
    } catch(err){
        console.error('Error fetching data from Epic Games Store: ', err.message);
        return [];
    }
}

// Function to fetch deals from all stores and save to DB
async function fetchAndSaveGames(req, res) {
    try {
        console.log('Fetching deals from all stores...');
        const results = await Promise.allSettled([
            getSteamDeals(),
            getGogDeals(),
            getEpicDeals()
        ]);

        const steamDeals = results[0].status === 'fulfilled' ? results[0].value : [];
        const gogDeals = results[1].status === 'fulfilled' ? results[1].value : [];
        const epicDeals = results[2].status === 'fulfilled' ? results[2].value : [];

        const allGames = [...steamDeals, ...gogDeals, ...epicDeals];
        console.log(`Fetched ${allGames.length} deals from all stores.`);

        const validGames = allGames.filter(isValidGameDeal);
        const skippedCount = allGames.length - validGames.length;

        if (skippedCount > 0) {
            console.warn(`Skipped ${skippedCount} deals with missing or invalid fields.`);
        }

        let savedCount = 0;
        for(let game of validGames) {
            try {
                await Game.findOneAndUpdate(
                    {url: game.url}, 
                    game,
                    { upsert: true, returnDocument: 'after', runValidators: true}
                );
                savedCount++;
            } catch (dbErr) {
                console.error(`Failed to save game "${game.title}" to DB: `, dbErr.message);
            }
        }

        console.log(`Successfully processed and saved ${savedCount} deals to DB.`);
        const result = {
            message: 'Deals fetched and saved successfully',
            count: savedCount,
            skipped: skippedCount
        };

        // Если функция вызвана из HTTP-роута, отправляем ответ в ней
        if(req && res && typeof res.json === 'function') {
            return res.json(result);
        }

        return result;
    } catch(err) {
        console.error('Error fetching and saving deals: ', err);
        if(req && res && typeof res.status === 'function') {
            return res.status(500).json({ message: 'Failed to fetch and save deals', error: err.message });
        }

        return { message: 'Failed to fetch and save deals', error: err.message };
    }
}

// Routes
app.get('/', (req,res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// API route to trigger game fetching
app.get('/api/fetch-now', async (req, res) => {
    // Передаем req и res внутрь функции, чтобы она сама корректно завершила запрос
    await fetchAndSaveGames(req, res);
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
app.get('/api/clear-database', async (req, res) => {
    try {
        await Game.deleteMany({}); // Удаляет абсолютно все записи из коллекции игр
        console.log('Database cleared successfully.');
        res.json({ success: true, message: 'Database cleared successfully! Click "Find New Deals" to refill.' });
    } catch (err) {
        console.error('Error clearing database: ', err);
        res.status(500).json({ success: false, error: 'Failed to clear database' });
    }
});
// Start the server
app.listen(port, () => {
    console.log(`Server is running on port: ${port}`);
});

module.exports = app;