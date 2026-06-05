import { useEffect, useState, useRef } from 'react';
import './App.css';
import axios from 'axios';

const STORES = {
  '1': 'Steam',
  '2': 'GreenManGaming',
  '3': 'GOG',
  '7': 'Uplay',
  '11': 'Humble Store',
  '25': 'Epic Games Store',
};

// Отдельный компонент карточки, который умеет плавно появляться при скролле
function AnimatedGameCard({ game }) {
  const cardRef = useRef(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        // Если карточка пересекла границу экрана хотя бы на 10%
        if (entry.isIntersecting) {
          cardRef.current.classList.add('visible');
          observer.unobserve(cardRef.current); // Перестаем следить, когда уже появилась
        }
      },
      { threshold: 0.1 } // Процент видимости карточки для старта анимации
    );

    if (cardRef.current) {
      observer.observe(cardRef.current);
    }

    return () => {
      if (cardRef.current) observer.unobserve(cardRef.current);
    };
  }, []);

  return (
    <div ref={cardRef} className="game-card">
      <div className="discount-badge">-{game.savings || game.saving}%</div>
      <img src={game.thumb} alt={game.title} />
      <div className="game-info">
        <h2>{game.title}</h2>
        <p className="store-info">
          Store: <strong>{STORES[game.storeID] || 'Unknown Store'}</strong>
        </p>
        <div className="prices">
          <p style={{ color: '#2ed573', margin: 0 }}>Sale Price: <strong>${game.salePrice}</strong></p>
          <p style={{ margin: 0 }}>Normal Price: <span className="old-price">${game.normalPrice}</span></p>
        </div>
        <a 
          href={`https://www.cheapshark.com/redirect?dealID=${game.dealID}`} 
          target="_blank" 
          rel="noopener noreferrer" 
          className="buy-btn"
        >
          Buy on {STORES[game.storeID] || 'Store'}
        </a>
      </div>
    </div>
  );
}

function App() {
  const [games, setGames] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isUpdating, setIsUpdating] = useState(false);

  const fetchGames = async () => {
    try { 
      const response = await axios.get('http://localhost:5000/api/games');
      setGames(response.data);
      setLoading(false);
    } catch (err) {
      setError('Error fetching games');
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchGames();
  }, []);

  const handleRefresh = async () => {
    setIsUpdating(true);
    try {
      await axios.get('http://localhost:5000/api/fetch-now');
      await fetchGames();
    } catch (err) {
      alert('Error updating database');
    } finally {
      setIsUpdating(false);
    }
  };

  if (loading) return <div>Loading...</div>;
  if (error) return <div>{error}</div>;

  return (
    <div className="App">
      <header className="app-header">
        <h1>Game Deals</h1>
        <button 
          className="refresh-btn" 
          onClick={handleRefresh} 
          disabled={isUpdating}
        >
          {isUpdating ? 'Updating Database...' : '🔄 Find New Deals'}
        </button>
      </header>

      <div className="game-list">
        {games.map(game => (
          // Используем наш новый анимированный компонент вместо обычной разметки
          <AnimatedGameCard key={game._id} game={game} />
        ))}
      </div>
    </div>
  );
}

export default App;