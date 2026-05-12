const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    
    // Types de transactions autorisés
    type: { 
        type: String, 
        enum: ['DEPOSIT', 'WITHDRAWAL', 'INVESTMENT', 'GAIN', 'REFERRAL_BONUS'], 
        required: true 
    },
    
    amount: { type: Number, required: true },
    method: { type: String }, // Ex: TMONEY, MOOV, MTN_CI, etc.
    
    status: { 
        type: String, 
        enum: ['PENDING', 'SUCCESS', 'FAILED'], 
        default: 'PENDING' 
    },
    
    reference: { type: String, required: true, unique: true }, // Référence interne (ex: DXP_...)
    sendavaReference: { type: String }, // ✅ Référence externe Sendavapay (ex: pay_abc123)
    
    description: { type: String }, // Description optionnelle
    date: { type: Date, default: Date.now }
}, { timestamps: true });

module.exports = mongoose.model('Transaction', transactionSchema);
