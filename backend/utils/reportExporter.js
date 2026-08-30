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
// Optional `totalsRow` (array matching columns.length, blank string for
// cells that don't apply) renders as a bold row directly under the data,
// with a divider line above it — used e.g. by the Sales Report export to
// show Total Profit under the Profit column.
//
// Signature block: the underline is drawn as a real line/border (not a
// string of underscores), and the caption beneath it is centered against
// that SAME width in every format — so "Signature over Printed Name"
// always lines up under the line regardless of how long the generated
// name or caption text is.
//
// Same emoji/₱ caveat as the original Inventory export: Excel and Word
// render the 💊 logo and ₱ sign fine (the viewing app handles the font),
// but PDFKit bakes text into the file with its own bundled fonts at
// generation time, which don't include either — so the PDF version uses
// "PHP" instead of "₱", and draws a small vector capsule icon (see
// drawPillLogo below) in place of the 💊 glyph, since no bundled PDF font
// has an emoji glyph to fall back on at all.
// ============================================================
const ExcelJS     = require('exceljs');
const PDFDocument = require('pdfkit');
const {
    Document, Packer, Paragraph, Table, TableRow, TableCell,
    TextRun, AlignmentType, WidthType, HeadingLevel, BorderStyle
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

// Draws a simple two-tone capsule/pill icon using plain vector shapes --
// a stand-in for the 💊 emoji used in the Excel/Word headers. PDFKit bakes
// text using its own bundled fonts, which have NO emoji glyphs at all, so
// a text-based "💊" silently renders as nothing in the PDF no matter which
// font is selected. Drawing it as shapes instead means it never depends
// on font/glyph support, so it's always there in every generated PDF.
function drawPillLogo(doc, x, y, w, h) {
    const r = h / 2;
    doc.save();
    doc.roundedRect(x, y, w, h, r).clip();
    doc.rect(x, y, w / 2, h).fill('#ff8fa3');
    doc.rect(x + w / 2, y, w / 2, h).fill('#ffffff');
    doc.restore();
    doc.roundedRect(x, y, w, h, r).lineWidth(1).strokeColor('#495057').stroke();
    doc.moveTo(x + w / 2, y).lineTo(x + w / 2, y + h).lineWidth(0.75).strokeColor('#495057').stroke();
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
 * @param {Array<string|number>} [opts.totalsRow] - optional bold summary row, same length as columns
 */
async function exportExcel({ res, title, generatedBy, filename, columns, rows, periodLabel, totalsRow }) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'PharmaTrack';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet(title.substring(0, 31)); // Excel sheet-name length limit

    const colCount      = columns.length;
    const lastColLetter = String.fromCharCode(64 + Math.min(colCount, 26));
    const colLetter     = n => String.fromCharCode(64 + n);

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
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
    });

    if (rows.length) {
        rows.forEach(row => {
            const excelRow = sheet.addRow(row);
            // Centered so no cell's content ever reads as clipped against
            // the left edge -- text that's too long to fit still gets cut
            // by column width either way, but centering means it never
            // LOOKS like the start of the value is what's missing.
            excelRow.eachCell(cell => { cell.alignment = { horizontal: 'center', vertical: 'middle' }; });
        });
    } else {
        // Compute the target row number FIRST, merge that exact row, THEN
        // write into it via getRow/getCell (rather than mixing mergeCells
        // with a later addRow) -- mixing the two was the original cause of
        // the "No records found" text rendering as if it started off the
        // left edge of the sheet.
        const emptyRowNum = sheet.rowCount + 1;
        sheet.mergeCells(`A${emptyRowNum}:${lastColLetter}${emptyRowNum}`);
        const emptyCell = sheet.getCell(`A${emptyRowNum}`);
        emptyCell.value = 'No records found for this period.';
        emptyCell.font = { italic: true, color: { argb: 'FF6C757D' } };
        emptyCell.alignment = { horizontal: 'center', vertical: 'middle' };
    }

    if (totalsRow) {
        const totalsExcelRow = sheet.addRow(totalsRow);
        totalsExcelRow.eachCell(cell => {
            // Same solid-blue treatment as the header row -- makes a
            // totals row (e.g. TOTAL PROFIT) read as clearly as the
            // header does, instead of a thin divider line over otherwise
            // plain black-on-white cells.
            cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D6EFD' } };
            cell.alignment = { horizontal: 'center', vertical: 'middle' };
        });
    }

    sheet.columns.forEach((col, i) => { col.width = columns[i]?.excelWidth || 16; });

    sheet.addRow([]);
    sheet.addRow([]);

    // ── Signature block ──────────────────────────────────────
    // Each side ("Prepared by" / "Approved by") gets its own merged span,
    // occupying the first/last N columns respectively so they never
    // overlap. The underline is a real cell BORDER (not typed
    // underscores) and the caption directly below it is centered against
    // that identical merged span -- guaranteeing the caption always lines
    // up under the line regardless of text length in either row.
    //
    // approvedStartCol is always preparedEndCol + 2 (never +1) so there's
    // always at least one un-bordered gap COLUMN between the two spans --
    // two bottom-bordered cells sitting directly adjacent to each other
    // render as one continuous line in Excel with no visible break at
    // all, regardless of report column count.
    const spanCols         = Math.max(2, Math.min(3, Math.floor((colCount - 1) / 2)));
    const preparedEndCol   = Math.min(spanCols, Math.max(1, colCount - 2));
    const approvedStartCol = Math.min(colCount, preparedEndCol + 2);
    const approvedEndCol   = colCount;

    let r = sheet.rowCount + 1;

    // Label row
    sheet.getCell(`A${r}`).value = 'Prepared by:';
    sheet.getCell(`A${r}`).font  = { bold: true };
    if (approvedStartCol <= colCount) {
        sheet.getCell(`${colLetter(approvedStartCol)}${r}`).value = 'Approved by:';
        sheet.getCell(`${colLetter(approvedStartCol)}${r}`).font  = { bold: true };
    }
    r++;

    // Underline row — a real bottom border, not a string of underscores
    if (preparedEndCol > 1) sheet.mergeCells(`A${r}:${colLetter(preparedEndCol)}${r}`);
    sheet.getCell(`A${r}`).border = { bottom: { style: 'thin' } };
    if (approvedStartCol <= colCount) {
        if (approvedEndCol > approvedStartCol) sheet.mergeCells(`${colLetter(approvedStartCol)}${r}:${colLetter(approvedEndCol)}${r}`);
        sheet.getCell(`${colLetter(approvedStartCol)}${r}`).border = { bottom: { style: 'thin' } };
    }
    r++;

    // Caption row — centered under the SAME merged span as the line above
    if (preparedEndCol > 1) sheet.mergeCells(`A${r}:${colLetter(preparedEndCol)}${r}`);
    const preparedCaption = sheet.getCell(`A${r}`);
    preparedCaption.value = generatedBy;
    preparedCaption.font  = { size: 9, italic: true };
    preparedCaption.alignment = { horizontal: 'center' };
    if (approvedStartCol <= colCount) {
        if (approvedEndCol > approvedStartCol) sheet.mergeCells(`${colLetter(approvedStartCol)}${r}:${colLetter(approvedEndCol)}${r}`);
        const approvedCaption = sheet.getCell(`${colLetter(approvedStartCol)}${r}`);
        approvedCaption.value = 'Signature over Printed Name';
        approvedCaption.font  = { size: 9, italic: true };
        approvedCaption.alignment = { horizontal: 'center' };
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
}

async function exportPDF({ res, title, generatedBy, filename, columns, rows, periodLabel, orientation = 'landscape', totalsRow }) {
    const doc = new PDFDocument({ margin: 40, size: 'A4', layout: orientation });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);
    doc.pipe(res);

    // Brand header -- a drawn capsule icon (see drawPillLogo above) plus
    // the wordmark, centered together as ONE group so the PDF always
    // carries the same logo mark the Excel/Word exports show as "💊
    // PharmaTrack", instead of silently dropping it the way plain text
    // did.
    const brandText   = 'PharmaTrack';
    doc.font('Helvetica-Bold').fontSize(20);
    const brandTextWidth = doc.widthOfString(brandText);
    const logoW = 24, logoH = 14, logoGap = 8;
    const groupWidth   = logoW + logoGap + brandTextWidth;
    const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const groupX        = doc.page.margins.left + (contentWidth - groupWidth) / 2;
    const groupY         = doc.y;
    const brandTextHeight = doc.currentLineHeight();

    drawPillLogo(doc, groupX, groupY + (brandTextHeight - logoH) / 2, logoW, logoH);
    doc.fillColor('#0d6efd').text(brandText, groupX + logoW + logoGap, groupY, { lineBreak: false });

    doc.x = doc.page.margins.left;
    doc.y = groupY + brandTextHeight + 4;

    doc.fontSize(13).font('Helvetica-Bold').fillColor('#212529').text(title, { align: 'center' });
    doc.fontSize(9).font('Helvetica-Oblique').fillColor('#6c757d')
       .text(periodLabel ? `${formatManilaDateTime()} — ${periodLabel}` : formatManilaDateTime(), { align: 'center' });
    doc.moveDown(1);

    const colWidths  = columns.map(c => c.pdfWidth || 70);
    const ROW_HEIGHT = 18;
    const tableWidth = colWidths.reduce((a, b) => a + b, 0);
    // Centered on the page rather than flush against the left margin --
    // report tables rarely fill the full page width (especially now that
    // some have fewer columns), and anchoring everything at the left
    // margin left a large, unbalanced strip of blank space on the right
    // that made the whole page (table AND the signature block below it,
    // which shares this same startX/tableWidth) look off-center and
    // unfinished.
    const pageContentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const startX = doc.page.margins.left + Math.max(0, (pageContentWidth - tableWidth) / 2);

    function drawHeader(y) {
        doc.rect(startX, y, tableWidth, 20).fill('#0d6efd');
        doc.fillColor('#fff').fontSize(8).font('Helvetica-Bold');
        let x = startX;
        columns.forEach((c, i) => {
            doc.text(c.label.replace('₱', 'PHP'), x + 3, y + 6, { width: colWidths[i] - 6, height: 12, ellipsis: true, align: 'center' });
            x += colWidths[i];
        });
        return y + 20;
    }

    // Centered so a value that's too long for its column still reads as
    // cut off on BOTH sides rather than looking like the left edge (the
    // start of the value) is specifically what's missing.
    function drawRow(row, rowY, { bold = false, topBorder = false, highlight = false } = {}) {
        if (highlight) {
            // Same treatment as the header bar above -- solid blue fill,
            // white bold text -- so a totals row (e.g. TOTAL PROFIT) reads
            // just as clearly as the header does, instead of a thin line
            // over otherwise-plain data-row styling.
            doc.rect(startX, rowY, tableWidth, ROW_HEIGHT).fill('#0d6efd');
            doc.fillColor('#fff').font('Helvetica-Bold').fontSize(8);
        } else {
            if (topBorder) {
                doc.moveTo(startX, rowY).lineTo(startX + tableWidth, rowY)
                   .strokeColor('#212529').lineWidth(0.75).stroke();
            }
            doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor('#212529');
        }
        let x = startX;
        row.forEach((cell, i) => {
            doc.text(String(cell).replace('₱', 'PHP '), x + 3, rowY + 5, { width: colWidths[i] - 6, height: 12, ellipsis: true, align: 'center' });
            x += colWidths[i];
        });
    }

    let y = drawHeader(doc.y);
    doc.font('Helvetica').fontSize(8);

    if (!rows.length) {
        doc.fillColor('#6c757d').font('Helvetica-Oblique')
           .text('No records found for this period.', startX, y + 10, { width: tableWidth, align: 'center' });
        y += 34;
    } else {
        rows.forEach((row, idx) => {
            if (y > doc.page.height - doc.page.margins.bottom - 30) {
                doc.addPage();
                y = drawHeader(doc.page.margins.top);
                doc.font('Helvetica').fontSize(8);
            }
            if (idx % 2 === 1) doc.rect(startX, y, tableWidth, ROW_HEIGHT).fill('#f8f9fa');
            drawRow(row, y);
            y += ROW_HEIGHT;
        });

        if (totalsRow) {
            if (y > doc.page.height - doc.page.margins.bottom - 30) {
                doc.addPage();
                y = drawHeader(doc.page.margins.top);
                doc.font('Helvetica').fontSize(8);
            }
            drawRow(totalsRow, y, { highlight: true });
            y += ROW_HEIGHT;
        }
    }

    // ── Signature block ──────────────────────────────────────
    // A real drawn line (not underscores), with the caption centered
    // underneath using the exact same x-start and width as that line --
    // so it can never drift out of alignment with it.
    y += 40;
    if (y > doc.page.height - doc.page.margins.bottom - 70) {
        doc.addPage();
        y = doc.page.margins.top;
    }

    const halfWidth  = tableWidth / 2;
    const lineWidth  = Math.min(halfWidth - 20, 220);
    const leftLineX  = startX;
    const rightLineX = startX + halfWidth;

    doc.fontSize(10).font('Helvetica-Bold').fillColor('#212529');
    doc.text('Prepared by:', leftLineX, y);
    doc.text('Approved by:', rightLineX, y);

    const lineY = y + 26;
    doc.moveTo(leftLineX, lineY).lineTo(leftLineX + lineWidth, lineY).strokeColor('#212529').lineWidth(0.75).stroke();
    doc.moveTo(rightLineX, lineY).lineTo(rightLineX + lineWidth, lineY).strokeColor('#212529').lineWidth(0.75).stroke();

    doc.fontSize(8).font('Helvetica-Oblique').fillColor('#6c757d');
    doc.text(generatedBy, leftLineX, lineY + 4, { width: lineWidth, align: 'center' });
    doc.text('Signature over Printed Name', rightLineX, lineY + 4, { width: lineWidth, align: 'center' });

    doc.end();
}

async function exportWord({ res, title, generatedBy, filename, columns, rows, periodLabel, totalsRow }) {
    const headerCells = columns.map(c => new TableCell({
        shading: { fill: '0D6EFD' },
        children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: c.label, bold: true, color: 'FFFFFF', size: 16 })]
        })]
    }));

    const dataRows = rows.length
        ? rows.map(row => new TableRow({
            children: row.map(value => new TableCell({
                children: [new Paragraph({
                    alignment: AlignmentType.CENTER,
                    children: [new TextRun({ text: String(value), size: 16 })]
                })]
            }))
        }))
        : [new TableRow({
            children: [new TableCell({
                columnSpan: columns.length,
                children: [new Paragraph({
                    alignment: AlignmentType.CENTER,
                    children: [new TextRun({ text: 'No records found for this period.', italics: true, size: 16 })]
                })]
            })]
        })];

    const totalsRows = totalsRow
        ? [new TableRow({
            children: totalsRow.map(value => new TableCell({
                // Same blue shading as the header row -- see the Excel/PDF
                // versions of this same row for why.
                shading: { fill: '0D6EFD' },
                children: [new Paragraph({
                    alignment: AlignmentType.CENTER,
                    children: [new TextRun({ text: String(value ?? ''), bold: true, color: 'FFFFFF', size: 16 })]
                })]
            }))
        })]
        : [];

    // Invisible 2-column table used purely for layout, so "Prepared by"
    // and "Approved by" sit in equal-width blocks. The underline is a
    // real paragraph BORDER (not typed underscores), and the caption
    // paragraph directly beneath it is centered against that SAME cell
    // width -- so it can never drift out from under the line. Each cell
    // also gets an inward margin (right on the left cell, left on the
    // right cell) so the two borders don't sit flush against each other --
    // without it they'd touch at the shared cell boundary and render as
    // ONE continuous line with no visible break between them at all.
    const noBorder = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
    const sigLine  = { style: BorderStyle.SINGLE, size: 6, color: '000000' };
    const SIG_GAP  = 360; // twips (0.25in) inset on the facing edge of each cell

    const signatureBlock = new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: {
            top: noBorder, bottom: noBorder, left: noBorder, right: noBorder,
            insideHorizontal: noBorder, insideVertical: noBorder
        },
        rows: [
            new TableRow({
                children: [
                    new TableCell({
                        width: { size: 50, type: WidthType.PERCENTAGE },
                        margins: { right: SIG_GAP },
                        children: [
                            new Paragraph({ children: [new TextRun({ text: 'Prepared by:', bold: true })] }),
                            new Paragraph({ border: { bottom: sigLine }, children: [new TextRun({ text: '' })] }),
                            new Paragraph({
                                alignment: AlignmentType.CENTER,
                                children: [new TextRun({ text: generatedBy, italics: true, size: 16, color: '6C757D' })]
                            })
                        ]
                    }),
                    new TableCell({
                        width: { size: 50, type: WidthType.PERCENTAGE },
                        margins: { left: SIG_GAP },
                        children: [
                            new Paragraph({ children: [new TextRun({ text: 'Approved by:', bold: true })] }),
                            new Paragraph({ border: { bottom: sigLine }, children: [new TextRun({ text: '' })] }),
                            new Paragraph({
                                alignment: AlignmentType.CENTER,
                                children: [new TextRun({ text: 'Signature over Printed Name', italics: true, size: 16, color: '6C757D' })]
                            })
                        ]
                    })
                ]
            })
        ]
    });

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
                new Table({
                    width: { size: 100, type: WidthType.PERCENTAGE },
                    rows: [new TableRow({ children: headerCells }), ...dataRows, ...totalsRows]
                }),
                new Paragraph({ text: '' }),
                new Paragraph({ text: '' }),
                signatureBlock
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
