import {useEffect, useState} from 'react';
import './App.css';
import axios from 'axios';

function App() {
  const [games, setGames] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    // Fetch games from the backend API
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
    fetchGames();
  }, []);

  if (loading) return <div>Loading...</div>;
  if (error) return <div>{error}</div>;

  return (
    <div className="App">
      <h1>Game Deals</h1>
      <div className="game-list">
        {games.map(game => (
          <div key={game._id} className="game-card">
            <img src={game.thumb} alt={game.title} />
            <h2>{game.title}</h2>
            <p>Sale Price: ${game.salePrice}</p>
            <p>Normal Price: ${game.normalPrice}</p>
            <p>Savings: {game.saving}%</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export default App;