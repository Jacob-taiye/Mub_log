const express = require('express');
const router = express.Router();
const db = require('../config/db');

// --- PRODUCT ROUTES (CONVERTED TO ASYNC/AWAIT) ---

// 1. ADD NEW PRODUCT
router.post('/add', async (req, res) => {
    const { category, name, price, product_link, details, stock } = req.body;
    const sql = "INSERT INTO products (category, name, price, product_link, details, stock) VALUES (?, ?, ?, ?, ?, ?)";
    
    try {
        const [result] = await db.query(sql, [category, name, price, product_link, details, stock]);
        res.status(200).json({ message: "Product added successfully", id: result.insertId });
    } catch (err) {
        console.error("Add Product Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// 2. GET PRODUCTS BY CATEGORY (Used by index.html)
router.get('/category/:name', async (req, res) => {
    const categoryName = req.params.name;
    const sql = "SELECT * FROM products WHERE category = ? AND stock > 0"; // Only show items in stock

    try {
        const [results] = await db.query(sql, [categoryName]);
        res.json(results);
    } catch (err) {
        console.error("Get Category Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// 3. GET ALL PRODUCTS (For "Manage Products" section)
router.get('/all', async (req, res) => {
    const sql = "SELECT * FROM products ORDER BY id DESC";
    
    try {
        const [results] = await db.query(sql);
        res.json(results);
    } catch (err) {
        console.error("Get All Products Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// 4. GET ALL SALES / ORDERS (Admin Panel)
router.get('/all-orders', async (req, res) => {
    const sql = `
        SELECT orders.*, users.username 
        FROM orders 
        INNER JOIN users ON orders.user_id = users.id 
        ORDER BY orders.id DESC`;

    try {
        const [results] = await db.query(sql); 
        res.json(results);
    } catch (err) {
        console.error("Get All Orders Error:", err);
        try {
            const [fallback] = await db.query("SELECT * FROM orders ORDER BY id DESC");
            res.json(fallback);
        } catch (e) {
            res.status(500).json({ error: "Failed to fetch orders" });
        }
    }
});

// 5. DELETE PRODUCT
router.delete('/delete/:id', async (req, res) => {
    const productId = req.params.id;
    const sql = "DELETE FROM products WHERE id = ?";

    try {
        await db.query(sql, [productId]);
        res.json({ message: "Product deleted successfully" });
    } catch (err) {
        console.error("Delete Product Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// 6. UPDATE PRODUCT (Edit Feature)
router.put('/update/:id', async (req, res) => {
    const productId = req.params.id;
    const { name, price, stock, details } = req.body;
    const sql = "UPDATE products SET name = ?, price = ?, stock = ?, details = ? WHERE id = ?";

    try {
        await db.query(sql, [name, price, stock, details, productId]);
        res.json({ message: "Product updated successfully" });
    } catch (err) {
        console.error("Update Product Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// 7. PURCHASE PRODUCT (Deducts stock and removes sold line)
router.post('/purchase', async (req, res) => {
    const { userId, productId } = req.body;

    try {
        const [userRows] = await db.query("SELECT balance FROM users WHERE id = ?", [userId]);
        const [productRows] = await db.query("SELECT * FROM products WHERE id = ?", [productId]);

        if (userRows.length === 0 || productRows.length === 0) {
            return res.status(404).json({ error: "User or Product not found" });
        }

        const user = userRows[0];
        const product = productRows[0];

        if (product.stock <= 0) return res.status(400).json({ error: "Item out of stock" });
        if (parseFloat(user.balance) < parseFloat(product.price)) return res.status(400).json({ error: "Insufficient balance" });

        // Logic: Extract the first line from product_link to sell, update the rest back to the DB
        const lines = product.product_link.split('\n').filter(l => l.trim() !== "");
        const itemToDeliver = lines.shift(); 
        const remainingLines = lines.join('\n'); 
        const newStock = lines.length;

        // 1. Update User Balance
        await db.query("UPDATE users SET balance = balance - ? WHERE id = ?", [product.price, userId]);

        // 2. Update Product Stock and remaining data
        await db.query("UPDATE products SET product_link = ?, stock = ? WHERE id = ?", [remainingLines, newStock, productId]);

        // 3. Record Order
        await db.query(
            "INSERT INTO orders (user_id, product_name, price, product_link) VALUES (?, ?, ?, ?)",
            [userId, product.name, product.price, itemToDeliver]
        );

        res.json({ message: "Purchase successful", item: itemToDeliver });

    } catch (err) {
        console.error("Purchase Error:", err);
        res.status(500).json({ error: "Processing error" });
    }
});

// 8. GET INDIVIDUAL USER ORDERS (New Addition for "My Purchases")
router.get('/my-orders/:userId', async (req, res) => {
    const userId = req.params.userId;
    const sql = "SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC";

    try {
        const [results] = await db.query(sql, [userId]);
        res.json(results);
    } catch (err) {
        console.error("Get My Orders Error:", err);
        res.status(500).json({ error: "Failed to fetch your history" });
    }
});

module.exports = router;