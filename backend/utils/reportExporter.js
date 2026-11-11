// Report Exporter - Shared Excel/PDF/Word generation engine used by every exportable...
const ExcelJS     = require('exceljs');
const PDFDocument = require('pdfkit');
const fs          = require('fs');
const path        = require('path');
const {
    Document, Packer, Paragraph, Table, TableRow, TableCell,
    TextRun, ImageRun, AlignmentType, WidthType, HeadingLevel, BorderStyle,
    PageOrientation, TableLayoutType
} = require('docx');

// Real logo file, shared by every format below
const LOGO_PATH = path.resolve(__dirname, '../../frontend/images/pharmatrack-logo.png');
const LOGO_BUFFER = (() => {
    try { return fs.readFileSync(LOGO_PATH); }
    catch (err) { console.error('[reportExporter] Could not read logo file:', err.message); return null; }
})();

// Column alignment - ONE rule for every report in every format (Excel, PDF, Word)
const NUMERIC_CELL = /^\s*[-+]?\s*(?:\u20b1|PHP)?\s*[-+]?\d[\d,]*(?:\.\d+)?\s*%?\s*$/;

function isNumericCell(value) {
    if (typeof value === 'number') return Number.isFinite(value);
    if (value === null || value === undefined) return false;
    const s = String(value).trim();
    return s !== '' && NUMERIC_CELL.test(s);
}

function isBlankCell(value) {
    if (value === null || value === undefined) return true;
    const s = String(value).trim();
    return s === '' || s === '\u2014' || s === '-';
}

function columnAligns(columns, rows) {
    return columns.map((c, i) => {
        if (c.align === 'left' || c.align === 'right') return c.align;
        let filled = 0;
        for (const row of rows) {
            if (isBlankCell(row[i])) continue;
            if (!isNumericCell(row[i])) return 'left';
            filled++;
        }
        return filled > 0 ? 'right' : 'left';
    });
}

// Excel column width: wide enough for the heading and for typical values, capped
function excelColumnWidth(col, i, rows) {
    const longest = rows.reduce((m, r) => Math.max(m, String(r[i] ?? '').length), 0);
    const want = Math.max(col.excelWidth || 0, String(col.label).length + 4, Math.min(longest, 42) + 2);
    return Math.min(Math.max(want, 8), 60);
}

function formatManilaDateTime() {
    return new Date().toLocaleString('en-PH', {
        timeZone: 'Asia/Manila',
        year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit'
    });
}

// "Jul 11 2026" - short and unambiguous, same format used everywhere else...
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const manila = require('./manilaTime');

// Read on a MANILA clock, never the server's: a hosted server runs in UTC
function formatShortDate(value) {
    if (!value) return '—';
    // a plain "2026-10-25" is a calendar date already - no time zone to apply
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
        const [y, m, day] = value.split('-').map(Number);
        return `${MONTHS[m - 1]} ${day} ${y}`;
    }
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return String(value);
    const p = manila.parts(d);
    return `${MONTHS[p.month - 1]} ${p.day} ${p.year}`;
}

function formatShortDateTime(value) {
    if (!value) return '—';
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return String(value);
    const p = manila.parts(d);
    const hours12 = p.hour % 12 || 12;
    const ampm    = p.hour >= 12 ? 'PM' : 'AM';
    const minutes = String(p.minute).padStart(2, '0');
    const seconds = String(p.second).padStart(2, '0');
    return `${formatShortDate(d)}, ${hours12}:${minutes}:${seconds} ${ampm}`;
}

async function exportExcel({ res, title, generatedBy, filename, columns, rows, periodLabel, totalsRow }) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'PharmaTrack';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet(title.substring(0, 31)); // Excel sheet-name length limit

    const colCount      = columns.length;
    const lastColLetter = String.fromCharCode(64 + Math.min(colCount, 26));
    const colLetter     = n => String.fromCharCode(64 + n);
    const aligns        = columnAligns(columns, rows);   // 'left' for text columns, 'right' for number columns

    sheet.mergeCells(`A1:${lastColLetter}1`);
    sheet.getCell('A1').value = 'PharmaTrack';
    sheet.getCell('A1').font = { size: 18, bold: true, color: { argb: 'FF0D6EFD' } };
    sheet.getCell('A1').alignment = { horizontal: 'center' };
    sheet.getRow(1).height = 30; // taller than default so the logo image below has room...

    // Real logo, anchored over the merged title cell
    if (LOGO_BUFFER) {
        const imageId = workbook.addImage({ buffer: LOGO_BUFFER, extension: 'png' });
        sheet.addImage(imageId, { tl: { col: 0, row: 0 }, ext: { width: 26, height: 26 } });
    }

    sheet.mergeCells(`A2:${lastColLetter}2`);
    sheet.getCell('A2').value = title;
    sheet.getCell('A2').font = { size: 13, bold: true };
    sheet.getCell('A2').alignment = { horizontal: 'center' };

    sheet.mergeCells(`A3:${lastColLetter}3`);
    sheet.getCell('A3').value = periodLabel || '';
    sheet.getCell('A3').font = { size: 10, italic: true, color: { argb: 'FF6C757D' } };
    sheet.getCell('A3').alignment = { horizontal: 'center' };

    sheet.addRow([]);

    const headerRow = sheet.addRow(columns.map(c => c.label));
    headerRow.eachCell((cell, colNumber) => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D6EFD' } };
        // Header aligned the same as its own data (text left, numbers right)
        cell.alignment = { horizontal: aligns[colNumber - 1] || 'left', vertical: 'middle', wrapText: true };
    });

    if (rows.length) {
        rows.forEach(row => {
            const excelRow = sheet.addRow(row);
            // Text columns left, number columns right. wrapText lets a long value
            excelRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
                cell.alignment = { horizontal: aligns[colNumber - 1] || 'left', vertical: 'top', wrapText: true };
            });
        });
    } else {
        // Compute the target row number FIRST, merge that exact row
        const emptyRowNum = sheet.rowCount + 1;
        sheet.mergeCells(`A${emptyRowNum}:${lastColLetter}${emptyRowNum}`);
        const emptyCell = sheet.getCell(`A${emptyRowNum}`);
        emptyCell.value = 'No records found for this period.';
        emptyCell.font = { italic: true, color: { argb: 'FF6C757D' } };
        emptyCell.alignment = { horizontal: 'center', vertical: 'middle' };
    }

    if (totalsRow) {
        const totalsExcelRow = sheet.addRow(totalsRow);
        totalsExcelRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
            // Same solid-blue treatment as the header row
            cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D6EFD' } };
            cell.alignment = { horizontal: aligns[colNumber - 1] || 'left', vertical: 'middle' };
        });
    }

    sheet.columns.forEach((col, i) => { col.width = excelColumnWidth(columns[i] || {}, i, rows); });

    // Generated date/time: directly below the table (and its totals row)
    sheet.addRow([]);
    const generatedRowNum = sheet.rowCount + 1;
    sheet.mergeCells(`A${generatedRowNum}:${lastColLetter}${generatedRowNum}`);
    const generatedCell = sheet.getCell(`A${generatedRowNum}`);
    generatedCell.value     = `Generated: ${formatManilaDateTime()}`;
    generatedCell.font      = { size: 10, italic: true, color: { argb: 'FF6C757D' } };
    generatedCell.alignment = { horizontal: 'center' };

    sheet.addRow([]);
    sheet.addRow([]);

    // Signature block - Each side ("Prepared by" / "Approved by") gets its own...
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

    // Underline row - a real bottom border, not a string of underscores
    if (preparedEndCol > 1) sheet.mergeCells(`A${r}:${colLetter(preparedEndCol)}${r}`);
    sheet.getCell(`A${r}`).border = { bottom: { style: 'thin' } };
    if (approvedStartCol <= colCount) {
        if (approvedEndCol > approvedStartCol) sheet.mergeCells(`${colLetter(approvedStartCol)}${r}:${colLetter(approvedEndCol)}${r}`);
        sheet.getCell(`${colLetter(approvedStartCol)}${r}`).border = { bottom: { style: 'thin' } };
    }
    r++;

    // Caption row - centered under the SAME merged span as the line above
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

    // Brand header - the real logo image plus the wordmark
    const brandText   = 'PharmaTrack';
    doc.font('Helvetica-Bold').fontSize(20);
    const brandTextWidth = doc.widthOfString(brandText);
    const logoW = 20, logoH = 20, logoGap = 8;
    const groupWidth   = LOGO_BUFFER ? logoW + logoGap + brandTextWidth : brandTextWidth;
    const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const groupX        = doc.page.margins.left + (contentWidth - groupWidth) / 2;
    const groupY         = doc.y;
    const brandTextHeight = doc.currentLineHeight();

    let textX = groupX;
    if (LOGO_BUFFER) {
        doc.image(LOGO_BUFFER, groupX, groupY + (brandTextHeight - logoH) / 2, { width: logoW, height: logoH });
        textX = groupX + logoW + logoGap;
    }
    doc.fillColor('#0d6efd').text(brandText, textX, groupY, { lineBreak: false });

    doc.x = doc.page.margins.left;
    doc.y = groupY + brandTextHeight + 4;

    doc.fontSize(13).font('Helvetica-Bold').fillColor('#212529').text(title, { align: 'center' });
    // Only the report range goes above the table now.
    if (periodLabel) {
        doc.fontSize(9).font('Helvetica-Oblique').fillColor('#6c757d')
           .text(periodLabel, { align: 'center' });
    }
    doc.moveDown(1);

    // Column widths: each column's pdfWidth is used as a RELATIVE weight and scaled
    const aligns           = columnAligns(columns, rows);   // text left, numbers right
    const pageContentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const weights          = columns.map(c => c.pdfWidth || 70);
    const weightSum        = weights.reduce((a, b) => a + b, 0);
    const scale            = weightSum > pageContentWidth
        ? pageContentWidth / weightSum
        : Math.min(pageContentWidth / weightSum, 1.5);
    const colWidths         = weights.map(w => w * scale);
    const tableWidth        = colWidths.reduce((a, b) => a + b, 0);
    // Centered on the page; the signature block below shares this same...
    const startX            = doc.page.margins.left + Math.max(0, (pageContentWidth - tableWidth) / 2);

    const CELL_PAD_X      = 3;
    const CELL_PAD_Y      = 5;
    const MIN_ROW_HEIGHT  = 18;
    const pdfText          = v => String(v ?? '').replace('\u20b1', 'PHP ');
    const bottomLimit      = () => doc.page.height - doc.page.margins.bottom - 30;

    // The height a row needs: its tallest cell once the text is wrapped...
    function rowHeightFor(cells, font) {
        doc.font(font).fontSize(8);
        let tallest = 0;
        cells.forEach((cell, i) => {
            const h = doc.heightOfString(pdfText(cell), { width: colWidths[i] - CELL_PAD_X * 2, align: aligns[i] });
            if (h > tallest) tallest = h;
        });
        return Math.max(MIN_ROW_HEIGHT, tallest + CELL_PAD_Y * 2);
    }

    function drawHeader(y) {
        const labels = columns.map(c => c.label.replace('\u20b1', 'PHP'));
        const h = rowHeightFor(labels, 'Helvetica-Bold') + 2;
        doc.rect(startX, y, tableWidth, h).fill('#0d6efd');
        doc.fillColor('#fff').fontSize(8).font('Helvetica-Bold');
        let x = startX;
        labels.forEach((label, i) => {
            // header aligned the same as its own data
            doc.text(label, x + CELL_PAD_X, y + CELL_PAD_Y + 1, { width: colWidths[i] - CELL_PAD_X * 2, align: aligns[i] });
            x += colWidths[i];
        });
        return y + h;
    }

    function drawRow(row, rowY, rowH, { bold = false, topBorder = false, highlight = false } = {}) {
        if (highlight) {
            // Solid blue fill with white bold text
            doc.rect(startX, rowY, tableWidth, rowH).fill('#0d6efd');
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
            doc.text(pdfText(cell), x + CELL_PAD_X, rowY + CELL_PAD_Y, { width: colWidths[i] - CELL_PAD_X * 2, align: aligns[i] });
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
            const rowH = rowHeightFor(row, 'Helvetica');
            if (y + rowH > bottomLimit()) {
                doc.addPage();
                y = drawHeader(doc.page.margins.top);
                doc.font('Helvetica').fontSize(8);
            }
            if (idx % 2 === 1) doc.rect(startX, y, tableWidth, rowH).fill('#f8f9fa');
            drawRow(row, y, rowH);
            y += rowH;
        });

        if (totalsRow) {
            const rowH = rowHeightFor(totalsRow, 'Helvetica-Bold');
            if (y + rowH > bottomLimit()) {
                doc.addPage();
                y = drawHeader(doc.page.margins.top);
                doc.font('Helvetica').fontSize(8);
            }
            drawRow(totalsRow, y, rowH, { highlight: true });
            y += rowH;
        }
    }

    // Signature block - A real drawn line (not underscores)
    y += 14;
    if (y > doc.page.height - doc.page.margins.bottom - 120) {
        doc.addPage();
        y = doc.page.margins.top;
    }
    doc.fontSize(9).font('Helvetica-Oblique').fillColor('#6c757d')
       .text(`Generated: ${formatManilaDateTime()}`, startX, y, { width: tableWidth, align: 'center' });
    y += 26;
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
    // Same column rule as Excel and PDF: text left, numbers right
    const aligns     = columnAligns(columns, rows);
    const wordAlign  = i => aligns[i] === 'right' ? AlignmentType.RIGHT : AlignmentType.LEFT;
    const weightSum  = columns.reduce((s, c) => s + (c.pdfWidth || 70), 0);
    const cellWidth  = i => ({ size: Math.round(((columns[i].pdfWidth || 70) / weightSum) * 1000) / 10, type: WidthType.PERCENTAGE });

    const headerCells = columns.map((c, i) => new TableCell({
        width: cellWidth(i),
        shading: { fill: '0D6EFD' },
        children: [new Paragraph({
            alignment: wordAlign(i),
            children: [new TextRun({ text: c.label, bold: true, color: 'FFFFFF', size: 16 })]
        })]
    }));

    const dataRows = rows.length
        ? rows.map(row => new TableRow({
            children: row.map((value, i) => new TableCell({
                width: cellWidth(i),
                children: [new Paragraph({
                    alignment: wordAlign(i),
                    children: [new TextRun({ text: String(value ?? ''), size: 16 })]
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
            children: totalsRow.map((value, i) => new TableCell({
                width: cellWidth(i),
                // Same blue shading as the header row
                shading: { fill: '0D6EFD' },
                children: [new Paragraph({
                    alignment: wordAlign(i),
                    children: [new TextRun({ text: String(value ?? ''), bold: true, color: 'FFFFFF', size: 16 })]
                })]
            }))
        })]
        : [];

    // Invisible 2-column table used purely for layout
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
            // Landscape, like the PDF, so wide reports have room for their columns
            properties: { page: { size: { orientation: PageOrientation.LANDSCAPE } } },
            children: [
                new Paragraph({
                    alignment: AlignmentType.CENTER,
                    children: [
                        ...(LOGO_BUFFER ? [new ImageRun({
                            type: 'png',
                            data: LOGO_BUFFER,
                            transformation: { width: 28, height: 28 }
                        })] : []),
                        new TextRun({ text: (LOGO_BUFFER ? '  ' : '') + 'PharmaTrack', bold: true, size: 36, color: '0D6EFD' })
                    ]
                }),
                new Paragraph({ alignment: AlignmentType.CENTER, heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: title, bold: true })] }),
                new Paragraph({
                    alignment: AlignmentType.CENTER,
                    children: [new TextRun({
                        text: periodLabel || '',
                        italics: true, size: 18, color: '6C757D'
                    })]
                }),
                new Paragraph({ text: '' }),
                new Table({
                    width: { size: 100, type: WidthType.PERCENTAGE },
                    layout: TableLayoutType.FIXED,
                    rows: [new TableRow({ children: headerCells }), ...dataRows, ...totalsRows]
                }),
                new Paragraph({ text: '' }),
                new Paragraph({
                    alignment: AlignmentType.CENTER,
                    children: [new TextRun({ text: `Generated: ${formatManilaDateTime()}`, italics: true, size: 18, color: '6C757D' })]
                }),
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

function csvEscape(value) {
    const str = String(value ?? '');
    if (/[",\n\r]/.test(str)) {
        return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
}

/** Plain-data CSV export */
function exportCSV({ res, filename, columns, rows, totalsRow }) {
    const lines = [columns.map(c => csvEscape(c.label)).join(',')];

    if (rows.length) {
        rows.forEach(row => lines.push(row.map(csvEscape).join(',')));
    } else {
        lines.push('No records found for this period.');
    }

    if (totalsRow) {
        lines.push(totalsRow.map(csvEscape).join(','));
    }

    // CRLF line endings - the CSV spec's own recommendation
    const csvContent = lines.join('\r\n');

    // UTF-8 BOM prefix - without it, Excel on Windows misreads a UTF-8 file...
    const bom = '\uFEFF';

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '.csv"');
    res.send(bom + csvContent);
}

/** Single entry point every controller uses */
async function exportReport(format, opts) {
    if (format === 'excel') return exportExcel(opts);
    if (format === 'pdf')   return exportPDF(opts);
    if (format === 'word')  return exportWord(opts);
    if (format === 'csv')   return exportCSV(opts);
    const err = new Error('Unknown export format. Use excel, pdf, word, or csv.');
    err.statusCode = 400;
    throw err;
}

module.exports = { exportReport, exportExcel, exportPDF, exportWord, exportCSV, formatManilaDateTime, formatShortDate, formatShortDateTime };
