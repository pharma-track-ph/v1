// VAT / Senior-PWD math - ONE place for the sale arithmetic, used by POS checkout

const VAT_PERCENT = 12;

function toCents(value) {
    return Math.round(Number(value) * 100);
}

function centsToPesos(cents) {
    return Math.round(cents) / 100;
}

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

/** Splits `totalCents` across rows in proportion to `weights`, using whole centavos */
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

/** One entry per CART LINE (a product family). */
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
