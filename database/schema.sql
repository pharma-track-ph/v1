-- ============================================================
-- PharmaTrack Database Schema
-- MySQL 8.0+
-- Regenerated to reflect the CURRENT live structure -- the previous
-- version of this file predated Cash Register, avatars, both OTP
-- flows, and several other features, and had drifted out of sync with
-- reality (columns/tables added via ad-hoc ALTER TABLE at runtime,
-- never backported here). See the note above each addition below for
-- where it was verified from.
-- ============================================================

CREATE DATABASE IF NOT EXISTS pharmatrack;
USE pharmatrack;

-- ============================================================
-- USERS TABLE
-- Roles: super_admin ("Admin" label), admin ("Owner" label), cashier
-- ("Pharmacy Assistant" label) -- see main.js/users.js/audit.js for the
-- label mapping; these three DB values and every permission check are
-- unaffected by that display-only swap.
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    name        VARCHAR(100)  NOT NULL,
    email       VARCHAR(150)  NOT NULL UNIQUE,
    password    VARCHAR(255)  NOT NULL,          -- bcrypt hash
    role        ENUM('super_admin','admin','cashier') NOT NULL DEFAULT 'cashier',
    is_active   TINYINT(1)    NOT NULL DEFAULT 1,
    created_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    -- Profile picture (Edit Profile) -- a resized JPEG data: URI, capped
    -- client-side to a 200x200 thumbnail before upload. TEXT is generous
    -- headroom for that (verified: models/User.js's updateProfile).
    avatar      TEXT NULL,

    -- Forgot Password OTP (verified: models/User.js's setResetOtp/
    -- incrementOtpAttempts/clearResetOtp). The OTP itself is never
    -- stored, only a bcrypt hash of it, same as a real password.
    reset_otp_hash        VARCHAR(255) NULL,
    reset_otp_expires_at  DATETIME     NULL,
    reset_otp_attempts    INT          NOT NULL DEFAULT 0
);

-- ============================================================
-- PRODUCTS TABLE
-- Core inventory model with expiry / batch tracking.
-- Unchanged since the Inventory restructure (Brand Name / Item No.) --
-- that was an APPLICATION-layer change only (grouping rows that share
-- the same `name` into one "brand" in the UI); this table is still one
-- row per physical batch, per PharmaTrack_Inventory_Restructure_
-- Handoff.md's own note: "No database schema change."
-- ============================================================
CREATE TABLE IF NOT EXISTS products (
    id               INT AUTO_INCREMENT PRIMARY KEY,
    batch_number     VARCHAR(50)   NOT NULL,
    name             VARCHAR(150)  NOT NULL,
    generic_name     VARCHAR(150),
    category         VARCHAR(255)  NOT NULL,   -- one category, or several joined with '|' (e.g. Analgesic|Antipyretic)
    supplier         VARCHAR(150),
    description      TEXT,
    -- NOT unique: every Item No. of a brand shares the brand's barcode (that is how
    -- scanning finds the brand). Two DIFFERENT brands sharing one is refused by
    -- the app (Product.assertBarcodeFree), not by the database.
    barcode          VARCHAR(80),
    price            DECIMAL(10,2) NOT NULL DEFAULT 0.00,   -- selling price
    cost             DECIMAL(10,2) NOT NULL DEFAULT 0.00,   -- purchase cost
    stock_quantity   INT           NOT NULL DEFAULT 0,
    low_stock_threshold INT        NOT NULL DEFAULT 10,
    -- Brand is exempt from VAT at the POS (applies to every Item No. row of
    -- the brand; written together by Product.updateGroupFields). Added by
    -- manual ALTER on the live database; default 0 = not exempt.
    is_tax_exempt    TINYINT(1)    NOT NULL DEFAULT 0,
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
-- NOTE ON ORDER: the two cash tables below are created BEFORE `orders`
-- on purpose -- `orders` has a foreign key to cash_sessions, and MySQL
-- refuses to create a table that references one which doesn't exist
-- yet ("Failed to open the referenced table"). They depend only on
-- `users`, so this is the earliest they can go after it.
-- ============================================================

-- ============================================================
-- CASH SESSIONS TABLE  (new -- not in the original schema at all)
-- One row per Open Register -> Close Register cycle for a cashier.
-- Cash-only (GCash/Card were never wired up for register tracking).
-- Reconstructed from models/CashSession.js's actual queries; exact FK/
-- index choices below are a best-practice reconstruction, not
-- independently verified against the live Aiven database's real DDL.
-- ============================================================
CREATE TABLE IF NOT EXISTS cash_sessions (
    id                     INT AUTO_INCREMENT PRIMARY KEY,
    cashier_id             INT           NOT NULL,
    opening_cash           DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    status                 ENUM('OPEN','CLOSED') NOT NULL DEFAULT 'OPEN',
    opened_at              DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- NULL when the requester is already admin/owner (self-authority)
    -- or for historical sessions predating this feature.
    opened_approved_by     INT NULL,
    closing_cash_expected  DECIMAL(10,2) NULL,
    closing_cash_actual    DECIMAL(10,2) NULL,
    variance               DECIMAL(10,2) NULL,
    closed_approved_by     INT NULL,
    closed_at              DATETIME NULL,
    FOREIGN KEY (cashier_id)         REFERENCES users(id) ON DELETE RESTRICT,
    FOREIGN KEY (opened_approved_by) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (closed_approved_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_cash_sessions_cashier (cashier_id),
    INDEX idx_cash_sessions_status  (status)
);

-- ============================================================
-- CASH MOVEMENTS TABLE  (new -- not in the original schema at all)
-- Cash In / Cash Out entries against an open cash session. Every
-- movement records who REQUESTED it and who APPROVED it -- for a
-- cashier these are two different people (manager approval required);
-- for admin/owner, the same person (self-authority).
-- Reconstructed from models/CashMovement.js's actual queries.
-- ============================================================
CREATE TABLE IF NOT EXISTS cash_movements (
    id               INT AUTO_INCREMENT PRIMARY KEY,
    cash_session_id  INT           NOT NULL,
    type             ENUM('CASH_IN','CASH_OUT') NOT NULL,
    amount           DECIMAL(10,2) NOT NULL,
    reason           VARCHAR(255)  NULL,
    requested_by     INT           NOT NULL,
    approved_by      INT           NOT NULL,
    created_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (cash_session_id) REFERENCES cash_sessions(id) ON DELETE RESTRICT,
    FOREIGN KEY (requested_by)    REFERENCES users(id)         ON DELETE RESTRICT,
    FOREIGN KEY (approved_by)     REFERENCES users(id)         ON DELETE RESTRICT,
    INDEX idx_cash_movements_session (cash_session_id)
);

-- ============================================================
-- ORDERS TABLE
-- Each completed POS transaction.
-- ============================================================
CREATE TABLE IF NOT EXISTS orders (
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

    -- Links a sale to the cash drawer session it was rung up under
    -- (verified: models/Order.js's create, models/CashSession.js's
    -- getLiveTotals). NULL for any order predating the Cash Register
    -- feature. Voiding an order does NOT use separate voided_by/
    -- voided_at columns -- it just flips status to 'voided' (see
    -- posController.js); who/when is instead recovered by joining
    -- audit_logs for that order's VOID_ORDER entry (see
    -- reportController.js's getVoidReport) rather than duplicating it
    -- here.
    cash_session_id INT NULL,

    -- VAT (12%, prices are VAT-inclusive -- see backend/utils/vat.js). `tax`
    -- above is the VAT amount; these two are the sales split it came from:
    -- vatable_sales is the VAT-exclusive net of VATable lines, and
    -- vat_exempt_sales is what was paid for VAT-exempt lines (tax-exempt
    -- brands and Senior/PWD-discounted lines). Orders from before VAT keep
    -- 0 for all three. Added by manual ALTER on the live database.
    vatable_sales    DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    vat_exempt_sales DECIMAL(10,2) NOT NULL DEFAULT 0.00,

    -- Offline-sync duplicate guard (one sync key per offline sale) and the
    -- link from a Partial Void replacement receipt back to the receipt it
    -- replaces. Both are NULL for ordinary orders. Not used by code yet.
    client_ref       VARCHAR(64) NULL,
    parent_order_id  INT NULL,

    FOREIGN KEY (cashier_id) REFERENCES users(id) ON DELETE RESTRICT,
    FOREIGN KEY (cash_session_id) REFERENCES cash_sessions(id) ON DELETE SET NULL,
    INDEX idx_orders_created_at (created_at),
    UNIQUE KEY uq_orders_client_ref (client_ref),
    INDEX idx_orders_parent (parent_order_id),
    FOREIGN KEY (parent_order_id) REFERENCES orders(id) ON DELETE SET NULL
);

-- ============================================================
-- ORDER ITEMS TABLE
-- Line items per order (tracks batch & price at time of sale).
-- Unchanged from the original schema.
-- ============================================================
CREATE TABLE IF NOT EXISTS order_items (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    order_id     INT           NOT NULL,
    product_id   INT           NOT NULL,
    batch_number VARCHAR(50)   NOT NULL,   -- snapshot at time of sale
    product_name VARCHAR(150)  NOT NULL,   -- snapshot
    quantity     INT           NOT NULL DEFAULT 1,
    unit_price   DECIMAL(10,2) NOT NULL,   -- price at time of sale
    unit_cost    DECIMAL(10,2) NOT NULL,   -- cost at time of sale
    subtotal     DECIMAL(10,2) NOT NULL,
    -- is_tax_exempt: snapshot of the brand's Tax Exempt flag at the time of
    -- sale. discount_amount: this row's share of the Senior/PWD reduction
    -- (VAT removal + 20%), 0 when not discounted. Added by manual ALTER.
    is_tax_exempt   TINYINT(1)    NOT NULL DEFAULT 0,
    discount_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    FOREIGN KEY (order_id)   REFERENCES orders(id)   ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
    INDEX idx_order   (order_id),
    INDEX idx_product (product_id)
);

-- ============================================================
-- APP SETTINGS TABLE  (new -- not in the original schema at all)
-- Generic key-value store for app-wide config (e.g. the scheduled
-- auto-backup time) -- deliberately generic so future settings don't
-- need their own migration each time.
-- Reconstructed from models/AppSetting.js's actual queries.
-- ============================================================
CREATE TABLE IF NOT EXISTS app_settings (
    setting_key    VARCHAR(100) NOT NULL PRIMARY KEY,
    setting_value  TEXT NULL
);

-- ============================================================
-- AUDIT LOGS TABLE
-- Super Admin oversight: every critical action is recorded. Also the
-- source of truth for "who voided this / when" (see orders.status
-- above) and for the readable role/action labels shown in Audit Logs
-- and various reports.
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_logs (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    user_id     INT          NOT NULL,
    action      VARCHAR(100) NOT NULL,   -- e.g. 'UPDATE_PRODUCT', 'VOID_ORDER'
    entity      VARCHAR(80),             -- e.g. 'products', 'orders'
    entity_id   INT,
    details     JSON,                    -- before/after snapshots
    ip_address  VARCHAR(45),
    created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- RESTRICT (not the original CASCADE) -- audit logs must stay
    -- immutable even if a user row is ever hard-deleted; this was
    -- already corrected in a previous pass (see DATABASE_FIXES.md fix #1).
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
    INDEX idx_user   (user_id),
    INDEX idx_action (action),
    INDEX idx_entity (entity, entity_id)
);

-- ============================================================
-- SEED DATA (only inserts if no users exist yet)
-- ============================================================

-- Each seed user has a UNIQUE bcrypt hash (12 rounds) generated locally.
-- Plaintext passwords are provided ONLY in database/SEED_CREDENTIALS.txt (gitignored) -- rotate on first login.
INSERT IGNORE INTO users (name, email, password, role) VALUES
('Maria Santos',   'superadmin@pharmatrack.ph', '$2b$12$Rz6VmwuLL0RVi0ti7mi41ulEOz0v4q9roMpUr022ngHxfUMkDMBd2', 'super_admin'),
('Juan Dela Cruz', 'admin@pharmatrack.ph',       '$2b$12$Z6btYTptF9AZ54ZUhmHPheKx6OXSf7k3q5yngRNSRE9ghr6ApoWVi', 'admin'),
('Ana Reyes',      'cashier@pharmatrack.ph',     '$2b$12$cIEVtczYoOae5Gtm.em4YOQ0y8QPyL1Tqh/EVn9Fuj.CsHFlVuVO6', 'cashier');

INSERT IGNORE INTO products (batch_number, name, generic_name, category, supplier, barcode, price, cost, stock_quantity, low_stock_threshold, expiry_date) VALUES
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

INSERT IGNORE INTO orders (order_number, cashier_id, subtotal, discount, tax, total, payment_method, amount_tendered, change_amount, status) VALUES
('ORD-001', 3, 850.00, 0.00, 0.00, 850.00, 'cash', 1000.00, 150.00, 'completed'),
('ORD-002', 3, 340.00, 0.00, 0.00, 340.00, 'gcash', 340.00, 0.00,  'completed'),
('ORD-003', 3, 120.50, 0.00, 0.00, 120.50, 'cash', 200.00, 79.50,  'completed'),
('ORD-004', 3, 660.00, 50.00, 0.00, 610.00, 'cash', 700.00, 90.00, 'completed'),
('ORD-005', 3, 450.00, 0.00, 0.00, 450.00, 'maya', 450.00, 0.00,   'completed');

INSERT IGNORE INTO order_items (order_id, product_id, batch_number, product_name, quantity, unit_price, unit_cost, subtotal) VALUES
(1, 1, 'BATCH-PARA-001', 'Paracetamol 500mg', 10, 8.50,  4.00, 85.00),
(1, 2, 'BATCH-BIO-001',  'Biogesic 500mg',    5,  12.00, 6.00, 60.00),
(2, 4, 'BATCH-AMO-001',  'Amoxicillin 500mg', 8,  18.50, 9.00, 148.00),
(3, 7, 'BATCH-CEF-001',  'Cetirizine 10mg',   6,  9.00,  4.50, 54.00),
(4, 3, 'BATCH-LOS-001',  'Losartan 50mg',     4,  22.00, 11.00, 88.00),
(5, 5, 'BATCH-MET-001',  'Metformin 500mg',   6,  15.00, 7.50, 90.00);
