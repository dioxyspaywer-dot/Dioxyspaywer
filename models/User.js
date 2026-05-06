const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    fullName: { type: String, required: true },
    phone: { type: String, required: true, unique: true },
    country: { type: String, required: true },
    password: { type: String, required: true },
    role: { type: String, default: 'user' }, // 'user' ou 'admin'
    
    balance: { type: Number, default: 0 },
    
    // Produits
    hasLongTerm: { type: Boolean, default: false },
    longTermStartDate: { type: Date },
    shortTermProducts: [{  // ✅ CORRECTION ICI
        type: String,
        amount: Number,
        dailyGain: Number,
        startDate: Date,
        unlockDate: Date
    }],
    
    // Parrainage
    referralCode: { type: String, unique: true, sparse: true },
    referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    referralCount: { type: Number, default: 0 },
    referralEarnings: { type: Number, default: 0 },
    
    // Limites mensuelles
    monthlyPurchasesCount: { type: Number, default: 0 },
    lastPurchaseMonth: { type: String },
    
    // Retraits
    lastWithdrawDate: { type: Date },
    
    // Statut
    isActive: { type: Boolean, default: true }
}, { timestamps: true });

// Générer un code parrainage unique avant sauvegarde
userSchema.pre('save', function(next) {
    if (!this.referralCode) {
        this.referralCode = Math.floor(1000 + Math.random() * 9000) + '-' + 
                           Math.random().toString(36).substring(2, 6).toUpperCase();
    }
    next();
});

module.exports = mongoose.model('User', userSchema);
