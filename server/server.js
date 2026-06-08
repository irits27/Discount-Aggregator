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
    const games = [];
    const gameUrls = new Set();
    const debugLog = [];

    try {
        debugLog.push('[Steam] Starting Steam deals fetch...');

        for (let page = 0; page < 3; page++) {
            try {
                const url = `https://store.steampowered.com/search/results?query=&count=50&start=${page * 50}&infinite=1`;

                const response = await axios.get(url, {
                    headers: { 'User-Agent': 'Mozilla/5.0' },
                    timeout: 20000
                });

                if (!response.data || !response.data.results_html) {
                    debugLog.push(`[Steam] No results_html on page ${page}`);
                    break;
                }

                const html = response.data.results_html;
                debugLog.push(`[Steam] Page ${page}: ${html.length} bytes`);

                // Check what discount looks like
                const discountMatches = html.match(/data-discount="[^"]*"/g);
                debugLog.push(`[Steam] Found ${discountMatches?.length || 0} data-discount attributes`);

                if (discountMatches && discountMatches.length > 0) {
                    debugLog.push(`[Steam] Sample: ${discountMatches[0]}`);
                }

                // Check price
                const priceMatches = html.match(/data-price-final="[^"]*"/g);
                debugLog.push(`[Steam] Found ${priceMatches?.length || 0} data-price-final attributes`);

                // Try to find them together - maybe they're not adjacent
                const fullMatches = html.match(/data-discount="(\d+)"[\s\S]*?data-price-final="(\d+)"/g);
                debugLog.push(`[Steam] Found ${fullMatches?.length || 0} combined matches with [\s\S]*?`);

                // Just count for now
                let gameCount = 0;
                let foundMatches = 0;

                // Look for discount blocks
                const discountRegex = /data-discount="(\d+)"/g;
                let match;
                while ((match = discountRegex.exec(html)) !== null) {
                    foundMatches++;

                    // Find nearest price
                    const searchAfter = html.substring(match.index, match.index + 500);
                    const priceInAfter = searchAfter.match(/data-price-final="(\d+)"/);
                    if (priceInAfter) {
                        gameCount++;
                    }
                }

                debugLog.push(`[Steam] Page ${page}: ${foundMatches} discount lines, ${gameCount} with prices`);

                if (page === 0) {
                    // Save sample HTML for inspection
                    fs.writeFileSync('./steam-sample.html', html.substring(0, 5000));
                }

                if (gameCount === 0) break;
            } catch (e) {
                debugLog.push(`[Steam] Error page ${page}: ${e.message}`);
                break;
            }
        }

        fs.writeFileSync('./steam-debug.log', debugLog.join('\n'));
    } catch (err) {
        const debugLog = [`[Steam] Fatal: ${err.message}`];
        fs.writeFileSync('./steam-debug.log', debugLog.join('\n'));
    }

    return games;
}

// Function to get deals from GOG
async function getGogDeals() {
    try {
        const games = [];
        let page = 1;
        let hasMore = true;

        while (hasMore && page <= 10) {
            const response = await axios.get(`https://catalog.gog.com/v1/catalog?order=desc:discount&page=${page}&price=discounted&limit=50`);
            const products = response.data.products || [];

            if (!products || products.length === 0) {
                hasMore = false;
                break;
            }

            products.forEach(item => {
                let base = null;
                let final = null;

                if (item.price) {
                    base = parseMoney(item.price?.base || item.price?.basePrice);
                    final = parseMoney(item.price?.final || item.price?.finalPrice);
                }

                const gameID = item.id || item.slug;

                if (item.title && item.slug && gameID && base !== null && final !== null && final < base) {
                    games.push({
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
                    });
                }
            });

            page++;
        }

        return games;
    } catch (err) {
        console.error('Error fetching data from GOG: ', err.message);
        return [];
    }
}

// Function to get deals from Epic Games Store
async function getEpicDeals(){
    try{
        const games = [];

        // Try multiple Epic endpoints
        const endpoints = [
            'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=en-US&country=US&allowCountries=US',
            'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=en-US',
        ];

        for (const url of endpoints) {
            try {
                const res = await axios.get(url, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    }
                });
                const elements = res.data.data?.Catalog?.searchStore?.elements || [];

                elements.forEach(item => {
                    const base = parseCentPrice(item.price?.totalPrice?.originalPrice);
                    const discount = parseCentPrice(item.price?.totalPrice?.discountPrice);
                    const pageSlug = item.catalogNs?.mappings?.[0]?.pageSlug || item.productSlug || item.id;

                    if (item.title && pageSlug && base !== null && discount !== null) {
                        const gameUrl = `https://store.epicgames.com/en-US/p/${pageSlug}`;
                        const existingGame = games.find(g => g.url === gameUrl);

                        if (!existingGame) {
                            const image = (item.keyImages || []).find(img => img.type === 'Thumbnail' || img.type === 'DieselStoreFrontWide')?.url || '';
                            const gameID = item.productSlug || item.id || item.title;
                            const saving = calculateSaving(base, discount);

                            if (saving > 0) {
                                games.push({
                                    title: item.title,
                                    storeID: 'epic',
                                    storeName: 'Epic Games',
                                    salePrice: discount,
                                    normalPrice: base,
                                    saving: saving,
                                    GameID: `epic-${gameID}`,
                                    dealID: `epic-${gameID}`,
                                    thumb: image,
                                    url: gameUrl
                                });
                            }
                        }
                    }
                });
            } catch (e) {
                console.warn(`Failed to fetch from Epic endpoint: ${e.message}`);
            }
        }

        return games;
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

// API route to get all games with filters
app.get('/api/games', async (req,res) => {
    try {
        let query = {};

        // Filter by store
        if (req.query.store) {
            const stores = req.query.store.split(',').map(s => s.trim().toLowerCase());
            const storeMap = {
                'steam': 'Steam',
                'gog': 'GOG',
                'epic': 'Epic Games'
            };
            const validStores = stores.map(s => storeMap[s]).filter(Boolean);
            if (validStores.length > 0) {
                query.storeName = { $in: validStores };
            }
        }

        // Filter by price range
        if (req.query.minPrice || req.query.maxPrice) {
            query.salePrice = {};
            if (req.query.minPrice) {
                query.salePrice.$gte = parseFloat(req.query.minPrice);
            }
            if (req.query.maxPrice) {
                query.salePrice.$lte = parseFloat(req.query.maxPrice);
            }
        }

        // Filter by discount percentage
        if (req.query.minDiscount) {
            query.saving = { $gte: parseInt(req.query.minDiscount) };
        }

        const games = await Game.find(query).sort({ saving: -1 });
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