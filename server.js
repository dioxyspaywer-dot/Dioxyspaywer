require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const cron = require('node-cron');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const path = require('path');

// Vérification des modèles (CRUCIAL)
let User, Transaction;
try {
    User = require('./models/User');
    Transaction = require('./models/Transaction');
    console.log("✅ Modèles chargés avec succès");
} catch (err) {
    console.error("❌ ERREUR CRITIQUE : Les fichiers models/User.js ou models/Transaction.js sont manquants ou contiennent une erreur.");
    console.error(err);
    // On arrête tout de suite pour éviter un plantage silencieux
    process.exit(1); 
}

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let isSiteActive = true;

// Connexion DB avec gestion d'erreur stricte
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ MongoDB Connecté'))
    .catch(err => {
        console.error(' ÉCHEC CONNEXION MONGODB:', err.message);
        process.exit(1);
    });

// Middleware Auth simple
const authMiddleware = async (req, res, next) => {
    if (!isSiteActive) return res.status(503).json({ error: 'SITE_CLOSED' });
    const token = req.headers.authorization;
    if (!token) return res.status(401).json({ error: 'Pas de token' });
    
    try {
        const decoded = jwt.verify(token.split(' ')[1], process.env.JWT_SECRET);
        req.user = await User.findById(decoded.id);
        if (!req.user) return res.status(404).json({ error: 'User introuvable' });
        next();
    } catch (e) {
        return res.status(401).json({ error: 'Token invalide' });
    }
};

// Routes Simples
app.get('/api/status', (req, res) => res.json({ active: isSiteActive }));

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

        // --- LOGIQUE DE PARRAINAGE (À RÉINTÉGRER) ---
        if (referralCode && referralCode.trim() !== '') {
            const sponsor = await User.findOne({ referralCode: referralCode.trim() });
            if (sponsor) {
                referredByUserId = sponsor._id;
                
                // Créditer les 350 FCFA au parrain
                sponsor.balance += 350;
                sponsor.referralCount += 1;
                sponsor.referralEarnings += 350;
                await sponsor.save(); // Sauvegarder les modifications du parrain
                
                // Créer une transaction pour le bonus
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
        // ---------------------------------------------
        
        await User.create({ fullName, phone, country, password: hashedPassword, role, referredBy: referredByUserId });
        res.json({ success: true, message: 'Inscription réussie' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});
app.post('/api/login', async (req, res) => {
    try {
        const { phone, password } = req.body;
        const user = await User.findOne({ phone });
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(400).json({ error: 'Identifiants incorrects' });
        }
        
        const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '24h' });
        
        // Calcul simple du solde retrait
        let withdrawBalance = 0;
        const now = new Date();
        // ... (logique simplifiée pour éviter les erreurs)
        if(user.shortTermProducts) {
             user.shortTermProducts.forEach(p => {
                 if(new Date(p.unlockDate) <= now) withdrawBalance += (p.amount + (p.dailyGain * 5));
             });
        }
        if(user.hasLongTerm && user.longTermStartDate) {
             const days = Math.floor((now - new Date(user.longTermStartDate)) / (1000*60*60*24));
             if(days >= 55) withdrawBalance += (700*55);
             else if(days > 0) withdrawBalance += (700*days);
        }

        res.json({ 
            token, role: user.role, balance: user.balance, depositBalance: user.balance,
            withdrawBalance, hasLongTerm: user.hasLongTerm, fullName: user.fullName,
            monthlyPurchasesCount: user.monthlyPurchasesCount || 0,
            remainingPurchases: 2 - (user.monthlyPurchasesCount || 0),
            shortTermProducts: user.shortTermProducts || [],
            referralCode: user.referralCode, referralCount: user.referralCount || 0,
            referralEarnings: user.referralEarnings || 0,
            transactions: [] // Simplifié pour le login
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erreur login' });
    }
});

// Investissement (Logique corrigée)
app.post('/api/invest', authMiddleware, async (req, res) => {
    try {
        const { productType, amount } = req.body;
        const user = req.user;
        
        if (user.balance < amount) return res.status(400).json({ error: 'Solde insuffisant.' });
        
        // Vérif Long Terme
        if (productType !== 'longterm' && !user.hasLongTerm) {
            return res.status(403).json({ error: 'Produit Long Terme obligatoire.' });
        }

        // Reset mensuel
        const currentMonth = new Date().toISOString().slice(0, 7);
        if (user.lastPurchaseMonth !== currentMonth) { 
            user.monthlyPurchasesCount = 0; 
            user.lastPurchaseMonth = currentMonth; 
        }

        // Limite 2 achats
        if (productType !== 'longterm' && user.monthlyPurchasesCount >= 2) {
            return res.status(403).json({ error: 'Limite 2 achats/mois atteinte.' });
        }

        user.balance -= amount;
        let dailyGain = 0;

        if (productType === 'longterm') {
            if (amount !== 2000) throw new Error('Prix LT incorrect');
            user.hasLongTerm = true;
            user.longTermStartDate = new Date();
        } else {
            // Définition des produits
            if (productType === 'prod1') { if(amount!==2000) throw new Error('Prix P1'); dailyGain=1000; }
            else if (productType === 'prod2') { if(amount!==3000) throw new Error('Prix P2'); dailyGain=1500; }
            else if (productType === 'prod3') { if(amount!==5000) throw new Error('Prix P3'); dailyGain=2000; } // 5000F
            else if (productType === 'prod4') { if(amount!==10000) throw new Error('Prix P4'); dailyGain=5000; } // 10000F
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
        console.error("Erreur Invest:", e);
        res.status(400).json({ error: e.message });
    }
});

// Dépôt (Simplifié)
app.post('/api/deposit', authMiddleware, async (req, res) => {
    try {
        const { amount, network, phone } = req.body;
        if (amount < 2000) return res.status(400).json({ error: 'Min 2000 FCFA' });
        
        // Création facture PayDunya
        const invoiceNumber = `DXP_${Date.now()}`;
        const postData = {
            master_key: process.env.PAYDUNYA_MASTER_KEY,
            token: process.env.PAYDUNYA_SIGNATURE_TOKEN,
            callback_url: process.env.PAYDUNYA_CALLBACK_URL,
            return_url: process.env.PAYDUNYA_RETURN_URL,
            cancel_url: process.env.PAYDUNYA_CANCEL_URL,
            invoice_number: invoiceNumber,
            description: "Dépôt Dioxyspaywer",
            total_amount: parseInt(amount),
            currency: "XOF",
            customer: { first_name: req.user.fullName.split(' ')[0], last_name: "User", phone_number: phone },
            custom_data: { user_id: req.user._id.toString(), network: network }
        };

        const response = await axios.post('https://paydunya.com/checkout-invoice/v1/invoice', postData, {
            headers: { 'Content-Type': 'application/json', 'PayDunya-Master-Key': process.env.PAYDUNYA_MASTER_KEY, 'PayDunya-Token': process.env.PAYDUNYA_SIGNATURE_TOKEN }
        });

        if (response.data && response.data.response_code === "success") {
            await Transaction.create({ userId: req.user._id, type: 'DEPOSIT', amount, method: network, status: 'PENDING', reference: invoiceNumber });
            res.json({ success: true, paymentUrl: response.data.checkout_url });
        } else {
            res.status(400).json({ error: 'Erreur PayDunya' });
        }
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erreur dépôt' });
    }
});

// Webhook
app.post('/api/webhook/deposit', async (req, res) => {
    try {
        if (req.body.status === "completed") {
            const tx = await Transaction.findOne({ reference: req.body.invoice_number });
            if (tx && tx.status === 'PENDING') {
                tx.status = 'SUCCESS';
                await tx.save();
                const user = await User.findById(tx.userId);
                if (user) {
                    user.balance += parseFloat(req.body.total_amount);
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
        
        if (amount < 1000) return res.status(400).json({ error: 'Min 1000' });
        if ([0, 6].includes(now.getDay())) return res.status(403).json({ error: 'Week-end' });
        if (now.getHours() < 8 || now.getHours() >= 21) return res.status(403).json({ error: 'Hors horaires' });
        if (user.lastWithdrawDate && user.lastWithdrawDate.toDateString() === now.toDateString()) return res.status(403).json({ error: '1/jour' });

        // Calcul solde disponible (simplifié)
        let available = 0;
        if(user.shortTermProducts) user.shortTermProducts.forEach(p => { if(new Date(p.unlockDate) <= now) available += (p.amount + p.dailyGain*5); });
        if(user.hasLongTerm && user.longTermStartDate) {
            const d = Math.floor((now - new Date(user.longTermStartDate))/(1000*60*60*24));
            if(d >= 55) available += 38500; else if(d>0) available += 700*d;
        }

        if (amount > available) return res.status(400).json({ error: `Solde insuffisant (${available})` });

        user.balance -= amount;
        user.lastWithdrawDate = now;
        await user.save();
        await Transaction.create({ userId: user._id, type: 'WITHDRAWAL', amount, method: network, status: 'SUCCESS', reference: `W_${Date.now()}` });
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erreur retrait' });
    }
});

// Démarrage
app.listen(PORT, () => console.log(`🚀 SERVEUR DÉMARRÉ SUR LE PORT ${PORT}`));
