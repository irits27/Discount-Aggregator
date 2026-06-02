const mongoose = require('mongoose');

const gameSchema = new mongoose.Schema({
    title: { type: String, required: true },
    GameID: { type: String, required: true, unique: true },
    salePrice: { type: Number, required: true },
    normalPrice: { type: Number, required: true },
    saving: { type: Number, required: true },
    thumb: { type: String},
    lastUpdated: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Game', gameSchema);
