const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const db = new Database('data/bportal.db');
const schema = fs.readFileSync('schema.sql', 'utf8');
db.exec(schema);

const DEFAULT_USERS = [
  { username: 'user', password: 'user', user: { name: 'Anders Jansson', role: 'member', email: 'personal@example.com' } },
  { username: 'admin', password: 'ambitionadmin', user: { name: 'Andreas', role: 'admin', email: 'admin@example.com' } },
];

const insertUser = db.prepare('INSERT OR IGNORE INTO users (username, password_hash, name, role, email) VALUES (?, ?, ?, ?, ?)');

for (const entry of DEFAULT_USERS) {
    const hashedPassword = bcrypt.hashSync(entry.password, 10);
    insertUser.run(entry.username, hashedPassword, entry.user.name, entry.user.role, entry.user.email);
}

console.log("Database initialized with hashed user passwords.");
db.close();
