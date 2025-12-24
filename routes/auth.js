const express = require('express');
const router = express.Router();
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const crypto = require('crypto'); // Built-in, no installation needed!

// Database connection
const pool = mysql.createPool({
    host: 'localhost', user: 'root', password: '', database: 'digital_store'
});

// Helper function to create a "Token" without the jwt module
const createToken = (data) => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString('base64');
    const payload = Buffer.from(JSON.stringify(data)).toString('base64');
    const signature = crypto.createHmac('sha256', 'your_secret_key').update(`${header}.${payload}`).digest('base64');
    return `${header}.${payload}.${signature}`;
};

/// 1. REGISTER
router.post('/register', async (req, res) => {
    const { username, email, password } = req.body;
    try {
        // Hash the password so even if the DB is hacked, users are safe
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        await pool.execute(
            'INSERT INTO users (username, email, password, balance) VALUES (?, ?, ?, ?)',
            [username, email, hashedPassword, 0.00]
        );
        res.status(201).json({ msg: "User created successfully!" });
    } catch (err) {
        res.status(500).json({ error: "Email or Username already exists" });
    }
});

// 2. LOGIN
router.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const [users] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
        if (users.length === 0) return res.status(400).json({ msg: "User not found" });

        const user = users[0];
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ msg: "Invalid password" });

        res.json({
            msg: "Login successful",
            user: { 
                id: user.id, 
                username: user.username, 
                balance: user.balance,
                role: user.role // <--- Add this
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get all users (Admin only)
router.get('/users', async (req, res) => {
    try {
        // We only fetch id, username, email, and balance (don't send passwords!)
        const [users] = await pool.execute('SELECT id, username, email, balance FROM users');
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Route for Admin to manually add balance to a user
router.post('/topup', async (req, res) => {
    const { userId, amount } = req.body;

    try {
        // Validation: make sure it's a number
        if (isNaN(amount)) {
            return res.status(400).json({ msg: "Invalid amount" });
        }

        // The SQL command: UPDATE the balance by adding the new amount
        const [result] = await pool.execute(
            'UPDATE users SET balance = balance + ? WHERE id = ?',
            [amount, userId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ msg: "User not found" });
        }

        res.json({ msg: `Successfully added $${amount}` });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Database update failed" });
    }
});

// Get specific user data (Balance and Username)
router.get('/user/:id', async (req, res) => {
    try {
        const [users] = await pool.execute(
            'SELECT id, username, email, balance, role FROM users WHERE id = ?', 
            [req.params.id]
        );

        if (users.length === 0) {
            return res.status(404).json({ msg: "User not found" });
        }

        res.json(users[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Database error" });
    }
});

module.exports = router;