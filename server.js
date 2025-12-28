const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const axios = require('axios');
const bcryptjs = require('bcryptjs');
const crypto = require('crypto');
const { ObjectId } = require('mongodb');

dotenv.config();
const app = express();

// ============================================
// CORS CONFIGURATION
// ============================================
app.use(cors({
    origin: [
        'https://mub-log.onrender.com',
        'http://localhost:3000',
        'http://localhost:5500',
        'http://127.0.0.1:5500'
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.options('*', cors());
app.use(express.json());

// ============================================
// MONGODB CONNECTION
// ============================================
let db = null;

async function connectDB() {
    try {
        const { MongoClient } = await import('mongodb');
        const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/mublog';
        const client = new MongoClient(uri);
        
        await client.connect();
        db = client.db('mublog');
        console.log('✅ Connected to MongoDB');
        return db;
    } catch (err) {
        console.error('❌ MongoDB Error:', err.message);
        return {
            collection: (name) => new InMemoryCollection(name)
        };
    }
}

class InMemoryCollection {
    constructor(name) {
        this.name = name;
        this.data = [];
        this.counter = 1;
    }
    
    async insertOne(doc) {
        doc._id = this.counter++;
        this.data.push(doc);
        return { insertedId: doc._id };
    }
    
    async find(query) {
        let results = this.data;
        for (let key in query) {
            if (query[key].$gt !== undefined) {
                results = results.filter(d => d[key] > query[key].$gt);
            } else {
                results = results.filter(d => d[key] === query[key]);
            }
        }
        return {
            toArray: async () => results,
            sort: () => ({ limit: () => ({ toArray: async () => results }) })
        };
    }
    
    async findOne(query) {
        return this.data.find(d => {
            for (let key in query) {
                if (d[key] !== query[key]) return false;
            }
            return true;
        }) || null;
    }
    
    async updateOne(query, update) {
        const item = this.data.find(d => d._id == query._id);
        if (item && update.$inc) {
            for (let key in update.$inc) {
                item[key] = (item[key] || 0) + update.$inc[key];
            }
        }
        if (item && update.$set) {
            for (let key in update.$set) {
                item[key] = update.$set[key];
            }
        }
        return { modifiedCount: item ? 1 : 0 };
    }
    
    async deleteOne(query) {
        const idx = this.data.findIndex(d => d._id == query._id);
        if (idx >= 0) this.data.splice(idx, 1);
        return { deletedCount: idx >= 0 ? 1 : 0 };
    }
}

connectDB();

// ============================================
// HELPER FUNCTIONS
// ============================================

function getCollection(name) {
    return db ? db.collection(name) : new InMemoryCollection(name);
}

function toObjectId(id) {
    if (!id) return null;
    if (id instanceof ObjectId) return id;
    if (typeof id === 'string' && ObjectId.isValid(id)) {
        try {
            return new ObjectId(id);
        } catch (e) {}
    }
    return id;
}

const createToken = (data) => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString('base64');
    const payload = Buffer.from(JSON.stringify(data)).toString('base64');
    const signature = crypto.createHmac('sha256', process.env.JWT_SECRET || 'your_secret_key')
        .update(`${header}.${payload}`)
        .digest('base64');
    return `${header}.${payload}.${signature}`;
};

// ============================================
// 🧪 HEALTH CHECK ENDPOINTS
// ============================================

app.get('/api/test', (req, res) => {
    res.json({ message: "✅ Server is running!" });
});

app.get('/api/health', (req, res) => {
    res.json({ 
        status: "✅ Server is healthy",
        timestamp: new Date().toISOString(),
        database: db ? "✅ Connected" : "⚠️ Using fallback"
    });
});

// ============================================
// AUTH ROUTES
// ============================================

app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;
        
        const existing = await getCollection('users').findOne({ email });
        if (existing) {
            return res.status(400).json({ error: "Email already exists" });
        }
        
        const salt = await bcryptjs.genSalt(10);
        const hashedPassword = await bcryptjs.hash(password, salt);
        
        const result = await getCollection('users').insertOne({
            username,
            email,
            password: hashedPassword,
            balance: 0,
            role: 'user',
            createdAt: new Date()
        });
        
        res.status(201).json({ msg: "User created successfully!", userId: result.insertedId });
    } catch (err) {
        console.error('Register error:', err);
        res.status(500).json({ error: "Registration failed" });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        const user = await getCollection('users').findOne({ email });
        if (!user) return res.status(400).json({ msg: "User not found" });
        
        const isMatch = await bcryptjs.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ msg: "Invalid password" });
        
        const token = createToken({ userId: user._id, email: user.email });
        
        res.json({
            msg: "Login successful",
            token,
            user: {
                id: user._id,
                username: user.username,
                email: user.email,
                balance: user.balance,
                role: user.role
            }
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/auth/users', async (req, res) => {
    try {
        const users = await getCollection('users').find({}).toArray();
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/auth/user/:userId', async (req, res) => {
    try {
        const userId = toObjectId(req.params.userId);
        const user = await getCollection('users').findOne({ _id: userId });
        if (!user) return res.status(404).json({ error: "User not found" });
        res.json(user);
    } catch (err) {
        console.error('Get user error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/topup', async (req, res) => {
    try {
        const { userId, amount } = req.body;
        
        if (!amount || isNaN(amount) || amount <= 0) {
            return res.status(400).json({ msg: "Invalid amount" });
        }
        
        if (!userId) {
            return res.status(400).json({ msg: "User ID is required" });
        }
        
        const userIdObj = toObjectId(userId);
        const user = await getCollection('users').findOne({ _id: userIdObj });
        
        if (!user) {
            return res.status(404).json({ msg: "User not found" });
        }
        
        const result = await getCollection('users').updateOne(
            { _id: userIdObj },
            { $inc: { balance: parseFloat(amount) } }
        );
        
        if (result.modifiedCount === 0) {
            return res.status(500).json({ msg: "Failed to update balance" });
        }
        
        const updatedUser = await getCollection('users').findOne({ _id: userIdObj });
        
        res.json({ 
            msg: `Successfully added ₦${amount}`,
            newBalance: updatedUser.balance 
        });
    } catch (err) {
        console.error('Topup error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// 🛍️ PRODUCT ROUTES
// ============================================

app.get('/api/products/category/:category', async (req, res) => {
    try {
        const products = await getCollection('products').find({
            category: req.params.category,
            stock: { $gt: 0 }
        }).toArray();
        
        const formatted = products.map(p => ({ ...p, id: p._id }));
        res.json(formatted);
    } catch (err) {
        console.error('Get category error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/products/all', async (req, res) => {
    try {
        const products = await getCollection('products').find({}).toArray();
        const formatted = products.map(p => ({ ...p, id: p._id }));
        res.json(formatted);
    } catch (err) {
        console.error('Get all products error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/products/all-orders', async (req, res) => {
    try {
        const orders = await getCollection('orders').find({}).toArray();
        res.json(orders || []);
    } catch (err) {
        console.error('Get orders error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/products/add', async (req, res) => {
    try {
        const result = await getCollection('products').insertOne({
            ...req.body,
            createdAt: new Date()
        });
        res.json({ message: "Product added", id: result.insertedId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// 🛒 PRODUCT PURCHASE
// ============================================

app.post('/api/products/purchase', async (req, res) => {
    try {
        const { userId, productId } = req.body;
        
        console.log('🛒 Purchase attempt:', { userId, productId });
        
        const userIdObj = toObjectId(userId);
        const productIdObj = toObjectId(productId);
        
        console.log('🔍 Looking for product:', productIdObj);
        
        const product = await getCollection('products').findOne({ _id: productIdObj });
        
        if (!product) {
            console.log('❌ Product not found. Trying with string ID...');
            const productStr = await getCollection('products').findOne({ _id: productId });
            if (!productStr) {
                console.log('❌ Product not found in any format');
                return res.status(404).json({ error: "Product not found" });
            }
            return purchaseProduct(userIdObj, userId, productStr, res);
        }
        
        return purchaseProduct(userIdObj, userId, product, res);
        
    } catch (err) {
        console.error('❌ Purchase error:', err);
        res.status(500).json({ error: err.message });
    }
});

async function purchaseProduct(userIdObj, userIdStr, product, res) {
    try {
        console.log('🔍 Looking for user:', userIdObj);
        
        const user = await getCollection('users').findOne({ _id: userIdObj });
        
        if (!user) {
            console.log('❌ User not found. Trying with string ID...');
            const userStr = await getCollection('users').findOne({ _id: userIdStr });
            if (!userStr) {
                console.log('❌ User not found in any format');
                return res.status(404).json({ error: "User not found" });
            }
            return processPurchase(userIdObj, userStr, product, res);
        }
        
        return processPurchase(userIdObj, user, product, res);
        
    } catch (err) {
        console.error('❌ User lookup error:', err);
        res.status(500).json({ error: err.message });
    }
}

async function processPurchase(userId, user, product, res) {
    try {
        console.log('💰 User balance:', user.balance, 'Product price:', product.price);
        
        if (user.balance < product.price) {
            return res.status(400).json({ 
                error: `Insufficient balance. Need ₦${product.price}, You have ₦${user.balance}` 
            });
        }
        
        if (product.stock < 1) {
            return res.status(400).json({ error: "Product out of stock" });
        }
        
        await getCollection('users').updateOne(
            { _id: userId },
            { $inc: { balance: -product.price } }
        );
        console.log('✅ Balance deducted');
        
        await getCollection('products').updateOne(
            { _id: product._id },
            { $inc: { stock: -1 } }
        );
        console.log('✅ Stock reduced');
        
        const orderDetails = `LOGIN: ${product.credentials}\nLINK: ${product.public_link}`;
        await getCollection('orders').insertOne({
            user_id: String(userId),
            username: user.username,
            product_name: product.name,
            price: product.price,
            product_link: product.public_link,
            details: orderDetails,
            type: 'PRODUCT',
            status: 'COMPLETED',
            created_at: new Date()
        });
        console.log('✅ Order created');
        
        res.json({ 
            message: "Success", 
            details: orderDetails
        });
        
    } catch (err) {
        console.error('❌ Purchase processing error:', err);
        res.status(500).json({ error: err.message });
    }
}

app.delete('/api/products/delete/:id', async (req, res) => {
    try {
        const id = req.params.id;
        let result;
        
        // Try with ObjectId first
        if (ObjectId.isValid(id)) {
            const idObj = new ObjectId(id);
            result = await getCollection('products').deleteOne({ _id: idObj });
        }
        
        // If not found, try with string id
        if (!result || result.deletedCount === 0) {
            result = await getCollection('products').deleteOne({ _id: id });
        }
        
        if (result.deletedCount === 0) {
            return res.status(404).json({ error: "Product not found" });
        }
        
        res.json({ message: "Product deleted successfully" });
    } catch (err) {
        console.error('Delete error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/products/update/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const { name, price, category, description, public_link, credentials } = req.body;
        
        const updateData = {
            name,
            price: parseFloat(price),
            category,
            description,
            public_link,
            credentials,
            updatedAt: new Date()
        };
        
        let result;
        
        // Try with ObjectId first
        if (ObjectId.isValid(id)) {
            const idObj = new ObjectId(id);
            result = await getCollection('products').updateOne(
                { _id: idObj },
                { $set: updateData }
            );
        }
        
        // If not found, try with string id
        if (!result || result.modifiedCount === 0) {
            result = await getCollection('products').updateOne(
                { _id: id },
                { $set: updateData }
            );
        }
        
        if (result.modifiedCount === 0) {
            return res.status(404).json({ error: "Product not found" });
        }
        
        res.json({ message: "Product updated successfully" });
    } catch (err) {
        console.error('Update error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// 📋 ORDERS ROUTES
// ============================================

app.get('/api/orders/all/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const orders = await getCollection('orders').find({ user_id: userId }).toArray();
        res.json(orders || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// 📱 SMS ROUTES
// ============================================

app.get('/api/sms/available-services', async (req, res) => {
    try {
        const services = await getCollection('allowed_services').find({}).toArray();
        res.json(services || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/sms/history/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const history = await getCollection('sms_orders').find({ user_id: userId }).toArray();
        res.json(history || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/sms/add-allowed', async (req, res) => {
    try {
        const { service_name, display_name } = req.body;
        
        const existing = await getCollection('allowed_services').findOne({ service_name: service_name.toLowerCase() });
        if (existing) {
            return res.status(400).json({ error: "Service already exists" });
        }
        
        await getCollection('allowed_services').insertOne({
            service_name: service_name.toLowerCase(),
            display_name,
            createdAt: new Date()
        });
        res.json({ message: "Service added successfully!" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/sms/delete-allowed/:id', async (req, res) => {
    try {
        const idObj = toObjectId(req.params.id);
        await getCollection('allowed_services').deleteOne({ _id: idObj });
        res.json({ message: "Service deleted" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/sms/admin-all-prices', async (req, res) => {
    try {
        const services = await getCollection('allowed_services').find({}).toArray();
        res.json(services || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// 📱 SMS LIVE CONFIG - FIXED PRICING
// ============================================

app.get('/api/sms/live-config/:service', async (req, res) => {
    const service = req.params.service;
    const EXCHANGE_RATE = 20; // 1 USD = 5 NGN
    const MARKUP_PERCENTAGE = 20; // 20% profit margin
    
    try {
        const response = await fetch(`https://5sim.net/v1/guest/prices?product=${service}`);
        const data = await response.json();
        const serviceData = data[service];
        if (!serviceData) return res.json([]);

        const results = [];
        for (const country of Object.keys(serviceData)) {
            const operators = serviceData[country];
            for (const operator of Object.keys(operators)) {
                const info = operators[operator];
                if (info.count > 0 && info.cost > 0) {
                    // Formula: (API price in USD × 5) × 1.20
                    const priceInNGN = info.cost * EXCHANGE_RATE; // Convert USD to NGN
                    const finalPrice = Math.ceil(priceInNGN * (1 + MARKUP_PERCENTAGE / 100)); // Add 20% markup
                    
                    results.push({
                        country,
                        operator,
                        price: finalPrice,
                        stock: info.count
                    });
                }
            }
        }
        
        console.log(`✅ SMS prices loaded for ${service}:`, results.slice(0, 2));
        res.json(results);
    } catch (err) {
        console.error('SMS config error:', err);
        res.json([]);
    }
});

// ============================================
// 📱 SMS ORDER - FIXED PRICING
// ============================================

app.post('/api/sms/order', async (req, res) => {
    try {
        const { userId, service, country, operator } = req.body;
        const EXCHANGE_RATE = 5; // 1 USD = 5 NGN
        const MARKUP_PERCENTAGE = 20; // 20% profit margin
        
        const priceRes = await fetch(`https://5sim.net/v1/guest/prices?product=${service}`);
        const priceData = await priceRes.json();
        
        // Calculate price using same formula
        const apiPrice = priceData[service][country][operator].cost; // Price in USD
        const priceInNGN = apiPrice * EXCHANGE_RATE; // Convert to NGN (5 naira per dollar)
        const finalPrice = Math.ceil(priceInNGN * (1 + MARKUP_PERCENTAGE / 100)); // Add 20% markup
        
        console.log(`💰 SMS Order pricing:`, {
            apiPrice: `$${apiPrice}`,
            priceInNGN: `₦${priceInNGN.toFixed(2)}`,
            finalPrice: `₦${finalPrice}`
        });
        
        const userIdObj = toObjectId(userId);
        const user = await getCollection('users').findOne({ _id: userIdObj });
        
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        if (user.balance < finalPrice) {
            return res.status(400).json({ 
                error: `Insufficient balance. Need ₦${finalPrice}, You have ₦${user.balance}` 
            });
        }
        
        const orderRes = await fetch(
            `https://5sim.net/v1/user/buy/activation/${country}/${operator}/${service}`,
            {
                headers: {
                    'Authorization': `Bearer ${process.env.FIVESIM_API_KEY}`,
                    'Accept': 'application/json'
                }
            }
        );
        
        const orderData = await orderRes.json();
        
        if (!orderRes.ok) {
            return res.status(400).json({ error: orderData.message || 'Order failed' });
        }
        
        await getCollection('users').updateOne(
            { _id: userIdObj },
            { $inc: { balance: -finalPrice } }
        );
        
        const result = await getCollection('sms_orders').insertOne({
            user_id: userId,
            service,
            country,
            operator,
            phone: orderData.phone,
            price: finalPrice,
            activation_id: orderData.id,
            status: 'WAITING',
            sms_code: null,
            created_at: new Date()
        });
        
        res.json({
            orderId: result.insertedId,
            phone: orderData.phone,
            price: finalPrice,
            message: 'SMS number purchased successfully'
        });
    } catch (err) {
        console.error('SMS order error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/sms/check/:orderId', async (req, res) => {
    try {
        const orderIdObj = toObjectId(req.params.orderId);
        const order = await getCollection('sms_orders').findOne({ _id: orderIdObj });
        if (!order) return res.status(404).json({ error: 'Order not found' });
        
        const checkRes = await fetch(
            `https://5sim.net/v1/user/check/${order.activation_id}`,
            {
                headers: {
                    'Authorization': `Bearer ${process.env.FIVESIM_API_KEY}`,
                    'Accept': 'application/json'
                }
            }
        );
        
        const data = await checkRes.json();
        
        if (data.sms && data.sms[0]) {
            const code = data.sms[0].code;
            
            await getCollection('sms_orders').updateOne(
                { _id: orderIdObj },
                { $set: { sms_code: code, status: 'COMPLETED' } }
            );
            
            res.json({ code, status: 'COMPLETED' });
        } else {
            res.json({ code: null, status: order.status });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// 💳 TRANSACTIONS ROUTES
// ============================================

app.get('/api/auth/transactions/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const transactions = await getCollection('transactions').find({ user_id: userId }).toArray();
        res.json(transactions || []);
    } catch (err) {
        res.json([]);
    }
});

app.post('/api/auth/verify-payment', async (req, res) => {
    try {
        const { transaction_id, userId } = req.body;
        
        const response = await axios.get(
            `https://api.flutterwave.com/v3/transactions/${transaction_id}/verify`,
            {
                headers: {
                    Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}`
                }
            }
        );
        
        const { data } = response.data;
        
        if (data.status === 'successful') {
            const amount = data.amount;
            const userIdObj = toObjectId(userId);
            
            await getCollection('users').updateOne(
                { _id: userIdObj },
                { $inc: { balance: amount } }
            );
            
            await getCollection('transactions').insertOne({
                user_id: userId,
                transaction_id,
                amount,
                status: 'successful',
                created_at: new Date()
            });
            
            res.json({ message: 'Payment verified', amount });
        } else {
            res.status(400).json({ error: 'Payment not successful' });
        }
    } catch (err) {
        console.error('Payment verification error:', err);
        res.status(500).json({ error: 'Verification failed' });
    }
});

// ============================================
// 📢 ANNOUNCEMENTS
// ============================================

app.get('/api/announcement', async (req, res) => {
    try {
        const announcements = await getCollection('announcements')
            .find({ is_active: true })
            .toArray();
        res.json(announcements[0] || {});
    } catch (err) {
        res.json({});
    }
});

app.post('/api/admin/announcement', async (req, res) => {
    try {
        const { title, message, type } = req.body;
        
        await getCollection('announcements').updateOne(
            { is_active: true },
            { $set: { is_active: false } }
        );
        
        const result = await getCollection('announcements').insertOne({
            title,
            message,
            type: type || 'info',
            is_active: true,
            createdAt: new Date()
        });
        
        res.json({ message: "Announcement published!", id: result.insertedId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/admin/announcement', async (req, res) => {
    try {
        await getCollection('announcements').updateOne(
            { is_active: true },
            { $set: { is_active: false } }
        );
        res.json({ message: "Announcement removed" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// 🎉 SMM SERVICES
// ============================================

app.get('/api/smm/live-services', async (req, res) => {
    try {
        const response = await axios.get('https://reallysimplesocial.com/api/v2', {
            params: { key: process.env.SMM_API_KEY, action: 'services' }
        });
        
        const processed = (response.data || []).map(s => ({
            id: s.service,
            name: s.name,
            category: s.category,
            min: s.min,
            max: s.max,
            rate: (parseFloat(s.rate) * 1.20).toFixed(2)
        }));
        
        res.json(processed);
    } catch (error) {
        console.error('SMM error:', error);
        res.json([]);
    }
});

app.post('/api/smm/order', async (req, res) => {
    try {
        const { userId, service, link, quantity } = req.body;
        
        const servicesRes = await axios.get('https://reallysimplesocial.com/api/v2', {
            params: { key: process.env.SMM_API_KEY, action: 'services' }
        });
        
        const serviceData = servicesRes.data.find(s => s.service == service);
        if (!serviceData) return res.status(400).json({ error: 'Service not found' });
        
        const price = (parseFloat(serviceData.rate) * 1.20 * quantity) / 1000;
        
        const userIdObj = toObjectId(userId);
        const user = await getCollection('users').findOne({ _id: userIdObj });
        if (user.balance < price) {
            return res.status(400).json({ error: 'Insufficient balance' });
        }
        
        const orderRes = await axios.post('https://reallysimplesocial.com/api/v2', null, {
            params: {
                key: process.env.SMM_API_KEY,
                action: 'add',
                service,
                link,
                quantity
            }
        });
        
        await getCollection('users').updateOne(
            { _id: userIdObj },
            { $inc: { balance: -price } }
        );
        
        await getCollection('orders').insertOne({
            user_id: userId,
            username: user.username,
            product_name: serviceData.name,
            price,
            product_link: link,
            details: `Order ID: ${orderRes.data.order}`,
            type: 'SMM',
            status: 'PENDING',
            created_at: new Date()
        });
        
        res.json({ orderId: orderRes.data.order, message: 'Order placed successfully!' });
    } catch (err) {
        console.error('SMM order error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// 🚀 START SERVER
// ============================================

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📊 Database: ${process.env.MONGODB_URI || 'MongoDB'}`);
    console.log(`✅ All routes loaded!`);
});

process.on('SIGINT', () => {
    console.log('\n👋 Server shutting down...');
    process.exit(0);
});
