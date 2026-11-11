// PharmaTrack - receipt.js - ONE receipt template, shared by
const Receipt = {
    // The receipt currently shown in the POS window
    current: null,

    esc(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    },

    /** Splits an order's stored discount into its two parts for display */
    splitDiscount(items, totalDiscount) {
        const groups = new Map();
        (items || []).forEach(i => {
            const key = i.product_name + '|' + (i.is_tax_exempt ? 1 : 0);
            const g = groups.get(key) || { grossC: 0, discC: 0, exempt: !!i.is_tax_exempt };
            g.grossC += Math.round(Number(i.subtotal) * 100);
            g.discC  += Math.round(Number(i.discount_amount) * 100);
            groups.set(key, g);
        });

        let vatExC = 0;
        groups.forEach(g => {
            if (g.discC > 0 && !g.exempt) {
                vatExC += g.grossC - Math.round(g.grossC * 100 / 112);
            }
        });

        const totalC = Math.round(Number(totalDiscount) * 100);
        vatExC = Math.min(vatExC, totalC);
        return { vatExemption: vatExC / 100, senior: (totalC - vatExC) / 100 };
    },

    /** Builds receipt data from a stored order (Sales Report row with its items). */
    fromOrder(order) {
        const num   = v => Number(v) || 0;
        const items = (order.items || []).map(i => ({
            product_name:    i.product_name,
            quantity:        num(i.quantity),
            unit_price:      num(i.unit_price),
            subtotal:        num(i.subtotal),
            is_tax_exempt:   num(i.is_tax_exempt),
            discount_amount: num(i.discount_amount)
        }));

        const discount = num(order.discount);
        const hasVat   = num(order.vatable_sales) > 0 || num(order.vat_exempt_sales) > 0 || num(order.tax) > 0;

        let vatEx = null, senior = null;
        if (hasVat) {
            const split = this.splitDiscount(items, discount);
            vatEx  = split.vatExemption;
            senior = split.senior;
        }

        return {
            order_number:           order.order_number,
            created_at:             order.created_at,
            cashier_name:           order.cashier_name,
            items,
            subtotal:               num(order.subtotal),
            discount,
            vat_exemption_discount: vatEx,
            senior_pwd_discount:    senior,
            tax:                    num(order.tax),
            vatable_sales:          hasVat ? num(order.vatable_sales)    : null,
            vat_exempt_sales:       hasVat ? num(order.vat_exempt_sales) : null,
            total:                  num(order.total),
            amount_tendered:        num(order.amount_tendered),
            change:                 num(order.change_amount),
            payment_method:         order.payment_method || 'cash',
            replaces_order_number:  order.parent_order_number || null
        };
    },

    /** The receipt markup. */
    build(r) {
        const esc   = v => this.esc(v);
        const money = v => Fmt.currency(v);
        const row   = (label, value, cls = '') =>
            `<div class="rc-row ${cls}"><span>${label}</span><span>${value}</span></div>`;

        const items = (r.items || []).map(i => `
            <div class="rc-item">
                <div class="rc-item-name">${esc(i.product_name)}</div>
                <div class="rc-row"><span>${i.quantity} x ${money(i.unit_price)}</span><span>${money(i.subtotal)}</span></div>
                ${Number(i.discount_amount) > 0 ? '<div class="rc-tag">Senior/PWD 20%</div>' : ''}
            </div>`).join('');

        const hasSplit = r.vat_exemption_discount != null;
        const discountLines = hasSplit
            ? (r.vat_exemption_discount > 0 ? row('Less: VAT exemption', '- ' + money(r.vat_exemption_discount)) : '')
              + (r.senior_pwd_discount > 0 ? row('Less: 20% Senior/PWD', '- ' + money(r.senior_pwd_discount)) : '')
            : (r.discount > 0 ? row('Discount', '- ' + money(r.discount)) : '');

        const vatBlock = r.vatable_sales != null ? `
            <div class="rc-sep"></div>
            ${row('VATable Sales', money(r.vatable_sales))}
            ${row('VAT-Exempt Sales', money(r.vat_exempt_sales))}
            ${row('VAT (12%)', money(r.tax))}` : '';

        return `
        <div class="receipt">
            <div class="rc-center">
                <img class="rc-logo" src="../images/pharmatrack-logo.png" alt="">
                <div class="rc-brand">PharmaTrack</div>
                <div>Official Receipt</div>
                <div>${esc(Fmt.datetime(r.created_at))}</div>
            </div>
            <div class="rc-sep"></div>
            <div><strong>OR #:</strong> ${esc(r.order_number)}</div>
            ${r.replaces_order_number ? `<div><strong>Replaces:</strong> ${esc(r.replaces_order_number)}</div>` : ''}
            <div><strong>Processed By:</strong> ${esc(r.cashier_name)}</div>
            <div class="rc-sep"></div>
            ${items}
            <div class="rc-sep"></div>
            ${row('Subtotal', money(r.subtotal))}
            ${discountLines}
            ${vatBlock}
            <div class="rc-sep"></div>
            ${row('TOTAL', money(r.total), 'rc-total')}
            ${row('Tendered', money(r.amount_tendered))}
            ${row('Change', money(r.change), 'rc-bold')}
            <div class="rc-sep"></div>
            <div>Payment: ${esc(String(r.payment_method || 'cash').toUpperCase())}</div>
            <div class="rc-center rc-thanks">
                Thank you for your purchase!<br>
                Please consult your pharmacist for medication advice.
            </div>
        </div>`;
    },

    /** Prints ONLY the receipt. */
    print(data) {
        let area = document.getElementById('receipt-print-area');
        if (!area) {
            area = document.createElement('div');
            area.id = 'receipt-print-area';
            document.body.appendChild(area);
        }
        area.innerHTML = this.build(data);

        const imagesReady = Promise.all(Array.from(area.querySelectorAll('img')).map(img =>
            img.complete ? Promise.resolve() : new Promise(resolve => { img.onload = img.onerror = resolve; })
        ));

        const cleanup = () => {
            document.body.classList.remove('printing-receipt');
            area.innerHTML = '';
            window.removeEventListener('afterprint', cleanup);
        };

        document.body.classList.add('printing-receipt');
        window.addEventListener('afterprint', cleanup);

        imagesReady.then(() => setTimeout(() => window.print(), 50));
    },

    /** Print button inside the POS receipt window */
    printCurrent() {
        if (this.current) this.print(this.current);
    }
};

window.Receipt = Receipt;
