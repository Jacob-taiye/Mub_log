const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const dotenv = require('dotenv');
const axios = require('axios'); 
const productRoutes = require('./routes/products'); 
const authRoutes = require('./routes/auth');

require('dotenv').config();
const app = express();
const FIVESIM_BASE = 'https://5sim.net/v1/user';

app.use(cors()); 
app.use(express.json());

const db = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '', 
    database: process.env.DB_NAME || 'digital_store',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

db.getConnection((err, connection) => {
    if (err) {
        console.error('❌ XAMPP MySQL Error: ' + err.message);
    } else {
        console.log('✅ Connected to XAMPP MySQL Database');
        connection.release();
    }
});

// --- 🚀 GLOBAL CONFIGURATION ---
let PROFIT_PERCENTAGE = 0.1;   
let NGN_EXCHANGE_RATE = 1650; // USD to NGN rate (for SMM services)
const RUB_TO_NGN_RATE = 5;  // Ruble to NGN rate (for 5sim SMS services) 
const SMM_API_URL = 'https://reallysimplesocial.com/api/v2';
const SMM_API_KEY = process.env.SMM_API_KEY || 'YOUR_SMM_API_KEY';
// Remove the hardcoded 'FLWSECK_TEST' string entirely
const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY;

if (!FLW_SECRET_KEY || FLW_SECRET_KEY.includes('TEST')) {
    console.warn("⚠️ WARNING: You are using a TEST key or no key. Live payments will fail.");
}

db.query("SELECT * FROM settings WHERE id = 1", (err, results) => {
    if (!err && results.length > 0) {
        PROFIT_PERCENTAGE = results[0].profit_margin;
        NGN_EXCHANGE_RATE = results[0].exchange_rate;
    }
});

const FIVESIM_TOKEN = process.env.FIVESIM_API_KEY || process.env.FIVESIM_TOKEN; 
const fivesim = axios.create({
    baseURL: 'https://5sim.net/v1/user',
    headers: { 
        'Authorization': `Bearer ${FIVESIM_TOKEN}`, 
        'Accept': 'application/json' 
    }
});

// --- 🔧 DEBUG ROUTES ---
app.get('/api/debug/orders-table', (req, res) => {
    db.query("DESCRIBE orders", (err, columns) => {
        if (err) return res.json({ error: "Orders table doesn't exist", message: err.message });
        res.json({ 
            table: "orders",
            columns: columns.map(c => c.Field),
            full: columns
        });
    });
});

app.get('/api/debug/user-orders/:userId', (req, res) => {
    const userId = req.params.userId;
    console.log('Debug: Fetching orders for user:', userId);
    db.query("SELECT * FROM orders WHERE user_id = ?", [userId], (err, results) => {
        if (err) return res.json({ error: err.message });
        console.log('Debug: Found orders:', results.length);
        res.json({ 
            userId, 
            ordersCount: results.length, 
            orders: results 
        });
    });
});

app.get('/api/debug/user/:userId', (req, res) => {
    const userId = req.params.userId;
    db.query("SELECT id, username, balance FROM users WHERE id = ?", [userId], (err, results) => {
        if (err) return res.json({ error: err.message });
        res.json({ 
            found: results.length > 0,
            user: results[0] 
        });
    });
});

// --- 💤 ADMIN SETTINGS ---
app.post('/api/admin/settings', (req, res) => {
    const { exchange_rate, profit_margin } = req.body;
    const query = "UPDATE settings SET exchange_rate = ?, profit_margin = ? WHERE id = 1";
    db.query(query, [exchange_rate, profit_margin], (err) => {
        if (err) return res.status(500).json({ error: "Failed to update settings" });
        NGN_EXCHANGE_RATE = exchange_rate;
        PROFIT_PERCENTAGE = profit_margin;
        res.json({ message: "Settings updated successfully" });
    });
});

// --- 💤 USER INFO ROUTE ---
app.get('/api/auth/user/:userId', (req, res) => {
    const userId = req.params.userId;
    const query = "SELECT username, email, balance FROM users WHERE id = ?";
    db.query(query, [userId], (err, results) => {
        if (err) return res.status(500).json({ error: "Database error" });
        if (results.length === 0) return res.status(404).json({ error: "User not found" });
        res.json(results[0]);
    });
});

// --- 📱 SMS ROUTES ---
app.get('/api/sms/available-services', (req, res) => {
    db.query("SELECT DISTINCT service_name, display_name FROM allowed_services", (err, results) => {
        if (err) return res.status(500).json({ error: "DB Error" });
        res.json(results);
    });
});

app.get('/api/sms/allowed-services', (req, res) => {
    db.query("SELECT * FROM allowed_services", (err, results) => {
        if (err) return res.status(500).json({ error: "DB Error" });
        res.json(results);
    });
});

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
                    // Calculate price: 5sim returns price in Rubles
                    // Convert Rubles to NGN, then add 20% markup
                    const basePrice = info.cost * RUB_TO_NGN_RATE;
                    const finalPrice = basePrice * 1.20; // 20% markup
                    results.push({
                        country,
                        operator,
                        price: Math.ceil(finalPrice),
                        stock: info.count
                    });
                }
            }
        }
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: "Error fetching rates" });
    }
});

// --- 📱 SMS ORDER LOGIC ---
app.post('/api/sms/order', async (req, res) => {
    const { userId, service, country, operator } = req.body;
    try {
        const response = await fetch(`${FIVESIM_BASE}/buy/activation/${country}/${operator}/${service}`, {
            headers: { 
                Accept: "application/json", 
                Authorization: `Bearer ${FIVESIM_TOKEN}` 
            }
        });
        
        // Check if response is OK
        if (!response.ok) {
            const errorText = await response.text();
            console.error('5sim API Error:', response.status, errorText);
            return res.status(400).json({ 
                error: errorText.includes('balance') ? 'Insufficient balance in 5sim account' : 
                       errorText.includes('stock') ? 'No numbers available for this service' :
                       `Service unavailable: ${errorText}` 
            });
        }

        // Try to parse JSON response
        let data;
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
            data = await response.json();
        } else {
            const text = await response.text();
            console.error('5sim returned non-JSON:', text);
            return res.status(400).json({ error: text || 'Service unavailable' });
        }

        if (!data.id) {
            return res.status(400).json({ error: data.error || "No stock available" });
        }

        // Calculate price: 5sim returns price in Rubles
        // Convert Rubles to NGN, then add 20% markup
        const basePrice = data.price * RUB_TO_NGN_RATE;
        const price = Math.ceil(basePrice * 1.20); // 20% markup

        // Deduct Balance
        db.query("UPDATE users SET balance = balance - ? WHERE id = ?", [price, userId]);

        // Insert into SMS specific table
        db.query(`INSERT INTO sms_orders (user_id, order_id_5sim, phone, service, country, operator, price, status) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`, 
                 [userId, data.id, data.phone, service, country, operator, price]);

        // Insert into General Orders table for history
        db.query(`INSERT INTO orders (user_id, type, product_name, amount, details, phone, status, created_at) 
                 VALUES (?, 'SMS', ?, ?, ?, ?, 'ACTIVE', NOW())`, 
                 [userId, service, price, `Order ID: ${data.id} - Waiting for code...`, data.phone]);

        res.json({ orderId: data.id, phone: data.phone });
    } catch (err) {
        console.error('SMS Error:', err);
        res.status(500).json({ error: err.message || "SMS purchase failed" });
    }
});

app.get('/api/sms/check/:orderId', async (req, res) => {
    const orderId = req.params.orderId;
    try {
        const response = await fivesim.get(`/check/${orderId}`);
        const data = response.data;
        if (data.sms && data.sms.length > 0) {
            const code = data.sms[0].code;
            db.query("UPDATE sms_orders SET status='COMPLETED', sms_code=? WHERE order_id_5sim=?", [code, orderId]);
            db.query("UPDATE orders SET status='COMPLETED', details=? WHERE details LIKE ?", [`SMS Code: ${code}`, `%${orderId}%`]);
            return res.json({ code, status: 'COMPLETED' });
        }
        res.json({ status: data.status });
    } catch (err) { 
        console.error('SMS Check Error:', err);
        res.status(500).json({ error: "Check failed" }); 
    }
});

app.post('/api/sms/cancel/:orderId', async (req, res) => {
    const orderId = req.params.orderId;
    try {
        await fivesim.get(`/cancel/${orderId}`);
        db.query("UPDATE sms_orders SET status='CANCELLED' WHERE order_id_5sim=?", [orderId]);
        db.query("UPDATE orders SET status='CANCELLED' WHERE details LIKE ?", [`%${orderId}%`]);
        res.json({ status: "CANCELLED" });
    } catch (err) { 
        console.error('SMS Cancel Error:', err);
        res.status(500).json({ error: "Cancel failed" }); 
    }
});

// --- 🛒 PRODUCTS & MARKETPLACE ---
app.get('/api/products/category/:category', (req, res) => {
    db.query("SELECT id, name, price, description, public_link, stock FROM products WHERE category = ? AND stock > 0", [req.params.category], (err, results) => {
        if (err) return res.status(500).json({ error: "DB Error" });
        res.json(results || []);
    });
});

app.get('/api/products/all', (req, res) => {
    db.query("SELECT id, name, category, price, stock FROM products", (err, results) => {
        if (err) return res.status(500).json({ error: "DB Error" });
        res.json(results || []);
    });
});

app.get('/api/products/all-orders', (req, res) => {
    const sql = `
        SELECT 
            o.id,
            o.user_id,
            o.product_name,
            o.price,
            o.product_link,
            o.details,
            o.created_at,
            u.username
        FROM orders o
        LEFT JOIN users u ON o.user_id = u.id
        ORDER BY o.created_at DESC
        LIMIT 100
    `;
    
    db.query(sql, (err, results) => {
        if (err) {
            console.error('All orders query error:', err);
            return res.status(500).json({ error: "Database error" });
        }
        res.json(results || []);
    });
});

app.post('/api/products/add', (req, res) => {
    const { category, name, price, public_link, description, credentials, stock } = req.body;
    const sql = `INSERT INTO products (category, name, price, public_link, description, credentials, stock) VALUES (?, ?, ?, ?, ?, ?, ?)`;
    db.query(sql, [category, name, price, public_link, description, credentials, stock], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "Product added", id: result.insertId });
    });
});

app.post('/api/products/purchase', (req, res) => {
    const { userId, productId } = req.body;
    
    db.query("SELECT * FROM products WHERE id = ?", [productId], (err, productRes) => {
        if (err || productRes.length === 0) {
            return res.status(404).json({ error: "Product not found" });
        }
        
        const product = productRes[0];

        db.query("SELECT balance FROM users WHERE id = ?", [userId], (err, userRes) => {
            if (err || !userRes.length) {
                return res.status(404).json({ error: "User not found" });
            }
            
            if (userRes[0].balance < product.price) {
                return res.status(400).json({ error: `Insufficient balance. Need ₦${product.price}, You have ₦${userRes[0].balance}` });
            }

            // Format credentials for display to customer
            const orderDetails = `LOGIN: ${product.credentials}\nLINK: ${product.public_link}`;
            
            // Deduct balance
            db.query("UPDATE users SET balance = balance - ? WHERE id = ?", [product.price, userId], (err) => {
                if (err) {
                    console.error("Balance update error:", err);
                    return res.status(500).json({ error: "Balance update failed" });
                }

                // Reduce stock
                db.query("UPDATE products SET stock = stock - 1 WHERE id = ?", [productId], (err) => {
                    if (err) console.error("Stock update error:", err);
                });

                // Insert into orders table - FIXED FOR YOUR TABLE STRUCTURE
                db.query(
                    `INSERT INTO orders (user_id, product_name, price, product_link, details) 
                     VALUES (?, ?, ?, ?, ?)`, 
                    [userId, product.name, product.price, product.public_link, orderDetails], 
                    (err) => {
                        if (err) {
                            console.error("Order insert error:", err);
                            return res.status(500).json({ error: "Order record failed" });
                        }
                        res.json({ message: "Success", details: orderDetails });
                    }
                );
            });
        });
    });
});

app.delete('/api/products/delete/:id', (req, res) => {
    db.query("DELETE FROM products WHERE id = ?", [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: "Delete failed" });
        res.json({ message: "Product deleted" });
    });
});

// --- 📋 HISTORY ROUTES ---
app.get('/api/orders/all/:userId', (req, res) => {
    const userId = req.params.userId;
    console.log('Fetching orders for userId:', userId);
    
    db.query(
        `SELECT 
            id,
            user_id,
            product_name,
            price,
            product_link,
            details,
            created_at,
            'PRODUCT' AS type,
            'COMPLETED' AS status
        FROM orders 
        WHERE user_id = ?
        ORDER BY created_at DESC`, 
        [userId], 
        (err, results) => {
            if (err) {
                console.error('Order query error:', err);
                return res.status(500).json({ error: "Database error", message: err.message });
            }
            console.log('Found orders:', results.length);
            res.json(results || []);
        }
    );
});

app.get('/api/auth/transactions/:userId', (req, res) => {
    db.query("SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC", [req.params.userId], (err, results) => {
        if (err) return res.status(500).json({ error: "Database error" });
        res.json(results || []);
    });
});

app.get('/api/sms/history/:userId', (req, res) => {
    db.query("SELECT * FROM sms_orders WHERE user_id = ? ORDER BY created_at DESC", [req.params.userId], (err, results) => {
        if (err) return res.status(500).json({ error: "Database error" });
        res.json(results || []);
    });
});

// --- 📱 ADMIN: SMS MANAGEMENT ---
app.post('/api/sms/add-allowed', (req, res) => {
    const { service_name, display_name } = req.body;
    db.query("INSERT INTO allowed_services (service_name, display_name) VALUES (?, ?)", [service_name.toLowerCase(), display_name], (err, result) => {
        if (err) return res.status(500).json({ error: "Service already exists" });
        res.json({ message: "Service added successfully!" });
    });
});

app.delete('/api/sms/delete-allowed/:id', (req, res) => {
    db.query("DELETE FROM allowed_services WHERE id = ?", [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: "Delete failed" });
        res.json({ message: "Service deleted" });
    });
});

app.get('/api/sms/admin-all-prices', (req, res) => {
    db.query("SELECT * FROM allowed_services", (err, results) => {
        if (err) return res.status(500).json({ error: "DB Error" });
        res.json(results || []);
    });
});

// --- 🎉 LIVE SMM SERVICES ---
// REPLACE THE /api/smm/live-services endpoint in server.js

app.get('/api/smm/live-services', async (req, res) => {
    try {
        const response = await axios.get(SMM_API_URL, { 
            params: { 
                key: SMM_API_KEY, 
                action: 'services' 
            } 
        });
        
        // Apply 20% markup on top of base price
        const MARKUP_PERCENTAGE = 20;
        
        const processed = response.data.map(s => {
            const basePrice = parseFloat(s.rate);
            // Price = base price + (base price * 20%)
            const finalPrice = basePrice * (1 + MARKUP_PERCENTAGE / 100);
            
            return { 
                id: s.service, 
                name: s.name, 
                category: s.category, 
                min: s.min, 
                max: s.max, 
                rate: finalPrice.toFixed(2) 
            };
        });
        
        console.log('SMM Services loaded with 20% markup');
        res.json(processed);
    } catch (error) { 
        console.error('SMM API error:', error.message);
        res.status(500).json({ error: "SMM API error" }); 
    }
});
app.post('/api/smm/order', async (req, res) => {
    const { userId, service, link, quantity } = req.body;
    
    try {
        // First, get the service price from SMM API
        const servicesRes = await axios.get(SMM_API_URL, { 
            params: { key: SMM_API_KEY, action: 'services' } 
        });
        
        const serviceData = servicesRes.data.find(s => s.service == service);
        if (!serviceData) {
            return res.status(400).json({ error: "Service not found" });
        }
        
        // Calculate total cost with 20% markup
        const basePrice = parseFloat(serviceData.rate);
        const pricePerUnit = basePrice * 1.20; // 20% markup
        const totalCost = (pricePerUnit / 1000) * quantity; // Price is per 1000
        
        // Check user balance
        db.query("SELECT balance FROM users WHERE id = ?", [userId], async (err, userRes) => {
            if (err || !userRes.length) {
                return res.status(404).json({ error: "User not found" });
            }
            
            if (userRes[0].balance < totalCost) {
                return res.status(400).json({ 
                    error: `Insufficient balance. Need ₦${totalCost.toFixed(2)}, You have ₦${userRes[0].balance}` 
                });
            }
            
            // Place order with SMM API
            try {
                const response = await axios.post(SMM_API_URL, {
                    key: SMM_API_KEY,
                    action: 'add',
                    service,
                    link,
                    quantity
                });
                
                const data = response.data;
                if (!data.order) {
                    return res.status(400).json({ error: data.error || "Order failed" });
                }
                
                // Deduct balance
                db.query("UPDATE users SET balance = balance - ? WHERE id = ?", [totalCost, userId]);
                
                // Save to orders table
                db.query(
                    `INSERT INTO orders (user_id, type, product_name, amount, details, status, created_at) 
                     VALUES (?, 'SMM', ?, ?, ?, 'COMPLETED', NOW())`,
                    [userId, serviceData.name, totalCost, `Order ID: ${data.order} | Link: ${link} | Qty: ${quantity}`]
                );
                
                res.json({ orderId: data.order, message: "Order placed successfully!" });
            } catch (apiErr) {
                console.error('SMM API Error:', apiErr.response?.data || apiErr.message);
                res.status(500).json({ error: "SMM service error" });
            }
        });
        
    } catch (err) {
        console.error('SMM Order error:', err);
        res.status(500).json({ error: "SMM order failed" });
    }
});

// --- 📢 ADMIN ANNOUNCEMENT SYSTEM ---
app.get('/api/announcement', (req, res) => {
    db.query("SELECT * FROM announcements WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1", (err, results) => {
        if (err) return res.status(500).json({ error: "Database error" });
        res.json(results.length > 0 ? results[0] : null);
    });
});

app.post('/api/admin/announcement', (req, res) => {
    const { title, message, type } = req.body; // type: 'info', 'warning', 'success'
    
    // Deactivate old announcements
    db.query("UPDATE announcements SET is_active = 0", (err) => {
        if (err) return res.status(500).json({ error: "Database error" });
        
        // Insert new announcement
        db.query(
            "INSERT INTO announcements (title, message, type, is_active, created_at) VALUES (?, ?, ?, 1, NOW())",
            [title, message, type || 'info'],
            (err) => {
                if (err) return res.status(500).json({ error: "Failed to create announcement" });
                res.json({ message: "Announcement published!" });
            }
        );
    });
});

app.delete('/api/admin/announcement', (req, res) => {
    db.query("UPDATE announcements SET is_active = 0", (err) => {
        if (err) return res.status(500).json({ error: "Database error" });
        res.json({ message: "Announcement removed" });
    });
});


// Manual payment verification (fallback)
app.post('/api/auth/verify-payment', async (req, res) => {
    const { transaction_id, userId } = req.body;
    
    try {
        // Verify transaction with Flutterwave API
        const response = await axios.get(
            `https://api.flutterwave.com/v3/transactions/${transaction_id}/verify`,
            {
                headers: {
                    'Authorization': `Bearer ${FLW_SECRET_KEY}`
                }
            }
        );
        
        const data = response.data;
        
        if (data.status === 'success' && data.data.status === 'successful') {
            const amount = data.data.amount;
            const tx_ref = data.data.tx_ref;
            
            // Check if already processed
            db.query("SELECT * FROM transactions WHERE reference_id = ?", [tx_ref], (err, existing) => {
                if (err) return res.status(500).json({ error: "Database error" });
                
                if (existing.length > 0) {
                    return res.json({ message: "Payment already credited", amount });
                }
                
                // Add balance
                db.query("UPDATE users SET balance = balance + ? WHERE id = ?", [amount, userId], (err) => {
                    if (err) return res.status(500).json({ error: "Failed to update balance" });
                    
                    // Record transaction
                    db.query(
                        "INSERT INTO transactions (user_id, amount, reference_id, status, created_at) VALUES (?, ?, ?, 'SUCCESS', NOW())",
                        [userId, amount, tx_ref],
                        (err) => {
                            if (err) console.error('Transaction record error:', err);
                        }
                    );
                    
                    res.json({ success: true, message: "Payment verified successfully", amount });
                });
            });
        } else {
            res.status(400).json({ error: "Payment verification failed" });
        }
    } catch (error) {
        console.error('Verify payment error:', error.response?.data || error.message);
        res.status(500).json({ error: "Verification failed" });
    }
});

async function handlePaymentComplete(transaction_id) {
        const btn = document.getElementById('paymentBtn');
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Verifying payment...';
        
        let attempts = 0;
        const maxAttempts = 15; // Try for up to 30 seconds
        let verificationSuccess = false;
        
        const checkPayment = async () => {
            attempts++;
            console.log(`🔍 Verification attempt ${attempts}/${maxAttempts}`);
            
            try {
                const res = await fetch(`${API_BASE}/auth/verify-payment`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ transaction_id, userId })
                });
                
                const data = await res.json();
                console.log('📡 Verification response:', data);
                
                if (res.ok && data.success) {
                    // Payment successfully verified and credited
                    verificationSuccess = true;
                    
                    btn.innerHTML = '<i class="fas fa-check-circle"></i> Payment successful!';
                    
                    // Update UI
                    await updateBalance();
                    await loadDashboardStats();
                    
                    // Show success message
                    alert(`✅ Success! Your wallet has been credited with ₦${parseFloat(data.amount).toLocaleString()}`);
                    
                    // Navigate to dashboard
                    showSection('dashboard');
                    
                    // Clear input and reset button
                    document.getElementById('topupAmount').value = '';
                    setTimeout(() => {
                        btn.disabled = false;
                        btn.innerHTML = '<i class="fas fa-credit-card"></i> Continue to Payment';
                    }, 2000);
                    
                    return;
                }
                
                if (data.alreadyProcessed) {
                    // Already credited (duplicate verification)
                    verificationSuccess = true;
                    
                    await updateBalance();
                    await loadDashboardStats();
                    
                    alert(`✅ Payment confirmed! Amount: ₦${parseFloat(data.amount).toLocaleString()}`);
                    
                    showSection('dashboard');
                    document.getElementById('topupAmount').value = '';
                    btn.disabled = false;
                    btn.innerHTML = '<i class="fas fa-credit-card"></i> Continue to Payment';
                    
                    return;
                }
                
                // If pending, try again
                if (data.pending && attempts < maxAttempts) {
                    console.log('⏳ Payment still processing, retrying...');
                    setTimeout(checkPayment, 2000);
                    return;
                }
                
                // If not successful yet and haven't exceeded attempts
                if (!verificationSuccess && attempts < maxAttempts) {
                    console.log('🔄 Retrying verification...');
                    setTimeout(checkPayment, 2000);
                } else if (attempts >= maxAttempts) {
                    // Max attempts reached
                    btn.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Verification timeout';
                    
                    alert('⏳ Payment verification is taking longer than expected. Your balance will update automatically within a few minutes. Please check back shortly.');
                    
                    showSection('dashboard');
                    
                    btn.disabled = false;
                    btn.innerHTML = '<i class="fas fa-credit-card"></i> Continue to Payment';
                    
                    // Keep checking in background
                    setTimeout(() => {
                        updateBalance();
                        loadDashboardStats();
                    }, 10000);
                }
                
            } catch (error) {
                console.error('❌ Verification error:', error);
                
                if (attempts < maxAttempts) {
                    console.log('🔄 Retrying after error...');
                    setTimeout(checkPayment, 2000);
                } else {
                    btn.innerHTML = '<i class="fas fa-exclamation-circle"></i> Verification failed';
                    
                    alert('⚠️ Unable to verify payment automatically. Please contact support with your transaction ID: ' + transaction_id);
                    
                    btn.disabled = false;
                    setTimeout(() => {
                        btn.innerHTML = '<i class="fas fa-credit-card"></i> Continue to Payment';
                    }, 3000);
                }
            }
        };
        
        // Start verification
        checkPayment();
    }

// --- 🔑 AUTH ROUTES & ROUTES ---
app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);

app.listen(5000, () => console.log('🚀 Server running on port 5000'));