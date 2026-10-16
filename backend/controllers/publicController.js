// ============================================================
// Public Controller
// Endpoints reachable WITHOUT a logged-in PharmaTrack user's JWT --
// currently just the JotForm AI agent's inventory search below. Gated by
// a shared secret (JOTFORM_API_KEY in .env) instead of a login.
// ============================================================
const Product = require('../models/Product');

const PAGE_SIZE = 25;

// Products the public chatbot must never see. Matched as lowercase
// substrings. Prescription-only medicines and non-health items are hidden
// completely, so the agent treats them as "not carried" and refers the
// customer to a pharmacist in person. Add to these lists whenever you stock
// a new prescription item or non-medicine product.
const HIDDEN_CATEGORIES = [
    'antihypertensive', 'antibiotic', 'antidiabetic', 'antiplatelet',
    'fragrance', 'cologne', 'cosmetic'
];
const HIDDEN_GENERICS = [
    'amoxicillin', 'losartan', 'amlodipine', 'metformin', 'aspirin',
    'domperidone'
];

function isHiddenFromChatbot(p) {
    const cat = String(p.category     || '').toLowerCase();
    const gen = String(p.generic_name || '').toLowerCase();
    const nam = String(p.name         || '').toLowerCase();
    return HIDDEN_CATEGORIES.some(c => cat.includes(c))
        || HIDDEN_GENERICS.some(g => gen.includes(g) || nam.includes(g));
}

function statusLabel(status) {
    const labels = {
        in_stock:     'In Stock',
        low_stock:    'Low Stock (limited quantity left)',
        expired:      'Expired -- not sellable',
        out_of_stock: 'Out of Stock'
    };
    return labels[status] || status;
}

/**
 * GET /api/public/inventory-search?q=<term>&page=<n>&key=<JOTFORM_API_KEY>
 *
 * q is OPTIONAL: with no q, lists every available product (paged).
 * Only products that can be sold right now are returned (out-of-stock and
 * fully-expired brands are left out), and prescription / non-health items
 * are hidden (see HIDDEN_* above). Quantities, costs, suppliers and batch
 * data are never returned.
 */
const searchInventoryForAgent = async (req, res) => {
    const providedKey = req.query.key || req.headers['x-api-key'];
    if (!process.env.JOTFORM_API_KEY || providedKey !== process.env.JOTFORM_API_KEY) {
        return res.status(401).json({ success: false, message: 'Invalid or missing API key.' });
    }

    const q    = (req.query.q || '').trim();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);

    try {
        let results = await Product.findAllGroupedBroadSearch(q);

        results = results.filter(p => p.stock_status !== 'out_of_stock' && !isHiddenFromChatbot(p));
        results.sort((a, b) => a.name.localeCompare(b.name));

        const total      = results.length;
        const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
        const slice      = results.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

        const products = slice.map(p => ({
            brand_name:   p.name,
            generic_name: p.generic_name || null,
            category:     p.category,
            price:        `\u20b1${Number(p.price).toFixed(2)}`,
            status:       statusLabel(p.stock_status),
            in_stock:     p.stock_status === 'in_stock' || p.stock_status === 'low_stock'
        }));

        res.json({
            success: true,
            query: q || '(all available products)',
            total_available: total,
            page,
            total_pages: totalPages,
            has_more: page < totalPages,
            products,
            note: products.length
                ? 'These are the ONLY products the pharmacy has. For each one, find its entry in the Knowledge Base by matching generic_name. Take uses, usage and warnings only from that entry. If no entry exists, say you have no information on it and refer the customer to a pharmacist. Never use outside knowledge.'
                : 'No matching available products. Do not suggest or invent any product. Tell the customer the pharmacy does not currently have anything matching and suggest asking a pharmacist in person.'
        });
    } catch (err) {
        console.error('[searchInventoryForAgent]', err);
        res.status(500).json({ success: false, message: 'Search failed.' });
    }
};

module.exports = { searchInventoryForAgent };