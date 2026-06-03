const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const db = new Database('data/bportal.db');

// Add hashing to existing users
const users = db.prepare('SELECT username, password_hash FROM users').all();

for (const user of users) {
    // Check if it's already a hash (simple check, bcrypt hashes usually start with $2a$ or $2b$)
    if (!user.password_hash.startsWith('$2a$') && !user.password_hash.startsWith('$2b$')) {
        const hashedPassword = bcrypt.hashSync(user.password_hash, 10);
        db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(hashedPassword, user.username);
        console.log(`Hashed password for user: ${user.username}`);
    }
}

db.close();
console.log("Migration to hashed passwords complete.");
