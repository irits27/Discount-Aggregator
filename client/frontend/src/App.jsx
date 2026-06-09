import { useEffect, useState, useRef } from 'react';
import axios from 'axios';
import './App.css';

const API_URL = 'http://localhost:5000/api';
const fallbackSvg = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 460 215'><defs><linearGradient id='grad' x1='0' y1='0' x2='1' y2='1'><stop offset='0%25' stop-color='%23b000ff'/><stop offset='100%25' stop-color='%2300fff0'/></linearGradient></defs><rect width='100%25' height='100%25' fill='%23161820'/><path d='M230 40 L380 160 L230 130 L80 160 Z' fill='url(%23grad)' opacity='0.2'/><path d='M230 65 L340 150 L230 120 L120 150 Z' fill='url(%23grad)' opacity='0.4'/><g><circle cx='230' cy='107' r='20' fill='none' stroke='url(%23grad)' stroke-width='4' opacity='0.8'/><animateTransform attributeName='transform' type='rotate' from='0 230 107' to='360 230 107' dur='4s' repeatCount='indefinite'/></g></svg>";

// === Компонент космического фона ===
function ParticleBackground() {
    const canvasRef = useRef(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        let particlesArray = [];
        let animationFrameId;

        class Particle {
            constructor() {
                this.x = Math.random() * canvas.width;
                this.y = Math.random() * canvas.height;
                this.size = Math.random() * 2 + 0.5; 
                this.speedX = Math.random() * 0.4 - 0.2; 
                this.speedY = Math.random() * 0.4 - 0.2; 
                const colors = ['rgba(0, 255, 240, 0.4)', 'rgba(176, 0, 255, 0.4)', 'rgba(255, 255, 255, 0.2)'];
                this.color = colors[Math.floor(Math.random() * colors.length)];
            }
            update() {
                this.x += this.speedX; this.y += this.speedY;
                if (this.x < 0) this.x = canvas.width; if (this.x > canvas.width) this.x = 0;
                if (this.y < 0) this.y = canvas.height; if (this.y > canvas.height) this.y = 0;
            }
            draw() {
                ctx.fillStyle = this.color; ctx.beginPath(); ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2); ctx.fill();
            }
        }

        function initCanvas() {
            canvas.width = window.innerWidth; 
            canvas.height = window.innerHeight;
            particlesArray = [];
            let numberOfParticles = (canvas.width * canvas.height) / 7000; 
            for (let i = 0; i < numberOfParticles; i++) { particlesArray.push(new Particle()); }
        }

        function animateParticles() {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            for (let i = 0; i < particlesArray.length; i++) { particlesArray[i].update(); particlesArray[i].draw(); }
            animationFrameId = requestAnimationFrame(animateParticles);
        }

        window.addEventListener('resize', initCanvas);
        initCanvas();
        animateParticles();

        return () => {
            window.removeEventListener('resize', initCanvas);
            cancelAnimationFrame(animationFrameId);
        };
    }, []);

    return <canvas ref={canvasRef} id="canvas-bg"></canvas>;
}

// === Главный компонент приложения ===
function App() {
    const [games, setGames] = useState([]);
    const [isLoading, setIsLoading] = useState(false);
    
    // Фильтры
    const [stores, setStores] = useState({ steam: true, epic: true, gog: true });
    const [minPrice, setMinPrice] = useState('');
    const [maxPrice, setMaxPrice] = useState('');
    const [minDiscount, setMinDiscount] = useState(0);

    const fetchGames = async () => {
        setIsLoading(true);
        try {
            const checkedStores = Object.keys(stores).filter(key => stores[key]).join(',');
            const params = new URLSearchParams();
            if (checkedStores) params.append('store', checkedStores);
            if (minPrice) params.append('minPrice', minPrice);
            if (maxPrice) params.append('maxPrice', maxPrice);
            if (minDiscount > 0) params.append('minDiscount', minDiscount);

            const res = await axios.get(`${API_URL}/games?${params.toString()}`);
            let data = res.data || [];
            
            data.sort((a, b) => {
                if (b.normalPrice !== a.normalPrice) return b.normalPrice - a.normalPrice;
                return b.saving - a.saving;
            });

            setGames(data);
        } catch (err) {
            console.error("Ошибка при загрузке:", err);
        } finally {
            setTimeout(() => setIsLoading(false), 300);
        }
    };

    // Эффект авто-обновления + ПЛАВНЫЙ СКРОЛЛ НАВЕРХ при изменении критериев
    useEffect(() => {
        const timeoutId = setTimeout(() => {
            fetchGames();
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }, 400);
        return () => clearTimeout(timeoutId);
    }, [stores, minPrice, maxPrice, minDiscount]);

    // Генератор искр при клике
    const handleSparks = (e) => {
        if (e.target.tagName.toLowerCase() === 'input') return;
        const btn = e.currentTarget;
        const colors = ['#00fff0', '#b000ff', '#ffffff', '#00bfff'];
        const particleCount = Math.floor(Math.random() * 5) + 8;

        for (let i = 0; i < particleCount; i++) {
            const spark = document.createElement('div');
            spark.classList.add('spark');
            spark.style.background = colors[Math.floor(Math.random() * colors.length)];
            spark.style.boxShadow = `0 0 10px ${spark.style.background}`;

            const angle = Math.random() * Math.PI * 2;
            const distance = 30 + Math.random() * 50; 
            const tx = Math.cos(angle) * distance;
            const ty = Math.sin(angle) * distance;
            
            spark.style.setProperty('--tx', `${tx}px`);
            spark.style.setProperty('--ty', `${ty}px`);
            btn.appendChild(spark);
            setTimeout(() => spark.remove(), 600);
        }
    };

    const handleClearDB = async () => {
        if(window.confirm('Очистить БД?')) { 
            setIsLoading(true);
            try {
                await axios.get(`${API_URL}/clear-database`); 
                fetchGames();
            } catch (err) {
                alert('Ошибка очистки');
            }
        }
    };

    const handleFetchNewDeals = async () => {
        setIsLoading(true);
        try { 
            await axios.get(`${API_URL}/fetch-now`); 
            fetchGames();
        } catch(e) { 
            alert('Ошибка парсинга!'); 
            setIsLoading(false);
        }
    };

    const getValidImage = (game) => {
        let currentImg = game.thumb ? game.thumb : fallbackSvg;
        if (currentImg.includes('steam')) {
            const match = currentImg.match(/(?:apps|capsules|steamcommunity.*?\/)\/([0-9]+)/) || currentImg.match(/\/([0-9]+)\//);
            if (match && match[1]) currentImg = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${match[1]}/header.jpg`;
        }
        return currentImg;
    };

    return (
        <>
            <ParticleBackground />

            <header>
                <div className="logo-container">
                    <svg className="site-logo" viewBox="0 0 300 300" xmlns="http://www.w3.org/2000/svg">
                        <defs><linearGradient id="grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="#b000ff"/><stop offset="100%" stopColor="#00fff0"/></linearGradient></defs>
                        <path d="M150 40 L280 240 L150 200 L20 240 Z" fill="url(#grad)" opacity="0.6"/>
                        <path d="M150 80 L240 220 L150 190 L60 220 Z" fill="url(#grad)" opacity="0.8"/>
                    </svg>
                    <h1>Nebula Deals</h1>
                </div>
                <div className="header-buttons">
                    <button className="btn-action" onClick={handleClearDB} style={{background: 'linear-gradient(45deg, #ff0055, #ff4400)'}}>
                        Очистить БД
                    </button>
                    <button className="btn-action" onClick={handleFetchNewDeals}>
                        Обновить скидки
                    </button>
                </div>
            </header>
            
            <div className="main-container">
                <aside className="filters-panel">
                    <div className="filter-group">
                        <h3>Магазины</h3>
                        <div className="filter-buttons-wrapper">
                            <label className="filter-btn" onClick={handleSparks}>
                                <input type="checkbox" className="store-checkbox" checked={stores.steam} onChange={() => setStores(s => ({...s, steam: !s.steam}))} />
                                <span><div className="status-dot"></div> Steam</span>
                            </label>
                            <label className="filter-btn" onClick={handleSparks}>
                                <input type="checkbox" className="store-checkbox" checked={stores.epic} onChange={() => setStores(s => ({...s, epic: !s.epic}))} />
                                <span><div className="status-dot"></div> Epic Games</span>
                            </label>
                            <label className="filter-btn" onClick={handleSparks}>
                                <input type="checkbox" className="store-checkbox" checked={stores.gog} onChange={() => setStores(s => ({...s, gog: !s.gog}))} />
                                <span><div className="status-dot"></div> GOG</span>
                            </label>
                        </div>
                    </div>
                    <div className="filter-group">
                        <h3>Цена ($)</h3>
                        <div className="price-inputs">
                            <div className="input-wrapper">
                                <span className="currency">$</span>
                                <input type="number" placeholder="Мин" value={minPrice} onChange={e => setMinPrice(e.target.value)} />
                            </div>
                            <div className="input-wrapper">
                                <span className="currency">$</span>
                                <input type="number" placeholder="Макс" value={maxPrice} onChange={e => setMaxPrice(e.target.value)} />
                            </div>
                        </div>
                    </div>
                    <div className="filter-group">
                        <h3>Минимальная скидка</h3>
                        <label style={{display: 'flex', alignItems: 'center', cursor: 'pointer'}}>
                            <input type="range" min="0" max="90" step="10" value={minDiscount} onChange={e => setMinDiscount(e.target.value)} />
                            <span style={{marginLeft: '15px', fontWeight: 'bold', color: 'var(--accent-cyan)'}}>{minDiscount}%</span>
                        </label>
                    </div>
                </aside>
                
                <div className={`grid-wrapper ${isLoading ? 'is-loading' : ''}`}>
                    <div className="nebula-loader"></div>
                    <main className={`games-grid ${isLoading ? 'updating' : ''}`}>
                        {games.length === 0 && !isLoading ? (
                            <h2 style={{gridColumn: '1/-1', textAlign: 'center', color: '#888'}}>Игр не найдено 😕</h2>
                        ) : (
                            games.map((game, index) => {
                                const delay = Math.min(index * 40, 1000);
                                return (
                                    <div className="game-card" style={{animationDelay: `${delay}ms`}} key={game._id || index}>
                                        <div className="game-thumb-wrapper">
                                            <img className="game-thumb" src={getValidImage(game)} alt={game.title} referrerPolicy="no-referrer" onError={(e) => { e.target.onerror = null; e.target.src = fallbackSvg; }} />
                                            <span className={`store-badge badge-${game.storeID}`}>{game.storeName}</span>
                                        </div>
                                        <div className="game-info">
                                            <h2 className="game-title">{game.title}</h2>
                                            <div className="price-row">
                                                <span className="discount-tag">-{game.saving}%</span>
                                                <span className="sale-price">${game.salePrice}</span>
                                                <span className="old-price">${game.normalPrice}</span>
                                            </div>
                                            <a href={game.url} target="_blank" rel="noopener noreferrer" className="buy-btn">В магазин</a>
                                        </div>
                                    </div>
                                );
                            })
                        )}
                    </main>
                </div>
            </div>
        </>
    );
}

export default App;