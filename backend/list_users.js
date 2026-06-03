const Database = require('better-sqlite3');
const db = new Database('data/bportal.db');

const rows = db.prepare('SELECT username, password_hash, role FROM users').all();
console.table(rows);
db.close();
