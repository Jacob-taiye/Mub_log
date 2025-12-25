const mongoose = require('mongoose');

const allowedServiceSchema = new mongoose.Schema({
    service_name: {
        type: String,
        required: true,
        unique: true,
        lowercase: true
    },
    display_name: {
        type: String,
        required: true
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model('AllowedService', allowedServiceSchema);