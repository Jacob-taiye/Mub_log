const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
    user_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    product_name: String,
    price: Number,
    product_link: String,
    details: String,
    type: {
        type: String,
        enum: ['PRODUCT', 'SMS', 'SMM'],
        default: 'PRODUCT'
    },
    status: {
        type: String,
        default: 'COMPLETED'
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model('Order', orderSchema);