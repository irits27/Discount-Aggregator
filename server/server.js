const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const fs = require('fs'); 
require('dotenv').config();
const axios = require('axios');
const Game = require('./models/Game');

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// CSP Headers
app.use((req, res, next) => {
    res.setHeader(
        'Content-Security-Policy', 
        "default-src 'self' http://localhost:* http://127.0.0.1:*; " +
        "style-src 'self' 'unsafe-inline'; " +
        "script-src 'self' 'unsafe-inline'; " +
        "connect-src 'self' http://localhost:* http://127.0.0.1:* https:; " +
        "img-src 'self' https: data:;"
    );
    next();
});

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
.then(() => console.log('MongoDB connected'))
.catch(err => console.log("MongoDB connection error: ", err));

function roundPrice(value) {
    return Math.round(value * 100) / 100;
}

function parseMoney(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return Number.isFinite(value) ? roundPrice(value) : null;
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
        game && game.title && game.GameID && game.dealID && game.storeID && 
        game.storeName && game.url && game.thumb &&
        Number.isFinite(game.salePrice) && Number.isFinite(game.normalPrice)
    );
}

// 1. STEAM DEALS (С гарантированным CDN)
async function getSteamDeals() {
    const games = [];
    try {
        for (let page = 0; page < 3; page++) {
            try {
                const url = `https://store.steampowered.com/search/results/?query=&start=${page * 50}&count=50&specials=1&infinite=1&json=1`;
                const response = await axios.get(url, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
                    timeout: 20000
                });
                if (!response.data || !response.data.results_html) break;

                const html = response.data.results_html;
                const rowRegex = /<a[^>]+class="[^"]*search_result_row[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
                let match;

                while ((match = rowRegex.exec(html)) !== null) {
                    const rowHtml = match[0];
                    const rowContent = match[1];

                    const urlMatch = rowHtml.match(/href="([^"]+)"/);
                    const appidMatch = rowHtml.match(/data-ds-appid="(\d+)"/);
                    const discountMatch = rowHtml.match(/data-discount="(\d+)"/);
                    const priceMatch = rowHtml.match(/data-price-final="(\d+)"/);
                    const titleMatch = rowContent.match(/<span class="title">([^<]+)<\/span>/);

                    if (urlMatch && appidMatch && discountMatch && priceMatch && titleMatch) {
                        const discountPercent = parseInt(discountMatch[1], 10);
                        if (discountPercent <= 0) continue; 

                        const priceFinalCents = parseInt(priceMatch[1], 10);
                        const salePrice = roundPrice(priceFinalCents / 100);
                        const normalPrice = discountPercent < 100 ? roundPrice(salePrice / (1 - discountPercent / 100)) : salePrice;
                        const gameID = appidMatch[1];

                        games.push({
                            title: titleMatch[1].trim(),
                            storeID: 'steam',
                            storeName: 'Steam',
                            salePrice,
                            normalPrice,
                            saving: discountPercent,
                            GameID: `steam-${gameID}`,
                            dealID: `steam-${gameID}`,
                            thumb: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${gameID}/header.jpg`,
                            url: urlMatch[1].split('?')[0]
                        });
                    }
                }
            } catch (e) { break; }
        }
    } catch (err) {}
    return games;
}

// 2. GOG DEALS (Исправление протоколов картинок)
async function getGogDeals() {
    try {
        const games = [];
        let page = 1;
        while (page <= 3) { 
            const response = await axios.get(`https://catalog.gog.com/v1/catalog?order=desc:discount&page=${page}&price=discounted&limit=50`);
            const products = response.data.products || [];
            if (products.length === 0) break;

            products.forEach(item => {
                let base = item.price ? parseMoney(item.price.base || item.price.basePrice) : null;
                let final = item.price ? parseMoney(item.price.final || item.price.finalPrice) : null;
                const gameID = item.id || item.slug;

                if (item.title && item.slug && gameID && base && final && final < base) {
                    let img = item.coverHorizontal || item.coverVertical || '';
                    // Фикс относительных протоколов GOG (//images.gog-statics.com -> https://...)
                    if (img.startsWith('//')) img = 'https:' + img;
                    else if (img.startsWith('http://')) img = img.replace('http://', 'https://');

                    games.push({
                        title: item.title,
                        storeID: 'gog',
                        storeName: 'GOG',
                        salePrice: final,
                        normalPrice: base,
                        saving: calculateSaving(base, final),
                        GameID: `gog-${gameID}`,
                        dealID: `gog-${gameID}`,
                        thumb: img,
                        url: `https://www.gog.com/game/${item.slug}`
                    });
                }
            });
            page++;
        }
        return games;
    } catch (err) { return []; }
}

// 3. EPIC DEALS (Очистка вотермарок и resize параметров)
async function getEpicDeals(){
    try{
        const games = [];
        const res = await axios.get('https://store-site-backend-static.ak.epicgames.com/catalog/searchStore?locale=en-US&country=US&allowCountries=US&count=100&start=0', {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        const elements = res.data.data?.Catalog?.searchStore?.elements || [];

        elements.forEach(item => {
            const base = parseCentPrice(item.price?.totalPrice?.originalPrice);
            const discount = parseCentPrice(item.price?.totalPrice?.discountPrice);
            const pageSlug = item.catalogNs?.mappings?.[0]?.pageSlug || item.productSlug || item.id;

            if (item.title && pageSlug && base !== null && discount !== null) {
                const gameUrl = `https://store.epicgames.com/en-US/p/${pageSlug}`;
                const imageTypes = ['OfferImageWide', 'Landscape', 'DieselStoreFrontWide', 'Thumbnail'];
                let image = '';
                
                for (const type of imageTypes) {
                    const foundImg = (item.keyImages || []).find(img => img.type === type);
                    if (foundImg && foundImg.url) {
                        image = foundImg.url;
                        break;
                    }
                }

                // Фикс для Epic Games: убираем параметры динамического изменения размера, ломающие картинку
                if (image.includes('?')) {
                    image = image.split('?')[0];
                }

                const gameID = item.productSlug || item.id || item.title;
                const saving = calculateSaving(base, discount);

                if (saving > 0 && discount < base && image) {
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
        });
        return games;
    } catch(err){ return []; }
}

// Синхронизация
async function fetchAndSaveGames(req, res) {
    try {
        console.log('🔄 Сбор свежих скидок...');
        const results = await Promise.allSettled([getSteamDeals(), getGogDeals(), getEpicDeals()]);

        const steamDeals = results[0].status === 'fulfilled' ? results[0].value : [];
        const gogDeals = results[1].status === 'fulfilled' ? results[1].value : [];
        const epicDeals = results[2].status === 'fulfilled' ? results[2].value : [];

        const allGames = [...steamDeals, ...gogDeals, ...epicDeals];
        const validGames = allGames.filter(isValidGameDeal);

        let savedCount = 0;
        for(let game of validGames) {
            try {
                await Game.findOneAndUpdate(
                    { url: game.url },
                    game,
                    { upsert: true, returnDocument: 'after', runValidators: true }
                );
                savedCount++;
            } catch (dbErr) {}
        }

        console.log(`✅ Сохранено в БД: ${savedCount}`);
        if(req && res) res.json({ message: 'Success', count: savedCount });
    } catch(err) {
        if(req && res) res.status(500).json({ error: err.message });
    }
}

// Роуты
app.get('/', (req, res) => {
    const indexPath = path.join(__dirname, '..', 'index.html');
    if (fs.existsSync(indexPath)) res.sendFile(indexPath);
    else res.status(404).send(`<h2>index.html не найден</h2>`);
});

app.use(express.static(path.join(__dirname, '..')));
app.get('/api/fetch-now', async (req, res) => { await fetchAndSaveGames(req, res); });

app.get('/api/games', async (req,res) => {
    try {
        let query = {};
        if (req.query.store) query.storeID = { $in: req.query.store.split(',') };
        if (req.query.minPrice || req.query.maxPrice) {
            query.salePrice = {};
            if (req.query.minPrice) query.salePrice.$gte = parseFloat(req.query.minPrice);
            if (req.query.maxPrice) query.salePrice.$lte = parseFloat(req.query.maxPrice);
        }
        if (req.query.minDiscount) query.saving = { $gte: parseInt(req.query.minDiscount) };

        const games = await Game.find(query).sort({ saving: -1 });
        res.json(games);
    } catch(err) { res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/clear-database', async (req, res) => {
    try {
        await Game.deleteMany({});
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false }); }
});

app.listen(port, () => console.log(`🚀 Server on port: ${port}`));
module.exports = app;