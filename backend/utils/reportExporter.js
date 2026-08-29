// ============================================================
// Report Exporter
// Shared Excel/PDF/Word generation engine used by every exportable
// report in the app (Inventory, Sales, Expired Inventory, Void Report,
// Register Report, Audit Logs) — built once here instead of being
// duplicated per report.
//
// Callers supply already-FORMATTED string/number values per row (dates
// as short strings like "Jul 11 2026", currency as "₱123.00", etc.) —
// this engine only handles LAYOUT (headers, widths, signature area,
// pagination), never data formatting, which stays specific to each
// report's own controller.
//
// Same emoji/₱ caveat as the original Inventory export: Excel and Word
// render the 💊 logo and ₱ sign fine (the viewing app handles the font),
// but PDFKit bakes text into the file with its own bundled fonts at
// generation time, which don't include either — so the PDF version uses
// plain "PharmaTrack" text and "PHP" instead of "₱".
// ============================================================
const ExcelJS     = require('exceljs');
const PDFDocument = require('pdfkit');
const {
    Document, Packer, Paragraph, Table, TableRow, TableCell,
    TextRun, AlignmentType, WidthType, HeadingLevel
} = require('docx');

function formatManilaDateTime() {
    return new Date().toLocaleString('en-PH', {
        timeZone: 'Asia/Manila',
        year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit'
    });
}

// "Jul 11 2026" — short and unambiguous, same format used everywhere else
// in exports. mysql2 returns DATE/DATETIME columns as JS Date objects;
// naively stringifying one produces a verbose, overflow-prone string —
// always go through this instead.
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function formatShortDate(value) {
    if (!value) return '—';
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return String(value);
    return `${MONTHS[d.getMonth()]} ${d.getDate()} ${d.getFullYear()}`;
}

function formatShortDateTime(value) {
    if (!value) return '—';
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return String(value);
    const hours24 = d.getHours();
    const hours12 = hours24 % 12 || 12;
    const ampm    = hours24 >= 12 ? 'PM' : 'AM';
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${formatShortDate(d)}, ${hours12}:${minutes} ${ampm}`;
}

/**
 * @param {object} opts
 * @param {object} opts.res - Express response
 * @param {string} opts.title - report title (e.g. "Sales Report")
 * @param {string} opts.generatedBy - name of whoever generated it
 * @param {string} opts.filename - e.g. "PharmaTrack_Sales_Report" (no extension)
 * @param {{label:string, excelWidth?:number, pdfWidth?:number}[]} opts.columns
 * @param {Array<Array<string|number>>} opts.rows - already-formatted values, one array per row
 * @param {string} [opts.periodLabel] - optional e.g. "Aug 1 - Aug 23, 2026"
 */
async function exportExcel({ res, title, generatedBy, filename, columns, rows, periodLabel }) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'PharmaTrack';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet(title.substring(0, 31)); // Excel sheet-name length limit

    const colCount      = columns.length;
    const lastColLetter = String.fromCharCode(64 + Math.min(colCount, 26));

    sheet.mergeCells(`A1:${lastColLetter}1`);
    sheet.getCell('A1').value = '💊 PharmaTrack';
    sheet.getCell('A1').font = { size: 18, bold: true, color: { argb: 'FF0D6EFD' } };
    sheet.getCell('A1').alignment = { horizontal: 'center' };

    sheet.mergeCells(`A2:${lastColLetter}2`);
    sheet.getCell('A2').value = title;
    sheet.getCell('A2').font = { size: 13, bold: true };
    sheet.getCell('A2').alignment = { horizontal: 'center' };

    sheet.mergeCells(`A3:${lastColLetter}3`);
    sheet.getCell('A3').value = periodLabel ? `${formatManilaDateTime()} — ${periodLabel}` : formatManilaDateTime();
    sheet.getCell('A3').font = { size: 10, italic: true, color: { argb: 'FF6C757D' } };
    sheet.getCell('A3').alignment = { horizontal: 'center' };

    sheet.addRow([]);

    const headerRow = sheet.addRow(columns.map(c => c.label));
    headerRow.eachCell(cell => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D6EFD' } };
        cell.alignment = { horizontal: 'center' };
    });

    if (rows.length) {
        rows.forEach(row => {
            const excelRow = sheet.addRow(row);
            excelRow.eachCell(cell => { cell.alignment = { vertical: 'middle' }; });
        });
    } else {
        sheet.mergeCells(`A${sheet.rowCount + 1}:${lastColLetter}${sheet.rowCount + 1}`);
        const emptyRow = sheet.addRow(['No records found for this period.']);
        emptyRow.getCell(1).font = { italic: true, color: { argb: 'FF6C757D' } };
        emptyRow.getCell(1).alignment = { horizontal: 'center' };
    }

    sheet.columns.forEach((col, i) => { col.width = columns[i]?.excelWidth || 16; });

    sheet.addRow([]);
    sheet.addRow([]);

    const approvedCol = Math.min(5, colCount);
    const sigLabelRow = sheet.addRow(['Prepared by:']);
    sigLabelRow.getCell(1).font = { bold: true };
    sigLabelRow.getCell(approvedCol).value = 'Approved by:';
    sigLabelRow.getCell(approvedCol).font  = { bold: true };

    const sigLineRow = sheet.addRow(['_________________________']);
    sigLineRow.getCell(approvedCol).value = '_________________________';

    const sigCaptionRow = sheet.addRow([generatedBy]);
    sigCaptionRow.getCell(1).font = { size: 9, italic: true };
    sigCaptionRow.getCell(approvedCol).value = 'Signature over Printed Name';
    sigCaptionRow.getCell(approvedCol).font  = { size: 9, italic: true };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
}

async function exportPDF({ res, title, generatedBy, filename, columns, rows, periodLabel, orientation = 'landscape' }) {
    const doc = new PDFDocument({ margin: 40, size: 'A4', layout: orientation });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);
    doc.pipe(res);

    doc.fontSize(20).font('Helvetica-Bold').fillColor('#0d6efd').text('PharmaTrack', { align: 'center' });
    doc.fontSize(13).font('Helvetica-Bold').fillColor('#212529').text(title, { align: 'center' });
    doc.fontSize(9).font('Helvetica-Oblique').fillColor('#6c757d')
       .text(periodLabel ? `${formatManilaDateTime()} — ${periodLabel}` : formatManilaDateTime(), { align: 'center' });
    doc.moveDown(1);

    const colWidths  = columns.map(c => c.pdfWidth || 70);
    const ROW_HEIGHT = 18;
    const startX     = doc.page.margins.left;
    const tableWidth = colWidths.reduce((a, b) => a + b, 0);

    function drawHeader(y) {
        doc.rect(startX, y, tableWidth, 20).fill('#0d6efd');
        doc.fillColor('#fff').fontSize(8).font('Helvetica-Bold');
        let x = startX;
        columns.forEach((c, i) => {
            doc.text(c.label.replace('₱', 'PHP'), x + 5, y + 6, { width: colWidths[i] - 8, height: 12, ellipsis: true });
            x += colWidths[i];
        });
        return y + 20;
    }

    let y = drawHeader(doc.y);
    doc.font('Helvetica').fontSize(8);

    if (!rows.length) {
        doc.fillColor('#6c757d').font('Helvetica-Oblique').text('No records found for this period.', startX, y + 10);
        y += 34;
    } else {
        rows.forEach((row, idx) => {
            if (y > doc.page.height - doc.page.margins.bottom - 30) {
                doc.addPage();
                y = drawHeader(doc.page.margins.top);
                doc.font('Helvetica').fontSize(8);
            }
            if (idx % 2 === 1) doc.rect(startX, y, tableWidth, ROW_HEIGHT).fill('#f8f9fa');
            doc.fillColor('#212529');
            let x = startX;
            row.forEach((cell, i) => {
                doc.text(String(cell).replace('₱', 'PHP '), x + 5, y + 5, { width: colWidths[i] - 8, height: 12, ellipsis: true });
                x += colWidths[i];
            });
            y += ROW_HEIGHT;
        });
    }

    y += 40;
    if (y > doc.page.height - doc.page.margins.bottom - 60) {
        doc.addPage();
        y = doc.page.margins.top;
    }
    doc.fontSize(10).font('Helvetica-Bold').fillColor('#212529');
    doc.text('Prepared by: ______________________________', startX, y);
    doc.text('Approved by: ______________________________', startX + tableWidth / 2, y);
    doc.fontSize(8).font('Helvetica-Oblique').fillColor('#6c757d');
    doc.text(generatedBy, startX, y + 16);
    doc.text('Signature over Printed Name', startX + tableWidth / 2, y + 16);

    doc.end();
}

async function exportWord({ res, title, generatedBy, filename, columns, rows, periodLabel }) {
    const headerCells = columns.map(c => new TableCell({
        shading: { fill: '0D6EFD' },
        children: [new Paragraph({ children: [new TextRun({ text: c.label, bold: true, color: 'FFFFFF', size: 16 })] })]
    }));

    const dataRows = rows.length
        ? rows.map(row => new TableRow({
            children: row.map(value => new TableCell({
                children: [new Paragraph({ children: [new TextRun({ text: String(value), size: 16 })] })]
            }))
        }))
        : [new TableRow({
            children: [new TableCell({
                columnSpan: columns.length,
                children: [new Paragraph({ children: [new TextRun({ text: 'No records found for this period.', italics: true, size: 16 })] })]
            })]
        })];

    const doc = new Document({
        sections: [{
            children: [
                new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: '💊 PharmaTrack', bold: true, size: 36, color: '0D6EFD' })] }),
                new Paragraph({ alignment: AlignmentType.CENTER, heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: title, bold: true })] }),
                new Paragraph({
                    alignment: AlignmentType.CENTER,
                    children: [new TextRun({
                        text: periodLabel ? `${formatManilaDateTime()} — ${periodLabel}` : formatManilaDateTime(),
                        italics: true, size: 18, color: '6C757D'
                    })]
                }),
                new Paragraph({ text: '' }),
                new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [new TableRow({ children: headerCells }), ...dataRows] }),
                new Paragraph({ text: '' }),
                new Paragraph({ text: '' }),
                new Paragraph({ children: [new TextRun({ text: 'Prepared by: ______________________________        Approved by: ______________________________', bold: true })] }),
                new Paragraph({ children: [new TextRun({ text: `${generatedBy}                                                                    Signature over Printed Name`, italics: true, size: 16, color: '6C757D' })] })
            ]
        }]
    });

    const buffer = await Packer.toBuffer(doc);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.docx"`);
    res.send(buffer);
}

/**
 * Single entry point every controller uses — pass the format from the
 * route param, plus the same opts object described above.
 */
async function exportReport(format, opts) {
    if (format === 'excel') return exportExcel(opts);
    if (format === 'pdf')   return exportPDF(opts);
    if (format === 'word')  return exportWord(opts);
    const err = new Error('Unknown export format. Use excel, pdf, or word.');
    err.statusCode = 400;
    throw err;
}

module.exports = { exportReport, exportExcel, exportPDF, exportWord, formatManilaDateTime, formatShortDate, formatShortDateTime };
