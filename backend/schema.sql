-- SQLite schema for Bportal

CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'orderer',
    email TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS user_groups (
    username TEXT,
    group_name TEXT,
    PRIMARY KEY (username, group_name),
    FOREIGN KEY (username) REFERENCES users(username)
);

CREATE TABLE IF NOT EXISTS departments (
    name TEXT PRIMARY KEY,
    description TEXT
);

CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    "from" TEXT NOT NULL,
    msg TEXT NOT NULL,
    deadline TEXT,
    dept TEXT,
    status TEXT NOT NULL,
    FOREIGN KEY (dept) REFERENCES departments(name)
);

CREATE TABLE IF NOT EXISTS user_settings (
    email TEXT PRIMARY KEY,
    settings_json TEXT
);
