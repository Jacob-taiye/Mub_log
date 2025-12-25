const express = require('express');
const router = express.Router();
const { Pool } = require('pg');

// ============================================
// PostgreSQL CONNECTION
// ============================================
const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: {
        rejectUnauthorized: false
    }
});

// ============================================
// 1. ADD NEW PRODUCT
// ============================================
router.post('/add', async (req, res) => {
    const { category, name, price, public_link, description, credentials, stock } = req.body;

    try {
        const result = await pool.query(
            `INSERT INTO products (category, name, price, public_link, description, credentials, stock, created_at) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
             RETURNING id, name, price`,
            [category, name, price, public_link, description, credentials, stock || 1]
        );

        res.status(200).json({ 
            message: "Product added successfully", 
            id: result.rows[0].id 
        });
    } catch (err) {
        console.error("Add Product Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// 2. GET PRODUCTS BY CATEGORY
// ============================================
router.get('/category/:category', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, name, price, description, public_link, stock, category 
             FROM products 
             WHERE category = $1 AND stock > 0
             ORDER BY created_at DESC`,
            [req.params.category]
        );
        res.json(result.rows);
    } catch (err) {
        console.error("Get Category Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// 3. GET ALL PRODUCTS (Admin)
// ============================================
router.get('/all', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, name, category, price, stock, description, public_link, created_at 
             FROM products 
             ORDER BY created_at DESC`
        );
        res.json(result.rows);
    } catch (err) {
        console.error("Get All Products Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// 4. GET ALL ORDERS/SALES (Admin Panel)
// ============================================
router.get('/all-orders', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT 
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
             LIMIT 100`
        );
        res.json(result.rows);
    } catch (err) {
        console.error("Get All Orders Error:", err.message);
        res.status(500).json({ error: "Failed to fetch orders" });
    }
});

// ============================================
// 5. DELETE PRODUCT
// ============================================
router.delete('/delete/:id', async (req, res) => {
    try {
        const result = await pool.query(
            'DELETE FROM products WHERE id = $1 RETURNING id',
            [req.params.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Product not found" });
        }

        res.json({ message: "Product deleted successfully" });
    } catch (err) {
        console.error("Delete Product Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// 6. UPDATE PRODUCT
// ============================================
router.put('/update/:id', async (req, res) => {
    const { name, price, stock, description } = req.body;

    try {
        const result = await pool.query(
            `UPDATE products 
             SET name = $1, price = $2, stock = $3, description = $4 
             WHERE id = $5
             RETURNING id`,
            [name, price, stock, description, req.params.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Product not found" });
        }

        res.json({ message: "Product updated successfully" });
    } catch (err) {
        console.error("Update Product Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// 7. PURCHASE PRODUCT
// ============================================
router.post('/purchase', async (req, res) => {
    const { userId, productId } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // Get user
        const userResult = await client.query(
            'SELECT balance FROM users WHERE id = $1',
            [userId]
        );

        if (userResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: "User not found" });
        }

        // Get product
        const productResult = await client.query(
            'SELECT * FROM products WHERE id = $1',
            [productId]
        );

        if (productResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: "Product not found" });
        }

        const user = userResult.rows[0];
        const product = productResult.rows[0];

        // Validations
        if (product.stock <= 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: "Item out of stock" });
        }

        if (parseFloat(user.balance) < parseFloat(product.price)) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: "Insufficient balance" });
        }

        // Deduct balance
        await client.query(
            'UPDATE users SET balance = balance - $1 WHERE id = $2',
            [product.price, userId]
        );

        // Reduce stock
        await client.query(
            'UPDATE products SET stock = stock - 1 WHERE id = $1',
            [productId]
        );

        // Create order details
        const orderDetails = `LOGIN: ${product.credentials}\nLINK: ${product.public_link}`;

        // Record order
        await client.query(
            `INSERT INTO orders (user_id, product_name, price, product_link, details, created_at) 
             VALUES ($1, $2, $3, $4, $5, NOW())`,
            [userId, product.name, product.price, product.public_link, orderDetails]
        );

        await client.query('COMMIT');
        res.json({ message: "Purchase successful", details: orderDetails });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Purchase Error:", err.message);
        res.status(500).json({ error: "Processing error" });
    } finally {
        client.release();
    }
});

// ============================================
// 8. GET USER ORDERS (My Purchases)
// ============================================
router.get('/my-orders/:userId', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM orders 
             WHERE user_id = $1 
             ORDER BY created_at DESC`,
            [req.params.userId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error("Get My Orders Error:", err.message);
        res.status(500).json({ error: "Failed to fetch your history" });
    }
});

module.exports = router;