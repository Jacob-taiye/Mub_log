try {
    require('express');
    require('jsonwebtoken');
    require('mysql2');
    console.log("✅ All modules are installed and readable!");
} catch (err) {
    console.log("❌ Missing module:", err.message);
}