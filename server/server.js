const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const fs = require('fs'); 
require('dotenv').config();
const axios = require('axios');
const Game = require('./models/Game');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

// Инициализируем плагин скрытности один раз в самом верху файла
puppeteer.use(StealthPlugin());

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

// 1. STEAM DEALS
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

// 2. GOG DEALS
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
                    if (img.startsWith('//')) img = 'https:' + img;
                    else if (img.startsWith('http://')) img = img.replace('http://', 'https://');

                    games.push({
                        title: item.title,
                        storeID: 'gog',
                        storeName: 'GOG',
                        salePrice: final,
                        normalPrice: base,
                        saving: calculateSaving(base, final, item.discount),
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
    } catch (err) { 
        console.error('Error fetching GOG deals: ', err.message);
        return []; 
    }
}

// 3. EPIC GAMES STORE DEALS
async function getEpicDeals() {
    const games = [];
    let browser = null;

    try {
        console.log('📡 [Epic Games] Запуск скрытого браузера...');
        
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 720 });
        await page.goto('https://store.epicgames.com/en-US/', { waitUntil: 'networkidle2', timeout: 30000 });

        console.log('🔑 Сессия valid. Начинаем сбор данных...');

        const elements = await page.evaluate(async () => {
            const url = 'https://store.epicgames.com/graphql';
            
            const createPayload = (sortBy) => ({
                operationName: "searchStoreQuery",
                variables: {
                    category: "games/edition/base|bundles/games",
                    count: 100, 
                    country: "US",
                    locale: "en-US",
                    sortBy: sortBy, 
                    sortDir: "DESC",
                    withPrice: true
                },
                query: `
                    query searchStoreQuery($category: String, $count: Int, $country: String!, $locale: String, $sortBy: String, $sortDir: String, $withPrice: Boolean = false) {
                        Catalog {
                            searchStore(category: $category, count: $count, country: $country, locale: $locale, sortBy: $sortBy, sortDir: $sortDir, onSale: true) {
                                elements {
                                    title
                                    id
                                    productSlug
                                    urlSlug
                                    offerType
                                    catalogNs { mappings { pageSlug } }
                                    keyImages { type url }
                                    price(country: $country) @include(if: $withPrice) {
                                        totalPrice { discountPrice originalPrice }
                                    }
                                }
                            }
                        }
                    }`
            });

            try {
                const resAAA = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(createPayload('currentPrice'))
                });
                const jsonAAA = await resAAA.json();
                const itemsAAA = jsonAAA?.data?.Catalog?.searchStore?.elements || [];

                const resFresh = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(createPayload('releaseDate'))
                });
                const jsonFresh = await resFresh.json();
                const itemsFresh = jsonFresh?.data?.Catalog?.searchStore?.elements || [];

                const allItems = [...itemsAAA, ...itemsFresh];
                const uniqueMap = new Map();
                
                allItems.forEach(item => {
                    if (item && item.id) {
                        uniqueMap.set(item.id, item);
                    }
                });

                return Array.from(uniqueMap.values());
            } catch (e) {
                return [];
            }
        });

        await browser.close();

        elements.forEach(item => {
            const totalPrice = item.price?.totalPrice;
            if (!totalPrice) return;

            const base = parseCentPrice(totalPrice.originalPrice);
            const discount = parseCentPrice(totalPrice.discountPrice);

            if (base === null || discount === null || discount >= base) return;

            let slug = null;

            // 1. В приоритете ищем валидный pageSlug из маппингов (кроме заглушки "home")
            if (item.catalogNs?.mappings && item.catalogNs.mappings.length > 0) {
                const validMapping = item.catalogNs.mappings.find(m => m.pageSlug && m.pageSlug !== 'home');
                if (validMapping) {
                    slug = validMapping.pageSlug;
                }
            }

            // 2. Если в маппингах пусто, берем productSlug (это чистый слаг страницы игры)
            if (!slug && item.productSlug) {
                slug = item.productSlug;
            }

            // 3. Фолбэк на urlSlug (дополнительная страховка)
            if (!slug && item.urlSlug) {
                slug = item.urlSlug;
            }

            // Пропускаем некорректные страницы во избежание 404
            if (!slug || slug === 'home' || slug.trim() === '' || !item.title) return;

            // Чистим слаг от системных хвостов Epic Games
            slug = slug.replace(/\/home$/, '').replace(/\/purchase$/, '').trim();

            const imageObj = (item.keyImages || []).find(img => 
                img.type === 'OfferImageWide' || 
                img.type === 'DieselStoreFrontWide' || 
                img.type === 'Thumbnail'
            );
            const image = imageObj ? imageObj.url : '';
            const gameID = item.id; 

            // --- ИСПРАВЛЕНИЕ: Используем offerType и жесткую локаль en-US ---
            const isBundle = item.offerType === 'BUNDLE';
            const finalUrl = isBundle 
                ? `https://store.epicgames.com/en-US/bundles/${slug}`
                : `https://store.epicgames.com/en-US/p/${slug}`;
                
            games.push({
                title: item.title,
                storeID: 'epic',
                storeName: 'Epic Games',
                salePrice: discount,
                normalPrice: base,
                saving: calculateSaving(base, discount, 0),
                GameID: `epic-${gameID}`,
                dealID: `epic-${gameID}`,
                thumb: image,
                url: finalUrl
            });
        });

        console.log(`✅ [Epic Games] Сбор завершен. Успешно собрано игр: ${games.length}`);
        return games;

    } catch (err) {
        console.error(`❌ Ошибка парсинга: ${err.message}`);
        if (browser) await browser.close();
        return [];
    }
}

// Additional helper functions and routes
async function fetchAndSaveGames(req, res) {
    try {
        console.log('🔄 Сбор свежих скидок из всех магазинов...');
        const results = await Promise.allSettled([
            getSteamDeals(), 
            getGogDeals(), 
            getEpicDeals()
        ]);

        const steamDeals = results[0].status === 'fulfilled' ? results[0].value : [];
        const gogDeals = results[1].status === 'fulfilled' ? results[1].value : [];
        const epicDeals = results[2].status === 'fulfilled' ? results[2].value : [];

        const allGames = [...steamDeals, ...gogDeals, ...epicDeals];
        console.log(`Fetched ${allGames.length} deals in total.`);

        const validGames = allGames.filter(isValidGameDeal);
        const skippedCount = allGames.length - validGames.length;

        if (skippedCount > 0) {
            console.warn(`Skipped ${skippedCount} deals with missing or invalid fields.`);
        }

        let savedCount = 0;
        for (let game of validGames) {
            try {
                await Game.findOneAndUpdate(
                    { url: game.url },
                    game,
                    { upsert: true, returnDocument: 'after', runValidators: true }
                );
                savedCount++;
            } catch (dbErr) {
                console.error(`Failed to save game "${game.title}" to DB: `, dbErr.message);
            }
        }

        console.log(`✅ Обработано и сохранено в БД: ${savedCount}`);
        
        const result = { 
            message: 'Success', 
            count: savedCount,
            skipped: skippedCount 
        };

        if (req && res && typeof res.json === 'function') {
            return res.json(result);
        }
        return result;
    } catch (err) {
        console.error('Critical error in fetchAndSaveGames: ', err.message);
        if (req && res && typeof res.status === 'function') {
            return res.status(500).json({ error: err.message });
        }
    }
}

// Routes
app.get('/', (req, res) => {
    const indexPath = path.join(__dirname, '..', 'index.html');
    if (fs.existsSync(indexPath)) res.sendFile(indexPath);
    else res.status(404).send(`<h2>index.html не найден</h2>`);
});

app.use(express.static(path.join(__dirname, '..')));
app.get('/api/fetch-now', async (req, res) => { await fetchAndSaveGames(req, res); });

app.get('/api/games', async (req, res) => {
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
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/clear-database', async (req, res) => {
    try {
        await Game.deleteMany({});
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false }); }
});

app.listen(port, () => console.log(`🚀 Server on port: ${port}`));
module.exports = app;