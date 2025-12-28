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
// 🔧 DEBUG: TEST SMS API KEY
// ============================================

app.get('/api/debug/sms-test', async (req, res) => {
    try {
        console.log('🔧 Testing SMS API...');
        
        const apiKey = process.env.FIVESIM_API_KEY;
        console.log('API Key exists:', !!apiKey);
        console.log('API Key length:', apiKey ? apiKey.length : 0);
        console.log('API Key starts with:', apiKey ? apiKey.substring(0, 10) : 'N/A');
        
        // Test 1: Guest API (no auth)
        console.log('\n📍 Test 1: Guest Prices API (no auth)...');
        const guestPricesRes = await fetch('https://5sim.net/v1/guest/prices?product=whatsapp');
        const guestPricesText = await guestPricesRes.text();
        console.log('Status:', guestPricesRes.status);
        console.log('Response (first 200 chars):', guestPricesText.substring(0, 200));
        
        // Test 2: User API with key
        console.log('\n📍 Test 2: User API (with auth)...');
        const userRes = await fetch('https://5sim.net/v1/user/profile', {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Accept': 'application/json'
            }
        });
        const userText = await userRes.text();
        console.log('Status:', userRes.status);
        console.log('Response:', userText.substring(0, 300));
        
        res.json({
            apiKeyConfigured: !!apiKey,
            apiKeyLength: apiKey ? apiKey.length : 0,
            test1_guestAPI: {
                status: guestPricesRes.status,
                success: guestPricesRes.ok
            },
            test2_userAPI: {
                status: userRes.status,
                success: userRes.ok
            },
            recommendation: userRes.ok ? '✅ API key is valid!' : '❌ API key may be invalid or expired'
        });
        
    } catch (err) {
        res.json({
            error: err.message,
            suggestion: 'Check if 5sim.net is accessible'
        });
    }
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
// 🛒 PRODUCT ROUTES
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
// 🛍 PRODUCT PURCHASE
// ============================================

app.post('/api/products/purchase', async (req, res) => {
    try {
        const { userId, productId } = req.body;
        
        console.log('🛍 Purchase attempt:', { userId, productId });
        
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
        const idObj = toObjectId(req.params.id);
        await getCollection('products').deleteOne({ _id: idObj });
        res.json({ message: "Product deleted" });
    } catch (err) {
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
    const EXCHANGE_RATE = 30;
    const MARKUP_PERCENTAGE = 20;
    
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
                    const priceInNGN = info.cost * EXCHANGE_RATE;
                    const finalPrice = Math.ceil(priceInNGN * (1 + MARKUP_PERCENTAGE / 100));
                    
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
// 📱 SMS ORDER WITH CANCELLATION & TIMER
// ============================================

const AUTO_REFUND_TIMEOUT = 25 * 60 * 1000;

app.post('/api/sms/order', async (req, res) => {
    try {
        const { userId, service, country, operator } = req.body;
        const EXCHANGE_RATE = 30;
        const MARKUP_PERCENTAGE = 20;
        
        console.log('🔱 SMS Order Request:', { userId, service, country, operator });
        
        if (!userId || !service || !country || !operator) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        if (!process.env.FIVESIM_API_KEY) {
            console.error('❌ FIVESIM_API_KEY not set');
            return res.status(500).json({ error: 'SMS service not configured' });
        }
        
        // Get prices
        const priceRes = await fetch(`https://5sim.net/v1/guest/prices?product=${service}`);
        if (!priceRes.ok) {
            return res.status(400).json({ error: 'Failed to fetch prices' });
        }
        
        const priceData = await priceRes.json();
        
        if (!priceData[service]?.[country]?.[operator]) {
            return res.status(400).json({ error: 'Service/Country/Operator not available' });
        }
        
        const apiPrice = priceData[service][country][operator].cost;
        const priceInNGN = apiPrice * EXCHANGE_RATE;
        const finalPrice = Math.ceil(priceInNGN * (1 + MARKUP_PERCENTAGE / 100));
        
        console.log(`💰 Pricing:`, { apiPrice, finalPrice });
        
        // Check user balance
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
        
        // Verify API key exists
        if (!process.env.FIVESIM_API_KEY) {
            console.error('❌ FIVESIM_API_KEY not configured in .env');
            return res.status(500).json({ error: 'SMS service not configured. Contact admin.' });
        }
        
        // Create SMS order with API key
        const orderUrl = `https://5sim.net/v1/user/buy/activation/${country}/${operator}/${service}`;
        console.log('📞 Order URL:', orderUrl);
        console.log('🔑 API Key length:', process.env.FIVESIM_API_KEY ? process.env.FIVESIM_API_KEY.length : 0);
        
        let orderData;
        
        try {
            const orderRes = await fetch(orderUrl, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${process.env.FIVESIM_API_KEY}`,
                    'Accept': 'application/json'
                }
            });
            
            console.log('📡 Response status:', orderRes.status);
            console.log('📡 Response headers:', {
                'content-type': orderRes.headers.get('content-type'),
                'content-length': orderRes.headers.get('content-length')
            });
            
            const orderText = await orderRes.text();
            console.log('📦 Raw response length:', orderText.length);
            console.log('📦 Raw response (first 300 chars):', orderText.substring(0, 300));
            
            if (!orderText || orderText.trim() === '') {
                console.error('❌ Empty response from 5sim');
                return res.status(400).json({ error: 'Empty response from SMS provider. Verify your API key is valid.' });
            }
            
            // Check if response is HTML (error page)
            if (orderText.includes('<!DOCTYPE') || orderText.includes('<html') || orderText.includes('<head')) {
                console.error('❌ Got HTML response instead of JSON');
                console.error('Response:', orderText.substring(0, 500));
                return res.status(400).json({ error: 'API returned HTML error page. Check your API key validity.' });
            }
            
            // Try to parse JSON
            let orderData;
            try {
                orderData = JSON.parse(orderText);
            } catch (parseErr) {
                console.error('❌ JSON parse error:', parseErr.message);
                console.error('Response text:', orderText.substring(0, 300));
                
                // Try to extract error message if possible
                if (orderText.includes('Unauthorized') || orderText.includes('401')) {
                    return res.status(400).json({ error: 'API key is unauthorized. Check if it\'s valid.' });
                }
                
                return res.status(400).json({ error: `Invalid response from provider: ${orderText.substring(0, 50)}` });
            }
            
            console.log('✅ Parsed response:', JSON.stringify(orderData).substring(0, 200));
            
            if (!orderRes.ok) {
                console.error('❌ API error (status ' + orderRes.status + '):', orderData);
                
                if (orderData.message === 'no free phones') {
                    return res.status(400).json({ error: 'No phones available. Try another operator.' });
                }
                
                if (orderData.message) {
                    return res.status(400).json({ error: orderData.message });
                }
                
                if (orderData.error) {
                    return res.status(400).json({ error: orderData.error });
                }
                
                return res.status(400).json({ error: `API Error (${orderRes.status}): Failed to purchase SMS` });
            }
            
            if (!orderData.phone || !orderData.id) {
                console.error('❌ Missing phone or id in response:', orderData);
                return res.status(400).json({ error: 'No phone number received from provider' });
            }
            
            console.log('✅ Phone number received:', orderData.phone);
            
        } catch (fetchErr) {
            console.error('❌ Network fetch error:', fetchErr);
            return res.status(500).json({ error: `Network error: ${fetchErr.message}` });
        }
        
        // Deduct balance
        await getCollection('users').updateOne(
            { _id: userIdObj },
            { $inc: { balance: -finalPrice } }
        );
        
        // Create order record
        const result = await getCollection('sms_orders').insertOne({
            user_id: String(userId),
            service,
            country,
            operator,
            phone: orderData.phone,
            price: finalPrice,
            activation_id: orderData.id,
            status: 'WAITING',
            sms_code: null,
            created_at: new Date(),
            expires_at: new Date(Date.now() + AUTO_REFUND_TIMEOUT)
        });
        
        console.log('✅ SMS order created:', result.insertedId);
        
        // Auto-refund after 25 minutes
        setTimeout(async () => {
            try {
                const order = await getCollection('sms_orders').findOne({ _id: result.insertedId });
                
                if (order && order.status === 'WAITING') {
                    const refundUserIdObj = toObjectId(order.user_id);
                    
                    await getCollection('users').updateOne(
                        { _id: refundUserIdObj },
                        { $inc: { balance: order.price } }
                    );
                    
                    await getCollection('sms_orders').updateOne(
                        { _id: result.insertedId },
                        { $set: { status: 'EXPIRED', expired_at: new Date() } }
                    );
                    
                    console.log(`✅ Auto-refund: ${result.insertedId} - ₦${order.price}`);
                }
            } catch (err) {
                console.error('Auto-refund error:', err);
            }
        }, AUTO_REFUND_TIMEOUT);
        
        return res.json({
            orderId: result.insertedId,
            phone: orderData.phone,
            price: finalPrice,
            timeoutSeconds: 1500,
            message: 'SMS number purchased successfully'
        });
        
    } catch (err) {
        console.error('❌ SMS order error:', err);
        return res.status(500).json({ error: err.message || 'Internal server error' });
    }
});

// ============================================
// 📱 SMS CHECK ENDPOINT
// ============================================

app.get('/api/sms/check/:orderId', async (req, res) => {
    try {
        const orderIdObj = toObjectId(req.params.orderId);
        const order = await getCollection('sms_orders').findOne({ _id: orderIdObj });
        
        if (!order) {
            return res.status(404).json({ error: 'Order not found' });
        }
        
        if (!process.env.FIVESIM_API_KEY) {
            return res.status(500).json({ error: 'SMS service not configured' });
        }
        
        const checkRes = await fetch(
            `https://5sim.net/v1/user/check/${order.activation_id}`,
            {
                headers: {
                    'Authorization': `Bearer ${process.env.FIVESIM_API_KEY}`,
                    'Accept': 'application/json'
                }
            }
        );
        
        const checkText = await checkRes.text();
        
        if (!checkText) {
            return res.json({ code: null, status: order.status });
        }
        
        let data;
        try {
            data = JSON.parse(checkText);
        } catch (err) {
            console.error('Check JSON error:', err);
            return res.json({ code: null, status: order.status });
        }
        
        if (data.sms && data.sms[0]) {
            const code = data.sms[0].code;
            
            await getCollection('sms_orders').updateOne(
                { _id: orderIdObj },
                { $set: { sms_code: code, status: 'COMPLETED' } }
            );
            
            return res.json({ code, status: 'COMPLETED' });
        }
        
        res.json({ code: null, status: order.status });
        
    } catch (err) {
        console.error('SMS check error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// 📱 SMS CANCEL ENDPOINT
// ============================================

app.post('/api/sms/cancel/:orderId', async (req, res) => {
    try {
        const orderIdObj = toObjectId(req.params.orderId);
        const order = await getCollection('sms_orders').findOne({ _id: orderIdObj });
        
        if (!order) {
            return res.status(404).json({ error: 'Order not found' });
        }
        
        if (['COMPLETED', 'CANCELLED', 'EXPIRED'].includes(order.status)) {
            return res.status(400).json({ error: 'Cannot cancel this order' });
        }
        
        const userIdObj = toObjectId(order.user_id);
        await getCollection('users').updateOne(
            { _id: userIdObj },
            { $inc: { balance: order.price } }
        );
        
        await getCollection('sms_orders').updateOne(
            { _id: orderIdObj },
            { $set: { status: 'CANCELLED', cancelled_at: new Date() } }
        );
        
        console.log(`✅ Order cancelled: ${orderIdObj}`);
        
        res.json({ 
            message: 'Order cancelled and balance refunded',
            refundAmount: order.price
        });
        
    } catch (err) {
        console.error('SMS cancel error:', err);
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
