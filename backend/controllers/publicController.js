// ============================================================
// Public Controller
// Endpoints reachable WITHOUT a logged-in PharmaTrack user's JWT --
// currently just the JotForm AI agent's inventory search below. Gated by
// a shared secret (JOTFORM_API_KEY in .env) instead of a login, since the
// caller here is JotForm's own server calling in from the internet, not
// a PharmaTrack user with a session.
// ============================================================
const Product = require('../models/Product');

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
 * GET /api/public/inventory-search?q=<term>&key=<JOTFORM_API_KEY>
 *
 * Read-only, no login required -- built specifically for the JotForm AI
 * agent's "Send API Request" tool. Searches Brand Name / Generic Name /
 * Category / Description for the term (see Product.findAllGroupedBroadSearch
 * -- deliberately a wider net than the Inventory page's own search, since
 * JotForm's "q" is usually a translated medical term like "pain relief",
 * far more likely to match a CATEGORY than a specific product name) and
 * returns only REAL, currently active products with their actual
 * rolled-up stock status (same logic the Inventory page itself uses --
 * see Product._rollUpGroup) -- the agent is instructed, via its own
 * Agent Prompt in JotForm, to answer using ONLY what this returns and
 * never invent a product that isn't listed here.
 *
 * Response is deliberately shaped for an AI agent to read directly --
 * plain labels, no internal ids/thresholds/costs it has no business
 * knowing about, and capped at 8 results so a broad query doesn't dump
 * the whole catalog into the agent's context.
 */
const searchInventoryForAgent = async (req, res) => {
    const providedKey = req.query.key || req.headers['x-api-key'];
    if (!process.env.JOTFORM_API_KEY || providedKey !== process.env.JOTFORM_API_KEY) {
        return res.status(401).json({ success: false, message: 'Invalid or missing API key.' });
    }

    const q = (req.query.q || '').trim();
    if (!q) {
        return res.status(400).json({ success: false, message: 'Query parameter "q" is required.' });
    }

    try {
        const results = await Product.findAllGroupedBroadSearch(q);

        const products = results.slice(0, 8).map(p => ({
            brand_name:   p.name,
            generic_name: p.generic_name || null,
            category:     p.category,
            price:        `\u20b1${Number(p.price).toFixed(2)}`,
            status:       statusLabel(p.stock_status),
            in_stock:     p.stock_status === 'in_stock' || p.stock_status === 'low_stock'
        }));

        res.json({
            success: true,
            query:   q,
            count:   products.length,
            products,
            note: products.length
                ? undefined
                : 'No matching products found in inventory. Do not suggest or invent a product name -- tell the user this pharmacy does not currently carry anything matching their query, and recommend they ask a pharmacist in person.'
        });
    } catch (err) {
        console.error('[searchInventoryForAgent]', err);
        res.status(500).json({ success: false, message: 'Search failed.' });
    }
};

module.exports = { searchInventoryForAgent };
