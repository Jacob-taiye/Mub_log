const mongoose = require('mongoose');

const smsOrderSchema = new mongoose.Schema({
    user_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    order_id_5sim: String,
    phone: String,
    service: String,
    country: String,
    operator: String,
    price: Number,
    sms_code: String,
    status: {
        type: String,
        default: 'ACTIVE'
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model('SMSOrder', smsOrderSchema);