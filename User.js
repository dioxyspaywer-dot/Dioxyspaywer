const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
    fullName: { type: String, required: true },
    phone: { type: String, required: true, unique: true },
    country: { type: String, enum: ['Togo', 'Côte d\'Ivoire', 'Bénin'], required: true },
    password: { type: String, required: true },
    balance: { type: Number, default: 0 },
    
    // Parrainage
    referralCode: { type: String, unique: true, sparse: true },
    referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    referralCount: { type: Number, default: 0 },
    referralEarnings: { type: Number, default: 0 },
    
    // Produit Long Terme
    hasLongTerm: { type: Boolean, default: false },
    longTermStartDate: { type: Date },
    
    // Retraits
    lastWithdrawDate: { type: Date },
    
    // Limites mensuelles
    monthlyPurchasesCount: { type: Number, default: 0 },
    lastPurchaseMonth: { type: String, default: '' },
    
    // Produits courts termes
    shortTermProducts: [{
        type: String,
        amount: Number,
        dailyGain: Number,
        startDate: { type: Date, default: Date.now },
        unlockDate: { type: Date }
    }],
    
    role: { type: String, default: 'user', enum: ['user', 'admin'] },
    isActive: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now }
});

UserSchema.pre('save', function(next) {
    if (this.isNew && !this.referralCode) {
        const randomPart = Math.random().toString(36).substring(2, 6).toUpperCase();
        this.referralCode = `${this.phone.substring(this.phone.length - 4)}-${randomPart}`;
    }
    next();
});

module.exports = mongoose.model('User', UserSchema);