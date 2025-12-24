const mysql = require('mysql2');
const dotenv = require('dotenv');
dotenv.config();

const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: '', // Default XAMPP password is empty
    database: 'digital_store',
    waitForConnections: true,
    connectionLimit: 10
});

module.exports = pool.promise();