// ============================================================
// Export Controller
// Inventory report exports: Excel (.xlsx), PDF, and Word (.docx).
// Formatted as a real report: business name, logo, date generated, and a
// signature area at the bottom (with "Prepared by" auto-filled with the
// name of whoever generated it) -- not just a raw data dump.
//
// A note on the logo emoji across formats: Excel and Word don't actually
// "bake in" font glyphs when this code runs -- they just store the
// Unicode character, and the emoji renders using whatever font the
// VIEWING app (Excel/Word) has installed, which handles emoji fine. PDF
// is different: PDFKit renders text into the file using its OWN bundled
// fonts at generation time (right here, on the server), and its standard
// fonts don't include emoji glyphs or the ₱ peso sign -- so the PDF
// version uses plain "PharmaTrack" text (no emoji) and "PHP" instead of
// "₱", to avoid a broken/missing-glyph box showing up instead.
// ============================================================
const ExcelJS     = require('exceljs');
const PDFDocument = require('pdfkit');
const {
    Document, Packer, Paragraph, Table, TableRow, TableCell,
    TextRun, AlignmentType, WidthType, HeadingLevel
} = require('docx');
const Product = require('../models/Product');

function formatManilaDateTime() {
    return new Date().toLocaleString('en-PH', {
        timeZone: 'Asia/Manila',
        year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit'
    });
}

// "Jul 11 2026" -- short and unambiguous. mysql2 returns DATE columns as
// JS Date objects; naively stringifying one of those (e.g. via
// String(value) or template interpolation) produces the full verbose
// "Sat Jul 11 2026 16:00:00 GMT+0800 (Philippine Standard Time)" —
// that's exactly what was overflowing/overlapping in the PDF before this
// fix. This always goes through an explicit, short, fixed format instead.
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function formatShortDate(value) {
    if (!value) return '—';
    const d = value instanceof Date ? value : new Date(`${value}T00:00:00`);
    if (isNaN(d.getTime())) return String(value);
    return `${MONTHS[d.getMonth()]} ${d.getDate()} ${d.getFullYear()}`;
}

function statusLabel(status) {
    const labels = {
        in_stock: 'In Stock', low_stock: 'Low Stock',
        near_expiry: 'Expiring This Month', expiring_3mo: 'Expiring in 3 Months',
        expired: 'Expired', out_of_stock: 'Out of Stock'
    };
    return labels[status] || status;
}

const REPORT_COLUMNS = ['Batch No.', 'Product Name', 'Generic Name', 'Category', 'Stock', 'Price (₱)', 'Expiry Date', 'Status'];

function toRow(p) {
    return [
        p.batch_number, p.name, p.generic_name || '—', p.category,
        String(p.stock_quantity), `₱${Number(p.price).toFixed(2)}`,
        formatShortDate(p.expiry_date), statusLabel(p.stock_status)
    ];
}

/**
 * GET /api/inventory/export/excel
 */
const exportExcel = async (req, res, next) => {
    try {
        const products = await Product.findAll({});

        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'PharmaTrack';
        workbook.created = new Date();
        const sheet = workbook.addWorksheet('Inventory Report');

        sheet.mergeCells('A1:H1');
        sheet.getCell('A1').value = '💊 PharmaTrack';
        sheet.getCell('A1').font = { size: 18, bold: true, color: { argb: 'FF0D6EFD' } };
        sheet.getCell('A1').alignment = { horizontal: 'center' };

        sheet.mergeCells('A2:H2');
        sheet.getCell('A2').value = 'Inventory Report';
        sheet.getCell('A2').font = { size: 13, bold: true };
        sheet.getCell('A2').alignment = { horizontal: 'center' };

        sheet.mergeCells('A3:H3');
        sheet.getCell('A3').value = formatManilaDateTime();
        sheet.getCell('A3').font = { size: 10, italic: true, color: { argb: 'FF6C757D' } };
        sheet.getCell('A3').alignment = { horizontal: 'center' };

        sheet.addRow([]);

        const headerRow = sheet.addRow(REPORT_COLUMNS);
        headerRow.eachCell(cell => {
            cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D6EFD' } };
            cell.alignment = { horizontal: 'center' };
        });

        products.forEach(p => {
            const row = sheet.addRow(toRow(p));
            row.eachCell(cell => { cell.alignment = { vertical: 'middle' }; });
        });

        // Widened Batch No./Generic Name/Category specifically -- these
        // were the columns getting clipped/wrapped awkwardly with the
        // previous, tighter widths. Expiry Date is narrower now since
        // "Jul 11 2026" needs far less room than a full date string did.
        sheet.columns.forEach((col, i) => {
            col.width = [18, 28, 24, 22, 9, 12, 13, 14][i] || 15;
        });

        sheet.addRow([]);
        sheet.addRow([]);

        const sigLabelRow = sheet.addRow(['Prepared by:', '', '', '', 'Approved by:']);
        sigLabelRow.eachCell(cell => { cell.font = { bold: true }; });

        sheet.addRow(['_________________________', '', '', '', '_________________________']);

        // "Prepared by" is auto-filled with whoever actually generated this
        // report -- "Approved by" stays a generic caption since that's
        // someone else, signing later.
        const sigCaptionRow = sheet.addRow([req.user.name, '', '', '', 'Signature over Printed Name']);
        sigCaptionRow.eachCell(cell => { cell.font = { size: 9, italic: true }; });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="PharmaTrack_Inventory_Report.xlsx"');
        await workbook.xlsx.write(res);
        res.end();
    } catch (err) { next(err); }
};

/**
 * GET /api/inventory/export/pdf
 *
 * Column widths were the root cause of the earlier garbled/overlapping
 * output: Batch No. and Category were too narrow for realistic values
 * ("BATCH-CARB-002", "Hyperacidity and Indigestion"), and text() calls
 * had no `height` constraint, so PDFKit wrapped onto multiple lines
 * instead of truncating with an ellipsis -- which bled into the row
 * below it. Both are fixed here: wider, content-aware columns, and every
 * cell now gets an explicit height alongside `ellipsis: true`, which is
 * what actually makes PDFKit clip to one line instead of wrapping.
 */
const exportPDF = async (req, res, next) => {
    try {
        const products = await Product.findAll({});
        const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename="PharmaTrack_Inventory_Report.pdf"');
        doc.pipe(res);

        doc.fontSize(20).font('Helvetica-Bold').fillColor('#0d6efd')
           .text('PharmaTrack', { align: 'center' });
        doc.fontSize(13).font('Helvetica-Bold').fillColor('#212529')
           .text('Inventory Report', { align: 'center' });
        doc.fontSize(9).font('Helvetica-Oblique').fillColor('#6c757d')
           .text(formatManilaDateTime(), { align: 'center' });
        doc.moveDown(1);

        // Simple table drawn by hand -- PDFKit has no built-in table
        // widget, so columns are fixed widths and rows are drawn one at a
        // time with a header band repeated whenever a page break happens.
        // Batch No./Category widened to fit realistic values without
        // wrapping; Expiry Date narrowed since "Jul 11 2026" is short.
        const colWidths  = [92, 148, 118, 118, 40, 58, 58, 68];
        const ROW_HEIGHT = 18;
        const startX     = doc.page.margins.left;
        const tableWidth = colWidths.reduce((a, b) => a + b, 0);

        function drawHeader(y) {
            doc.rect(startX, y, tableWidth, 20).fill('#0d6efd');
            doc.fillColor('#fff').fontSize(8).font('Helvetica-Bold');
            let x = startX;
            REPORT_COLUMNS.forEach((label, i) => {
                doc.text(label.replace('₱', 'PHP'), x + 5, y + 6, {
                    width: colWidths[i] - 8, height: 12, ellipsis: true
                });
                x += colWidths[i];
            });
            return y + 20;
        }

        let y = drawHeader(doc.y);

        doc.font('Helvetica').fontSize(8);
        products.forEach((p, idx) => {
            if (y > doc.page.height - doc.page.margins.bottom - 30) {
                doc.addPage();
                y = drawHeader(doc.page.margins.top);
                doc.font('Helvetica').fontSize(8);
            }
            if (idx % 2 === 1) {
                doc.rect(startX, y, tableWidth, ROW_HEIGHT).fill('#f8f9fa');
            }
            doc.fillColor('#212529');
            const row = toRow(p).map(v => String(v).replace('₱', 'PHP '));
            let x = startX;
            row.forEach((cell, i) => {
                // height + ellipsis together are what force a SINGLE
                // truncated line instead of PDFKit wrapping onto (and
                // overlapping into) the next row.
                doc.text(cell, x + 5, y + 5, {
                    width: colWidths[i] - 8, height: 12, ellipsis: true
                });
                x += colWidths[i];
            });
            y += ROW_HEIGHT;
        });

        // Signature area
        y += 40;
        if (y > doc.page.height - doc.page.margins.bottom - 60) {
            doc.addPage();
            y = doc.page.margins.top;
        }
        doc.fontSize(10).font('Helvetica-Bold').fillColor('#212529');
        doc.text('Prepared by: ______________________________', startX, y);
        doc.text('Approved by: ______________________________', startX + tableWidth / 2, y);
        doc.fontSize(8).font('Helvetica-Oblique').fillColor('#6c757d');
        // "Prepared by" is auto-filled with whoever actually generated this
        // report -- "Approved by" stays a generic caption since that's
        // someone else, signing later.
        doc.text(req.user.name, startX, y + 16);
        doc.text('Signature over Printed Name', startX + tableWidth / 2, y + 16);

        doc.end();
    } catch (err) { next(err); }
};

/**
 * GET /api/inventory/export/word
 */
const exportWord = async (req, res, next) => {
    try {
        const products = await Product.findAll({});

        const headerCells = REPORT_COLUMNS.map(label => new TableCell({
            shading: { fill: '0D6EFD' },
            children: [new Paragraph({
                children: [new TextRun({ text: label, bold: true, color: 'FFFFFF', size: 16 })]
            })]
        }));

        const dataRows = products.map(p => new TableRow({
            children: toRow(p).map(value => new TableCell({
                children: [new Paragraph({ children: [new TextRun({ text: String(value), size: 16 })] })]
            }))
        }));

        const doc = new Document({
            sections: [{
                children: [
                    new Paragraph({
                        alignment: AlignmentType.CENTER,
                        children: [new TextRun({ text: '💊 PharmaTrack', bold: true, size: 36, color: '0D6EFD' })]
                    }),
                    new Paragraph({
                        alignment: AlignmentType.CENTER,
                        heading: HeadingLevel.HEADING_2,
                        children: [new TextRun({ text: 'Inventory Report', bold: true })]
                    }),
                    new Paragraph({
                        alignment: AlignmentType.CENTER,
                        children: [new TextRun({
                            text: formatManilaDateTime(),
                            italics: true, size: 18, color: '6C757D'
                        })]
                    }),
                    new Paragraph({ text: '' }),
                    new Table({
                        width: { size: 100, type: WidthType.PERCENTAGE },
                        rows: [new TableRow({ children: headerCells }), ...dataRows]
                    }),
                    new Paragraph({ text: '' }),
                    new Paragraph({ text: '' }),
                    new Paragraph({
                        children: [new TextRun({ text: 'Prepared by: ______________________________        Approved by: ______________________________', bold: true })]
                    }),
                    // "Prepared by" is auto-filled with whoever actually
                    // generated this report -- "Approved by" stays a
                    // generic caption since that's someone else, signing
                    // later.
                    new Paragraph({
                        children: [new TextRun({
                            text: `${req.user.name}                                                                    Signature over Printed Name`,
                            italics: true, size: 16, color: '6C757D'
                        })]
                    })
                ]
            }]
        });

        const buffer = await Packer.toBuffer(doc);

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', 'attachment; filename="PharmaTrack_Inventory_Report.docx"');
        res.send(buffer);
    } catch (err) { next(err); }
};

module.exports = { exportExcel, exportPDF, exportWord };
