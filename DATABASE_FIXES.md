# PharmaTrack Database & Code Fixes Guide

> Use this document as a prompt for another AI agent to implement fixes step-by-step, from critical to low priority.

---

## 📋 Overview of the Project

**PharmaTrack** is a pharmacy inventory and POS system with:
- **Backend**: Node.js + Express + MySQL (hosted on Aiven Cloud)
- **Database**: MySQL 8.0 with tables: `users`, `products`, `orders`, `order_items`, `audit_logs`
- **Database Host**: `pharma-track-jasonmontes2004-d52d.e.aivencloud.com:26087`
- **Database Name**: `defaultdb`
- **Env**: Production mode with `SKIP_SCHEMA_INIT=true`

---

## 🔧 FIX #1 — CRITICAL: `audit_logs.user_id` CASCADE Risk

### Problem
In `database/schema.sql`, the `audit_logs` table has:
```sql
FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
```
If any user record is **hard-deleted** (physically removed from the `users` table), ALL audit log entries for that user will be automatically deleted by MySQL. Audit logs should be **immutable** — they are critical for compliance, thesis defense, and regulatory requirements.

### Fix
Change `ON DELETE CASCADE` to `ON DELETE RESTRICT` so MySQL prevents deletion of a user who still has audit log entries.

### File to Edit
`c:/Pharma_Track_Final_Defense/v1-main/database/schema.sql`

### Step-by-Step Instructions
1. Open `database/schema.sql`
2. Find the `audit_logs` CREATE TABLE statement
3. Locate: `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`
4. Change to: `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT`
5. Save the file

> **Note**: Since `SKIP_SCHEMA_INIT=true` in production, this change won't auto-apply. You need to run the ALTER TABLE manually via a MySQL client (HeidiSQL, MySQL Workbench, etc.) or execute:
> ```sql
> ALTER TABLE audit_logs DROP FOREIGN KEY audit_logs_ibfk_1;
> ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_ibfk_1 FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;
> ```

---

## 🔧 FIX #2 — CRITICAL: Weak Password for `avnadmin` (Aiven DB User)

### Problem
The `.env` file contains:
```
DB_PASSWORD=<redacted — see your local .env file, never commit real credentials>
```
While this is an Aiven-generated password (strong), the seed data password `password123` is shared across all 3 seed users:
- superadmin@pharmatrack.ph
- admin@pharmatrack.ph
- cashier@pharmatrack.ph

### Fix
Change the seed user passwords to different, unique passwords for each role.

### File to Edit
`c:/Pharma_Track_Final_Defense/v1-main/database/schema.sql`

### Step-by-Step Instructions
1. Open `database/schema.sql`
2. Find the `INSERT IGNORE INTO users` section
3. Generate unique bcrypt hashes for 3 different passwords (e.g., using `https://bcrypt-generator.com/` with 12 rounds)
4. Replace the shared hash with 3 different hashes
5. Save the file

---

## 🔧 FIX #3 — HIGH: Restock Suggestions Skip Low-Stock Products With No Sales

### Problem
In `backend/controllers/forecastingController.js`, the `getRestockSuggestions` function has this logic flaw:

```javascript
if (!reason) continue; // product is fine, skip
```

The `reason` variable is only set when:
- `stock <= 0` (out of stock)
- `stock <= threshold` (below reorder level)
- `dailyAvg > 0 && daysLeft <= 14` (will run out soon)
- `daysExpiry <= 30 && stock > threshold` (expiring soon)

But there's a BUG: The check `stock <= threshold` comes AFTER the `dailyAvg > 0` check in the loop. If a product has `stock = 2` but `dailyAvg = 0` (no sales in 30 days), the `stock <= threshold` check IS performed and should catch it. Let me re-verify...

Actually, looking more carefully at the code flow, the issue is that the `dailyAvg` check can OVERRIDE a valid low-stock alert. The `urgency` variable is set for each condition sequentially, so the last matching condition wins. Since `dailyAvg > 0 && daysLeft <= 14` sets `urgency = 60`, it could overwrite a more urgent `urgency = 80` from `stock <= threshold`.

### Fix
Restructure the conditions so that stock-based urgency always takes priority over sales-based projections.

### File to Edit
`c:/Pharma_Track_Final_Defense/v1-main/backend/controllers/forecastingController.js`

### Step-by-Step Instructions
1. Open `backend/controllers/forecastingController.js`
2. Find the `getRestockSuggestions` function (around line 100-180)
3. Locate the for loop where `reason` and `urgency` are assigned
4. Replace the condition-checking block with this improved version:

```javascript
// Determine if this product needs attention
let reason = null;
let urgency = 0; // higher = more urgent, used for sorting

// Priority 1: Stock level issues (most critical)
if (stock <= 0) {
    reason  = 'Out of stock';
    urgency = 100;
} else if (stock <= threshold) {
    reason  = `Below reorder level (${threshold} units)`;
    urgency = 80;
}
// Priority 2: Sales-based projections (only if no stock issue)
else if (dailyAvg > 0 && daysLeft <= 14) {
    reason  = `Will run out in ~${daysLeft} day${daysLeft !== 1 ? 's' : ''} at current rate`;
    urgency = 60;
}
// Priority 3: Expiry concerns (lowest priority)
else if (daysExpiry <= 30 && stock > threshold) {
    reason  = `Expires in ${daysExpiry} day${daysExpiry !== 1 ? 's' : ''} — sell or reorder fresher batch`;
    urgency = 40;
}
```

5. Save the file

---

## 🔧 FIX #4 — MEDIUM: Add Index on `orders.created_at`

### Problem
Multiple queries filter or sort by `orders.created_at`:
- `Order.getTodaySales()` — `WHERE DATE(created_at) = CURDATE()`
- `Order.getMonthlySales()` — `WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)`
- `Order.findAll()` — `ORDER BY o.created_at DESC`
- `getSalesReport()` — `ORDER BY o.created_at DESC`
- `getTrendingProducts()` — filter by date ranges

Without an index, these queries do full table scans. As order count grows (1000+), performance will degrade significantly.

### Fix
Add a B-tree index on `orders.created_at`.

### File to Edit
`c:/Pharma_Track_Final_Defense/v1-main/database/schema.sql`

### Step-by-Step Instructions
1. Open `database/schema.sql`
2. Find the `orders` CREATE TABLE statement (after the closing parenthesis and before the semicolon)
3. Add an index line inside the CREATE TABLE:
```sql
INDEX idx_orders_created_at (created_at)
```
4. The full orders table should look like:
```sql
CREATE TABLE IF NOT EXISTS orders (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    order_number    VARCHAR(30)   NOT NULL UNIQUE,
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
    FOREIGN KEY (cashier_id) REFERENCES users(id) ON DELETE RESTRICT,
    INDEX idx_orders_created_at (created_at)  -- ← ADD THIS LINE
);
```
5. Also run this SQL manually via MySQL client:
```sql
CREATE INDEX idx_orders_created_at ON orders(created_at);
```

---

## 🔧 FIX #5 — MEDIUM: Cashier Cannot Access Forecasting

### Problem
In `backend/routes/forecastingRoutes.js`, all routes use:
```javascript
requireRole('admin')
```
This means only `admin` and `super_admin` roles can access forecasting features. Cashiers may need to view forecasts for daily operations.

### Fix
Change to use role hierarchy or allow both cashier and admin.

### File to Edit
`c:/Pharma_Track_Final_Defense/v1-main/backend/routes/forecastingRoutes.js`

### Step-by-Step Instructions
1. Open `backend/routes/forecastingRoutes.js`
2. Find all lines with `requireRole('admin')`
3. Change each one to `requireRole('cashier', 'admin')`
4. The final file should look like:
```javascript
router.get('/products',              verifyToken, requireRole('cashier', 'admin'), getProductList);
router.get('/data/:productId',       verifyToken, requireRole('cashier', 'admin'), getForecastData);
router.get('/trending',              verifyToken, requireRole('cashier', 'admin'), getTrendingProducts);
router.get('/restock-suggestions',   verifyToken, requireRole('cashier', 'admin'), getRestockSuggestions);
router.get('/compare/:productId',    verifyToken, requireRole('cashier', 'admin'), compareForecasts);
```
5. Save the file

---

## 🔧 FIX #6 — LOW: `MIN()` Aggregate Not in GROUP BY

### Problem
In `backend/models/Order.js`, the `getWeeklySalesByProduct` function has:
```sql
SELECT
    YEARWEEK(o.created_at, 1) AS year_week,
    MIN(DATE(o.created_at)) AS week_start,
    ...
GROUP BY YEARWEEK(o.created_at, 1)
```

With `ONLY_FULL_GROUP_BY` SQL mode enabled (as configured in `db.js`), this query relies on MySQL's functional dependency detection — `MIN(DATE(o.created_at))` is functionally dependent on `YEARWEEK(o.created_at, 1)` because it's the same underlying column. However, this is MySQL-specific behavior and may break with version upgrades or different databases.

### Fix
Explicitly list `week_start` in the GROUP BY clause.

### File to Edit
`c:/Pharma_Track_Final_Defense/v1-main/backend/models/Order.js`

### Step-by-Step Instructions
1. Open `backend/models/Order.js`
2. Find the `getWeeklySalesByProduct` method (around line 105-125)
3. Locate the SQL query string
4. Change:
```sql
GROUP BY YEARWEEK(o.created_at, 1)
```
To:
```sql
GROUP BY YEARWEEK(o.created_at, 1), week_start
```
5. Save the file

---

## 🔧 FIX #7 — LOW: Inline `require` in Controller

### Problem
In `backend/controllers/reportController.js`, the `getDashboardKPIs` function has:
```javascript
const Product = require('../models/Product');
```
inside the function body instead of at the top of the file.

### Fix
Move the `require` statement to the top of the file.

### File to Edit
`c:/Pharma_Track_Final_Defense/v1-main/backend/controllers/reportController.js`

### Step-by-Step Instructions
1. Open `backend/controllers/reportController.js`
2. At the top of the file (after the existing requires), add:
```javascript
const Product = require('../models/Product');
```
3. Inside the `getDashboardKPIs` function, remove this line:
```javascript
const Product = require('../models/Product');
```
4. Save the file

---

## 📋 EXECUTION ORDER SUMMARY

| Step | Priority | Fix Description | File(s) |
|------|----------|-----------------|---------|
| 1 | 🔴 Critical | Change `audit_logs` FK to `ON DELETE RESTRICT` | `database/schema.sql` + manual SQL |
| 2 | 🔴 Critical | Differentiate seed user passwords | `database/schema.sql` |
| 3 | 🟠 High | Fix restock suggestion logic for low-stock products | `backend/controllers/forecastingController.js` |
| 4 | 🟡 Medium | Add index on `orders.created_at` | `database/schema.sql` + manual SQL |
| 5 | 🟡 Medium | Allow cashier access to forecasting | `backend/routes/forecastingRoutes.js` |
| 6 | 🔵 Low | Add `week_start` to GROUP BY clause | `backend/models/Order.js` |
| 7 | 🔵 Low | Move inline `require` to top of file | `backend/controllers/reportController.js` |

---

## 🧪 HOW TO VERIFY FIXES

After all fixes are applied:

1. **Restart the server**:
```bash
cd c:/Pharma_Track_Final_Defense/v1-main/backend
node server.js
```

2. **Check the logs** — confirm database connection succeeds without errors

3. **For the SQL changes** (Fix 1, 2, 4), connect to your Aiven database and run:
```sql
-- Verify audit_logs FK constraint
SELECT CONSTRAINT_NAME, DELETE_RULE 
FROM information_schema.REFERENTIAL_CONSTRAINTS 
WHERE TABLE_NAME = 'audit_logs';

-- Verify orders index exists
SHOW INDEX FROM orders WHERE Key_name = 'idx_orders_created_at';

-- Test the FK constraint (this should FAIL with RESTRICT)
DELETE FROM users WHERE id = 1;
-- Expected error: Cannot delete or update a parent row: a foreign key constraint fails
```

4. **For code changes** (Fix 3, 5, 6, 7):
- Log in as a `cashier` user — verify you can access the forecasting page
- Check the restock suggestions for a product with low stock but no sales
- Verify the API returns successfully

