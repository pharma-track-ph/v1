// Cash Session Controller - Opening Cash / Cash In / Cash Out / Close Register...
const db           = require('../config/db');
const CashSession  = require('../models/CashSession');
const CashMovement = require('../models/CashMovement');
const User         = require('../models/User');
const { logAudit } = require('../middleware/authMiddleware');

const ELEVATED_ROLES = ['admin', 'super_admin'];

/** Verifies manager/owner credentials supplied in the request body. */
async function verifyManagerApproval(body) {
    const { manager_email, manager_password } = body;
    if (!manager_email || !manager_password) return null;

    const manager = await User.findByEmail(manager_email);
    if (!manager || !ELEVATED_ROLES.includes(manager.role)) return null;

    const matches = await User.comparePassword(manager_password, manager.password);
    return matches ? manager : null;
}

/** GET /api/pos/cash-session/current - Returns the requesting cashier's OPEN... */
const getCurrentSession = async (req, res, next) => {
    try {
        const session = await CashSession.findOpenByCashier(req.user.id);
        if (!session) {
            return res.json({ success: true, data: null });
        }

        const totals = await CashSession.getLiveTotals(session.id);
        const expected_cash = parseFloat(session.opening_cash) + totals.cash_sales + totals.cash_in - totals.cash_out;

        res.json({
            success: true,
            data: { ...session, ...totals, expected_cash: Math.round(expected_cash * 100) / 100 }
        });
    } catch (err) { next(err); }
};

/** POST /api/pos/cash-session/open - Body: { opening_cash, manager_email? */
const openSession = async (req, res, next) => {
    const { opening_cash } = req.body;
    const openingCash = parseFloat(opening_cash);

    if (isNaN(openingCash) || openingCash < 0) {
        return res.status(400).json({ success: false, message: 'Opening cash must be a valid, non-negative amount.' });
    }

    const isCashier = req.user.role === 'cashier';
    let approver = null; // stays null for self-authority (admin/owner)...

    if (isCashier) {
        approver = await verifyManagerApproval(req.body);
        if (!approver) {
            // 403, NOT 401: the browser treats any 401 as "your login expired"...
            return res.status(403).json({ success: false, message: 'Invalid admin/owner credentials.' });
        }
    }

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        // Row-locked check-then-insert prevents a double-click
        const existing = await CashSession.lockOpenByCashier(req.user.id, connection);
        if (existing) {
            await connection.rollback();
            return res.status(409).json({
                success: false,
                message: `You already have an open register from ${new Date(existing.opened_at).toLocaleString('en-PH', { timeZone: 'Asia/Manila' })}. Please close it before opening a new one.`
            });
        }

        const sessionId = await CashSession.create(req.user.id, openingCash, approver?.id ?? null, connection);
        await connection.commit();

        // Attributed to the cashier (req.user.id), not the approver - see file header.
        await logAudit(req.user.id, 'OPEN_CASH_SESSION', 'cash_sessions', sessionId,
            {
                opening_cash: openingCash,
                ...(approver ? { approved_by: approver.name, approved_by_id: approver.id } : {})
            }, req.ip);

        res.status(201).json({ success: true, message: 'Register opened.', data: { id: sessionId } });

    } catch (err) {
        await connection.rollback();
        next(err);
    } finally {
        connection.release();
    }
};

/** POST /api/pos/cash-session/cash-in - POST /api/pos/cash-session/cash-out Body */
function makeMovementHandler(type) {
    return async (req, res, next) => {
        const { amount, reason } = req.body;
        const parsedAmount = parseFloat(amount);
        const trimmedReason = (reason || '').trim();

        if (isNaN(parsedAmount) || parsedAmount <= 0) {
            return res.status(400).json({ success: false, message: 'Amount must be a positive number.' });
        }
        if (!trimmedReason) {
            return res.status(400).json({ success: false, message: 'A reason is required.' });
        }

        const isCashier = req.user.role === 'cashier';
        let approverId   = req.user.id;
        let approverName = null; // only set for cashier-requested (manager-approved) movements

        if (isCashier) {
            const manager = await verifyManagerApproval(req.body);
            if (!manager) {
                // 403, not 401 (a 401 would sign the cashier out) - see openSession
                return res.status(403).json({ success: false, message: 'Invalid admin/owner credentials.' });
            }
            approverId   = manager.id;
            approverName = manager.name;
        }

        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();

            // Lock the session row FIRST
            const session = await CashSession.lockOpenByCashier(req.user.id, connection);
            if (!session) {
                await connection.rollback();
                return res.status(404).json({ success: false, message: 'You do not have an open register.' });
            }

            // Cash Out can never remove more than what's actually expected to be...
            if (type === 'CASH_OUT') {
                const totals = await CashSession.getLiveTotals(session.id, connection);
                const availableNow = parseFloat(session.opening_cash) + totals.cash_sales + totals.cash_in - totals.cash_out;
                if (parsedAmount > availableNow) {
                    await connection.rollback();
                    return res.status(400).json({
                        success: false,
                        message: `Cannot remove ₱${parsedAmount.toFixed(2)} — only ₱${availableNow.toFixed(2)} is expected in the drawer.`
                    });
                }
            }

            const movementId = await CashMovement.create({
                cashSessionId: session.id,
                type,
                amount: parsedAmount,
                reason: trimmedReason,
                requestedBy: req.user.id,
                approvedBy: approverId
            }, connection);

            await connection.commit();

            // Attributed to the cashier who requested it (req.user.id)
            await logAudit(req.user.id, type, 'cash_movements', movementId,
                {
                    amount: parsedAmount,
                    reason: trimmedReason,
                    ...(approverName ? { approved_by: approverName, approved_by_id: approverId } : {})
                }, req.ip);

            res.status(201).json({ success: true, message: `${type === 'CASH_IN' ? 'Cash in' : 'Cash out'} recorded.` });

        } catch (err) {
            await connection.rollback();
            next(err);
        } finally {
            connection.release();
        }
    };
}

const cashIn  = makeMovementHandler('CASH_IN');
const cashOut = makeMovementHandler('CASH_OUT');

/** POST /api/pos/cash-session/close - Body: { actual_cash, manager_email? */
const closeSession = async (req, res, next) => {
    const { actual_cash } = req.body;
    const actualCash = parseFloat(actual_cash);

    if (isNaN(actualCash) || actualCash < 0) {
        return res.status(400).json({ success: false, message: 'Actual cash counted must be a valid, non-negative amount.' });
    }

    const isCashier = req.user.role === 'cashier';
    let approverId   = req.user.id;
    let approverName = null;

    if (isCashier) {
        const manager = await verifyManagerApproval(req.body);
        if (!manager) {
            // 403, not 401 (a 401 would sign the cashier out) - see openSession
            return res.status(403).json({ success: false, message: 'Invalid admin/owner credentials.' });
        }
        approverId   = manager.id;
        approverName = manager.name;
    }

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        // Lock FIRST, then compute totals, all inside this one transaction
        const session = await CashSession.lockOpenByCashier(req.user.id, connection);
        if (!session) {
            await connection.rollback();
            return res.status(404).json({ success: false, message: 'You do not have an open register.' });
        }

        const totals = await CashSession.getLiveTotals(session.id, connection);
        const expected = parseFloat(session.opening_cash) + totals.cash_sales + totals.cash_in - totals.cash_out;
        const expectedRounded = Math.round(expected * 100) / 100;
        const variance = Math.round((actualCash - expectedRounded) * 100) / 100;

        const affected = await CashSession.close(session.id, {
            closingCashExpected: expectedRounded,
            closingCashActual:   actualCash,
            variance,
            approvedBy:          approverId
        }, connection);

        if (!affected) {
            // Should be unreachable given the lock above
            await connection.rollback();
            return res.status(409).json({ success: false, message: 'This register was already closed.' });
        }

        await connection.commit();

        // Attributed to the cashier whose shift this is (req.user.id)
        await logAudit(req.user.id, 'CLOSE_CASH_SESSION', 'cash_sessions', session.id,
            {
                expected: expectedRounded,
                actual: actualCash,
                variance,
                ...(approverName ? { approved_by: approverName, approved_by_id: approverId } : {})
            }, req.ip);

        res.json({
            success: true,
            message: `Register closed. Variance: ${variance >= 0 ? '+' : ''}₱${variance.toFixed(2)}.`,
            data: { expected: expectedRounded, actual: actualCash, variance }
        });

    } catch (err) {
        await connection.rollback();
        next(err);
    } finally {
        connection.release();
    }
};

module.exports = { getCurrentSession, openSession, cashIn, cashOut, closeSession };
