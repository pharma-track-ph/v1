// ============================================================
// VAT / Senior-PWD math
//
// ONE place for the sale arithmetic, used by POS checkout (and reused
// later by per-item Senior/PWD and Partial Void), so every part of the
// app agrees to the centavo.
//
// Rules (agreed with the owner):
//   - Prices are VAT-INCLUSIVE, VAT rate 12%.
//   - A VATable line of price P holds net = P / 1.12 and VAT = P - net.
//   - Tax-exempt brands carry no VAT.
//   - Senior/PWD discount: for a VATable line, VAT is removed FIRST
//     (P / 1.12), then 20% comes off that, and the line becomes
//     VAT-exempt. The customer pays P / 1.12 * 0.8 = P * 5/7.
//     For an already tax-exempt brand there is no VAT to remove, so only
//     the 20% applies (customer pays P * 0.8).
//
// All arithmetic is in whole centavos (integers) so no floating-point
// drift can creep into totals. Each line is rounded once, and order
// totals are the SUM of the rounded lines, so VATable + VAT + exempt
// always adds back to the total exactly.
// ============================================================

const VAT_PERCENT = 12;

function toCents(value) {
    return Math.round(Number(value) * 100);
}

function centsToPesos(cents) {
    return Math.round(cents) / 100;
}

/**
 * @param {number}  grossCents  line price x quantity, in centavos (VAT-inclusive)
 * @param {object}  opts
 * @param {boolean} opts.taxExempt  the brand's Tax Exempt flag
 * @param {boolean} opts.seniorPwd  Senior/PWD discount applies to this line
 */
function computeLine(grossCents, { taxExempt = false, seniorPwd = false } = {}) {
    const gross = Math.round(grossCents);

    // VATable, no discount: split the price into net + VAT
    if (!taxExempt && !seniorPwd) {
        const net = Math.round(gross * 100 / 112);
        return {
            grossCents: gross, payCents: gross, discountCents: 0,
            vatCents: gross - net, vatableNetCents: net, exemptCents: 0,
            vatExemptionDiscountCents: 0, seniorDiscountCents: 0
        };
    }

    // VATable brand + Senior/PWD: remove VAT first, then 20% off
    if (!taxExempt && seniorPwd) {
        const pay            = Math.round(gross * 5 / 7);          // gross / 1.12 * 0.8
        const discount       = gross - pay;
        const vatRemoved     = gross - Math.round(gross * 100 / 112);
        return {
            grossCents: gross, payCents: pay, discountCents: discount,
            vatCents: 0, vatableNetCents: 0, exemptCents: pay,
            vatExemptionDiscountCents: vatRemoved,
            seniorDiscountCents: discount - vatRemoved
        };
    }

    // Tax-exempt brand, no discount
    if (taxExempt && !seniorPwd) {
        return {
            grossCents: gross, payCents: gross, discountCents: 0,
            vatCents: 0, vatableNetCents: 0, exemptCents: gross,
            vatExemptionDiscountCents: 0, seniorDiscountCents: 0
        };
    }

    // Tax-exempt brand + Senior/PWD: only the 20% applies
    const pay      = Math.round(gross * 4 / 5);
    const discount = gross - pay;
    return {
        grossCents: gross, payCents: pay, discountCents: discount,
        vatCents: 0, vatableNetCents: 0, exemptCents: pay,
        vatExemptionDiscountCents: 0, seniorDiscountCents: discount
    };
}

/**
 * Splits `totalCents` across rows in proportion to `weights`, using whole
 * centavos; the LAST row takes whatever is left so the pieces always sum
 * to exactly `totalCents`.
 */
function allocate(totalCents, weights) {
    if (!weights.length) return [];
    const weightSum = weights.reduce((a, b) => a + b, 0);
    if (weightSum <= 0 || totalCents === 0) return weights.map(() => 0);

    let remaining = totalCents;
    return weights.map((w, i) => {
        if (i === weights.length - 1) return remaining;
        const share = Math.round(totalCents * w / weightSum);
        remaining -= share;
        return share;
    });
}

/**
 * @param {Array<{ rowGrossCents: number[], taxExempt: boolean, seniorPwd: boolean }>} lines
 *   One entry per CART LINE (a product family). A line that was filled from
 *   several batches (FEFO) passes one gross figure per batch row; the line
 *   is rounded once as a whole, then its discount is spread back over its
 *   rows so each stored order_items row gets its own discount_amount.
 */
function computeOrder(lines) {
    const totals = {
        grossCents: 0, discountCents: 0, totalCents: 0,
        vatCents: 0, vatableSalesCents: 0, vatExemptSalesCents: 0,
        vatExemptionDiscountCents: 0, seniorDiscountCents: 0
    };

    const lineResults = lines.map(line => {
        const lineGross = line.rowGrossCents.reduce((a, b) => a + b, 0);
        const r = computeLine(lineGross, line);

        totals.grossCents                 += r.grossCents;
        totals.discountCents              += r.discountCents;
        totals.vatCents                   += r.vatCents;
        totals.vatableSalesCents          += r.vatableNetCents;
        totals.vatExemptSalesCents        += r.exemptCents;
        totals.vatExemptionDiscountCents  += r.vatExemptionDiscountCents;
        totals.seniorDiscountCents        += r.seniorDiscountCents;

        return { ...r, rowDiscountCents: allocate(r.discountCents, line.rowGrossCents) };
    });

    totals.totalCents = totals.grossCents - totals.discountCents;
    return { totals, lines: lineResults };
}

module.exports = { VAT_PERCENT, toCents, centsToPesos, computeLine, computeOrder, allocate };
