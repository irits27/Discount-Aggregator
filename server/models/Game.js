const mongoose = require('mongoose');

const gameSchema = new mongoose.Schema({
    title: { type: String, required: true },
    GameID: { type: String, required: true },
    dealID: { type: String, required: true },
    storeID: { type: String, required: true },
    storeName: { type: String, required: true },
    thumb: { type: String },
    url: { type: String, required: true, unique: true },
    lastUpdated: { type: Date, default: Date.now },
    prices: {
        type: Map,
        of: {
            sale: { type: Number, required: true },
            normal: { type: Number, required: true },
            saving: { type: Number, required: true }
        }
    }
});

module.exports = mongoose.model('Game', gameSchema);