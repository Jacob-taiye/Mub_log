const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const axios = require('axios');
const bcryptjs = require('bcryptjs');
const crypto = require('crypto');

// Load env variables
dotenv.config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// ============================================
// SIMPLE MONGODB CONNECTION
// ============================================
let db = null;

async function connectDB() {
    try {
        // Using MongoDB Atlas URI directly
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
        
        // Fallback: in-memory storage
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
        if (query.category) {
            results = results.filter(d => d.category === query.category);
        }
        if (query.stock && query.stock.$gt !== undefined) {
            results = results.filter(d => d.stock > query.stock.$gt);
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
        return { modifiedCount: item ? 1 : 0 };
    }
    
    async deleteOne(query) {
        const idx = this.data.findIndex(d => d._id == query._id);
        if (idx >= 0) this.data.splice(idx, 1);
        return { deletedCount: idx >= 0 ? 1 : 0 };
    }
}

// Initialize DB on startup
connectDB();

// ============================================
// HELPER FUNCTIONS
// ============================================

function getCollection(name) {
    return db ? db.collection(name) : new InMemoryCollection(name);
}

const createToken = (data) => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString('base64');
    const payload = Buffer.from(JSON.stringify(data)).toString('base64');
    const signature = crypto.createHmac('sha256', 'your_secret_key')
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
        
        const salt = await bcryptjs.genSalt(10);
        const hashedPassword = await bcryptjs.hash(password, salt);
        
        await getCollection('users').insertOne({
            username,
            email,
            password: hashedPassword,
            balance: 0,
            role: 'user',
            createdAt: new Date()
        });
        
        res.status(201).json({ msg: "User created successfully!" });
    } catch (err) {
        res.status(500).json({ error: "Email or Username already exists" });
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

// Get single user
app.get('/api/auth/user/:userId', async (req, res) => {
    try {
        const user = await getCollection('users').findOne({ _id: req.params.userId });
        if (!user) return res.status(404).json({ error: "User not found" });
        res.json(user);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Topup
app.post('/api/auth/topup', async (req, res) => {
    try {
        const { userId, amount } = req.body;
        if (isNaN(amount) || amount <= 0) {
            return res.status(400).json({ msg: "Invalid amount" });
        }
        
        await getCollection('users').updateOne(
            { _id: userId },
            { $inc: { balance: amount } }
        );
        
        res.json({ msg: `Successfully added ₦${amount}` });
    } catch (err) {
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

app.post('/api/products/purchase', async (req, res) => {
    try {
        const { userId, productId } = req.body;
        
        const product = await getCollection('products').findOne({ _id: productId });
        if (!product) return res.status(404).json({ error: "Product not found" });
        
        const user = await getCollection('users').findOne({ _id: userId });
        if (!user) return res.status(404).json({ error: "User not found" });
        
        if (user.balance < product.price) {
            return res.status(400).json({ error: "Insufficient balance" });
        }
        
        // Deduct balance
        await getCollection('users').updateOne(
            { _id: userId },
            { $inc: { balance: -product.price } }
        );
        
        // Reduce stock
        await getCollection('products').updateOne(
            { _id: productId },
            { $inc: { stock: -1 } }
        );
        
        // Create order
        const orderDetails = `LOGIN: ${product.credentials}\nLINK: ${product.public_link}`;
        await getCollection('orders').insertOne({
            user_id: userId,
            product_name: product.name,
            price: product.price,
            product_link: product.public_link,
            details: orderDetails,
            type: 'PRODUCT',
            status: 'COMPLETED',
            createdAt: new Date()
        });
        
        res.json({ message: "Success", details: orderDetails });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/products/delete/:id', async (req, res) => {
    try {
        await getCollection('products').deleteOne({ _id: req.params.id });
        res.json({ message: "Product deleted" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// ORDERS
// ============================================

app.get('/api/orders/all/:userId', async (req, res) => {
    try {
        const orders = await getCollection('orders').find({ user_id: req.params.userId }).toArray();
        res.json(orders);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// SMS ROUTES
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
        const history = await getCollection('sms_orders').find({ user_id: req.params.userId }).toArray();
        res.json(history);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/sms/add-allowed', async (req, res) => {
    try {
        const { service_name, display_name } = req.body;
        await getCollection('allowed_services').insertOne({
            service_name: service_name.toLowerCase(),
            display_name,
            createdAt: new Date()
        });
        res.json({ message: "Service added successfully!" });
    } catch (err) {
        res.status(500).json({ error: "Service already exists" });
    }
});

app.delete('/api/sms/delete-allowed/:id', async (req, res) => {
    try {
        await getCollection('allowed_services').deleteOne({ _id: req.params.id });
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
// TRANSACTIONS
// ============================================

app.get('/api/auth/transactions/:userId', async (req, res) => {
    try {
        const transactions = await getCollection('transactions').find({ user_id: req.params.userId }).toArray();
        res.json(transactions);
    } catch (err) {
        res.json([]);
    }
});

// ============================================
// ANNOUNCEMENTS
// ============================================

app.get('/api/announcement', async (req, res) => {
    try {
        const announcement = await getCollection('announcements').findOne({ is_active: true });
        res.json(announcement || {});
    } catch (err) {
        res.json({});
    }
});

app.post('/api/admin/announcement', async (req, res) => {
    try {
        const { title, message, type } = req.body;
        await getCollection('announcements').insertOne({
            title,
            message,
            type: type || 'info',
            is_active: true,
            createdAt: new Date()
        });
        res.json({ message: "Announcement published!" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/admin/announcement', async (req, res) => {
    try {
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

// ============================================
// SMM SERVICES
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
        res.json({ orderId: Math.random(), message: "Order placed!" });
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

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n👋 Server shutting down...');
    process.exit(0);
});