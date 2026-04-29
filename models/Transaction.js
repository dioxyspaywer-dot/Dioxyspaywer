const mongoose = require('mongoose');

const TransactionSchema = new mongoose.Schema({
    userId: mongoose.Schema.Types.ObjectId,
    type: { type: String, enum: ['DEPOSIT', 'WITHDRAWAL', 'INVESTMENT', 'GAIN', 'REFERRAL_BONUS', 'ADMIN_SEIZE'], required: true },
    amount: Number,
    method: String,
    status: { type: String, enum: ['PENDING', 'SUCCESS', 'FAILED'], default: 'PENDING' },
    reference: String,
    date: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Transaction', TransactionSchema);
