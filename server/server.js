const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cron = require('node-cron');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

puppeteer.use(StealthPlugin());

const app = express();
const port = process.env.PORT || 5000;

app.use(helmet({ contentSecurityPolicy: false }));

const allowedOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173', process.env.FRONTEND_URL].filter(Boolean);

app.use(cors({
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    }
}));

app.use(express.json());
app.use((req, res, next) => {
    res.setHeader(
        'Content-Security-Policy', 
        "default-src 'self' http://localhost:* http://127.0.0.1:*; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' http://localhost:* http://127.0.0.1:* https:; img-src 'self' https: data:;"
    );
    next();
});

mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/nebula')
.then(() => console.log('✅ MongoDB подключена'))
.catch(err => console.log("❌ Ошибка MongoDB: ", err));

// Схема БД
const gameSchema = new mongoose.Schema({
    title: String,
    storeID: String,
    storeName: String,
    prices: { type: Object, default: {} },
    GameID: String,
    dealID: { type: String, unique: true },
    thumb: String,
    url: String,
    lastUpdated: { type: Date, default: Date.now, expires: '7d' } // Автоудаление через 7 дней
});

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: 'Слишком много запросов с вашего IP, пожалуйста, подождите.' }
});
app.use('/api/', limiter);

// ИНДЕКСЫ ДЛЯ ОПТИМИЗАЦИИ
gameSchema.index({ title: 1 });
gameSchema.index({ storeID: 1 });
gameSchema.index({ 'prices.USD.sale': 1 });
gameSchema.index({ 'prices.EUR.sale': 1 });
gameSchema.index({ 'prices.UAH.sale': 1 });
gameSchema.index({ 'prices.USD.saving': -1 });

const Game = mongoose.model('Game', gameSchema);

// Утилиты
function roundPrice(value) { return Math.round(value * 100) / 100; }
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
    return Boolean(game && game.title && game.dealID && game.storeID && Object.keys(game.prices).length > 0);
}

// 1. STEAM DEALS
async function getSteamDeals() {
    const gamesMap = new Map();
    const regions = [ 
        { cc: 'US', cur: 'USD' }, 
        { cc: 'DE', cur: 'EUR' }, 
        { cc: 'UA', cur: 'UAH' } 
    ];

    console.log('📡 [Steam] Собираем цены...');
    for (const region of regions) {
        const fetchPage = async (page) => {
            const pageGames = [];
            try {
                const url = `https://store.steampowered.com/search/results/?query=&start=${page * 50}&count=50&specials=1&infinite=1&json=1&cc=${region.cc}`;
                const response = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 20000 });
                if (!response.data || !response.data.results_html) return pageGames;

                const html = response.data.results_html;
                const rowRegex = /<a[^>]+class="[^"]*search_result_row[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
                let match;

                while ((match = rowRegex.exec(html)) !== null) {
                    const rowHtml = match[0];
                    const urlMatch = rowHtml.match(/href="([^"]+)"/);
                    const appidMatch = rowHtml.match(/data-ds-appid="(\d+)"/);
                    const discountMatch = rowHtml.match(/data-discount="(\d+)"/);
                    const priceMatch = rowHtml.match(/data-price-final="(\d+)"/);
                    const titleMatch = match[1].match(/<span class="title">([^<]+)<\/span>/);

                    if (urlMatch && appidMatch && discountMatch && priceMatch && titleMatch) {
                        const discountPercent = parseInt(discountMatch[1], 10);
                        if (discountPercent <= 0) continue; 

                        const priceFinalCents = parseInt(priceMatch[1], 10);
                        const salePrice = roundPrice(priceFinalCents / 100);
                        const normalPrice = discountPercent < 100 ? roundPrice(salePrice / (1 - discountPercent / 100)) : salePrice;
                        const gameID = appidMatch[1];
                        const dealID = `steam-${gameID}`;

                        pageGames.push({
                            title: titleMatch[1].trim(),
                            storeID: 'steam',
                            storeName: 'Steam',
                            dealID: dealID,
                            GameID: dealID,
                            thumb: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${gameID}/header.jpg`,
                            url: urlMatch[1].split('?')[0],
                            prices: {
                                [region.cur]: { sale: salePrice, normal: normalPrice, saving: discountPercent }
                            }
                        });
                    }
                }
            } catch (e) {}
            return pageGames;
        };

        const results = await Promise.all([0, 1, 2].map(fetchPage));
        results.flat().forEach(g => {
            if (!gamesMap.has(g.dealID)) {
                gamesMap.set(g.dealID, g);
            } else {
                gamesMap.get(g.dealID).prices[region.cur] = g.prices[region.cur];
            }
        });
    }
    return Array.from(gamesMap.values());
}

// 2. GOG DEALS
async function getGogDeals() {
    const gamesMap = new Map();
    const regions = ['USD', 'EUR', 'UAH'];

    console.log('📡 [GOG] Собираем цены...');
    for (const cur of regions) {
        const fetchPage = async (page) => {
            const pageGames = [];
            try {
                const response = await axios.get(`https://catalog.gog.com/v1/catalog?order=desc:discount&page=${page}&price=discounted&limit=50&currency=${cur}`);
                const products = response.data.products || [];
                
                products.forEach(item => {
                    let base = item.price ? parseMoney(item.price.base || item.price.basePrice) : null;
                    let final = item.price ? parseMoney(item.price.final || item.price.finalPrice) : null;
                    const gameID = item.id || item.slug;

                    if (item.title && item.slug && gameID && base && final && final < base) {
                        let img = item.coverHorizontal || item.coverVertical || '';
                        if (img.startsWith('//')) img = 'https:' + img;
                        else if (img.startsWith('http://')) img = img.replace('http://', 'https://');
                        const dealID = `gog-${gameID}`;

                        pageGames.push({
                            title: item.title,
                            storeID: 'gog',
                            storeName: 'GOG',
                            dealID: dealID,
                            GameID: dealID,
                            thumb: img,
                            url: `https://www.gog.com/game/${item.slug}`,
                            prices: {
                                [cur]: { sale: final, normal: base, saving: calculateSaving(base, final, item.discount) }
                            }
                        });
                    }
                });
            } catch (e) {}
            return pageGames;
        };

        const results = await Promise.all([1, 2, 3].map(fetchPage));
        results.flat().forEach(g => {
            if (!gamesMap.has(g.dealID)) {
                gamesMap.set(g.dealID, g);
            } else {
                gamesMap.get(g.dealID).prices[cur] = g.prices[cur];
            }
        });
    }
    return Array.from(gamesMap.values());
}

// 3. EPIC GAMES DEALS
async function getEpicDeals() {
    const gamesMap = new Map();
    const regions = [ 
        { country: 'US', cur: 'USD', locale: 'en-US' }, 
        { country: 'DE', cur: 'EUR', locale: 'de-DE' }, 
        { country: 'UA', cur: 'UAH', locale: 'uk-UA' } 
    ];
    let browser = null;

    try {
        console.log('📡 [Epic Games] Запуск браузера...');
        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 720 });
        await page.goto('https://store.epicgames.com/en-US/', { waitUntil: 'networkidle2', timeout: 30000 });

        for (const region of regions) {
            const elements = await page.evaluate(async (reg) => {
                const url = 'https://store.epicgames.com/graphql';
                
                const fetchPages = async (sortBy) => {
                    let start = 0;
                    const count = 100;
                    let hasMore = true;
                    const results = [];

                    while (hasMore) {
                        const payload = {
                            operationName: "searchStoreQuery",
                            variables: {
                                category: "games/edition/base|bundles/games|games/edition/deluxe|games/edition/ultimate",
                                count: count,
                                start: start,
                                country: reg.country,
                                locale: reg.locale,
                                sortBy: sortBy, 
                                sortDir: "DESC",
                                withPrice: true
                            },
                            query: `query searchStoreQuery($category: String, $count: Int, $start: Int, $country: String!, $locale: String, $sortBy: String, $sortDir: String, $withPrice: Boolean = false) {
                                Catalog { searchStore(category: $category, count: $count, start: $start, country: $country, locale: $locale, sortBy: $sortBy, sortDir: $sortDir, onSale: true) { elements { title id productSlug urlSlug offerType catalogNs { mappings { pageSlug } } keyImages { type url } price(country: $country) @include(if: $withPrice) { totalPrice { discountPrice originalPrice } } } } }
                            }`
                        };

                        try {
                            const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                            const json = await res.json();
                            const items = json?.data?.Catalog?.searchStore?.elements || [];
                            
                            results.push(...items);
                            
                            if (items.length < count || results.length >= 400) {
                                hasMore = false;
                            } else {
                                start += count;
                            }
                        } catch (e) {
                            hasMore = false;
                        }
                    }
                    return results;
                };

                try {
                    const [itemsAAA, itemsFresh] = await Promise.all([
                        fetchPages('currentPrice'),
                        fetchPages('releaseDate')
                    ]);
                    const allItems = [...itemsAAA, ...itemsFresh];
                    
                    const uniqueMap = new Map();
                    allItems.forEach(item => { if (item && item.id) uniqueMap.set(item.id, item); });
                    return Array.from(uniqueMap.values());
                } catch (e) { return []; }
            }, region);

            elements.forEach(item => {
                const totalPrice = item.price?.totalPrice;
                if (!totalPrice) return;
                const base = parseCentPrice(totalPrice.originalPrice);
                const discount = parseCentPrice(totalPrice.discountPrice);

                if (base === null || discount === null || discount >= base) return;

                let slug = null;
                if (item.catalogNs?.mappings?.length > 0) {
                    const validMapping = item.catalogNs.mappings.find(m => m.pageSlug && m.pageSlug !== 'home');
                    if (validMapping) slug = validMapping.pageSlug;
                }
                if (!slug && item.productSlug) slug = item.productSlug;
                if (!slug && item.urlSlug) slug = item.urlSlug;
                if (!slug || slug === 'home' || slug.trim() === '' || !item.title) return;
                slug = slug.replace(/\/home$/, '').replace(/\/purchase$/, '').trim();

                const imageObj = (item.keyImages || []).find(img => img.type === 'OfferImageWide' || img.type === 'DieselStoreFrontWide' || img.type === 'Thumbnail');
                const dealID = `epic-${item.id}`;
                const finalUrl = item.offerType === 'BUNDLE' ? `https://store.epicgames.com/en-US/bundles/${slug}` : `https://store.epicgames.com/en-US/p/${slug}`;

                const priceData = { sale: discount, normal: base, saving: calculateSaving(base, discount, 0) };

                if (!gamesMap.has(dealID)) {
                    gamesMap.set(dealID, {
                        title: item.title,
                        storeID: 'epic',
                        storeName: 'Epic Games',
                        dealID: dealID,
                        GameID: dealID,
                        thumb: imageObj ? imageObj.url : '',
                        url: finalUrl,
                        prices: { [region.cur]: priceData }
                    });
                } else {
                    gamesMap.get(dealID).prices[region.cur] = priceData;
                }
            });
        }
        await browser.close();
        return Array.from(gamesMap.values());
    } catch (err) {
        if (browser) await browser.close();
        return [];
    }
}

// Сохранение в БД + Удаление пропавших скидок
async function fetchAndSaveGames() {
    const startTime = Date.now();
    try {
        console.log('🔄 Запуск сбора данных со всех магазинов...');
        const results = await Promise.allSettled([ getSteamDeals(), getGogDeals(), getEpicDeals() ]);

        const steamDeals = results[0].status === 'fulfilled' ? results[0].value : [];
        const gogDeals = results[1].status === 'fulfilled' ? results[1].value : [];
        const epicDeals = results[2].status === 'fulfilled' ? results[2].value : [];

        const allGames = [...steamDeals, ...gogDeals, ...epicDeals];
        const validGames = allGames.filter(isValidGameDeal);

        console.log(`✅ Найдено ${validGames.length} валидных скидок.`);
        
        if (validGames.length > 0) {
            const bulkOps = validGames.map(game => {
                const { prices, ...baseData } = game;
                const updateObj = { $set: { ...baseData, lastUpdated: Date.now() } };

                if (prices) {
                    for (const [currency, priceData] of Object.entries(prices)) {
                        updateObj.$set[`prices.${currency}`] = priceData;
                    }
                }

                return {
                    updateOne: {
                        filter: { dealID: game.dealID },
                        update: updateObj,
                        upsert: true
                    }
                };
            });

            await Game.bulkWrite(bulkOps);

            // ОЧИСТКА: Удаляем игры, которые не были обновлены в этот цикл
            const processedStores = [];
            if (results[0].status === 'fulfilled') processedStores.push('steam');
            if (results[1].status === 'fulfilled') processedStores.push('gog');
            if (results[2].status === 'fulfilled') processedStores.push('epic');

            if (processedStores.length > 0) {
                const cleanResult = await Game.deleteMany({
                    storeID: { $in: processedStores },
                    lastUpdated: { $lt: startTime }
                });
                console.log(`🧹 Очистка: удалено ${cleanResult.deletedCount} игр (скидки закончились).`);
            }
        }

        console.log(`💾 Успешно сохранено/обновлено: ${validGames.length} игр.`);
    } catch (e) {
        console.error('❌ Глобальная ошибка в fetchAndSaveGames:', e);
    }
}

// ---------------- REST API ----------------

// 1. Получить игры (С пагинацией и сортировкой на уровне БД)
app.get('/api/games', async (req, res) => {
    try {
        const { store, minPrice, maxPrice, minDiscount, currency, search, page = 1, limit = 30 } = req.query;

        if (minPrice && isNaN(Number(minPrice))) return res.status(400).json({ error: 'Invalid minPrice parameter' });
        if (maxPrice && isNaN(Number(maxPrice))) return res.status(400).json({ error: 'Invalid maxPrice parameter' });
        if (minDiscount && isNaN(Number(minDiscount))) return res.status(400).json({ error: 'Invalid minDiscount parameter' });

        let query = {};
        
        if (store) query.storeID = { $in: store.split(',') };

        // ИЗМЕНЕННЫЙ БЛОК ПОИСКА ПО ПЕРВЫМ БУКВАМ СЛОВ
        if (search && search.trim() !== '') {
            const escapedSearch = search.trim().replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
            // (^|\\s) проверяет, что это либо начало названия, либо начало нового слова после пробела
            query.title = { $regex: '(^|\\s)' + escapedSearch, $options: 'i' };
        }

        const cur = currency || 'USD';
        query[`prices.${cur}`] = { $exists: true }; 

        if (minPrice || maxPrice) {
            query[`prices.${cur}.sale`] = {};
            if (minPrice) query[`prices.${cur}.sale`].$gte = Number(minPrice);
            if (maxPrice) query[`prices.${cur}.sale`].$lte = Number(maxPrice);
        }
        
        if (minDiscount) {
            query[`prices.${cur}.saving`] = { $gte: Number(minDiscount) };
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);

        // ПАГИНАЦИЯ + СОРТИРОВКА В БД (Сначала самые дорогие по базовой цене)
        const games = await Game.find(query)
            .sort({ [`prices.${cur}.normal`]: -1, [`prices.${cur}.saving`]: -1 })
            .skip(skip)
            .limit(parseInt(limit)); 
            
        res.json(games);
    } catch (e) {
        console.error("Ошибка при поиске в БД:", e);
        res.status(500).json({ error: 'Database error' });
    }
});

cron.schedule('0 */3 * * *', () => {
    console.log('⏰ Автоматический запуск парсинга...');
    fetchAndSaveGames();
});

app.listen(port, () => {
    console.log(`🚀 Сервер запущен на порту ${port}`);
    // Запускаем парсинг при старте сервера
    // fetchAndSaveGames(); 
});