const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const LOGO_PATH = path.join(__dirname, '..', 'public', 'img', 'cspc-logo.png');

// Wording printed on every certificate. Admins can override any of these
// from Settings (stored as JSON under the 'certificate_template' setting --
// see certificateController.getTemplate/saveTemplate); blank fields fall back
// to these defaults. Signatory titles are newline-separated lines.
const DEFAULT_TEMPLATE = {
  schoolName: 'CAMARINES SUR POLYTECHNIC COLLEGES',
  accreditation: 'ISO 9001 : 2008 CERTIFIED',
  title: 'CERTIFICATE',
  subtitle: 'OF ATTENDANCE',
  awardText: 'This certificate has been awarded to',
  defaultVenue: 'Camarines Sur Polytechnic Colleges',
  signatory1Name: 'DR. AMADO A. OLIVA, JR.',
  signatory1Title: 'CSPC - SUC President III',
  signatory2Name: 'MRS. MARITES A. BERMAL',
  signatory2Title: 'Administrative Officer V/\nDepartment Head, CSPC - HRMDU'
};

function resolveTemplate(overrides = {}) {
  const t = { ...DEFAULT_TEMPLATE };
  Object.keys(DEFAULT_TEMPLATE).forEach((k) => {
    const v = overrides[k];
    if (typeof v === 'string' && v.trim()) t[k] = v.trim();
  });
  return t;
}

const NAVY = '#13237A';
const NAVY_LIGHT = '#1D3494';
const TITLE_BLUE = '#1F3A9E';
const TEXT = '#222222';
const MUTED = '#555555';

// "2026-09-29" -> "September 29, 2026"; anything unparseable is printed as-is.
function formatLongDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  if (!m) return String(value || '');
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function goldGradient(doc, x1, y1, x2, y2) {
  return doc.linearGradient(x1, y1, x2, y2)
    .stop(0, '#A8761F')
    .stop(0.45, '#F3D77A')
    .stop(0.7, '#D9AE4A')
    .stop(1, '#9C6B18');
}

// Stepped gold "Greek key" ornament hugging a corner. (x, y) is the corner;
// dx/dy (+1/-1) point into the page.
function drawCornerKey(doc, x, y, dx, dy) {
  const s = 9;
  const p = (a, b) => [x + dx * a * s, y + dy * b * s];
  doc.save().lineWidth(2.2).strokeColor('#D4A94A').lineJoin('miter');
  const path1 = [p(0, 9), p(0, 0), p(9, 0)];
  const path2 = [p(1, 7), p(1, 1), p(7, 1), p(7, 3), p(3, 3), p(3, 5), p(5, 5)];
  const path3 = [p(2, 11), p(2, 2), p(11, 2)];
  [path1, path2, path3].forEach((pts) => {
    doc.moveTo(...pts[0]);
    pts.slice(1).forEach((pt) => doc.lineTo(...pt));
    doc.stroke();
  });
  doc.restore();
}

// Draws one line of mixed plain / underlined-filled segments, centered, and
// shrinks the font until it fits `maxWidth`.
function drawBlankLine(doc, segments, y, { maxWidth, size = 11.5, minSize = 7 }) {
  let fontSize = size;
  const widthAt = (fs) => segments.reduce((w, seg) => {
    doc.font(seg.fill ? 'Helvetica-Bold' : 'Helvetica').fontSize(fs);
    return w + doc.widthOfString(seg.text);
  }, 0);
  while (fontSize > minSize && widthAt(fontSize) > maxWidth) fontSize -= 0.5;
  let x = (doc.page.width - widthAt(fontSize)) / 2;
  segments.forEach((seg) => {
    doc.font(seg.fill ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize).fillColor(seg.fill ? TEXT : MUTED);
    const w = doc.widthOfString(seg.text);
    doc.text(seg.text, x, y, { lineBreak: false });
    if (seg.fill) {
      doc.save().moveTo(x - 2, y + fontSize + 1.5).lineTo(x + w + 2, y + fontSize + 1.5)
        .lineWidth(0.6).strokeColor('#777777').stroke().restore();
    }
    x += w;
  });
}

/**
 * Generates a PDF certificate of attendance in the CSPC design, using the
 * admin-editable wording in `template` (see DEFAULT_TEMPLATE).
 * Returns { pdfPath }.
 */
async function generateCertificatePdf({ certificateNumber, employeeName, eventTitle, issuedDate, awardDate, venue, template }) {
  const t = resolveTemplate(template);
  const dir = path.join(__dirname, '..', 'uploads', 'certificates');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const pdfPath = path.join(dir, `${certificateNumber}.pdf`);

  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0 });
    const stream = fs.createWriteStream(pdfPath);
    doc.pipe(stream);

    const W = doc.page.width;
    const H = doc.page.height;

    // Navy background with lighter diagonal panels.
    doc.rect(0, 0, W, H).fill(NAVY);
    doc.polygon([W * 0.55, 0], [W * 0.8, 0], [W * 0.35, H], [W * 0.1, H]).fillOpacity(0.35).fill(NAVY_LIGHT);
    doc.polygon([W * 0.9, 0], [W, 0], [W, H * 0.3], [W * 0.75, H]).fillOpacity(0.25).fill(NAVY_LIGHT);
    doc.fillOpacity(1);

    // Gold ribbons: top-right and bottom-left corners.
    doc.polygon([W * 0.82, 0], [W * 0.875, 0], [W, H * 0.2], [W, H * 0.285])
      .fill(goldGradient(doc, W * 0.82, 0, W, H * 0.28));
    doc.polygon([W * 0.9, 0], [W * 0.925, 0], [W, H * 0.12], [W, H * 0.16])
      .fill(goldGradient(doc, W * 0.9, 0, W, H * 0.16));
    doc.polygon([0, H * 0.72], [0, H * 0.8], [W * 0.13, H], [W * 0.075, H])
      .fill(goldGradient(doc, 0, H * 0.72, W * 0.13, H));
    doc.polygon([0, H * 0.84], [0, H * 0.88], [W * 0.075, H], [W * 0.05, H])
      .fill(goldGradient(doc, 0, H * 0.84, W * 0.075, H));

    // White card with a thin gold inner border.
    const cx = 38, cy = 32, cw = W - 76, ch = H - 60;
    doc.rect(cx, cy, cw, ch).fill('#FFFFFF');
    doc.rect(cx + 7, cy + 7, cw - 14, ch - 14).lineWidth(1.2).strokeColor('#D4A94A').stroke();

    // Greek-key corners (top-left and bottom-right).
    drawCornerKey(doc, 14, 12, 1, 1);
    drawCornerKey(doc, W - 14, H - 12, -1, -1);

    // Header: logo + school name.
    const headerName = t.schoolName;
    let headerSize = 19;
    doc.font('Times-Bold');
    while (headerSize > 10 && doc.fontSize(headerSize).widthOfString(headerName) > 560) headerSize -= 0.5;
    const nameW = doc.widthOfString(headerName);
    const logoSize = 50;
    const gap = 10;
    const headerX = (W - (logoSize + gap + nameW)) / 2;
    if (fs.existsSync(LOGO_PATH)) doc.image(LOGO_PATH, headerX, 52, { width: logoSize, height: logoSize });
    const textX = headerX + logoSize + gap;
    doc.fillColor(NAVY).text(headerName, textX, 62, { lineBreak: false });
    doc.font('Times-Roman').fontSize(10).fillColor(NAVY)
      .text(t.accreditation, textX, 85, { width: nameW, align: 'center', lineBreak: false });

    // Title.
    let titleSize = 66;
    doc.font('Times-Bold');
    while (titleSize > 30 && doc.fontSize(titleSize).widthOfString(t.title) > 680) titleSize -= 1;
    doc.fontSize(titleSize).fillColor(TITLE_BLUE)
      .text(t.title, 0, 118 + (66 - titleSize) / 2, { width: W, align: 'center', characterSpacing: 2, lineBreak: false });
    doc.font('Times-Roman').fontSize(22).fillColor(TITLE_BLUE)
      .text(t.subtitle, 0, 192, { width: W, align: 'center', characterSpacing: 1, lineBreak: false });

    doc.font('Helvetica').fontSize(15).fillColor(TEXT)
      .text(t.awardText, 0, 252, { width: W, align: 'center', lineBreak: false });

    // Recipient name over the blue line.
    let nameSize = 30;
    doc.font('Times-Bold');
    while (nameSize > 16 && doc.fontSize(nameSize).widthOfString(employeeName) > 460) nameSize -= 1;
    doc.fontSize(nameSize).fillColor(NAVY)
      .text(employeeName, 0, 356 - nameSize, { width: W, align: 'center', lineBreak: false });
    doc.moveTo(W / 2 - 230, 362).lineTo(W / 2 + 230, 362).lineWidth(1.2).strokeColor(TITLE_BLUE).stroke();

    // "for attending the ___. Given this award on ___ at ___."
    drawBlankLine(doc, [
      { text: 'for attending the ' },
      { text: eventTitle, fill: true },
      { text: '. Given this' }
    ], 378, { maxWidth: 560 });
    drawBlankLine(doc, [
      { text: 'award on ' },
      { text: formatLongDate(awardDate || issuedDate), fill: true },
      { text: ' at ' },
      { text: venue || t.defaultVenue, fill: true },
      { text: '.' }
    ], 400, { maxWidth: 560 });

    // Signatories.
    const sigY = 486;
    const signatories = [
      { name: t.signatory1Name, title: t.signatory1Title.split(/\r?\n/) },
      { name: t.signatory2Name, title: t.signatory2Title.split(/\r?\n/) }
    ];
    [W * 0.29, W * 0.71].forEach((centerX, i) => {
      const sig = signatories[i];
      const boxW = 250;
      let sigSize = 13;
      doc.font('Helvetica-Bold');
      while (sigSize > 8 && doc.fontSize(sigSize).widthOfString(sig.name) > boxW) sigSize -= 0.5;
      doc.fillColor(TEXT);
      const w = doc.widthOfString(sig.name);
      doc.text(sig.name, centerX - boxW / 2, sigY, { width: boxW, align: 'center', lineBreak: false });
      doc.moveTo(centerX - w / 2 - 4, sigY + 16).lineTo(centerX + w / 2 + 4, sigY + 16).lineWidth(0.9).strokeColor(TEXT).stroke();
      doc.font('Helvetica').fontSize(9.5).fillColor(MUTED);
      sig.title.slice(0, 3).forEach((line, j) => {
        doc.text(line, centerX - boxW / 2, sigY + 24 + j * 12, { width: boxW, align: 'center', lineBreak: false });
      });
    });

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  return { pdfPath };
}

module.exports = { generateCertificatePdf, DEFAULT_TEMPLATE, resolveTemplate };
