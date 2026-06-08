const mongoose = require('mongoose');

const gameSchema = new mongoose.Schema({
    title: { type: String, required: true },
    GameID: { type: String, required: true},
    dealID: { type: String, required: true },
    storeID: { type: String, required: true }, //steam, epic, gog
    storeName: { type: String, required: true },
    salePrice: { type: Number, required: true },
    normalPrice: { type: Number, required: true },
    saving: { type: Number, required: true },
    thumb: { type: String},
    url: { type: String, required: true, unique: true }, //url on game
    lastUpdated: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Game', gameSchema);
