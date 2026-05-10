const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    // --- INFORMATIONS UTILISATEUR ---
    fullName: { type: String, required: true },
    phone: { type: String, required: true, unique: true },
    country: { type: String, required: true },
    password: { type: String, required: true },
    role: { type: String, default: 'user' }, // 'user' ou 'admin'
    
    // --- SOLDES ---
    balance: { type: Number, default: 0 }, // Solde DÉPÔT (pour acheter des produits)
    withdrawalBalance: { type: Number, default: 0 }, // Solde RETRAITE (gains libérés uniquement)
    
    // --- PRODUIT LONG TERME (UNIQUE : 2000F) ---
    hasLongTerm: { type: Boolean, default: false },
    longTermStartDate: { type: Date },
    longTermAccumulatedGains: { type: Number, default: 0 }, // Gains accumulés LT
    longTermFinished: { type: Boolean, default: false },   // Indicateur de fin de cycle
    
    // --- PRODUITS COURTS TERMES ---
    shortTermProducts: [{
        type: { type: String, required: true },      // ex: 'prod1', 'prod2'...
        amount: { type: Number, required: true },    // Capital investi
        dailyGain: { type: Number, required: true }, // Gain par jour
        startDate: { type: Date, required: true },   // Date de début
        unlockDate: { type: Date, required: true },  // Date de fin (J+5)
        accumulatedGains: { type: Number, default: 0 } // Gains accumulés CT
    }],
    
    // --- PARRAINAGE ---
    referralCode: { type: String, unique: true, sparse: true },
    referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    referralCount: { type: Number, default: 0 },
    referralEarnings: { type: Number, default: 0 },
    
    // --- LIMITES D'ACHAT ---
    monthlyPurchasesCount: { type: Number, default: 0 },
    lastPurchaseMonth: { type: String },
    
    // --- GESTION DES RETRAITS ---
    lastWithdrawDate: { type: Date },
    
    // --- STATUT DU COMPTE ---
    isActive: { type: Boolean, default: true }
}, { 
    timestamps: true // Ajoute automatiquement createdAt et updatedAt
});

// Génération automatique d'un code parrainage unique avant la première sauvegarde
userSchema.pre('save', function(next) {
    if (!this.referralCode) {
        this.referralCode = Math.floor(1000 + Math.random() * 9000) + '-' + 
                           Math.random().toString(36).substring(2, 6).toUpperCase();
    }
    next();
});

module.exports = mongoose.model('User', userSchema);
