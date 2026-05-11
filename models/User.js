const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    fullName: { type: String, required: true },
    phone: { type: String, required: true, unique: true },
    country: { type: String, required: true },
    password: { type: String, required: true },
    role: { type: String, default: 'user' },
    
    balance: { type: Number, default: 0 },
    withdrawalBalance: { type: Number, default: 0 },
    
    hasLongTerm: { type: Boolean, default: false },
    longTermStartDate: { type: Date },
    longTermAccumulatedGains: { type: Number, default: 0 },
    longTermFinished: { type: Boolean, default: false },
    
    shortTermProducts: [{
        type: { type: String, required: true },
        amount: { type: Number, required: true },
        dailyGain: { type: Number, required: true },
        startDate: { type: Date, required: true },
        unlockDate: { type: Date, required: true },
        accumulatedGains: { type: Number, default: 0 }
    }],
    
    referralCode: { type: String, unique: true, sparse: true },
    referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    referralCount: { type: Number, default: 0 },
    referralEarnings: { type: Number, default: 0 },
    
    monthlyPurchasesCount: { type: Number, default: 0 },
    lastPurchaseMonth: { type: String },
    lastWithdrawDate: { type: Date },
    isActive: { type: Boolean, default: true }
}, { timestamps: true });

userSchema.pre('save', function(next) {
    if (!this.referralCode) {
        this.referralCode = Math.floor(1000 + Math.random() * 9000) + '-' + 
                           Math.random().toString(36).substring(2, 6).toUpperCase();
    }
    next();
});

module.exports = mongoose.model('User', userSchema);
