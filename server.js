const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const axios = require('axios');
const bcryptjs = require('bcryptjs');
const crypto = require('crypto');
const { ObjectId } = require('mongodb');

// Load env variables
dotenv.config();

const app = express();

// ============================================
// FIXED CORS CONFIGURATION
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
        console.log('ℹ️ Using in-memory storage as fallback');
        
        return {
            collection: (name) => new InMemoryCollection(name)
        };
    }
}

// In-memory collection for fallback
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
        if (query._id) {
            results = results.filter(d => d._id == query._id);
        }
        if (query.email) {
            results = results.filter(d => d.email === query.email);
        }
        if (query.category) {
            results = results.filter(d => d.category === query.category);
        }
        if (query.stock && query.stock.$gt !== undefined) {
            results = results.filter(d => d.stock > query.stock.$gt);
        }
        if (query.user_id) {
            results = results.filter(d => d.user_id === query.user_id);
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
        const item = this.data.find(d => d._id == query._id || d.email === query.email);
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

// Helper to convert string ID to ObjectId if needed
function toObjectId(id) {
    if (!id) return null;
    
    // If it's already an ObjectId, return it
    if (id instanceof ObjectId) return id;
    
    // If it's a valid ObjectId string, convert it
    if (ObjectId.isValid(id) && String(new ObjectId(id)) === id) {
        return new ObjectId(id);
    }
    
    // Otherwise return as-is (for numeric IDs in fallback mode)
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
// AUTH ROUTES
// ============================================

// Register
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

// Login
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

// Get all users
app.get('/api/auth/users', async (req, res) => {
    try {
        const users = await getCollection('users').find({}).toArray();
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get single user - FIXED ID HANDLING
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

// Topup - FIXED ID HANDLING
// REPLACE the topup route in server.js (around line 167) with this enhanced version:

app.post('/api/auth/topup', async (req, res) => {
    try {
        const { userId, amount } = req.body;
        
        console.log('💰 Topup request received:', { userId, amount, type: typeof userId }); // Debug
        
        // Validate amount
        if (!amount || isNaN(amount) || amount <= 0) {
            console.log('❌ Invalid amount');
            return res.status(400).json({ msg: "Invalid amount" });
        }
        
        // Validate userId
        if (!userId) {
            console.log('❌ No userId provided');
            return res.status(400).json({ msg: "User ID is required" });
        }
        
        // Convert to ObjectId
        let userIdObj;
        try {
            userIdObj = toObjectId(userId);
            console.log('✅ Converted userId:', userIdObj);
        } catch (err) {
            console.log('❌ Failed to convert userId:', err);
            return res.status(400).json({ msg: "Invalid user ID format" });
        }
        
        // Check if user exists first
        const user = await getCollection('users').findOne({ _id: userIdObj });
        console.log('👤 User found:', user ? 'Yes' : 'No');
        
        if (!user) {
            return res.status(404).json({ msg: "User not found" });
        }
        
        // Update balance
        const result = await getCollection('users').updateOne(
            { _id: userIdObj },
            { $inc: { balance: parseFloat(amount) } }
        );
        
        console.log('✅ Update result:', result); // Debug
        
        if (result.modifiedCount === 0) {
            console.log('⚠️ No documents were modified');
            return res.status(500).json({ msg: "Failed to update balance" });
        }
        
        // Get updated user data
        const updatedUser = await getCollection('users').findOne({ _id: userIdObj });
        console.log('💰 New balance:', updatedUser.balance);
        
        res.json({ 
            msg: `Successfully added ₦${amount}`,
            newBalance: updatedUser.balance 
        });
        
    } catch (err) {
        console.error('❌ Topup error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// PRODUCT ROUTES
// ============================================

app.get('/api/products/category/:category', async (req, res) => {
    try {
        const products = await getCollection('products').find({
            category: req.params.category,
            stock: { $gt: 0 }
        }).toArray();
        res.json(products);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/products/all', async (req, res) => {
    try {
        const products = await getCollection('products').find({}).toArray();
        res.json(products);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/products/all-orders', async (req, res) => {
    try {
        const orders = await getCollection('orders').find({}).toArray();
        res.json(orders);
    } catch (err) {
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

// Purchase - FIXED ID HANDLING
app.post('/api/products/purchase', async (req, res) => {
    try {
        const { userId, productId } = req.body;
        
        const userIdObj = toObjectId(userId);
        const productIdObj = toObjectId(productId);
        
        const product = await getCollection('products').findOne({ _id: productIdObj });
        if (!product) return res.status(404).json({ error: "Product not found" });
        
        const user = await getCollection('users').findOne({ _id: userIdObj });
        if (!user) return res.status(404).json({ error: "User not found" });
        
        if (user.balance < product.price) {
            return res.status(400).json({ error: "Insufficient balance" });
        }
        
        await getCollection('users').updateOne(
            { _id: userIdObj },
            { $inc: { balance: -product.price } }
        );
        
        await getCollection('products').updateOne(
            { _id: productIdObj },
            { $inc: { stock: -1 } }
        );
        
        const orderDetails = `LOGIN: ${product.credentials}\nLINK: ${product.public_link}`;
        await getCollection('orders').insertOne({
            user_id: userId,
            username: user.username,
            product_name: product.name,
            price: product.price,
            product_link: product.public_link,
            details: orderDetails,
            type: 'PRODUCT',
            status: 'COMPLETED',
            created_at: new Date()
        });
        
        res.json({ message: "Success", details: orderDetails });
    } catch (err) {
        console.error('Purchase error:', err);
        res.status(500).json({ error: err.message });
    }
});

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
// ORDERS - FIXED ID HANDLING
// ============================================

app.get('/api/orders/all/:userId', async (req, res) => {
    try {
        const userId = req.params.userId; // Keep as string for comparison
        const orders = await getCollection('orders').find({ user_id: userId }).toArray();
        res.json(orders);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// SMS ROUTES - FIXED ID HANDLING
// ============================================

app.get('/api/sms/available-services', async (req, res) => {
    try {
        const services = await getCollection('allowed_services').find({}).toArray();
        res.json(services);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/sms/history/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const history = await getCollection('sms_orders').find({ user_id: userId }).toArray();
        res.json(history);
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
        res.json(services);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// TRANSACTIONS - FIXED ID HANDLING
// ============================================

app.get('/api/auth/transactions/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const transactions = await getCollection('transactions').find({ user_id: userId }).toArray();
        res.json(transactions);
    } catch (err) {
        res.json([]);
    }
});

// Verify payment - FIXED ID HANDLING
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
// ANNOUNCEMENTS
// ============================================

app.get('/api/announcement', async (req, res) => {
    try {
        const announcement = await getCollection('announcements')
            .find({ is_active: true })
            .sort({ createdAt: -1 })
            .limit(1)
            .toArray();
        res.json(announcement[0] || {});
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
// LIVE SMS CONFIG
// ============================================

app.get('/api/sms/live-config/:service', async (req, res) => {
    const service = req.params.service;
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
                    const finalPrice = Math.ceil(info.cost * 1650 * 1.20);
                    results.push({
                        country,
                        operator,
                        price: finalPrice,
                        stock: info.count
                    });
                }
            }
        }
        res.json(results);
    } catch (err) {
        res.json([]);
    }
});

// SMS Order - FIXED ID HANDLING
app.post('/api/sms/order', async (req, res) => {
    try {
        const { userId, service, country, operator } = req.body;
        
        const priceRes = await fetch(`https://5sim.net/v1/guest/prices?product=${service}`);
        const priceData = await priceRes.json();
        const price = Math.ceil(priceData[service][country][operator].cost * 1650 * 1.20);
        
        const userIdObj = toObjectId(userId);
        const user = await getCollection('users').findOne({ _id: userIdObj });
        if (user.balance < price) {
            return res.status(400).json({ error: 'Insufficient balance' });
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
            { $inc: { balance: -price } }
        );
        
        const result = await getCollection('sms_orders').insertOne({
            user_id: userId,
            service,
            country,
            operator,
            phone: orderData.phone,
            price,
            activation_id: orderData.id,
            status: 'WAITING',
            sms_code: null,
            created_at: new Date()
        });
        
        res.json({
            orderId: result.insertedId,
            phone: orderData.phone,
            message: 'SMS number purchased successfully'
        });
    } catch (err) {
        console.error('SMS order error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Check SMS code - FIXED ID HANDLING
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
// SMM SERVICES - FIXED ID HANDLING
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
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// HEALTH CHECK
// ============================================

app.get('/api/test', (req, res) => {
    res.json({ message: "✅ Server is running!" });
});

// ============================================
// START SERVER
// ============================================

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📊 Database: ${process.env.MONGODB_URI || 'MongoDB Atlas'}`);
    console.log(`✅ Production ready!`);
});

process.on('SIGINT', () => {
    console.log('\n👋 Server shutting down...');
    process.exit(0);
});
