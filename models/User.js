const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    fullName: { type: String, required: true },
    phone: { type: String, required: true, unique: true },
    country: { type: String, required: true },
    password: { type: String, required: true },
    role: { type: String, default: 'user' },
    
    balance: { type: Number, default: 0 },
    
    // --- PRODUITS ---
    hasLongTerm: { type: Boolean, default: false },
    longTermStartDate: { type: Date },
    
    // ✅ CORRECTION ICI : On définit explicitement la structure des objets
    shortTermProducts: [{
        type: { type: String, required: true },      // ex: 'prod1'
        amount: { type: Number, required: true },    // ex: 2000
        dailyGain: { type: Number, required: true }, // ex: 1000
        startDate: { type: Date, required: true },
        unlockDate: { type: Date, required: true }
    }],
    
    // --- PARRAINAGE ---
    referralCode: { type: String, unique: true, sparse: true },
    referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    referralCount: { type: Number, default: 0 },
    referralEarnings: { type: Number, default: 0 },
    
    // --- LIMITES ---
    monthlyPurchasesCount: { type: Number, default: 0 },
    lastPurchaseMonth: { type: String },
    
    // --- RETRAITS ---
    lastWithdrawDate: { type: Date },
    
    // --- STATUT ---
    isActive: { type: Boolean, default: true }
}, { 
    timestamps: true,
    strict: true // On garde strict true car on a défini le schéma ci-dessus
});

// Génération automatique du code parrainage
userSchema.pre('save', function(next) {
    if (!this.referralCode) {
        this.referralCode = Math.floor(1000 + Math.random() * 9000) + '-' + 
                           Math.random().toString(36).substring(2, 6).toUpperCase();
    }
    next();
});

module.exports = mongoose.model('User', userSchema);
