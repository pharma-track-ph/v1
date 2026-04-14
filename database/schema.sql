-- ============================================================
-- PharmaTrack Database Schema
-- MySQL 8.0+
-- ============================================================

CREATE DATABASE IF NOT EXISTS pharmatrack;
USE pharmatrack;

-- ============================================================
-- USERS TABLE
-- Roles: super_admin, admin, cashier
-- ============================================================
CREATE TABLE users (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    name        VARCHAR(100)  NOT NULL,
    email       VARCHAR(150)  NOT NULL UNIQUE,
    password    VARCHAR(255)  NOT NULL,          -- bcrypt hash
    role        ENUM('super_admin','admin','cashier') NOT NULL DEFAULT 'cashier',
    is_active   TINYINT(1)    NOT NULL DEFAULT 1,
    created_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ============================================================
-- PRODUCTS TABLE
-- Core inventory model with expiry / batch tracking
-- ============================================================
CREATE TABLE products (
    id               INT AUTO_INCREMENT PRIMARY KEY,
    batch_number     VARCHAR(50)   NOT NULL,
    name             VARCHAR(150)  NOT NULL,
    generic_name     VARCHAR(150),
    category         VARCHAR(80)   NOT NULL,
    supplier         VARCHAR(150),
    description      TEXT,
    barcode          VARCHAR(80)   UNIQUE,
    price            DECIMAL(10,2) NOT NULL DEFAULT 0.00,   -- selling price
    cost             DECIMAL(10,2) NOT NULL DEFAULT 0.00,   -- purchase cost
    stock_quantity   INT           NOT NULL DEFAULT 0,
    low_stock_threshold INT        NOT NULL DEFAULT 10,
    expiry_date      DATE          NOT NULL,
    is_active        TINYINT(1)    NOT NULL DEFAULT 1,
    created_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_name       (name),
    INDEX idx_category   (category),
    INDEX idx_expiry     (expiry_date),
    INDEX idx_barcode    (barcode)
);

-- ============================================================
-- ORDERS TABLE
-- Each completed POS transaction
-- ============================================================
CREATE TABLE orders (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    order_number    VARCHAR(30)   NOT NULL UNIQUE,   -- e.g. ORD-20240315-001
    cashier_id      INT           NOT NULL,
    subtotal        DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    discount        DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    tax             DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    total           DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    payment_method  ENUM('cash','card','gcash','maya') NOT NULL DEFAULT 'cash',
    amount_tendered DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    change_amount   DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    status          ENUM('completed','voided','refunded') NOT NULL DEFAULT 'completed',
    notes           TEXT,
    created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (cashier_id) REFERENCES users(id) ON DELETE RESTRICT
);

-- ============================================================
-- ORDER ITEMS TABLE
-- Line items per order (tracks batch & price at time of sale)
-- ============================================================
CREATE TABLE order_items (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    order_id     INT           NOT NULL,
    product_id   INT           NOT NULL,
    batch_number VARCHAR(50)   NOT NULL,   -- snapshot at time of sale
    product_name VARCHAR(150)  NOT NULL,   -- snapshot
    quantity     INT           NOT NULL DEFAULT 1,
    unit_price   DECIMAL(10,2) NOT NULL,   -- price at time of sale
    unit_cost    DECIMAL(10,2) NOT NULL,   -- cost at time of sale
    subtotal     DECIMAL(10,2) NOT NULL,
    FOREIGN KEY (order_id)   REFERENCES orders(id)   ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
    INDEX idx_order   (order_id),
    INDEX idx_product (product_id)
);

-- ============================================================
-- AUDIT LOGS TABLE
-- Super Admin oversight: every critical action is recorded
-- ============================================================
CREATE TABLE audit_logs (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    user_id     INT          NOT NULL,
    action      VARCHAR(100) NOT NULL,   -- e.g. 'UPDATE_PRODUCT', 'DELETE_USER'
    entity      VARCHAR(80),             -- e.g. 'products'
    entity_id   INT,
    details     JSON,                    -- before/after snapshots
    ip_address  VARCHAR(45),
    created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_user   (user_id),
    INDEX idx_action (action),
    INDEX idx_entity (entity, entity_id)
);

-- ============================================================
-- SEED DATA
-- ============================================================

-- Passwords are bcrypt of 'password123' (12 rounds)
INSERT INTO users (name, email, password, role) VALUES
('Maria Santos',   'superadmin@pharmatrack.ph', '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMKiQqTl.KRoUsQVyVXumCqJle', 'super_admin'),
('Juan Dela Cruz', 'admin@pharmatrack.ph',       '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMKiQqTl.KRoUsQVyVXumCqJle', 'admin'),
('Ana Reyes',      'cashier@pharmatrack.ph',     '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMKiQqTl.KRoUsQVyVXumCqJle', 'cashier');

-- NOTE: Replace expiry_date values with dates relative to your current date.
-- PARACETAMOL: expires ~30 days from now (near-expiry demo)
-- BIOGESIC:    expires ~1 year from now (normal stock)
-- LOSARTAN:    low stock demo

INSERT INTO products (batch_number, name, generic_name, category, supplier, barcode, price, cost, stock_quantity, low_stock_threshold, expiry_date) VALUES
('BATCH-PARA-001', 'Paracetamol 500mg',   'Paracetamol',   'Analgesic',        'Unilab Inc.',       '4800001001001', 8.50,  4.00,  120, 20, DATE_ADD(CURDATE(), INTERVAL 28  DAY)),
('BATCH-BIO-001',  'Biogesic 500mg',      'Paracetamol',   'Analgesic',        'Unilab Inc.',       '4800001002001', 12.00, 6.00,  200, 20, DATE_ADD(CURDATE(), INTERVAL 365 DAY)),
('BATCH-LOS-001',  'Losartan 50mg',       'Losartan',      'Antihypertensive', 'Novartis Pharma',   '4800001003001', 22.00, 11.00, 6,   20, DATE_ADD(CURDATE(), INTERVAL 180 DAY)),
('BATCH-AMO-001',  'Amoxicillin 500mg',   'Amoxicillin',   'Antibiotic',       'GSK Philippines',   '4800001004001', 18.50, 9.00,  80,  15, DATE_ADD(CURDATE(), INTERVAL 120 DAY)),
('BATCH-MET-001',  'Metformin 500mg',     'Metformin',     'Antidiabetic',     'Merck Philippines', '4800001005001', 15.00, 7.50,  95,  15, DATE_ADD(CURDATE(), INTERVAL 200 DAY)),
('BATCH-IBU-001',  'Ibuprofen 200mg',     'Ibuprofen',     'Analgesic',        'Unilab Inc.',       '4800001006001', 10.00, 5.00,  5,   10, DATE_ADD(CURDATE(), INTERVAL 15  DAY)),
('BATCH-CEF-001',  'Cetirizine 10mg',     'Cetirizine',    'Antihistamine',    'Interphil',         '4800001007001', 9.00,  4.50,  150, 20, DATE_ADD(CURDATE(), INTERVAL 300 DAY)),
('BATCH-OMP-001',  'Omeprazole 20mg',     'Omeprazole',    'Antacid',          'AstraZeneca PH',    '4800001008001', 14.00, 7.00,  60,  15, DATE_ADD(CURDATE(), INTERVAL 90  DAY)),
('BATCH-ASA-001',  'Aspirin 80mg',        'Aspirin',       'Antiplatelet',     'Bayer Philippines', '4800001009001', 6.50,  3.00,  8,   10, DATE_ADD(CURDATE(), INTERVAL 45  DAY)),
('BATCH-AML-001',  'Amlodipine 5mg',      'Amlodipine',    'Antihypertensive', 'Pfizer Philippines','4800001010001', 19.00, 9.50,  45,  15, DATE_ADD(CURDATE(), INTERVAL 240 DAY));

-- Sample orders (last 7 days) for analytics demo
INSERT INTO orders (order_number, cashier_id, subtotal, discount, tax, total, payment_method, amount_tendered, change_amount, status) VALUES
('ORD-001', 3, 850.00, 0.00, 0.00, 850.00, 'cash', 1000.00, 150.00, 'completed'),
('ORD-002', 3, 340.00, 0.00, 0.00, 340.00, 'gcash', 340.00, 0.00,  'completed'),
('ORD-003', 3, 120.50, 0.00, 0.00, 120.50, 'cash', 200.00, 79.50,  'completed'),
('ORD-004', 3, 660.00, 50.00, 0.00, 610.00, 'cash', 700.00, 90.00, 'completed'),
('ORD-005', 3, 450.00, 0.00, 0.00, 450.00, 'maya', 450.00, 0.00,   'completed');

INSERT INTO order_items (order_id, product_id, batch_number, product_name, quantity, unit_price, unit_cost, subtotal) VALUES
(1, 1, 'BATCH-PARA-001', 'Paracetamol 500mg', 10, 8.50,  4.00, 85.00),
(1, 2, 'BATCH-BIO-001',  'Biogesic 500mg',    5,  12.00, 6.00, 60.00),
(2, 4, 'BATCH-AMO-001',  'Amoxicillin 500mg', 8,  18.50, 9.00, 148.00),
(3, 7, 'BATCH-CEF-001',  'Cetirizine 10mg',   6,  9.00,  4.50, 54.00),
(4, 3, 'BATCH-LOS-001',  'Losartan 50mg',     4,  22.00, 11.00, 88.00),
(5, 5, 'BATCH-MET-001',  'Metformin 500mg',   6,  15.00, 7.50, 90.00);
